//! The flight recorder: writes what has flown to Postgres as it happens, so
//! the database holds the past and nothing else (docs/DESIGN.md section 5).
//!
//! It is in two halves, so that the database can never hold up a tick.
//!
//! - [`Recorder`] is called from the simulation loop with every tick. It
//!   notes which real aircraft have come and gone, keeps the 10 s samples
//!   each has flown, and puts what there is to write on a channel. It does
//!   no I/O and no encoding.
//! - The writer ([`writer`]) is a task of its own that takes those events
//!   and writes them, in batches. When the database is away it keeps them,
//!   up to a limit, and writes them when it is back.
//!
//! Stress-mode clones are not recorded, so the load is that of the real
//! picture whatever the multiplier.

pub mod codec;
pub mod store;
pub mod writer;

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use atc_core::recording::{SAMPLE_SPACING_S, Sample};
use atc_core::wire::units::text_from_wire;
use atc_core::wire::{FLAG_SYNTHETIC, Metadata, Position};
use sqlx::postgres::PgPool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::sim::Tick;

/// How often the samples flown since the last write are handed over, in sim
/// seconds. A flight's recorded track is this far behind at most, and ten
/// seconds more.
pub const FLUSH_EVERY_S: u32 = 300;

/// A real aircraft that has come into the picture.
#[derive(Debug, Clone, PartialEq)]
pub struct FlightStart {
    pub aircraft_id: u32,
    pub icao24: u32,
    pub callsign: String,
    pub aircraft_type: String,
    /// `None` where the recording does not know.
    pub origin: Option<String>,
    pub destination: Option<String>,
    /// Which trip through the recording, from 0.
    pub pass: u32,
    pub sim_time_s: u32,
    /// The wall clock, in seconds since the epoch.
    pub at: f64,
}

/// Some of what an aircraft has flown: samples [`SAMPLE_SPACING_S`] apart.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackBatch {
    pub aircraft_id: u32,
    /// Sim time of the first sample.
    pub first_sample_sim_s: u32,
    pub samples: Vec<Sample>,
}

/// An aircraft that has left the picture.
#[derive(Debug, Clone, PartialEq)]
pub struct FlightEnd {
    pub aircraft_id: u32,
    /// Sim time of the last tick it was in.
    pub sim_time_s: u32,
    pub at: f64,
}

/// Something for the writer to write. They are written in the order sent.
#[derive(Debug)]
pub enum Event {
    Started(FlightStart),
    Track(TrackBatch),
    Ended(FlightEnd),
    /// Answered once everything sent before it has been written, or given
    /// up on. For tests.
    Sync(tokio::sync::oneshot::Sender<()>),
}

/// A real aircraft in the picture now.
#[derive(Debug)]
struct Open {
    /// Sim time of the last tick it was in.
    last_seen_s: u32,
    /// Whether its `Started` has been sent. It is sent when the tick's
    /// metadata names the aircraft, which is the tick it appears in.
    announced: bool,
    /// The samples not yet handed over, and when the first was taken.
    first_sample_sim_s: u32,
    samples: Vec<Sample>,
}

/// The half that watches the simulation. See the module.
#[derive(Debug)]
pub struct Recorder {
    open: HashMap<u32, Open>,
    events: mpsc::UnboundedSender<Event>,
    /// The length of a pass, for the pass number.
    window_s: u32,
}

fn wall_clock() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64())
}

/// A wire text field as the database holds it: trimmed, and `None` if empty.
fn text(field: &[u8]) -> Option<String> {
    let text = text_from_wire(field);
    (!text.is_empty()).then(|| text.to_owned())
}

fn sample_of(position: &Position) -> Sample {
    Sample {
        lat: position.lat,
        lon: position.lon,
        altitude: position.altitude,
        barometric: position.barometric,
        ground_speed: position.ground_speed,
        track: position.track,
        vertical_rate: position.vertical_rate,
        // Recorded aircraft are real, so only the ground bit can be set.
        flags: position.flags & !FLAG_SYNTHETIC,
    }
}

impl Recorder {
    /// A recorder with nothing behind it but a channel: what it has to say
    /// is read from the receiver. `window_s` is the length of a pass.
    pub fn new(window_s: u32) -> (Recorder, mpsc::UnboundedReceiver<Event>) {
        let (events, receiver) = mpsc::unbounded_channel();
        let recorder = Recorder {
            open: HashMap::new(),
            events,
            window_s: window_s.max(1),
        };
        (recorder, receiver)
    }

