//! The feed that replays a recording, round and round.
//!
//! Where it is in the recording is sim time modulo the window. Each trip
//! through is a pass, and a flight coming round again is a new aircraft with
//! a new id.
//!
//! A stress multiplier above 1 flies every flight that many times over. The
//! first copy is the real one. The others are clones: each is a fixed number
//! of seconds ahead in the recording, set a little to one side, and flagged
//! as synthetic. A clone wraps when its own place in the recording does, so
//! the clones do not all restart together.

use std::fmt;

use atc_core::recording::{Flight, Recording};
use atc_core::wire::units::{degrees_from_wire, degrees_to_wire};
use atc_core::wire::{FLAG_SYNTHETIC, Metadata};

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

/// How one copy of a flight differs from the recording.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Shift {
    /// How far ahead in the recording the copy is, in seconds.
    time_s: u32,
    /// How far to the side it flies, in metres.
    east_m: i16,
    north_m: i16,
}

impl Shift {
    /// The shift of copy `copy` of flight `flight_id`, of `multiplier`.
    ///
    /// Copy 0 is the real flight and has none. Copy n is between n and n + 1
    /// parts of the window ahead, where a part is the window divided by the
    /// multiplier; where in that part depends on the flight, so the clones
    /// wrap at moments spread across the whole window. The numbers are fixed
    /// by the ids alone, so every run of the server makes the same clones.
    fn of(flight_id: u32, copy: u32, multiplier: u32, window_s: u32) -> Shift {
        if copy == 0 {
            return Shift::default();
        }
        let part = (window_s / multiplier).max(1);
        let bits = mix(u64::from(flight_id) << 32 | u64::from(copy));
        let within = |range: u64, bits: u64| (bits % range) as u32;
        let offset = |bits: u64| within(2 * MAX_OFFSET_M + 1, bits) as i64 - MAX_OFFSET_M as i64;
        Shift {
            time_s: (copy * part + within(u64::from(part), bits)) % window_s,
            east_m: offset(bits >> 16) as i16,
            north_m: offset(bits >> 40) as i16,
        }
    }
}

/// The furthest a clone flies to the east or north of its flight, in metres.
const MAX_OFFSET_M: u64 = 20_000;
/// Metres in a degree of latitude.
const METRES_PER_DEGREE: f64 = 111_320.0;

/// Scrambles a number into 64 well-spread bits (the SplitMix64 finaliser).
fn mix(mut bits: u64) -> u64 {
    bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    bits ^ (bits >> 31)
}

/// Replays a [`Recording`] held in memory.
#[derive(Debug)]
pub struct Replay {
    recording: Recording,
    /// Copies of each flight in the picture; 1 is the real picture alone.
    multiplier: u32,
    /// For each copy of each flight, flights within copies: how it is
    /// shifted, and the aircraft it is in the picture as, if it is.
    copies: Vec<(Shift, Option<Aircraft>)>,
    /// Sim time of the next tick.
    sim_time_s: u32,
    /// Aircraft ids count up from 1 and are never used twice.
    next_aircraft_id: u32,
}

impl Replay {
    /// A replay of the real picture that starts at the beginning of
    /// `recording`, at sim time 0.
    pub fn new(recording: Recording) -> Result<Replay, EmptyRecording> {
        Replay::with_multiplier(recording, 1)
    }

    /// A replay with `multiplier` copies of every flight: the real one and
    /// `multiplier - 1` clones.
    pub fn with_multiplier(
        recording: Recording,
        multiplier: u32,
    ) -> Result<Replay, EmptyRecording> {
        if recording.window_s == 0 || recording.flights.is_empty() {
            return Err(EmptyRecording);
        }
        let multiplier = multiplier.max(1);
        let flights = recording.flights.len() as u32;
        let copies = (0..multiplier)
            .flat_map(|copy| (0..flights).map(move |flight_id| (flight_id, copy)))
            .map(|(flight_id, copy)| {
                let shift = Shift::of(flight_id, copy, multiplier, recording.window_s);
                (shift, None)
            })
            .collect();
        Ok(Replay {
            copies,
            multiplier,
            recording,
            sim_time_s: 0,
            next_aircraft_id: 1,
        })
    }

    pub fn recording(&self) -> &Recording {
        &self.recording
    }

    pub fn multiplier(&self) -> u32 {
        self.multiplier
    }
}

