//! The native half of the parity test.
//!
//! ```text
//! cargo run -p atc-wasm --example parity -- <directory>
//! ```
//!
//! It writes two files into the directory. `script.bin` is a list of calls
//! to make on an `AircraftStore`: frames to ingest, times to advance to,
//! things to read back. `expected.bin` is everything this native build read
//! back while making those calls. `tools/store-parity.test.ts` makes the
//! same calls on the WASM build and compares what it reads, byte for byte.
//!
//! The script is the fixture recording from 380 s to 500 s, in which
//! flights begin and end, with the troubles a real connection has: frames
//! that arrive unevenly, late or not at all, a narrower viewport for a
//! while, and a render loop that stops and resumes.
//!
//! A call in the script is one byte naming it, a float64, a u32 length and
//! that many bytes, little-endian. The test's reader in TypeScript mirrors
//! [`run`] and the functions under it; change them together.

use std::path::PathBuf;

use atc_core::fixture;
use atc_core::recording::{Flight, SAMPLE_SPACING_S};
use atc_core::wire::{Alert, FRAME_NEW_PASS, Metadata, Record, TrackSample, encode_frame};
use atc_wasm::AircraftStore;

const INGEST: u8 = 0;
const ADVANCE: u8 = 1;
const SET_SELECTED: u8 = 2;
const SET_HOVERED: u8 = 3;
const SET_ALTITUDE_SCALE: u8 = 4;
const READ_AIRCRAFT: u8 = 5;
const READ_TRACK: u8 = 6;
const READ_ALERTS: u8 = 7;
const RESET: u8 = 8;

/// The value that stands for "none" where a call takes an optional id.
const NONE: f64 = -1.0;

/// First second of the recording played, and how many follow it.
const START_S: u32 = 380;
const TICKS: u32 = 121;
/// Clock time at which the first frame is due.
const START_MS: f64 = 5_000.0;

/// One call, and the clock time it is made at.
struct Call {
    at_ms: f64,
    name: u8,
    value: f64,
    bytes: Vec<u8>,
}

fn aircraft_id(flight: usize) -> u32 {
    1_000 + flight as u32
}

fn frame<R: Record>(seq: u32, sim_s: u32, flags: u32, records: &[R]) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_frame(&mut bytes, seq, f64::from(sim_s) * 1_000.0, flags, records);
    bytes
}

fn metadata(flight_id: usize, flight: &Flight) -> Metadata {
    Metadata {
        aircraft_id: aircraft_id(flight_id),
        flight_id: flight_id as u32,
        icao24: flight.icao24,
        time_shift_s: 0,
        offset_east_m: 0,
        offset_north_m: 0,
        callsign: flight.callsign,
        aircraft_type: flight.aircraft_type,
        origin: flight.origin,
        destination: flight.destination,
    }
}

/// The track frame the server would answer with at `second`: the flight's
/// samples on the 10 s grid so far, then where it is now.
fn track(flight_id: usize, flight: &Flight, second: u32) -> Vec<TrackSample> {
    let sample = |sim_time_s: u32| {
        let state = flight.state_at(sim_time_s)?;
        Some(TrackSample {
            id: aircraft_id(flight_id),
            sim_time_s,
            lat: state.lat,
            lon: state.lon,
            altitude: state.altitude,
            ground_speed: state.ground_speed,
            track: state.track,
            vertical_rate: state.vertical_rate,
            flags: state.flags,
            barometric: state.barometric,
        })
    };
    let mut samples: Vec<TrackSample> = (flight.start_s()..=second)
        .step_by(SAMPLE_SPACING_S as usize)
        .filter_map(sample)
        .collect();
    if !second.is_multiple_of(SAMPLE_SPACING_S) {
        samples.extend(sample(second));
    }
    samples
}

