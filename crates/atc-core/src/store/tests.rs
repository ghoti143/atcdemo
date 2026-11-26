use super::*;
use crate::wire::units::{
    altitude_to_wire, degrees_to_wire, text_from_wire, text_to_wire, track_to_wire,
    vertical_rate_to_wire,
};
use crate::wire::{FRAME_NEW_PASS, Record, encode_frame};

/// An aircraft standing still in the air at 30,000 ft.
fn at(id: u32, lat: f64, lon: f64) -> Position {
    Position {
        id,
        lat: degrees_to_wire(lat),
        lon: degrees_to_wire(lon),
        altitude: altitude_to_wire(30_000.0),
        ..Position::default()
    }
}

/// An aircraft flying north at 360 knots, a tenth of a mile a second, and
/// climbing at 1,920 ft/min, 32 ft a second.
fn northbound(id: u32, lat: f64) -> Position {
    Position {
        ground_speed: 360,
        vertical_rate: vertical_rate_to_wire(1_920.0),
        ..at(id, lat, -100.0)
    }
}

/// Degrees of latitude flown in a second at 360 knots.
const NORTH_PER_S: f64 = 0.1 / 60.0;

fn frame<R: Record>(seq: u32, sim_s: u32, records: &[R]) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_frame(&mut bytes, seq, f64::from(sim_s) * 1_000.0, 0, records);
    bytes
}

/// Ingests a frame of any kind that arrives exactly on its sim time.
fn take<R: Record>(store: &mut Store, sim_s: u32, records: &[R]) {
    let bytes = frame(sim_s, sim_s, records);
    store
        .ingest(&bytes, f64::from(sim_s) * 1_000.0)
        .expect("the frame decodes");
}

/// Ingests a positions frame that arrives exactly on its sim time, so the
/// store draws sim time `t - 1000` at clock time `t`.
fn feed(store: &mut Store, sim_s: u32, records: &[Position]) {
    take(store, sim_s, records);
}

/// lon, lat, scaled altitude and angle of an aircraft as last drawn.
fn drawn(store: &Store, id: u32) -> (f64, f64, f64, f64) {
    let row = store.row_of(id).expect("the aircraft has a row");
    assert_eq!(store.id_at(row), Some(id));
    let position = &store.positions()[row * 3..row * 3 + 3];
    (
        f64::from(position[0]),
        f64::from(position[1]),
        f64::from(position[2]),
        f64::from(store.angles()[row]),
    )
}

#[track_caller]
fn close(got: f64, want: f64, within: f64) {
    assert!((got - want).abs() <= within, "got {got}, want {want}");
}

/// A float32 resolves about 8e-6 degrees at longitude 100.
const DEGREES: f64 = 1e-5;

#[test]
fn interpolates_between_the_last_two_samples() {
    let mut store = Store::new();
    let mut first = at(7, 40.0, -100.0);
    first.altitude = altitude_to_wire(10_000.0);
    first.track = track_to_wire(350.0);
    let mut second = at(7, 40.001, -99.998);
    second.altitude = altitude_to_wire(10_100.0);
    second.track = track_to_wire(10.0);
    feed(&mut store, 10, &[first]);
    feed(&mut store, 11, &[second]);

    // One update behind: when the second frame arrives, the first is what
    // is drawn.
    store.advance(11_000.0);
    let (lon, lat, altitude, angle) = drawn(&store, 7);
    close(lon, -100.0, DEGREES);
    close(lat, 40.0, DEGREES);
    close(altitude, 10_000.0, 0.01);
    close(angle, -350.0, 0.01);

    store.advance(11_500.0);
    let (lon, lat, altitude, angle) = drawn(&store, 7);
    close(lon, -99.999, DEGREES);
    close(lat, 40.0005, DEGREES);
    close(altitude, 10_050.0, 0.01);
    // Halfway from 350 to 10 the short way is north, not south.
    close(angle, -360.0, 0.01);

    store.advance(12_000.0);
    let (lon, lat, altitude, angle) = drawn(&store, 7);
    close(lon, -99.998, DEGREES);
    close(lat, 40.001, DEGREES);
    close(altitude, 10_100.0, 0.01);
    close(angle, -370.0, 0.01);
}