impl Feed for Replay {
    fn advance(&mut self, tick: &mut Tick) {
        let window_s = self.recording.window_s;

        tick.sim_time_s = self.sim_time_s;
        // The real picture's pass. Clones start theirs at other times.
        tick.new_pass = self.sim_time_s > 0 && self.sim_time_s.is_multiple_of(window_s);
        tick.positions.clear();
        tick.appeared.clear();

        let flights = &self.recording.flights;
        let copies = self.copies.chunks_exact_mut(flights.len());
        for (copy, shifted) in copies.enumerate() {
            for (flight_id, (flight, (shift, aircraft))) in flights.iter().zip(shifted).enumerate()
            {
                // Where this copy is in the recording. u64, because sim time
                // plus a shift can pass u32 after 136 years less a window.
                let time = u64::from(self.sim_time_s) + u64::from(shift.time_s);
                let pass = (time / u64::from(window_s)) as u32;
                let second = (time % u64::from(window_s)) as u32;

                let Some(state) = flight.state_at(second) else {
                    *aircraft = None;
                    continue;
                };
                let id = match aircraft {
                    Some(aircraft) if aircraft.pass == pass => aircraft.id,
                    // It has just appeared, or it was flying when its last
                    // pass ended and is a new aircraft in this one.
                    _ => {
                        let id = self.next_aircraft_id;
                        self.next_aircraft_id += 1;
                        *aircraft = Some(Aircraft { id, pass });
                        tick.appeared
                            .push(metadata(id, flight_id as u32, flight, shift));
                        id
                    }
                };
                let mut position = state.position(id);
                if copy > 0 {
                    let lat = degrees_from_wire(position.lat);
                    let north = f64::from(shift.north_m) / METRES_PER_DEGREE;
                    let east =
                        f64::from(shift.east_m) / (METRES_PER_DEGREE * lat.to_radians().cos());
                    position.lat = degrees_to_wire(lat + north);
                    position.lon = degrees_to_wire(degrees_from_wire(position.lon) + east);
                    position.flags |= FLAG_SYNTHETIC;
                }
                tick.positions.push(position);
            }
        }

        self.sim_time_s += 1;
    }
}