fn script() -> Vec<Call> {
    let recording = fixture::recording();
    let flights = &recording.flights;
    let mut calls = Vec::new();
    let mut call = |at_ms: f64, name: u8, value: f64, bytes: Vec<u8>| {
        calls.push(Call {
            at_ms,
            name,
            value,
            bytes,
        });
    };
    let (selected, hovered, later_hovered) = (0, 12, 3);

    call(0.0, SET_SELECTED, f64::from(aircraft_id(selected)), vec![]);
    call(0.0, SET_HOVERED, f64::from(aircraft_id(hovered)), vec![]);
    // Before any frame: nothing to draw.
    call(1.0, ADVANCE, 1.0, vec![]);

    let mut told = vec![false; flights.len()];
    for tick in 0..TICKS {
        let second = START_S + tick;
        let due_ms = START_MS + f64::from(tick) * 1_000.0;

        // The render loop, four times a tick. It stops for a few seconds,
        // as it does in a hidden tab.
        if !(90..94).contains(&tick) {
            for into_ms in [15.0, 265.0, 515.0, 765.0] {
                call(due_ms + into_ms, ADVANCE, due_ms + into_ms, vec![]);
            }
        }

        // Some ticks never reach this client.
        if [20, 21, 55].contains(&tick) {
            continue;
        }
        // Frames arrive up to 30 ms early or late, and one much later.
        let jitter_ms = f64::from((tick * 37) % 61) - 30.0;
        let late_ms = if tick == 80 { 700.0 } else { 0.0 };
        let received_ms = due_ms + jitter_ms + late_ms;

        // For a while the viewport takes in only two flights in three.
        let narrowed = (40..70).contains(&tick);
        let in_view = |flight_id: usize| !narrowed || !flight_id.is_multiple_of(3);
        let mut positions = Vec::new();
        let mut announced = Vec::new();
        for (flight_id, flight) in flights.iter().enumerate() {
            let Some(state) = flight.state_at(second).filter(|_| in_view(flight_id)) else {
                continue;
            };
            positions.push(state.position(aircraft_id(flight_id)));
            if !told[flight_id] {
                told[flight_id] = true;
                announced.push(metadata(flight_id, flight));
            }
        }
        if !announced.is_empty() {
            let bytes = frame(tick, second, 0, &announced);
            call(received_ms, INGEST, received_ms, bytes);
        }
        let flags = if tick == 100 { FRAME_NEW_PASS } else { 0 };
        let bytes = frame(tick, second, flags, &positions);
        call(received_ms, INGEST, received_ms, bytes);

        let mut send_track = |flight_id: usize| {
            let bytes = frame(
                tick,
                second,
                0,
                &track(flight_id, &flights[flight_id], second),
            );
            call(received_ms, INGEST, received_ms, bytes);
        };
        match tick {
            5 => {
                send_track(selected);
                send_track(hovered);
                // Nobody is waiting for this one.
                send_track(later_hovered);
            }
            63 => send_track(later_hovered),
            _ => {}
        }
        match tick {
            10 => {
                let position = |flight_id: usize| {
                    flights[flight_id]
                        .state_at(second)
                        .expect("the pair flies the whole window")
                        .position(aircraft_id(flight_id))
                };
                let (first, second_of_pair) = (position(0), position(1));
                let alert = Alert {
                    aircraft_ids: [first.id, second_of_pair.id],
                    lats: [first.lat, second_of_pair.lat],
                    lons: [first.lon, second_of_pair.lon],
                    altitudes: [first.altitude, second_of_pair.altitude],
                    seconds_to_closest: 210,
                    lateral_distance: 37,
                    vertical_separation: 4,
                    flags: 0,
                };
                let bytes = frame(tick, second, 0, &[alert, Alert::default()]);
                call(received_ms, INGEST, received_ms, bytes);
                call(received_ms, READ_ALERTS, 0.0, vec![]);
            }
            30 => call(received_ms, SET_ALTITUDE_SCALE, 0.0, vec![]),
            35 => call(received_ms, SET_ALTITUDE_SCALE, 0.3048 * 4.0, vec![]),
            36 => call(received_ms, READ_ALERTS, 0.0, vec![]),
            45 => {
                for flight_id in [selected, hovered] {
                    call(
                        received_ms,
                        READ_TRACK,
                        f64::from(aircraft_id(flight_id)),
                        vec![],
                    );
                }
            }
            50 => call(received_ms, SET_ALTITUDE_SCALE, 1.0, vec![]),
            60 => call(received_ms, SET_HOVERED, NONE, vec![]),
            62 => {
                let id = f64::from(aircraft_id(later_hovered));
                call(received_ms, SET_HOVERED, id, vec![]);
            }
            110 => {
                let bytes = frame::<Alert>(tick, second, 0, &[]);
                call(received_ms, INGEST, received_ms, bytes);
            }
            _ => {}
        }
    }

    // Stable, so calls made at the same moment keep the order above.
    calls.sort_by(|a, b| a.at_ms.total_cmp(&b.at_ms));

    let end_ms = START_MS + f64::from(TICKS) * 1_000.0;
    let mut call = |name: u8, value: f64| {
        calls.push(Call {
            at_ms: end_ms,
            name,
            value,
            bytes: vec![],
        });
    };
    // One past the last flight is an aircraft the store never heard of.
    for flight_id in 0..=flights.len() {
        call(READ_AIRCRAFT, f64::from(aircraft_id(flight_id)));
    }
    for flight_id in [selected, hovered, later_hovered] {
        call(READ_TRACK, f64::from(aircraft_id(flight_id)));
    }
    call(READ_ALERTS, 0.0);
    call(SET_SELECTED, NONE);
    call(READ_TRACK, f64::from(aircraft_id(selected)));
    call(RESET, 0.0);
    call(ADVANCE, end_ms);
    call(READ_AIRCRAFT, f64::from(aircraft_id(selected)));
    calls
}