#[test]
fn interpolates_across_a_skipped_frame() {
    let mut store = Store::new();
    feed(&mut store, 10, &[at(1, 40.0, -100.0)]);
    feed(&mut store, 12, &[at(1, 40.002, -100.0)]);

    // Sim time 11.5 s, three quarters of the way across two seconds.
    store.advance(12_500.0);
    close(drawn(&store, 1).1, 40.0015, DEGREES);
}

#[test]
fn an_aircraft_that_has_just_appeared_flies_in() {
    let mut store = Store::new();
    feed(&mut store, 10, &[northbound(1, 40.0)]);

    store.advance(10_000.0);
    let (_, lat, altitude, _) = drawn(&store, 1);
    close(lat, 40.0 - NORTH_PER_S, DEGREES);
    // 25 ft is the nearest the older sample can be to 32 ft lower.
    close(altitude, 29_975.0, 0.01);

    store.advance(10_500.0);
    close(drawn(&store, 1).1, 40.0 - NORTH_PER_S / 2.0, DEGREES);

    // The same goes for one that joins a picture already under way.
    let both = [northbound(1, 40.0 + NORTH_PER_S), northbound(2, 41.0)];
    feed(&mut store, 11, &both);
    store.advance(11_500.0);
    close(drawn(&store, 2).1, 41.0 - NORTH_PER_S / 2.0, DEGREES);
}

#[test]
fn dead_reckons_when_the_next_frame_is_late() {
    let mut store = Store::new();
    let mut aircraft = northbound(1, 40.0);
    aircraft.track = track_to_wire(90.0);
    feed(&mut store, 10, &[aircraft]);

    // Two seconds past the only sample: 0.2 nm east and 64 ft up.
    store.advance(13_000.0);
    let (lon, lat, altitude, angle) = drawn(&store, 1);
    let (want_lat, want_lon) = geo::step(40.0, -100.0, 90.0, 0.2);
    assert!(want_lon > -100.0 + 0.004);
    close(lon, want_lon, DEGREES);
    close(lat, want_lat, DEGREES);
    close(altitude, 30_064.0, 0.01);
    close(angle, -90.0, 0.01);
}

#[test]
fn dead_reckoning_stops_after_five_seconds() {
    let mut store = Store::new();
    feed(&mut store, 10, &[northbound(1, 40.0)]);

    store.advance(11_000.0 + 60_000.0);
    let (_, lat, altitude, _) = drawn(&store, 1);
    close(lat, 40.0 + 5.0 * NORTH_PER_S, DEGREES);
    close(altitude, 30_160.0, 0.01);
}

/// Metres in a degree of latitude.
const METRES: f64 = 111_120.0;

/// Plays a connection whose first frame is `age_ms` old when it arrives and
/// whose later frames come exactly a second apart, each arriving
/// `jitter_ms(tick)` off its time, to one aircraft flying north at 480
/// knots. It draws 60 frames a second and returns the metres moved between
/// each frame and the one before, from `from_s` seconds in.
fn steps(age_ms: f64, jitter_ms: impl Fn(u32) -> f64, seconds: u32, from_s: u32) -> Vec<f64> {
    const FRAME_MS: f64 = 1_000.0 / 60.0;
    let aircraft = |tick: u32| Position {
        ground_speed: 480,
        ..at(1, 40.0 + f64::from(tick) * 480.0 / 3_600.0 / 60.0, -100.0)
    };
    let mut store = Store::new();
    // Clock time 0 is when the first frame arrives; the next is due a
    // second after the first was sent.
    let arrives = |tick: u32| match tick {
        0 => 0.0,
        _ => f64::from(tick) * 1_000.0 - age_ms + jitter_ms(tick),
    };
    let mut next = 0;
    let mut last = None;
    let mut steps = Vec::new();
    for frame in 0..seconds * 60 {
        let now_ms = f64::from(frame) * FRAME_MS;
        while arrives(next) <= now_ms {
            let bytes = frame_of(next, &[aircraft(next)]);
            store.ingest(&bytes, arrives(next)).expect("it decodes");
            next += 1;
        }
        store.advance(now_ms);
        let lat = drawn(&store, 1).1;
        if let Some(last) = last.filter(|_| frame >= from_s * 60) {
            steps.push((lat - last) * METRES);
        }
        last = Some(lat);
    }
    steps
}

