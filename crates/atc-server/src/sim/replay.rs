//! The feed that replays a recording, round and round.
//!
//! Where it is in the recording is sim time modulo the window. Each trip
//! through is a pass, and a flight coming round again is a new aircraft with
//! a new id.

use std::fmt;

use atc_core::recording::{Flight, Recording};
use atc_core::wire::Metadata;

use super::{Feed, Tick};

/// A recording with no flights or no window, which cannot be replayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyRecording;

impl fmt::Display for EmptyRecording {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the recording holds no flights")
    }
}

impl std::error::Error for EmptyRecording {}

/// The aircraft a flight is flying as at the moment.
#[derive(Debug, Clone, Copy)]
struct Aircraft {
    id: u32,
    /// The pass it was given its id in.
    pass: u32,
}

/// Replays a [`Recording`] held in memory.
#[derive(Debug)]
pub struct Replay {
    recording: Recording,
    /// By flight id: the aircraft the flight is in the picture as, if it is.
    aircraft: Vec<Option<Aircraft>>,
    /// Sim time of the next tick.
    sim_time_s: u32,
    /// Aircraft ids count up from 1 and are never used twice.
    next_aircraft_id: u32,
}

impl Replay {
    /// A replay that starts at the beginning of `recording`, at sim time 0.
    pub fn new(recording: Recording) -> Result<Replay, EmptyRecording> {
        if recording.window_s == 0 || recording.flights.is_empty() {
            return Err(EmptyRecording);
        }
        Ok(Replay {
            aircraft: vec![None; recording.flights.len()],
            recording,
            sim_time_s: 0,
            next_aircraft_id: 1,
        })
    }

    pub fn recording(&self) -> &Recording {
        &self.recording
    }
}

impl Feed for Replay {
    fn advance(&mut self, tick: &mut Tick) {
        let window_s = self.recording.window_s;
        let pass = self.sim_time_s / window_s;
        let second = self.sim_time_s % window_s;

        tick.sim_time_s = self.sim_time_s;
        tick.new_pass = pass > 0 && second == 0;
        tick.positions.clear();
        tick.appeared.clear();

        let flights = self.recording.flights.iter().zip(&mut self.aircraft);
        for (flight_id, (flight, aircraft)) in flights.enumerate() {
            let Some(state) = flight.state_at(second) else {
                *aircraft = None;
                continue;
            };
            let id = match aircraft {
                Some(aircraft) if aircraft.pass == pass => aircraft.id,
                // It has just appeared, or it was flying when the last pass
                // ended and is a new aircraft in this one.
                _ => {
                    let id = self.next_aircraft_id;
                    self.next_aircraft_id += 1;
                    *aircraft = Some(Aircraft { id, pass });
                    tick.appeared.push(metadata(id, flight_id as u32, flight));
                    id
                }
            };
            tick.positions.push(state.position(id));
        }

        self.sim_time_s += 1;
    }
}