/// What a client is told about the aircraft `aircraft_id`, which is flying
/// the recorded flight `flight_id`, shifted by `shift`.
fn metadata(aircraft_id: u32, flight_id: u32, flight: &Flight, shift: &Shift) -> Metadata {
    Metadata {
        aircraft_id,
        flight_id,
        icao24: flight.icao24,
        time_shift_s: shift.time_s,
        offset_east_m: shift.east_m,
        offset_north_m: shift.north_m,
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

    /// The copies of the fixture at `multiplier`, by aircraft id, as the
    /// metadata announces them over `seconds` ticks; and each tick.
    fn cloned(multiplier: u32, seconds: u32) -> (HashMap<u32, Metadata>, Vec<Tick>) {
        let mut replay = Replay::with_multiplier(fixture::recording(), multiplier).unwrap();
        let mut announced = HashMap::new();
        let mut ticks = Vec::new();
        let mut tick = Tick::default();
        for _ in 0..seconds {
            replay.advance(&mut tick);
            for metadata in &tick.appeared {
                assert!(announced.insert(metadata.aircraft_id, *metadata).is_none());
            }
            ticks.push(tick.clone());
        }
        (announced, ticks)
    }

    fn is_clone(metadata: &Metadata) -> bool {
        metadata.time_shift_s != 0 || metadata.offset_east_m != 0 || metadata.offset_north_m != 0
    }

    #[test]
    fn a_multiplier_of_one_is_the_real_picture() {
        let (announced, ticks) = cloned(1, fixture::WINDOW_S);
        assert!(!announced.values().any(is_clone));
        assert!(
            ticks
                .iter()
                .flat_map(|tick| &tick.positions)
                .all(|position| position.flags & FLAG_SYNTHETIC == 0)
        );
        // Zero is treated as one.
        let replay = Replay::with_multiplier(fixture::recording(), 0).unwrap();
        assert_eq!(replay.multiplier(), 1);
    }

    #[test]
    fn a_multiplier_puts_that_many_times_the_aircraft_in_the_picture() {
        let window = fixture::WINDOW_S as usize;
        let (_, real) = cloned(1, fixture::WINDOW_S);
        let (_, five) = cloned(5, fixture::WINDOW_S);

        // Clones are at other places in the recording, so the count at one
        // moment is not exactly five times; over a whole window it is.
        let total = |ticks: &[Tick]| ticks.iter().map(|t| t.positions.len()).sum::<usize>();
        assert_eq!(total(&five), 5 * total(&real));
        let mean = total(&five) / window;
        for (second, tick) in five.iter().enumerate() {
            let count = tick.positions.len();
            assert!(
                count.abs_diff(mean) < mean / 4,
                "{count} aircraft at {second} s"
            );
        }
    }

    #[test]
    fn clones_are_flagged_shifted_and_set_to_one_side() {
        let (announced, ticks) = cloned(4, fixture::WINDOW_S);
        let recording = fixture::recording();

        let mut clones = 0;
        for (second, tick) in ticks.iter().enumerate() {
            for position in &tick.positions {
                let metadata = &announced[&position.id];
                assert_eq!(
                    position.flags & FLAG_SYNTHETIC != 0,
                    is_clone(metadata),
                    "aircraft {}",
                    position.id
                );
                if !is_clone(metadata) {
                    continue;
                }
                clones += 1;

                // The clone is where its flight is, `time_shift_s` further on
                // in the recording, moved by the offset.
                let flight = &recording.flights[metadata.flight_id as usize];
                let at = (second as u32 + metadata.time_shift_s) % fixture::WINDOW_S;
                let source = flight
                    .state_at(at)
                    .expect("the flight is in the picture then");
                let (lat, lon) = lat_lon(position);
                let (source_lat, source_lon) =
                    (degrees_from_wire(source.lat), degrees_from_wire(source.lon));
                let north_m = (lat - source_lat) * METRES_PER_DEGREE;
                let east_m = (lon - source_lon) * METRES_PER_DEGREE * source_lat.to_radians().cos();
                assert!((north_m - f64::from(metadata.offset_north_m)).abs() < 1.0);
                assert!((east_m - f64::from(metadata.offset_east_m)).abs() < 1.0);
                assert_eq!(position.altitude, source.altitude);
                assert_eq!(position.track, source.track);
            }
        }
        assert!(clones > 0);

        for metadata in announced.values().filter(|m| is_clone(m)) {
            assert!(metadata.time_shift_s < fixture::WINDOW_S);
            assert!(i64::from(metadata.offset_east_m).unsigned_abs() <= MAX_OFFSET_M);
            assert!(i64::from(metadata.offset_north_m).unsigned_abs() <= MAX_OFFSET_M);
        }
    }

    /// Flight 0 is in the picture for the whole window, so each of its
    /// copies changes id exactly when that copy's place in the recording
    /// wraps. With eight copies those are eight different moments.
    #[test]
    fn clones_of_one_flight_wrap_at_different_times() {
        let multiplier = 8;
        let (announced, ticks) = cloned(multiplier, 2 * fixture::WINDOW_S);

        // For each time shift, the sim times at which a new aircraft flying
        // flight 0 with that shift is announced, after the first.
        let mut wraps: HashMap<u32, Vec<u32>> = HashMap::new();
        for tick in &ticks[1..] {
            for metadata in tick.appeared.iter().filter(|m| m.flight_id == 0) {
                wraps
                    .entry(metadata.time_shift_s)
                    .or_default()
                    .push(tick.sim_time_s);
            }
        }
        assert_eq!(wraps.len(), multiplier as usize, "one shift for each copy");
        for (shift, times) in &wraps {
            // A copy `shift` seconds ahead reaches the end of the recording
            // that much sooner, and again a window later.
            let first = if *shift == 0 {
                fixture::WINDOW_S
            } else {
                fixture::WINDOW_S - shift
            };
            let expected: Vec<u32> = (0..2)
                .map(|n| first + n * fixture::WINDOW_S)
                .filter(|&time| time < 2 * fixture::WINDOW_S)
                .collect();
            assert_eq!(times, &expected, "shift {shift}");
        }
        let moments: HashSet<u32> = wraps.values().map(|times| times[0]).collect();
        assert_eq!(moments.len(), multiplier as usize);

        // The eight shifts are spread over the window, one in each eighth.
        let part = fixture::WINDOW_S / multiplier;
        let parts: HashSet<u32> = wraps.keys().map(|shift| shift / part).collect();
        assert_eq!(parts.len(), multiplier as usize);
        assert!(announced.len() > multiplier as usize);
    }

    #[test]
    fn only_the_real_picture_starts_a_new_pass() {
        let (_, ticks) = cloned(6, 2 * fixture::WINDOW_S + 1);
        for tick in &ticks {
            let wrapped = tick.sim_time_s > 0 && tick.sim_time_s.is_multiple_of(fixture::WINDOW_S);
            assert_eq!(tick.new_pass, wrapped, "at {} s", tick.sim_time_s);
        }
    }

    #[test]
    fn the_same_clones_are_made_on_every_run() {
        let (_, one) = cloned(3, 50);
        let (_, two) = cloned(3, 50);
        assert_eq!(one, two);
    }

    /// The committed recording at multiplier 7. Run by name:
    /// `cargo test -p atc-server --release -- --ignored real_seed`
    #[test]
    #[ignore = "reads the 40 MB seed file"]
    fn the_real_seed_at_multiplier_seven_holds_fifty_thousand() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/seed/flights.bin.gz");
        let recording = crate::seed::load(&path).unwrap();
        let mut replay = Replay::with_multiplier(recording, 7).unwrap();
        let mut tick = Tick::default();
        for second in 0..600 {
            let started = std::time::Instant::now();
            replay.advance(&mut tick);
            let airborne = tick
                .positions
                .iter()
                .filter(|p| p.flags & atc_core::wire::FLAG_ON_GROUND == 0)
                .count();
            assert!(airborne > 50_000, "{airborne} airborne at {second} s");
            if second % 100 == 0 {
                println!(
                    "{second} s: {} in the picture, {airborne} airborne, advance took {:?}",
                    tick.positions.len(),
                    started.elapsed()
                );
            }
        }
    }
}