    /// Takes in one tick. Called from the simulation loop, so it does no
    /// I/O and waits for nothing: sending on the channel never blocks.
    pub fn observe(&mut self, tick: &Tick) {
        let now = tick.sim_time_s;
        let at = wall_clock();
        let on_grid = now.is_multiple_of(SAMPLE_SPACING_S);

        // Every five minutes, what each aircraft has flown since the last
        // time goes to the writer: the samples up to ten seconds ago. It is
        // done before this tick's sample is taken, so a batch is whole, five
        // minutes of samples, and an aircraft that appears on this tick,
        // as every one does when a pass begins, is not given a row of one
        // sample.
        if now.is_multiple_of(FLUSH_EVERY_S) {
            for (&aircraft_id, open) in &mut self.open {
                if open.samples.is_empty() {
                    continue;
                }
                let batch = TrackBatch {
                    aircraft_id,
                    first_sample_sim_s: open.first_sample_sim_s,
                    samples: std::mem::take(&mut open.samples),
                };
                // The writer has gone only when the server is stopping.
                let _ = self.events.send(Event::Track(batch));
            }
        }

        for position in &tick.positions {
            if position.flags & FLAG_SYNTHETIC != 0 {
                continue;
            }
            let open = self.open.entry(position.id).or_insert_with(|| Open {
                last_seen_s: now,
                announced: false,
                first_sample_sim_s: now,
                samples: Vec::new(),
            });
            open.last_seen_s = now;
            if on_grid {
                if open.samples.is_empty() {
                    open.first_sample_sim_s = now;
                }
                open.samples.push(sample_of(position));
            }
        }

        for metadata in &tick.appeared {
            if let Some(open) = self.open.get_mut(&metadata.aircraft_id)
                && !open.announced
            {
                open.announced = true;
                self.send(Event::Started(self.start(metadata, now, at)));
            }
        }

        // An aircraft that is not in this tick has gone: what it flew since
        // the last write goes out, then its end.
        let mut gone: Vec<(u32, Open)> = Vec::new();
        self.open.retain(|&aircraft_id, open| {
            if open.last_seen_s == now {
                return true;
            }
            let left = std::mem::replace(
                open,
                Open {
                    last_seen_s: open.last_seen_s,
                    announced: open.announced,
                    first_sample_sim_s: 0,
                    samples: Vec::new(),
                },
            );
            gone.push((aircraft_id, left));
            false
        });
        for (aircraft_id, open) in gone {
            if !open.samples.is_empty() {
                self.send(Event::Track(TrackBatch {
                    aircraft_id,
                    first_sample_sim_s: open.first_sample_sim_s,
                    samples: open.samples,
                }));
            }
            self.send(Event::Ended(FlightEnd {
                aircraft_id,
                sim_time_s: open.last_seen_s,
                at,
            }));
        }
    }

    fn start(&self, metadata: &Metadata, sim_time_s: u32, at: f64) -> FlightStart {
        FlightStart {
            aircraft_id: metadata.aircraft_id,
            icao24: metadata.icao24,
            callsign: text(&metadata.callsign).unwrap_or_default(),
            aircraft_type: text(&metadata.aircraft_type).unwrap_or_default(),
            origin: text(&metadata.origin),
            destination: text(&metadata.destination),
            pass: sim_time_s / self.window_s,
            sim_time_s,
            at,
        }
    }

    fn send(&self, event: Event) {
        // The writer has gone only when the server is stopping.
        let _ = self.events.send(event);
    }

    /// How many real aircraft are being recorded now.
    pub fn open_flights(&self) -> usize {
        self.open.len()
    }

    /// Asks the writer to say when everything sent so far is written.
    pub fn sync(&self) -> tokio::sync::oneshot::Receiver<()> {
        let (done, wait) = tokio::sync::oneshot::channel();
        self.send(Event::Sync(done));
        wait
    }
}

/// Why the recorder could not start.
#[derive(Debug)]
pub struct StartError(pub String);

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StartError {}

