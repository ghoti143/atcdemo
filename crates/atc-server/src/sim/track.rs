//! The track an aircraft has flown so far, worked out from the recording.
//!
//! Nothing is remembered as the simulator runs. An aircraft's metadata says
//! which recorded flight it is flying and how it is shifted, so its past is
//! read back out of the recording: the same way for a real aircraft and for
//! a stress clone, and without asking the simulator, which is busy ticking.

use std::sync::Arc;

use atc_core::recording::{Recording, SAMPLE_SPACING_S};
use atc_core::wire::units::{degrees_from_wire, degrees_to_wire};
use atc_core::wire::{FLAG_SYNTHETIC, Metadata, Position, TrackSample};

/// Metres in a degree of latitude.
pub(crate) const METRES_PER_DEGREE: f64 = 111_320.0;

/// Answers for the tracks of the aircraft that fly one recording. Cloning it
/// is cheap.
#[derive(Debug, Clone)]
pub struct Tracks {
    recording: Arc<Recording>,
}

impl Tracks {
    pub fn new(recording: Arc<Recording>) -> Tracks {
        Tracks { recording }
    }

    /// The track of the aircraft `metadata` describes, which appeared at
    /// sim time `appeared_s` and at `sim_time_s` is at `current`.
    ///
    /// The recorded samples it has flown past since it appeared come first,
    /// oldest first and [`SAMPLE_SPACING_S`] apart, and `current` is the
    /// last. Nothing in it is later than `sim_time_s`, and it is never
    /// empty.
    pub fn track(
        &self,
        metadata: &Metadata,
        appeared_s: u32,
        sim_time_s: u32,
        current: Position,
    ) -> Vec<TrackSample> {
        let id = current.id;
        let mut track = Vec::new();
        let flight = self.recording.flights.get(metadata.flight_id as usize);
        if let Some(flight) = flight
            && self.recording.window_s > 0
        {
            // Where the aircraft is in the recording. u64, as in the replay:
            // sim time plus a shift can pass u32.
            let time = u64::from(sim_time_s) + u64::from(metadata.time_shift_s);
            let second = (time % u64::from(self.recording.window_s)) as u32;
            // How long it has been flying. It became a new aircraft when its
            // place in the recording last wrapped, so never longer than that.
            let flown = sim_time_s.saturating_sub(appeared_s).min(second);

            let grid = (second - flown).div_ceil(SAMPLE_SPACING_S)..;
            let times = grid.map(|index| (index, index * SAMPLE_SPACING_S));
            // The sample at `second` itself is left to `current`.
            for (index, at) in times.take_while(|&(_, at)| at < second) {
                let Some(sample) = flight.sample_at(index) else {
                    continue;
                };
                let (lat, lon) = set_aside(
                    sample.lat,
                    sample.lon,
                    metadata.offset_east_m,
                    metadata.offset_north_m,
                );
                track.push(TrackSample {
                    id,
                    sim_time_s: sim_time_s - (second - at),
                    lat,
                    lon,
                    altitude: sample.altitude,
                    ground_speed: sample.ground_speed,
                    track: sample.track,
                    vertical_rate: sample.vertical_rate,
                    // A clone's samples are as synthetic as it is.
                    flags: sample.flags | current.flags & FLAG_SYNTHETIC,
                    barometric: sample.barometric,
                });
            }
        }
        track.push(TrackSample {
            id,
            sim_time_s,
            lat: current.lat,
            lon: current.lon,
            altitude: current.altitude,
            ground_speed: current.ground_speed,
            track: current.track,
            vertical_rate: current.vertical_rate,
            flags: current.flags,
            barometric: current.barometric,
        });
        track
    }
}