/// A positions frame for tick `tick`, sent at sim time `tick` seconds.
fn frame_of(tick: u32, records: &[Position]) -> Vec<u8> {
    frame(tick, 10 + tick, records)
}

/// 480 knots for a sixtieth of a second, in metres.
const STEP_M: f64 = 480.0 * 1_852.0 / 3_600.0 / 60.0;

#[test]
fn moves_smoothly_however_old_the_first_frame_was() {
    // The first frame of a connection is the picture as it stood, so it is
    // anywhere up to a second old. Every later frame then arrives early
    // against a clock set from it.
    for age_ms in [0.0, 300.0, 700.0, 999.0] {
        let steps = steps(age_ms, |_| 0.0, 30, 2);
        assert_eq!(steps.len(), 28 * 60);
        for (frame, step) in steps.iter().enumerate() {
            // A float32 latitude is good to 0.4 m here.
            assert!(
                (step - STEP_M).abs() < 1.0,
                "first frame {age_ms} ms old: moved {step} m in frame {frame}, not {STEP_M}"
            );
        }
    }
}

#[test]
fn uneven_arrival_moves_the_picture_by_less_than_the_unevenness() {
    // Up to 30 ms early or late, in no order.
    let jitter = |tick: u32| f64::from((tick * 37) % 61) - 30.0;
    let steps = steps(400.0, jitter, 60, 3);
    // 60 ms of flight is 15 m. Following every frame exactly would jump by
    // up to that, forwards and back.
    let most = steps
        .iter()
        .fold(0.0_f64, |most, step| most.max((step - STEP_M).abs()));
    assert!(most < 5.0, "a frame moved {most} m off its {STEP_M}");
    assert!(steps.iter().all(|step| *step > 0.0), "it never goes back");
}

#[test]
fn resumes_in_step_after_the_render_loop_stops() {
    let mut store = Store::new();
    let lat = |sim_s: f64| 40.0 + sim_s * NORTH_PER_S;
    let mut newest = 0.0;
    let mut feed_one = |store: &mut Store, sim_s: u32| {
        feed(store, sim_s, &[northbound(1, lat(f64::from(sim_s)))]);
        newest = lat(f64::from(sim_s));
        newest
    };
    feed_one(&mut store, 10);
    feed_one(&mut store, 11);
    store.advance(11_500.0);
    close(drawn(&store, 1).1, lat(10.5), DEGREES);

    // The tab is hidden for six seconds: frames keep arriving and nothing
    // is drawn.
    for sim_s in 12..=17 {
        feed_one(&mut store, sim_s);
    }

    // The first frame drawn is the picture as it now is, one update behind
    // the newest sample and not ahead of it, with nothing to catch up.
    store.advance(17_200.0);
    close(drawn(&store, 1).1, lat(16.2), DEGREES);

    // And it stays in step from there.
    for sim_s in 18..30 {
        let newest = feed_one(&mut store, sim_s);
        for into_ms in [0.0, 250.0, 500.0, 750.0, 999.0] {
            let now_ms = f64::from(sim_s) * 1_000.0 + into_ms;
            store.advance(now_ms);
            let drawn = drawn(&store, 1).1;
            close(drawn, lat(now_ms / 1_000.0 - 1.0), DEGREES);
            assert!(drawn <= newest + DEGREES);
        }
    }
}

#[test]
fn frames_held_up_together_do_not_leave_the_picture_behind() {
    let mut store = Store::new();
    let lat = |sim_s: f64| 40.0 + sim_s * NORTH_PER_S;
    let send = |store: &mut Store, sim_s: u32, received_ms: f64| {
        let bytes = frame(sim_s, sim_s, &[northbound(1, lat(f64::from(sim_s)))]);
        store.ingest(&bytes, received_ms).expect("it decodes");
    };
    send(&mut store, 10, 10_000.0);
    send(&mut store, 11, 11_000.0);
    store.advance(11_500.0);

    // The page stalls for six seconds, and the frames it missed all reach
    // it at once.
    for sim_s in 12..=17 {
        send(&mut store, sim_s, 17_300.0);
    }
    store.advance(17_300.0);
    let lat_drawn = drawn(&store, 1).1;
    assert!(lat_drawn >= lat(16.0) - DEGREES && lat_drawn <= lat(17.0) + DEGREES);

    // The next frame comes when it should, and the picture is one update
    // behind it as before.
    send(&mut store, 18, 18_000.0);
    store.advance(18_500.0);
    close(drawn(&store, 1).1, lat(17.5), DEGREES);
}