fn encode(calls: &[Call]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for call in calls {
        bytes.push(call.name);
        bytes.extend(call.value.to_le_bytes());
        bytes.extend((call.bytes.len() as u32).to_le_bytes());
        bytes.extend(&call.bytes);
    }
    bytes
}

/// What was read back, as bytes.
#[derive(Default)]
struct Read(Vec<u8>);

impl Read {
    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }

    fn u32(&mut self, value: u32) {
        self.0.extend(value.to_le_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.0.extend(value.to_le_bytes());
    }

    fn u32s(&mut self, values: &[u32]) {
        for value in values {
            self.0.extend(value.to_le_bytes());
        }
    }

    fn f32s(&mut self, values: &[f32]) {
        for value in values {
            self.0.extend(value.to_le_bytes());
        }
    }

    /// An optional number: a byte saying whether it is there, then it.
    fn number(&mut self, value: Option<f64>) {
        self.u8(u8::from(value.is_some()));
        self.f64(value.unwrap_or(0.0));
    }

    fn flag(&mut self, value: Option<bool>) {
        self.number(value.map(|flag| f64::from(u8::from(flag))));
    }

    /// An optional string: a byte saying whether it is there, its length in
    /// bytes, then it.
    fn text(&mut self, value: Option<String>) {
        self.u8(u8::from(value.is_some()));
        let text = value.unwrap_or_default();
        self.u32(text.len() as u32);
        self.0.extend(text.as_bytes());
    }
}

fn optional_id(value: f64) -> Option<u32> {
    (value != NONE).then_some(value as u32)
}

/// Makes every call in an encoded script and returns what it read.
fn run(script: &[u8]) -> Vec<u8> {
    let mut store = AircraftStore::new();
    let mut read = Read::default();
    let mut rest = script;
    while let [name, tail @ ..] = rest {
        let (value, tail) = tail.split_at(8);
        let (length, tail) = tail.split_at(4);
        let value = f64::from_le_bytes(value.try_into().expect("eight bytes"));
        let length = u32::from_le_bytes(length.try_into().expect("four bytes")) as usize;
        let (bytes, tail) = tail.split_at(length);
        rest = tail;

        match *name {
            INGEST => {
                let Ok(kind) = store.ingest(bytes, value) else {
                    panic!("every frame in the script decodes");
                };
                read.u8(kind);
                read.u32(store.frame_seq());
                read.f64(store.frame_sim_time_ms());
                read.u8(u8::from(store.frame_new_pass()));
                read.u32(store.frame_count());
            }
            ADVANCE => {
                store.advance(value);
                let rows = store.len();
                let buffers = store.store();
                read.u32(rows as u32);
                read.u32(store.rows_version());
                read.u32s(&buffers.row_ids()[..rows]);
                read.f32s(&buffers.positions()[..rows * 3]);
                read.f32s(&buffers.angles()[..rows]);
                read.0.extend(&buffers.colors()[..rows * 4]);
            }
            SET_SELECTED => store.set_selected(optional_id(value)),
            SET_HOVERED => store.set_hovered(optional_id(value)),
            SET_ALTITUDE_SCALE => store.set_altitude_scale(value as f32),
            READ_AIRCRAFT => {
                let id = value as u32;
                let row = store.row_of(id);
                read.number(row.map(|row| row as f64));
                read.number(row.and_then(|row| store.id_at(row)).map(f64::from));
                read.text(store.callsign(id));
                read.text(store.aircraft_type(id));
                read.text(store.origin(id));
                read.text(store.destination(id));
                read.number(store.flight_id(id).map(f64::from));
                read.number(store.icao24(id).map(f64::from));
                read.number(store.latitude(id));
                read.number(store.longitude(id));
                read.number(store.altitude_ft(id));
                read.number(store.barometric_ft(id));
                read.number(store.ground_speed_kt(id));
                read.number(store.track_deg(id));
                read.number(store.vertical_rate_fpm(id));
                read.flag(store.on_ground(id));
                read.flag(store.synthetic(id));
            }
            READ_TRACK => {
                let id = value as u32;
                read.u32(store.track_len(id) as u32);
                read.u32s(store.store().track_times(id));
                read.f32s(store.store().track_positions(id));
            }
            READ_ALERTS => {
                read.u32(store.alert_count() as u32);
                read.u32s(store.store().alert_ids());
                read.f32s(store.store().alert_positions());
                read.f32s(store.store().alert_details());
            }
            RESET => store.reset(),
            other => panic!("the script has no call {other}"),
        }
    }
    read.0
}

fn main() -> std::io::Result<()> {
    let Some(directory) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: parity <directory>");
        std::process::exit(2);
    };
    let script = encode(&script());
    let expected = run(&script);
    std::fs::create_dir_all(&directory)?;
    std::fs::write(directory.join("script.bin"), &script)?;
    std::fs::write(directory.join("expected.bin"), &expected)?;
    println!(
        "{} bytes of script, {} bytes read back",
        script.len(),
        expected.len()
    );
    Ok(())
}