/// A place moved `east_m` metres east and `north_m` north, in the wire's
/// units. A clone flies this far to the side of its flight; the replay and
/// the tracks both use this, so a clone's track passes through the places
/// its positions were.
pub(crate) fn set_aside(lat: i32, lon: i32, east_m: i16, north_m: i16) -> (i32, i32) {
    if east_m == 0 && north_m == 0 {
        return (lat, lon);
    }
    let degrees = degrees_from_wire(lat);
    let north = f64::from(north_m) / METRES_PER_DEGREE;
    let east = f64::from(east_m) / (METRES_PER_DEGREE * degrees.to_radians().cos());
    (
        degrees_to_wire(degrees + north),
        degrees_to_wire(degrees_from_wire(lon) + east),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::sim::replay::Replay;
    use crate::sim::{Feed, Tick};
    use atc_core::fixture;
    use atc_core::geo::distance_nm;

    /// A replay of the fixture run up to and including `sim_time_s`, with
    /// every tick it produced.
    fn run_to(sim_time_s: u32) -> (Tracks, Vec<Tick>) {
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let tracks = replay.tracks();
        let mut tick = Tick::default();
        let mut ticks = Vec::new();
        for _ in 0..=sim_time_s {
            replay.advance(&mut tick);
            ticks.push(tick.clone());
        }
        (tracks, ticks)
    }

    /// The metadata of the aircraft flying `flight_id` at the last of
    /// `ticks`, and the sim time it appeared at.
    fn aircraft(ticks: &[Tick], flight_id: u32) -> (Metadata, u32) {
        let appeared = ticks.iter().rev().find_map(|tick| {
            let mut appeared = tick.appeared.iter();
            let metadata = appeared.find(|metadata| metadata.flight_id == flight_id)?;
            Some((*metadata, tick.sim_time_s))
        });
        appeared.expect("the flight has not appeared")
    }

    fn position(tick: &Tick, id: u32) -> Position {
        let mut positions = tick.positions.iter();
        *positions.find(|position| position.id == id).unwrap()
    }

    fn sample_of(position: Position, sim_time_s: u32) -> TrackSample {
        TrackSample {
            id: position.id,
            sim_time_s,
            lat: position.lat,
            lon: position.lon,
            altitude: position.altitude,
            ground_speed: position.ground_speed,
            track: position.track,
            vertical_rate: position.vertical_rate,
            flags: position.flags,
            barometric: position.barometric,
        }
    }

    /// The track of the aircraft flying `flight_id` at the last of `ticks`.
    fn track_of(tracks: &Tracks, ticks: &[Tick], flight_id: u32) -> Vec<TrackSample> {
        let (metadata, appeared_s) = aircraft(ticks, flight_id);
        let now = ticks.last().unwrap();
        let current = position(now, metadata.aircraft_id);
        tracks.track(&metadata, appeared_s, now.sim_time_s, current)
    }

    /// Flight 5 joins a minute in.
    #[test]
    fn a_track_is_where_the_aircraft_was_every_ten_seconds_and_where_it_is_now() {
        let (tracks, ticks) = run_to(307);
        let track = track_of(&tracks, &ticks, 5);
        let id = aircraft(&ticks, 5).0.aircraft_id;

        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        let mut expected: Vec<u32> = (60..=300).step_by(10).collect();
        expected.push(307);
        assert_eq!(times, expected);
        // Each sample is what the positions frame of its second held.
        for sample in &track {
            let then = position(&ticks[sample.sim_time_s as usize], id);
            assert_eq!(*sample, sample_of(then, sample.sim_time_s));
        }
    }

    #[test]
    fn on_a_sample_time_the_current_position_is_not_given_twice() {
        let (tracks, ticks) = run_to(300);
        let track = track_of(&tracks, &ticks, 5);

        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        assert_eq!(times, (60..=300).step_by(10).collect::<Vec<u32>>());
    }

    #[test]
    fn an_aircraft_that_has_just_appeared_has_a_track_of_one_sample() {
        let (tracks, ticks) = run_to(60);
        let track = track_of(&tracks, &ticks, 5);
        let id = aircraft(&ticks, 5).0.aircraft_id;

        assert_eq!(track, [sample_of(position(&ticks[60], id), 60)]);
    }

    /// Flight 0 flies the whole window, and is a new aircraft in each pass.
    #[test]
    fn a_track_starts_with_the_pass_the_aircraft_appeared_in() {
        let now = 2 * fixture::WINDOW_S + 25;
        let (tracks, ticks) = run_to(now);
        let track = track_of(&tracks, &ticks, 0);
        let id = aircraft(&ticks, 0).0.aircraft_id;

        let start = 2 * fixture::WINDOW_S;
        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        assert_eq!(times, [start, start + 10, start + 20, now]);
        for sample in &track {
            let then = position(&ticks[sample.sim_time_s as usize], id);
            assert_eq!(*sample, sample_of(then, sample.sim_time_s));
        }
    }

    /// No replay makes a clone yet, so this one is made by hand: flight 0,
    /// 400 s ahead in the recording and set to one side, which was already
    /// mid-flight when the simulator started.
    #[test]
    fn a_clone_has_the_track_of_its_flight_shifted_in_time_and_to_the_side() {
        let recording = fixture::recording();
        let tracks = Tracks::new(Arc::new(recording.clone()));
        let flight = &recording.flights[0];
        let metadata = Metadata {
            aircraft_id: 9,
            flight_id: 0,
            time_shift_s: 405,
            offset_east_m: 3_000,
            offset_north_m: -4_000,
            ..Metadata::default()
        };
        // At sim time 62 it is 467 s into the recording.
        let current = Position {
            id: 9,
            flags: FLAG_SYNTHETIC,
            ..flight.state_at(467).unwrap().position(9)
        };

        let track = tracks.track(&metadata, 0, 62, current);

        // The grid of the recording, not of sim time: 410 s is sim time 5.
        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        assert_eq!(times, [5, 15, 25, 35, 45, 55, 62]);
        assert_eq!(track[6], sample_of(current, 62));
        for (sample, second) in track[..6].iter().zip((410..).step_by(10)) {
            let recorded = flight.sample_at(second / SAMPLE_SPACING_S).unwrap();
            assert_eq!(sample.id, 9);
            assert_eq!(sample.altitude, recorded.altitude);
            assert_eq!(sample.barometric, recorded.barometric);
            assert_eq!(sample.flags, FLAG_SYNTHETIC);
            let degrees = |wire: i32| degrees_from_wire(wire);
            let (lat, lon) = (degrees(recorded.lat), degrees(recorded.lon));
            // 3 km east and 4 km south is 5 km away: 2.7 nm.
            let aside = distance_nm(lat, lon, degrees(sample.lat), degrees(sample.lon));
            assert!((aside - 5_000.0 / 1_852.0).abs() < 0.02, "{aside} nm");
            assert!(sample.lat < recorded.lat && sample.lon > recorded.lon);
        }

        // Its place in the recording wraps at sim time 795, and the aircraft
        // that carries on from there is a new one.
        let after = Metadata {
            aircraft_id: 10,
            ..metadata
        };
        let current = flight.state_at(27).unwrap().position(10);
        let track = tracks.track(&after, 795, 822, current);
        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        assert_eq!(times, [795, 805, 815, 822]);
    }

    #[test]
    fn an_aircraft_of_no_known_flight_still_has_its_current_position() {
        let tracks = Tracks::new(Arc::new(Recording::default()));
        let current = Position {
            id: 3,
            lat: 400_000_000,
            ..Position::default()
        };

        let track = tracks.track(&Metadata::default(), 0, 500, current);

        assert_eq!(track, [sample_of(current, 500)]);
    }

    /// With the clock started at 307 s, flights 0 and 5 are already flying.
    /// Through the world state, which is where the hub gets the second an
    /// aircraft appeared.
    #[test]
    fn a_track_never_starts_before_the_servers_clock_did() {
        use crate::world::WorldWriter;

        let start = 307;
        let mut replay = Replay::new(fixture::recording())
            .unwrap()
            .starting_at(start);
        let tracks = replay.tracks();
        let mut writer = WorldWriter::new();
        let reader = writer.reader();
        let mut tick = Tick::default();
        let mut ticks: Vec<Tick> = Vec::new();

        let mut lengths = Vec::new();
        for now in start..=start + 25 {
            replay.advance(&mut tick);
            writer.update(&tick);
            ticks.push(tick.clone());
            let world = reader.latest();
            assert_eq!(world.sim_time_s(), now);

            for flight_id in [0, 5] {
                let id = aircraft(&ticks, flight_id).0.aircraft_id;
                let row = world.row_of(id).unwrap();
                assert_eq!(world.appeared_s(row), start);
                let track = tracks.track(
                    world.metadata(row),
                    world.appeared_s(row),
                    world.sim_time_s(),
                    world.position(row),
                );

                // The grid seconds since the start, then now.
                let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
                let mut expected: Vec<u32> = (start..now).filter(|at| at % 10 == 0).collect();
                expected.push(now);
                assert_eq!(times, expected, "flight {flight_id} at {now} s");
                // Each sample is what the positions frame of its second held.
                for sample in &track {
                    let then = position(&ticks[(sample.sim_time_s - start) as usize], id);
                    assert_eq!(*sample, sample_of(then, sample.sim_time_s));
                }
                lengths.push(track.len());
            }
        }
        // One sample in the first tick; 310, 320, 330 and now in the last.
        assert_eq!(lengths[..2], [1, 1]);
        assert_eq!(lengths[lengths.len() - 2..], [4, 4]);
    }

    /// Clones too: one that was mid-flight at the start, and one that has
    /// wrapped since, have nothing from before the start or after now.
    #[test]
    fn a_clones_track_never_starts_before_the_servers_clock_did() {
        let start = fixture::WINDOW_S - 60;
        let mut replay = Replay::with_multiplier(fixture::recording(), 4)
            .unwrap()
            .starting_at(start);
        let tracks = replay.tracks();
        let mut tick = Tick::default();
        let mut known: HashMap<u32, (Metadata, u32)> = HashMap::new();
        let (mut from_the_start, mut later) = (0, 0);

        for now in start..start + 400 {
            replay.advance(&mut tick);
            for metadata in &tick.appeared {
                known.insert(metadata.aircraft_id, (*metadata, now));
            }
            for current in &tick.positions {
                let (metadata, appeared_s) = &known[&current.id];
                let track = tracks.track(metadata, *appeared_s, now, *current);

                let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
                assert!(times.is_sorted_by(|a, b| a < b));
                assert!(times[0] >= *appeared_s && *appeared_s >= start);
                assert!(times[0] < appeared_s + SAMPLE_SPACING_S);
                assert_eq!(*times.last().unwrap(), now);
                from_the_start += usize::from(*appeared_s == start && now > start + 20);
                later += usize::from(*appeared_s > start);
            }
        }
        assert!(from_the_start > 100 && later > 100);
    }

    /// An aircraft's metadata, when it appeared, and every position since.
    type Seen = (Metadata, u32, Vec<(u32, Position)>);

    /// Every position a clone has been sent at on a recording-grid second,
    /// since it appeared, is in its track, and nothing else is: through the
    /// moment its own place in the recording wraps and it becomes a new
    /// aircraft.
    #[test]
    fn a_real_clones_track_is_where_its_positions_were() {
        let mut replay = Replay::with_multiplier(fixture::recording(), 4).unwrap();
        let tracks = replay.tracks();
        let mut tick = Tick::default();
        // By aircraft id: its metadata, when it appeared, and every position.
        let mut seen: HashMap<u32, Seen> = HashMap::new();
        let mut checked = 0;
        let mut wrapped = 0;

        for sim_time_s in 0..2 * fixture::WINDOW_S {
            replay.advance(&mut tick);
            for metadata in &tick.appeared {
                seen.insert(metadata.aircraft_id, (*metadata, sim_time_s, Vec::new()));
            }
            for position in &tick.positions {
                let (metadata, appeared_s, history) = seen.get_mut(&position.id).unwrap();
                history.push((sim_time_s, *position));
                // Flight 0 spans the window; follow its clones only.
                if metadata.flight_id != 0 || metadata.time_shift_s == 0 || sim_time_s % 7 != 0 {
                    continue;
                }
                let track = tracks.track(metadata, *appeared_s, sim_time_s, *position);

                // The positions it had on the recording's grid, then now.
                let on_grid = |at: u32| {
                    ((at + metadata.time_shift_s) % fixture::WINDOW_S)
                        .is_multiple_of(SAMPLE_SPACING_S)
                };
                let mut expected: Vec<(u32, Position)> = history
                    .iter()
                    .filter(|(at, _)| *at < sim_time_s && on_grid(*at))
                    .copied()
                    .collect();
                expected.push((sim_time_s, *position));

                assert_eq!(track.len(), expected.len(), "aircraft {}", position.id);
                for (sample, (at, was)) in track.iter().zip(&expected) {
                    assert_eq!(sample.id, position.id);
                    assert_eq!(sample.sim_time_s, *at);
                    assert_eq!((sample.lat, sample.lon), (was.lat, was.lon));
                    assert_eq!(sample.altitude, was.altitude);
                    assert_eq!(sample.barometric, was.barometric);
                    assert_eq!(sample.flags, was.flags);
                    assert!(sample.flags & FLAG_SYNTHETIC != 0);
                }
                checked += 1;
                // A clone that appeared after the start has been through its
                // own wrap.
                wrapped += usize::from(*appeared_s > 0);
            }
        }
        assert!(
            checked > 100 && wrapped > 50,
            "{checked} checked, {wrapped} after a wrap"
        );
    }
}