#[test]
fn a_late_frame_does_not_jolt_the_picture() {
    let mut store = Store::new();
    let lat = |sim_s: u32| 40.0 + f64::from(sim_s) * NORTH_PER_S;
    feed(&mut store, 10, &[northbound(1, lat(10))]);
    feed(&mut store, 11, &[northbound(1, lat(11))]);
    store.advance(11_500.0);
    store.advance(12_290.0);
    let before = drawn(&store, 1).1;
    close(before, lat(11) + 0.29 * NORTH_PER_S, DEGREES);

    // 300 ms late. Following it exactly would put the aircraft back 300 ms
    // of flight, 5e-4 degrees.
    let bytes = frame(12, 12, &[northbound(1, lat(12))]);
    store.ingest(&bytes, 12_300.0).expect("the frame decodes");
    store.advance(12_300.0);
    let after = drawn(&store, 1).1;
    close(after, before, 1e-4);
}

#[test]
fn drops_an_aircraft_absent_from_the_newest_frame() {
    let mut store = Store::new();
    let metadata = Metadata {
        aircraft_id: 2,
        callsign: text_to_wire("JBU123"),
        ..Metadata::default()
    };
    take(&mut store, 10, &[metadata]);
    let all = [1, 2, 3, 4].map(|id| at(id, 40.0 + f64::from(id), -100.0));
    feed(&mut store, 10, &all);
    store.advance(10_000.0);
    assert_eq!(store.len(), 4);
    assert_eq!(store.row_of(2), Some(1));

    feed(&mut store, 11, &[all[0], all[2], all[3]]);

    // Until the next advance the buffers still hold what was drawn, so a
    // pick of row 1 is still aircraft 2.
    assert_eq!(store.len(), 4);
    assert_eq!(store.id_at(1), Some(2));
    assert_eq!(store.aircraft_count(), 3);
    assert_eq!(store.row_of(2), None);
    assert_eq!(store.newest(2), None);

    store.advance(11_000.0);
    assert_eq!(store.len(), 3);
    assert_eq!(store.id_at(3), None);
    // The last row moved into the gap, and both lookups follow it.
    assert_eq!(store.row_of(4), Some(1));
    for id in [1, 3, 4] {
        close(drawn(&store, id).1, 40.0 + f64::from(id), DEGREES);
    }
    assert_eq!(store.newest(3), Some(all[2]));

    // Metadata is told once, so it outlives the row.
    let kept = store.metadata(2).expect("metadata is kept");
    assert_eq!(text_from_wire(&kept.callsign), "JBU123");

    // An aircraft that comes back is new: it has no older sample.
    feed(&mut store, 12, &[all[0], all[1]]);
    store.advance(12_000.0);
    assert_eq!(store.len(), 2);
    close(drawn(&store, 2).1, 42.0, DEGREES);

    feed(&mut store, 13, &[]);
    store.advance(13_000.0);
    assert!(store.is_empty());
    assert_eq!(store.row_of(1), None);
}

#[test]
fn the_first_of_two_records_for_one_aircraft_stands() {
    let mut store = Store::new();
    feed(&mut store, 10, &[at(1, 40.0, -100.0), at(1, 50.0, -100.0)]);
    store.advance(10_000.0);
    assert_eq!(store.len(), 1);
    close(drawn(&store, 1).1, 40.0, DEGREES);
}

#[test]
fn reports_each_frames_header() {
    let mut store = Store::new();
    assert_eq!(store.last_frame(), None);

    let mut bytes = Vec::new();
    let records = [at(1, 40.0, -100.0)];
    encode_frame(&mut bytes, 41, 12_000.0, FRAME_NEW_PASS, &records);
    let info = store.ingest(&bytes, 0.0).expect("the frame decodes");
    assert_eq!(
        info,
        FrameInfo {
            kind: FrameKind::Positions,
            seq: 41,
            sim_time_ms: 12_000.0,
            new_pass: true,
            count: 1,
        }
    );
    assert_eq!(store.last_frame(), Some(info));

    let info = store
        .ingest(&frame(42, 13, &[Metadata::default()]), 0.0)
        .expect("the frame decodes");
    assert_eq!(info.kind, FrameKind::Metadata);
    assert_eq!(info.seq, 42);
    assert!(!info.new_pass);
}