/// Starts recording to `db`: checks that the tables are as this code needs
/// them, closes the flights an earlier run left open, and starts the task
/// that writes. Returns the half the simulation loop calls.
///
/// If the database cannot be reached now, that is not an error: the server
/// runs without it, and the writer makes the same checks when it first gets
/// through. Tables that are there and wrong are an error, because nothing
/// would ever be written and nothing would say so.
pub async fn start(db: PgPool, window_s: u32) -> Result<Recorder, StartError> {
    let prepared = match store::prepare(&db).await {
        Ok(closed) => {
            if closed > 0 {
                info!("recorder: closed {closed} flight(s) an earlier run left open");
            }
            true
        }
        Err(store::Error::Schema(problem)) => return Err(StartError(problem)),
        Err(store::Error::Database(error)) => {
            warn!(
                "recorder: the database cannot be reached ({error}); flights are kept in \
                 memory and written when it can"
            );
            false
        }
    };
    let (recorder, events) = Recorder::new(window_s);
    tokio::spawn(writer::run(
        db.clone(),
        events,
        prepared,
        writer::Limits::default(),
    ));
    tokio::spawn(writer::retain(db));
    Ok(recorder)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use atc_core::fixture;

    use super::*;
    use crate::sim::Feed;
    use crate::sim::replay::Replay;

    /// Everything a recorder said over `seconds` of the fixture's replay at
    /// `multiplier`, checking as it goes that nothing is from the future.
    fn record(multiplier: u32, seconds: u32) -> Vec<Event> {
        let mut replay = Replay::with_multiplier(fixture::recording(), multiplier).unwrap();
        let (mut recorder, mut events) = Recorder::new(fixture::WINDOW_S);
        let mut tick = Tick::default();
        let mut said = Vec::new();
        for _ in 0..seconds {
            replay.advance(&mut tick);
            recorder.observe(&tick);
            while let Ok(event) = events.try_recv() {
                let latest = match &event {
                    Event::Started(start) => start.sim_time_s,
                    Event::Ended(end) => end.sim_time_s,
                    Event::Track(batch) => {
                        batch.first_sample_sim_s
                            + (batch.samples.len() as u32 - 1) * SAMPLE_SPACING_S
                    }
                    Event::Sync(_) => 0,
                };
                assert!(
                    latest <= tick.sim_time_s,
                    "{event:?} at {}",
                    tick.sim_time_s
                );
                said.push(event);
            }
        }
        said
    }

    /// The samples recorded for each aircraft, by the sim time of each.
    fn tracks(events: &[Event]) -> BTreeMap<u32, BTreeMap<u32, Sample>> {
        let mut tracks: BTreeMap<u32, BTreeMap<u32, Sample>> = BTreeMap::new();
        for event in events {
            if let Event::Track(batch) = event {
                let track = tracks.entry(batch.aircraft_id).or_default();
                for (n, sample) in batch.samples.iter().enumerate() {
                    let time = batch.first_sample_sim_s + n as u32 * SAMPLE_SPACING_S;
                    assert!(track.insert(time, *sample).is_none(), "a sample twice");
                }
            }
        }
        tracks
    }

    #[test]
    fn a_whole_pass_records_every_flight_from_its_first_sample_to_its_last() {
        let recording = fixture::recording();
        // A pass and a little more, so the last flights have ended.
        let events = record(1, fixture::WINDOW_S + 20);
        let tracks = tracks(&events);

        let mut started = 0;
        for event in &events {
            let Event::Started(start) = event else {
                continue;
            };
            if start.pass != 0 {
                continue;
            }
            started += 1;
            // The fixture's callsigns are unique, so they name the flight.
            let flight = recording
                .flights
                .iter()
                .find(|flight| text(&flight.callsign).as_deref() == Some(&start.callsign))
                .expect("a flight of the recording");
            assert_eq!(start.icao24, flight.icao24);
            assert_eq!(start.sim_time_s, flight.start_s());
            assert_eq!(start.origin, text(&flight.origin));

            let ended = events.iter().find_map(|event| match event {
                Event::Ended(end) if end.aircraft_id == start.aircraft_id => Some(end),
                _ => None,
            });
            let ended = ended.expect("the flight ended");
            // A flight cut by the end of the window has its last sample
            // exactly there, which is the first second of the next pass:
            // the replay never shows it, so the last second flown is the
            // one before.
            let last_s = flight.end_s().min(fixture::WINDOW_S - 1);
            assert_eq!(ended.sim_time_s, last_s);

            // The whole track: every sample flown, at its time, exactly.
            let track = &tracks[&start.aircraft_id];
            let flown: Vec<(u32, &Sample)> = flight
                .samples
                .iter()
                .enumerate()
                .map(|(n, sample)| (flight.start_s() + n as u32 * SAMPLE_SPACING_S, sample))
                .filter(|(time, _)| *time <= last_s)
                .collect();
            assert_eq!(track.len(), flown.len(), "{}", start.callsign);
            for (time, sample) in flown {
                assert_eq!(
                    track.get(&time),
                    Some(sample),
                    "{} at {time}",
                    start.callsign
                );
            }
        }
        assert_eq!(started, recording.flights.len());
    }

    #[test]
    fn events_for_one_aircraft_come_in_order_start_tracks_end() {
        let events = record(1, fixture::WINDOW_S + 20);
        let mut state: HashMap<u32, &str> = HashMap::new();
        for event in &events {
            match event {
                Event::Started(start) => {
                    assert_eq!(state.insert(start.aircraft_id, "started"), None);
                }
                Event::Track(batch) => {
                    assert_eq!(state.get(&batch.aircraft_id), Some(&"started"));
                }
                Event::Ended(end) => {
                    assert_eq!(state.insert(end.aircraft_id, "ended"), Some("started"));
                }
                Event::Sync(_) => {}
            }
        }
    }

    #[test]
    fn a_batch_is_five_minutes_at_most_and_is_handed_over_on_the_five_minutes() {
        let events = record(1, 700);
        let batches: Vec<&TrackBatch> = events
            .iter()
            .filter_map(|event| match event {
                Event::Track(batch) => Some(batch),
                _ => None,
            })
            .collect();
        assert!(!batches.is_empty());
        for batch in &batches {
            assert!(batch.samples.len() <= (FLUSH_EVERY_S / SAMPLE_SPACING_S) as usize);
        }
        // An aircraft in the air from before 300 s to after 600 s has a
        // batch ending ten seconds before each.
        let ends: Vec<u32> = batches
            .iter()
            .map(|batch| {
                batch.first_sample_sim_s + (batch.samples.len() as u32 - 1) * SAMPLE_SPACING_S
            })
            .collect();
        assert!(ends.contains(&290));
        assert!(ends.contains(&590));
    }

    #[test]
    fn clones_are_not_recorded_so_a_multiplier_writes_the_same() {
        let counts = |events: &[Event]| {
            let mut counts = (0, 0, 0, 0);
            for event in events {
                match event {
                    Event::Started(_) => counts.0 += 1,
                    Event::Track(batch) => {
                        counts.1 += 1;
                        counts.2 += batch.samples.len();
                    }
                    Event::Ended(_) => counts.3 += 1,
                    Event::Sync(_) => {}
                }
            }
            counts
        };
        let seconds = fixture::WINDOW_S + 400;
        let one = counts(&record(1, seconds));
        assert!(one.0 > 0 && one.1 > 0);
        assert_eq!(counts(&record(3, seconds)), one);
        assert_eq!(counts(&record(7, seconds)), one);
    }

    #[test]
    fn a_new_pass_ends_the_old_flights_and_starts_new_ones_under_new_ids() {
        let events = record(1, 2 * fixture::WINDOW_S);
        let mut by_pass: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for event in &events {
            if let Event::Started(start) = event {
                by_pass
                    .entry(start.pass)
                    .or_default()
                    .push(start.aircraft_id);
            }
        }
        assert_eq!(by_pass.keys().copied().collect::<Vec<_>>(), [0, 1]);
        let first: std::collections::HashSet<_> = by_pass[&0].iter().collect();
        assert!(by_pass[&1].iter().all(|id| !first.contains(id)));
    }

    #[test]
    fn started_off_the_ten_second_grid_the_first_sample_is_the_next_on_it() {
        let mut replay = Replay::new(fixture::recording()).unwrap().starting_at(307);
        let (mut recorder, mut events) = Recorder::new(fixture::WINDOW_S);
        let mut tick = Tick::default();
        for _ in 0..30 {
            replay.advance(&mut tick);
            recorder.observe(&tick);
        }
        assert!(recorder.open_flights() > 0);
        // Nothing has reached 600 s, so no batch yet; the starts have gone.
        let mut starts = 0;
        while let Ok(event) = events.try_recv() {
            match event {
                Event::Started(start) => {
                    starts += 1;
                    assert_eq!(start.sim_time_s, 307);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(starts, recorder.open_flights());
        for open in recorder.open.values() {
            assert_eq!(open.first_sample_sim_s, 310);
            assert_eq!(open.samples.len(), 3);
        }
    }
}
