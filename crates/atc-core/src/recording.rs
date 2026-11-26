//! Recorded flights, as the simulator holds them in memory.
//!
//! The seed file reader and the test fixture both produce a [`Recording`],
//! and the simulator replays one without knowing which it was given.

use crate::wire::{FLAG_ON_GROUND, Position};

/// Seconds between one sample of a flight and the next.
pub const SAMPLE_SPACING_S: u32 = 10;

/// One flight's state at one moment, in the wire format's units (see
/// [`crate::wire::units`]), so a sample turns into a position record without
/// arithmetic. 20 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sample {
    /// 1e-7 degrees.
    pub lat: i32,
    /// 1e-7 degrees.
    pub lon: i32,
    /// 25 ft above mean sea level.
    pub altitude: i16,
    /// 25 ft: barometric altitude, what the altimeter reads at standard
    /// pressure. Aircraft are separated by this one, so the conflict
    /// detector uses it.
    pub barometric: i16,
    /// Knots.
    pub ground_speed: u16,
    /// 360/65536 degrees.
    pub track: u16,
    /// 64 ft/min.
    pub vertical_rate: i8,
    /// [`FLAG_ON_GROUND`] only; the simulator adds the synthetic flag.
    pub flags: u8,
}

impl Sample {
    pub fn on_ground(&self) -> bool {
        self.flags & FLAG_ON_GROUND != 0
    }

    /// This sample as the position record of the aircraft `id`.
    pub fn position(&self, id: u32) -> Position {
        Position {
            id,
            lat: self.lat,
            lon: self.lon,
            altitude: self.altitude,
            ground_speed: self.ground_speed,
            track: self.track,
            vertical_rate: self.vertical_rate,
            flags: self.flags,
            barometric: self.barometric,
        }
    }

    /// The state `fraction` of the way from this sample to `next`, where 0
    /// is this sample and 1 is `next`. Track turns the short way round. The
    /// flags are this sample's.
    pub fn interpolate(&self, next: &Sample, fraction: f64) -> Sample {
        let mix = |from: f64, to: f64| (from + (to - from) * fraction).round();
        // The wrapped difference, read as signed, is the short way round.
        let turn = f64::from(next.track.wrapping_sub(self.track) as i16);
        Sample {
            lat: mix(f64::from(self.lat), f64::from(next.lat)) as i32,
            lon: mix(f64::from(self.lon), f64::from(next.lon)) as i32,
            altitude: mix(f64::from(self.altitude), f64::from(next.altitude)) as i16,
            barometric: mix(f64::from(self.barometric), f64::from(next.barometric)) as i16,
            ground_speed: mix(f64::from(self.ground_speed), f64::from(next.ground_speed)) as u16,
            track: self
                .track
                .wrapping_add((turn * fraction).round() as i16 as u16),
            vertical_rate: mix(f64::from(self.vertical_rate), f64::from(next.vertical_rate)) as i8,
            flags: self.flags,
        }
    }
}

/// One recorded flight: who it was, and where it was every
/// [`SAMPLE_SPACING_S`] seconds.
///
/// Its flight id is its index in [`Recording::flights`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Flight {
    pub icao24: u32,
    /// Space-padded ASCII, as are the next three.
    pub callsign: [u8; 8],
    pub aircraft_type: [u8; 4],
    pub origin: [u8; 4],
    pub destination: [u8; 4],
    /// Where the first sample falls on the window's grid: it was taken
    /// `first_sample × SAMPLE_SPACING_S` seconds into the window.
    pub first_sample: u32,
    pub samples: Vec<Sample>,
}

impl Flight {
    /// Seconds into the window of the first sample.
    pub fn start_s(&self) -> u32 {
        self.first_sample * SAMPLE_SPACING_S
    }

    /// Seconds into the window of the last sample.
    pub fn end_s(&self) -> u32 {
        let last = (self.samples.len() as u32).saturating_sub(1);
        (self.first_sample + last) * SAMPLE_SPACING_S
    }

    /// The sample taken `grid_index × SAMPLE_SPACING_S` seconds into the
    /// window, if the flight was in the picture then.
    pub fn sample_at(&self, grid_index: u32) -> Option<&Sample> {
        let index = grid_index.checked_sub(self.first_sample)?;
        self.samples.get(index as usize)
    }

    /// The flight's state `second` seconds into the window, interpolated
    /// between the samples either side, if the flight was in the picture
    /// then.
    pub fn state_at(&self, second: u32) -> Option<Sample> {
        let since_start = second.checked_sub(self.start_s())?;
        let index = (since_start / SAMPLE_SPACING_S) as usize;
        let before = self.samples.get(index)?;
        let into = since_start % SAMPLE_SPACING_S;
        if into == 0 {
            return Some(*before);
        }
        let after = self.samples.get(index + 1)?;
        let fraction = f64::from(into) / f64::from(SAMPLE_SPACING_S);
        Some(before.interpolate(after, fraction))
    }
}