#[test]
fn a_frame_that_does_not_decode_changes_nothing() {
    let mut store = Store::new();
    feed(&mut store, 10, &[at(1, 40.0, -100.0)]);
    let before = store.last_frame();

    let mut bytes = frame(11, 11, &[at(2, 41.0, -100.0)]);
    bytes.pop();
    assert!(matches!(
        store.ingest(&bytes, 11_000.0),
        Err(DecodeError::Truncated { .. })
    ));
    bytes[0] = 99;
    assert_eq!(
        store.ingest(&bytes, 11_000.0),
        Err(DecodeError::Version(99))
    );
    // Records too small to hold a position.
    let mut small = frame(11, 11, &[at(2, 41.0, -100.0)]);
    small[2..4].copy_from_slice(&8u16.to_le_bytes());
    assert!(matches!(
        store.ingest(&small, 11_000.0),
        Err(DecodeError::RecordTooSmall { .. })
    ));

    assert_eq!(store.last_frame(), before);
    assert_eq!(store.aircraft_count(), 1);
    assert_eq!(store.row_of(2), None);
}

#[test]
fn sim_time_going_back_starts_afresh() {
    let mut store = Store::new();
    feed(&mut store, 100, &[northbound(1, 40.0)]);
    feed(&mut store, 101, &[northbound(1, 40.01)]);
    store.advance(101_500.0);

    // A restarted server, on a connection that was not reset.
    let bytes = frame(0, 5, &[northbound(1, 45.0)]);
    store.ingest(&bytes, 102_000.0).expect("the frame decodes");
    store.advance(102_500.0);
    close(drawn(&store, 1).1, 45.0 - NORTH_PER_S / 2.0, DEGREES);
}

#[test]
fn colours_by_altitude_band() {
    let mut store = Store::new();
    let with = |id: u32, feet: f64, flags: u8| Position {
        altitude: altitude_to_wire(feet),
        flags,
        ..at(id, 40.0, -100.0)
    };
    let aircraft = [
        with(1, 600.0, FLAG_ON_GROUND),
        with(2, 4_975.0, 0),
        with(3, 5_000.0, 0),
        with(4, 45_000.0, 0),
        with(5, -100.0, 0),
    ];
    feed(&mut store, 10, &aircraft);
    store.advance(10_000.0);

    let color = |row: usize| &store.colors()[row * 4..row * 4 + 4];
    assert_eq!(color(0), GROUND_COLOR);
    assert_eq!(color(1), ALTITUDE_BANDS[0].1);
    assert_eq!(color(2), ALTITUDE_BANDS[1].1);
    assert_eq!(color(3), ALTITUDE_BANDS[5].1);
    assert_eq!(color(4), ALTITUDE_BANDS[0].1);
}

fn track_sample(id: u32, sim_time_s: u32) -> TrackSample {
    TrackSample {
        id,
        sim_time_s,
        lat: degrees_to_wire(40.0),
        lon: degrees_to_wire(-100.0 + f64::from(sim_time_s) * 0.001),
        altitude: altitude_to_wire(30_000.0),
        ..TrackSample::default()
    }
}

#[test]
fn the_altitude_scale_applies_to_everything_drawn() {
    let mut store = Store::new();
    store.set_selected(Some(1));
    feed(&mut store, 10, &[at(1, 40.0, -100.0)]);
    let alert = Alert {
        aircraft_ids: [1, 2],
        altitudes: [altitude_to_wire(30_000.0), altitude_to_wire(31_000.0)],
        ..Alert::default()
    };
    take(&mut store, 10, &[track_sample(1, 10)]);
    take(&mut store, 10, &[alert]);

    store.advance(10_000.0);
    assert_eq!(drawn(&store, 1).2, 30_000.0);
    assert_eq!(store.track_positions(1)[2], 30_000.0);
    assert_eq!(store.alert_positions()[5], 31_000.0);

    // Flat, for 2D.
    store.set_altitude_scale(0.0);
    store.advance(10_016.0);
    assert_eq!(drawn(&store, 1).2, 0.0);
    assert_eq!(store.track_positions(1)[2], 0.0);
    assert_eq!(store.alert_positions()[5], 0.0);

    // Metres, for 3D.
    store.set_altitude_scale(0.3048);
    store.advance(10_032.0);
    close(drawn(&store, 1).2, 9_144.0, 0.01);
    close(f64::from(store.track_positions(1)[2]), 9_144.0, 0.01);
    close(f64::from(store.alert_positions()[5]), 9_448.8, 0.01);
}