/// What a client is told about the aircraft `aircraft_id`, which is flying
/// the recorded flight `flight_id`.
fn metadata(aircraft_id: u32, flight_id: u32, flight: &Flight) -> Metadata {
    Metadata {
        aircraft_id,
        flight_id,
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

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;
    use atc_core::fixture::{self, CONFLICT_LAT, CONFLICT_LON, CONFLICT_PAIR, CONFLICT_TIME_S};
    use atc_core::geo::distance_nm;
    use atc_core::recording::{SAMPLE_SPACING_S, Sample};
    use atc_core::wire::Position;
    use atc_core::wire::units::{altitude_from_wire, degrees_from_wire, text_to_wire};

    /// A replay of the fixture, and every tick it has produced so far.
    struct Run {
        replay: Replay,
        ticks: Vec<Tick>,
        /// Flight id by aircraft id, from the metadata.
        flight_of: HashMap<u32, usize>,
    }

    impl Run {
        fn new() -> Run {
            Run {
                replay: Replay::new(fixture::recording()).unwrap(),
                ticks: Vec::new(),
                flight_of: HashMap::new(),
            }
        }

        /// Runs up to and including the tick at `sim_time_s`.
        fn to(mut self, sim_time_s: u32) -> Run {
            let mut tick = Tick::default();
            while self.ticks.len() <= sim_time_s as usize {
                self.replay.advance(&mut tick);
                for metadata in &tick.appeared {
                    let before = self
                        .flight_of
                        .insert(metadata.aircraft_id, metadata.flight_id as usize);
                    assert_eq!(before, None, "aircraft id {} reused", metadata.aircraft_id);
                }
                self.ticks.push(tick.clone());
            }
            self
        }

        fn flight(&self, flight_id: usize) -> &Flight {
            &self.replay.recording().flights[flight_id]
        }

        /// Where the flight is at `sim_time_s`, if it is in the picture.
        fn position(&self, sim_time_s: u32, flight_id: usize) -> Option<Position> {
            self.ticks[sim_time_s as usize]
                .positions
                .iter()
                .copied()
                .find(|position| self.flight_of[&position.id] == flight_id)
        }
    }

    fn lat_lon(position: &Position) -> (f64, f64) {
        (
            degrees_from_wire(position.lat),
            degrees_from_wire(position.lon),
        )
    }

    #[test]
    fn a_recording_with_nothing_to_replay_is_refused() {
        assert_eq!(
            Replay::new(Recording::default()).err(),
            Some(EmptyRecording)
        );
        let no_window = Recording {
            window_s: 0,
            ..fixture::recording()
        };
        assert_eq!(Replay::new(no_window).err(), Some(EmptyRecording));
    }

    #[test]
    fn on_a_sample_time_every_flight_is_at_its_sample() {
        let run = Run::new().to(fixture::WINDOW_S - 1);

        for second in (0..fixture::WINDOW_S).step_by(SAMPLE_SPACING_S as usize) {
            let tick = &run.ticks[second as usize];
            let mut in_the_picture = 0;
            for (flight_id, flight) in run.replay.recording().flights.iter().enumerate() {
                let sample = flight.sample_at(second / SAMPLE_SPACING_S);
                let position = run.position(second, flight_id);
                assert_eq!(
                    position.map(|position| Sample {
                        lat: position.lat,
                        lon: position.lon,
                        altitude: position.altitude,
                        ground_speed: position.ground_speed,
                        track: position.track,
                        vertical_rate: position.vertical_rate,
                        flags: position.flags,
                    }),
                    sample.copied(),
                    "flight {flight_id} at {second} s"
                );
                in_the_picture += usize::from(sample.is_some());
            }
            assert_eq!(tick.positions.len(), in_the_picture, "at {second} s");
        }
    }

    #[test]
    fn the_pair_meets_where_and_when_the_fixture_says() {
        let run = Run::new().to(CONFLICT_TIME_S);
        let east = run.position(CONFLICT_TIME_S, CONFLICT_PAIR.0).unwrap();
        let north = run.position(CONFLICT_TIME_S, CONFLICT_PAIR.1).unwrap();

        for position in [east, north] {
            let (lat, lon) = lat_lon(&position);
            let miss = distance_nm(lat, lon, CONFLICT_LAT, CONFLICT_LON);
            assert!(miss < 0.5, "{miss} nm from the meeting point");
            assert_eq!(altitude_from_wire(position.altitude), 41_000.0);
        }
    }

    /// Flight 0 flies east at 480 knots, which is 0.1333 nm a second.
    #[test]
    fn between_samples_a_flight_moves_at_its_speed() {
        let run = Run::new().to(140);
        let at = |second| lat_lon(&run.position(second, 0).unwrap());

        let (start_lat, start_lon) = at(100);
        for second in 101..=140 {
            let (lat, lon) = at(second);
            let (before_lat, before_lon) = at(second - 1);
            let step = distance_nm(before_lat, before_lon, lat, lon);
            assert!((step - 480.0 / 3_600.0).abs() < 0.001, "{second} s: {step}");
            assert!(lon > before_lon, "{second} s: not eastbound");

            let flown = distance_nm(start_lat, start_lon, lat, lon);
            let expected = 480.0 * f64::from(second - 100) / 3_600.0;
            assert!((flown - expected).abs() < 0.005, "{second} s: {flown}");
        }
    }

    /// Flight 20 starts on the ground and climbs away; its height between
    /// samples lies between the heights of the samples either side.
    #[test]
    fn between_samples_a_climbing_flight_is_between_their_heights() {
        let run = Run::new().to(300);
        let flight = run.flight(20);

        for second in flight.start_s()..300 {
            let grid = second / SAMPLE_SPACING_S;
            let below = flight.sample_at(grid).unwrap();
            let above = flight.sample_at(grid + 1).unwrap();
            let position = run.position(second, 20).unwrap();
            assert!(
                (below.altitude..=above.altitude).contains(&position.altitude),
                "{second} s: {} outside {}..={}",
                position.altitude,
                below.altitude,
                above.altitude
            );
            assert_eq!(position.flags, below.flags, "{second} s");
        }
    }

    #[test]
    fn flights_appear_and_vanish_at_their_own_times() {
        let run = Run::new().to(fixture::WINDOW_S - 1);

        for (flight_id, flight) in run.replay.recording().flights.iter().enumerate() {
            for second in 0..fixture::WINDOW_S {
                let expected = (flight.start_s()..=flight.end_s()).contains(&second);
                assert_eq!(
                    run.position(second, flight_id).is_some(),
                    expected,
                    "flight {flight_id} at {second} s"
                );
            }
        }
        // Flight 5 joins a minute in, and is announced in that tick only.
        assert_eq!(run.flight(5).start_s(), 60);
        let announced: Vec<u32> = (0..fixture::WINDOW_S)
            .filter(|&second| {
                run.ticks[second as usize]
                    .appeared
                    .iter()
                    .any(|metadata| metadata.flight_id == 5)
            })
            .collect();
        assert_eq!(announced, [60]);
    }

    #[test]
    fn metadata_names_the_flight_behind_an_aircraft() {
        let run = Run::new().to(0);
        let position = run.position(0, 1).unwrap();
        let metadata = run.ticks[0]
            .appeared
            .iter()
            .find(|metadata| metadata.aircraft_id == position.id)
            .unwrap();

        assert_eq!(
            *metadata,
            Metadata {
                aircraft_id: position.id,
                flight_id: 1,
                icao24: 0xF0_0001,
                time_shift_s: 0,
                offset_east_m: 0,
                offset_north_m: 0,
                callsign: text_to_wire("FIX001"),
                aircraft_type: text_to_wire("A320"),
                origin: text_to_wire(""),
                destination: text_to_wire(""),
            }
        );
    }

    #[test]
    fn sim_time_never_goes_back_and_only_a_wrap_starts_a_pass() {
        let run = Run::new().to(3 * fixture::WINDOW_S + 5);

        for (index, tick) in run.ticks.iter().enumerate() {
            assert_eq!(tick.sim_time_s as usize, index);
            let wrapped = index > 0 && (index as u32).is_multiple_of(fixture::WINDOW_S);
            assert_eq!(tick.new_pass, wrapped, "at {index} s");
        }
    }

    #[test]
    fn every_pass_flies_the_same_picture_with_new_ids() {
        let run = Run::new().to(3 * fixture::WINDOW_S - 1);
        let window = fixture::WINDOW_S as usize;
        let ids = |tick: &Tick| -> HashSet<u32> { tick.positions.iter().map(|p| p.id).collect() };
        let without_ids = |tick: &Tick| -> Vec<Position> {
            let unnumbered = |p: &Position| Position { id: 0, ..*p };
            tick.positions.iter().map(unnumbered).collect()
        };

        let mut seen_in_earlier_passes = HashSet::new();
        for pass in 0..3 {
            let ticks = &run.ticks[pass * window..(pass + 1) * window];
            let mut seen = HashSet::new();
            for (second, tick) in ticks.iter().enumerate() {
                assert_eq!(
                    without_ids(tick),
                    without_ids(&run.ticks[second]),
                    "pass {pass} at {second} s"
                );
                seen.extend(ids(tick));
            }
            // One aircraft for each flight, and none from an earlier pass.
            assert_eq!(seen.len(), run.replay.recording().flights.len());
            assert!(seen.is_disjoint(&seen_in_earlier_passes), "pass {pass}");
            seen_in_earlier_passes.extend(seen);
        }
    }

    /// Flight 0 is in the picture for the whole window, so it is flying both
    /// just before the wrap and just after it.
    #[test]
    fn a_flight_that_spans_the_wrap_changes_id_there() {
        let run = Run::new().to(fixture::WINDOW_S + 1);
        let id = |second| run.position(second, 0).unwrap().id;
        let last = fixture::WINDOW_S - 1;

        assert_eq!(run.flight(0).end_s(), fixture::WINDOW_S);
        assert_eq!(id(0), id(last));
        assert_ne!(id(last), id(last + 1));
        assert_eq!(id(last + 1), id(last + 2));
        // It is announced again, as the new aircraft.
        assert!(
            run.ticks[fixture::WINDOW_S as usize]
                .appeared
                .iter()
                .any(|metadata| metadata.aircraft_id == id(last + 1) && metadata.flight_id == 0)
        );
    }

    #[test]
    fn the_last_seconds_of_the_window_lead_up_to_a_sample_at_its_end() {
        let run = Run::new().to(fixture::WINDOW_S - 1);
        let flight = run.flight(0);
        let last = flight.samples.last().unwrap();
        let (end_lat, end_lon) = (degrees_from_wire(last.lat), degrees_from_wire(last.lon));

        let (lat, lon) = lat_lon(&run.position(fixture::WINDOW_S - 1, 0).unwrap());
        let to_go = distance_nm(lat, lon, end_lat, end_lon);
        assert!((to_go - 480.0 / 3_600.0).abs() < 0.001, "{to_go}");
    }
}
