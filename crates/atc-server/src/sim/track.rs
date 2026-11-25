//! The track an aircraft has flown so far, worked out from the recording.
//!
//! Nothing is remembered as the simulator runs. An aircraft's metadata says
//! which recorded flight it is flying and how it is shifted, so its past is
//! read back out of the recording: the same way for a real aircraft and for
//! a stress clone, and without asking the simulator, which is busy ticking.

use std::sync::Arc;

use atc_core::recording::{Recording, SAMPLE_SPACING_S, Sample};
use atc_core::wire::units::{degrees_from_wire, degrees_to_wire};
use atc_core::wire::{FLAG_SYNTHETIC, Metadata, Position, TrackSample};

/// Metres in a degree of latitude.
const METRES_PER_DEGREE: f64 = 111_320.0;

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
                let (lat, lon) = offset(sample, metadata);
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
        });
        track
    }
}

/// Where a sample is for the aircraft `metadata` describes: the recorded
/// place, moved by the aircraft's sideways offset if it has one.
fn offset(sample: &Sample, metadata: &Metadata) -> (i32, i32) {
    if metadata.offset_east_m == 0 && metadata.offset_north_m == 0 {
        return (sample.lat, sample.lon);
    }
    let lat = degrees_from_wire(sample.lat);
    let north = f64::from(metadata.offset_north_m) / METRES_PER_DEGREE;
    let east = f64::from(metadata.offset_east_m) / (METRES_PER_DEGREE * lat.to_radians().cos());
    (
        degrees_to_wire(lat + north),
        degrees_to_wire(degrees_from_wire(sample.lon) + east),
    )
}

#[cfg(test)]
mod tests {
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
}
