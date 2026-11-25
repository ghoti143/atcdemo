//! Recorded flights, as the simulator holds them in memory.
//!
//! The seed file reader and the test fixture both produce a [`Recording`],
//! and the simulator replays one without knowing which it was given.

use crate::wire::{FLAG_ON_GROUND, Position};

/// Seconds between one sample of a flight and the next.
pub const SAMPLE_SPACING_S: u32 = 10;

/// One flight's state at one moment, in the wire format's units (see
/// [`crate::wire::units`]), so a sample turns into a position record without
/// arithmetic. 16 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Sample {
    /// 1e-7 degrees.
    pub lat: i32,
    /// 1e-7 degrees.
    pub lon: i32,
    /// 25 ft.
    pub altitude: i16,
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
}

/// Every flight in one window of time. No sample falls outside the window.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recording {
    /// Length of the window in seconds; the replay wraps at this point.
    pub window_s: u32,
    pub flights: Vec<Flight>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_is_sixteen_bytes() {
        assert_eq!(size_of::<Sample>(), 16);
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
}