#[test]
fn the_buffers_move_only_when_they_must_grow() {
    let mut store = Store::new();
    assert_eq!(store.capacity(), 0);
    assert_eq!(store.layout_version(), 0);

    let fleet =
        |count: u32| -> Vec<Position> { (0..count).map(|id| at(id, 40.0, -100.0)).collect() };
    feed(&mut store, 10, &fleet(1_000));
    store.advance(10_000.0);
    assert_eq!(store.capacity(), 1_024);
    assert_eq!(store.layout_version(), 1);
    assert_eq!(store.positions().len(), 1_024 * 3);
    assert_eq!(store.angles().len(), 1_024);
    assert_eq!(store.colors().len(), 1_024 * 4);
    assert_eq!(store.row_ids().len(), 1_024);
    let pointer = store.positions().as_ptr();

    feed(&mut store, 11, &fleet(1_024));
    feed(&mut store, 12, &fleet(3));
    store.advance(12_000.0);
    assert_eq!(store.layout_version(), 1);
    assert_eq!(store.positions().as_ptr(), pointer);

    feed(&mut store, 13, &fleet(1_025));
    assert_eq!(store.capacity(), 2_048);
    assert_eq!(store.layout_version(), 2);
}

#[test]
fn rows_version_counts_the_frames_taken_up() {
    let mut store = Store::new();
    feed(&mut store, 10, &[at(1, 40.0, -100.0)]);
    assert_eq!(store.rows_version(), 0);
    store.advance(10_000.0);
    store.advance(10_016.0);
    assert_eq!(store.rows_version(), 1);
    feed(&mut store, 11, &[at(1, 40.0, -100.0)]);
    store.advance(11_000.0);
    assert_eq!(store.rows_version(), 2);
}

#[test]
fn holds_a_track_and_extends_it_every_ten_seconds() {
    let mut store = Store::new();
    store.set_selected(Some(5));
    let here = |sim_s: u32| at(5, 40.0, -100.0 + f64::from(sim_s) * 0.001);
    feed(&mut store, 25, &[here(25)]);

    // Samples on the 10 s grid, then the aircraft's position now.
    let samples = [0, 10, 20, 25].map(|sim_s| track_sample(5, sim_s));
    take(&mut store, 25, &samples);
    assert_eq!(store.track_times(5), [0, 10, 20, 25]);
    assert_eq!(store.track_len(5), 4);

    // Each positions frame moves the end of the track.
    for sim_s in 26..30 {
        feed(&mut store, sim_s, &[here(sim_s)]);
        assert_eq!(store.track_times(5), [0, 10, 20, sim_s]);
    }
    let end = &store.track_positions(5)[9..];
    close(f64::from(end[0]), -100.0 + 0.029, DEGREES);
    close(f64::from(end[1]), 40.0, DEGREES);
    assert_eq!(end[2], 30_000.0);

    // Ten seconds after the last kept sample, the end is kept too.
    feed(&mut store, 30, &[here(30)]);
    assert_eq!(store.track_times(5), [0, 10, 20, 30]);
    feed(&mut store, 31, &[here(31)]);
    assert_eq!(store.track_times(5), [0, 10, 20, 30, 31]);
    // A skipped frame does not lose the sample.
    feed(&mut store, 43, &[here(43)]);
    assert_eq!(store.track_times(5), [0, 10, 20, 30, 43]);
    feed(&mut store, 44, &[here(44)]);
    assert_eq!(store.track_times(5), [0, 10, 20, 30, 43, 44]);
    assert_eq!(store.track_positions(5).len(), 6 * 3);

    // A track with one sample is an aircraft that has just appeared.
    take(&mut store, 44, &[track_sample(5, 44)]);
    assert_eq!(store.track_times(5), [44]);
    feed(&mut store, 45, &[here(45)]);
    assert_eq!(store.track_times(5), [44, 45]);

    // It stops, and stays, when the aircraft leaves the picture.
    feed(&mut store, 46, &[]);
    assert_eq!(store.track_times(5), [44, 45]);
}