/// Every flight in one window of time. Every sample is at or before
/// `window_s`: a flight cut by the end of the window may have its last
/// sample exactly there.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recording {
    /// Length of the window in seconds; the replay wraps at this point.
    pub window_s: u32,
    pub flights: Vec<Flight>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::units::{track_from_wire, track_to_wire};

    #[test]
    fn a_sample_is_twenty_bytes() {
        assert_eq!(size_of::<Sample>(), 20);
    }

    #[test]
    fn a_flight_knows_when_it_starts_and_ends() {
        let flight = Flight {
            first_sample: 6,
            samples: vec![Sample::default(); 4],
            ..Flight::default()
        };
        assert_eq!(flight.start_s(), 60);
        assert_eq!(flight.end_s(), 90);
        assert!(flight.sample_at(5).is_none());
        assert!(flight.sample_at(6).is_some());
        assert!(flight.sample_at(9).is_some());
        assert!(flight.sample_at(10).is_none());
    }

    #[test]
    fn a_sample_becomes_a_position_unchanged() {
        let sample = Sample {
            lat: 1,
            lon: -2,
            altitude: 3,
            barometric: 9,
            ground_speed: 4,
            track: 5,
            vertical_rate: -6,
            flags: FLAG_ON_GROUND,
        };
        let position = sample.position(77);
        assert_eq!(position.id, 77);
        assert_eq!(
            (position.lat, position.lon, position.altitude),
            (sample.lat, sample.lon, sample.altitude)
        );
        assert_eq!(position.barometric, sample.barometric);
        assert_eq!(
            (
                position.ground_speed,
                position.track,
                position.vertical_rate
            ),
            (sample.ground_speed, sample.track, sample.vertical_rate)
        );
        assert!(sample.on_ground() && position.flags == FLAG_ON_GROUND);
    }

    #[test]
    fn interpolation_is_linear_and_keeps_the_earlier_flags() {
        let from = Sample {
            lat: 100,
            lon: -100,
            altitude: 400,
            barometric: 410,
            ground_speed: 300,
            track: 0x4000,
            vertical_rate: 20,
            flags: FLAG_ON_GROUND,
        };
        let to = Sample {
            lat: 200,
            lon: -300,
            altitude: 380,
            barometric: 400,
            ground_speed: 310,
            track: 0x5000,
            vertical_rate: 0,
            flags: 0,
        };

        assert_eq!(from.interpolate(&to, 0.0), from);
        assert_eq!(
            from.interpolate(&to, 0.3),
            Sample {
                lat: 130,
                lon: -160,
                altitude: 394,
                barometric: 407,
                ground_speed: 303,
                track: 0x44CD,
                vertical_rate: 14,
                flags: FLAG_ON_GROUND,
            }
        );
        let end = from.interpolate(&to, 1.0);
        assert_eq!(
            end,
            Sample {
                flags: from.flags,
                ..to
            }
        );
    }

    #[test]
    fn track_is_interpolated_the_short_way_round() {
        let at = |degrees: f64| Sample {
            track: track_to_wire(degrees),
            ..Sample::default()
        };
        let track = |from: f64, to: f64, fraction| {
            track_from_wire(at(from).interpolate(&at(to), fraction).track)
        };

        // Through north, in both directions, and not the long way through
        // south.
        assert!((track(350.0, 10.0, 0.25) - 355.0).abs() < 0.01);
        assert!((track(350.0, 10.0, 0.75) - 5.0).abs() < 0.01);
        assert!((track(10.0, 350.0, 0.25) - 5.0).abs() < 0.01);
        assert!((track(10.0, 350.0, 0.75) - 355.0).abs() < 0.01);
        assert!((track(90.0, 180.0, 0.5) - 135.0).abs() < 0.01);
    }

    #[test]
    fn a_flight_has_a_state_every_second_it_is_in_the_picture() {
        let sample = |lat| Sample {
            lat,
            ..Sample::default()
        };
        let flight = Flight {
            first_sample: 6,
            samples: vec![sample(0), sample(100), sample(300)],
            ..Flight::default()
        };

        assert_eq!(flight.state_at(59), None);
        assert_eq!(flight.state_at(60), Some(sample(0)));
        assert_eq!(flight.state_at(63), Some(sample(30)));
        assert_eq!(flight.state_at(70), Some(sample(100)));
        assert_eq!(flight.state_at(79), Some(sample(280)));
        assert_eq!(flight.state_at(80), Some(sample(300)));
        assert_eq!(flight.state_at(81), None);
        assert_eq!(Flight::default().state_at(0), None);
    }
}