#[test]
fn holds_tracks_for_the_selected_and_hovered_aircraft_only() {
    let mut store = Store::new();
    let track = |id: u32| [track_sample(id, 0), track_sample(id, 10)];
    store.set_selected(Some(1));
    store.set_hovered(Some(2));
    for id in [1, 2, 3] {
        take(&mut store, 10, &track(id));
    }
    assert_eq!(store.track_len(1), 2);
    assert_eq!(store.track_len(2), 2);
    // Nobody asked for 3, or they have moved on since.
    assert_eq!(store.track_len(3), 0);
    assert!(store.track_positions(3).is_empty());

    // Selecting what was hovered keeps its track.
    store.set_selected(Some(2));
    assert_eq!(store.track_len(1), 0);
    assert_eq!(store.track_len(2), 2);
    store.set_hovered(None);
    assert_eq!(store.track_len(2), 2);
    store.set_selected(None);
    assert_eq!(store.track_len(2), 0);

    // An empty track frame is nothing.
    take::<TrackSample>(&mut store, 11, &[]);
}

#[test]
fn keeps_the_newest_alerts_frame_up_to_the_cap() {
    let mut store = Store::new();
    let alert = |first: u32| Alert {
        aircraft_ids: [first, first + 1],
        lats: [degrees_to_wire(40.0), degrees_to_wire(41.0)],
        lons: [degrees_to_wire(-100.0), degrees_to_wire(-101.0)],
        altitudes: [altitude_to_wire(30_000.0), altitude_to_wire(30_500.0)],
        seconds_to_closest: 90,
        lateral_distance: 250,
        vertical_separation: 20,
        flags: 0,
    };
    let pointer = store.alert_positions().as_ptr();

    let many: Vec<Alert> = (0..600).map(alert).collect();
    take(&mut store, 10, &many);
    assert_eq!(store.alert_count(), MAX_ALERTS);
    assert_eq!(store.alert_ids().len(), MAX_ALERTS * 2);
    assert_eq!(store.alert_positions().len(), MAX_ALERTS * 6);
    assert_eq!(store.alert_details().len(), MAX_ALERTS * 3);
    assert_eq!(store.alert_ids()[998..], [499, 500]);

    take(&mut store, 15, &[alert(7)]);
    assert_eq!(store.alert_count(), 1);
    assert_eq!(store.alert_ids(), [7, 8]);
    let want = [-100.0, 40.0, 30_000.0, -101.0, 41.0, 30_500.0];
    for (got, want) in store.alert_positions().iter().zip(want) {
        close(f64::from(*got), want, DEGREES);
    }
    assert_eq!(store.alert_details(), [90.0, 2.5, 500.0]);
    assert_eq!(store.alert_positions().as_ptr(), pointer);

    take::<Alert>(&mut store, 20, &[]);
    assert_eq!(store.alert_count(), 0);
    assert!(store.alert_ids().is_empty());
}

#[test]
fn reset_forgets_what_the_server_sent() {
    let mut store = Store::new();
    store.set_selected(Some(1));
    let metadata = Metadata {
        aircraft_id: 1,
        ..Metadata::default()
    };
    take(&mut store, 10, &[metadata]);
    feed(&mut store, 10, &[at(1, 40.0, -100.0)]);
    take(&mut store, 10, &[track_sample(1, 10)]);
    take(&mut store, 10, &[Alert::default()]);
    store.advance(10_000.0);
    let capacity = store.capacity();

    store.reset();
    assert!(store.is_empty());
    assert_eq!(store.aircraft_count(), 0);
    assert_eq!(store.row_of(1), None);
    assert!(store.metadata(1).is_none());
    assert_eq!(store.track_len(1), 0);
    assert_eq!(store.alert_count(), 0);
    assert_eq!(store.last_frame(), None);
    assert_eq!(store.capacity(), capacity);

    // The new connection's first frame is a first frame again, and the
    // selection still stands.
    feed(&mut store, 3, &[northbound(1, 40.0)]);
    take(&mut store, 3, &[track_sample(1, 3)]);
    store.advance(3_500.0);
    close(drawn(&store, 1).1, 40.0 - NORTH_PER_S / 2.0, DEGREES);
    assert_eq!(store.track_len(1), 1);
}
