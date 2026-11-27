//! How a batch of track samples is stored in one `flight_tracks` row: the
//! seed file's difference encoding (docs/DESIGN.md section 5), for one
//! flight and one stretch of time.
//!
//! A row is eight columns one after another, each holding every sample of
//! the batch, with no lengths between them: the row's `sample_count` says
//! how many values each column has.
//!
//! | Column | Unit | Stored as |
//! |---|---|---|
//! | lat | 1e-5 degrees | second differences |
//! | lon | 1e-5 degrees | second differences |
//! | altitude | 25 ft | differences |
//! | barometric | 25 ft, less the altitude | differences |
//! | ground speed | knots | differences |
//! | track | whole degrees | differences, the short way round |
//! | vertical rate | 64 ft/min | differences |
//! | on ground | one bit a sample | bytes, lowest bit first |
//!
//! The first seven are signed variable-length integers: zigzag, then seven
//! bits to a byte, low bits first, the top bit set on every byte but the
//! last. The first value of a column is whole, so a row decodes alone.
//! "Second differences" stores the first value whole, the second as the
//! change, and each later one as the change in the change.
//!
//! The web app decodes the same bytes when it serves a flight's track; its
//! reader arrives with the flights API and shares the test vector below.

use atc_core::recording::Sample;
use atc_core::wire::FLAG_ON_GROUND;
use atc_core::wire::units::{track_from_wire, track_to_wire};

/// A sample holds lat and lon in 1e-7 degrees; a row in 1e-5.
const DEGREE_SCALE: i64 = 100;

fn put_varint(out: &mut Vec<u8>, value: i64) {
    let mut bits = ((value << 1) ^ (value >> 63)) as u64;
    while bits >= 0x80 {
        out.push((bits & 0x7f) as u8 | 0x80);
        bits >>= 7;
    }
    out.push(bits as u8);
}

/// A sample's lat or lon in the row's unit, rounded to the nearest.
fn degrees(wire: i32) -> i64 {
    (i64::from(wire) + DEGREE_SCALE / 2).div_euclid(DEGREE_SCALE)
}

/// A sample's track in whole degrees, 0 to 359.
fn whole_degrees(wire: u16) -> i64 {
    (track_from_wire(wire).round() as i64).rem_euclid(360)
}

/// Encodes `samples`, which are one flight's and 10 s apart, as one row.
pub fn encode(samples: &[Sample]) -> Vec<u8> {
    // About eight bytes a sample on the committed recording.
    let mut out = Vec::with_capacity(samples.len() * 9 + 8);

    let second_differences = |out: &mut Vec<u8>, value: fn(&Sample) -> i64| {
        let (mut previous, mut step) = (0, 0);
        for (n, sample) in samples.iter().enumerate() {
            let now = value(sample);
            match n {
                0 => put_varint(out, now),
                _ => {
                    put_varint(out, now - previous - step);
                    step = now - previous;
                }
            }
            previous = now;
        }
    };
    let differences = |out: &mut Vec<u8>, value: fn(&Sample) -> i64| {
        let mut previous = 0;
        for sample in samples {
            let now = value(sample);
            put_varint(out, now - previous);
            previous = now;
        }
    };

    second_differences(&mut out, |sample| degrees(sample.lat));
    second_differences(&mut out, |sample| degrees(sample.lon));
    differences(&mut out, |sample| i64::from(sample.altitude));
    differences(&mut out, |sample| {
        i64::from(sample.barometric) - i64::from(sample.altitude)
    });
    differences(&mut out, |sample| i64::from(sample.ground_speed));
    // Track: the first whole, then each turn the short way, -180 to 179.
    let mut previous = 0;
    for (n, sample) in samples.iter().enumerate() {
        let now = whole_degrees(sample.track);
        match n {
            0 => put_varint(&mut out, now),
            _ => put_varint(&mut out, (now - previous + 540).rem_euclid(360) - 180),
        }
        previous = now;
    }
    differences(&mut out, |sample| i64::from(sample.vertical_rate));
    for chunk in samples.chunks(8) {
        let mut byte = 0u8;
        for (bit, sample) in chunk.iter().enumerate() {
            if sample.on_ground() {
                byte |= 1 << bit;
            }
        }
        out.push(byte);
    }
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let (&first, rest) = self.bytes.split_first()?;
        self.bytes = rest;
        Some(first)
    }

    fn varint(&mut self) -> Option<i64> {
        let mut bits: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            bits |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Some((bits >> 1) as i64 ^ -((bits & 1) as i64));
            }
        }
        None
    }
}

/// Decodes a row of `count` samples. `None` if the bytes are not one: cut
/// short, too long, or holding a value no sample can.
pub fn decode(bytes: &[u8], count: usize) -> Option<Vec<Sample>> {
    let mut input = Reader { bytes };
    let mut samples = vec![Sample::default(); count];

    let mut column =
        |second_differences: bool, store: fn(&mut Sample, i64) -> Option<()>| -> Option<()> {
            let (mut value, mut step) = (0i64, 0i64);
            for (n, sample) in samples.iter_mut().enumerate() {
                let stored = input.varint()?;
                if n == 0 {
                    value = stored;
                } else if second_differences {
                    step = step.checked_add(stored)?;
                    value = value.checked_add(step)?;
                } else {
                    value = value.checked_add(stored)?;
                }
                store(sample, value)?;
            }
            Some(())
        };
    column(true, |sample, lat| {
        sample.lat = (lat.abs() <= 90 * 100_000).then_some((lat * DEGREE_SCALE) as i32)?;
        Some(())
    })?;
    column(true, |sample, lon| {
        sample.lon = (lon.abs() <= 180 * 100_000).then_some((lon * DEGREE_SCALE) as i32)?;
        Some(())
    })?;
    column(false, |sample, altitude| {
        sample.altitude = i16::try_from(altitude).ok()?;
        Some(())
    })?;
    column(false, |sample, difference| {
        sample.barometric = i16::try_from(i64::from(sample.altitude) + difference).ok()?;
        Some(())
    })?;
    column(false, |sample, speed| {
        sample.ground_speed = u16::try_from(speed).ok()?;
        Some(())
    })?;
    column(false, |sample, track| {
        sample.track = track_to_wire(track.rem_euclid(360) as f64);
        Some(())
    })?;
    column(false, |sample, rate| {
        sample.vertical_rate = i8::try_from(rate).ok()?;
        Some(())
    })?;
    for chunk in samples.chunks_mut(8) {
        let byte = input.u8()?;
        for (bit, sample) in chunk.iter_mut().enumerate() {
            if byte & (1 << bit) != 0 {
                sample.flags = FLAG_ON_GROUND;
            }
        }
    }
    input.bytes.is_empty().then_some(samples)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use atc_core::fixture;

    use super::*;

    fn sample(lat: i32, lon: i32, altitude: i16, track_degrees: f64) -> Sample {
        Sample {
            lat,
            lon,
            altitude,
            barometric: altitude - 12,
            ground_speed: 440,
            track: track_to_wire(track_degrees),
            vertical_rate: -3,
            flags: 0,
        }
    }

    /// A fixed vector, for the web app's reader to be tested against too.
    #[test]
    fn a_small_batch_encodes_to_known_bytes() {
        let samples = [
            sample(391_332_400, -777_028_900, 87, 277.0),
            sample(391_339_100, -777_103_800, 88, 276.0),
            Sample {
                flags: FLAG_ON_GROUND,
                ..sample(391_346_000, -777_180_500, 92, 2.0)
            },
        ];
        let row = encode(&samples);
        let hex: String = row.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "d8d9dd03860104e1c2b407d90b23ae010208170000f0060000aa0401ac0105000004"
        );
        assert_eq!(decode(&row, 3).unwrap(), samples);
    }

    #[test]
    fn every_flight_of_the_sample_recording_survives_whole_in_batches_of_thirty() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/sample/flights.bin.gz");
        let recording = crate::seed::load(&path).unwrap();
        let (mut samples, mut bytes) = (0, 0);
        for flight in &recording.flights {
            for batch in flight.samples.chunks(30) {
                let row = encode(batch);
                assert_eq!(decode(&row, batch.len()).as_deref(), Some(batch));
                samples += batch.len();
                bytes += row.len();
            }
        }
        // The design's estimate for the whole recording is 7.7.
        let per_sample = bytes as f64 / samples as f64;
        assert!(
            (5.0..11.0).contains(&per_sample),
            "{per_sample} bytes a sample"
        );
    }

    #[test]
    fn a_sample_off_the_rows_grid_comes_back_within_half_a_step() {
        // The fixture's positions are not multiples of 1e-5 degrees.
        for flight in &fixture::recording().flights {
            let row = encode(&flight.samples);
            let decoded = decode(&row, flight.samples.len()).unwrap();
            for (before, after) in flight.samples.iter().zip(&decoded) {
                assert!((before.lat - after.lat).abs() <= 50);
                assert!((before.lon - after.lon).abs() <= 50);
                assert_eq!(before.altitude, after.altitude);
                assert_eq!(before.barometric, after.barometric);
                assert_eq!(before.ground_speed, after.ground_speed);
                assert_eq!(before.vertical_rate, after.vertical_rate);
                assert_eq!(before.flags, after.flags);
                let turn = before.track.wrapping_sub(after.track) as i16;
                // Half a degree, in 360/65536 degrees.
                assert!(turn.abs() <= 92, "track off by {turn}");
            }
        }
    }

    #[test]
    fn a_turn_through_north_is_stored_the_short_way() {
        let samples = [
            sample(0, 0, 100, 359.0),
            sample(0, 0, 100, 1.0),
            sample(0, 0, 100, 358.0),
        ];
        let decoded = decode(&encode(&samples), 3).unwrap();
        assert_eq!(decoded, samples);
        // 359, then +2, then -3: two bytes for the first and one for each
        // turn. The long way round would be -358 and +357, two bytes each.
        let row = encode(&samples);
        assert!(
            row.windows(4)
                .any(|window| window == [0xce, 0x05, 0x04, 0x05])
        );
    }

    #[test]
    fn an_empty_batch_is_an_empty_row() {
        assert_eq!(encode(&[]), Vec::<u8>::new());
        assert_eq!(decode(&[], 0), Some(Vec::new()));
    }

    #[test]
    fn bytes_that_are_not_a_row_of_that_count_are_refused() {
        let row = encode(&[sample(1_000, 2_000, 3, 4.0), sample(1_100, 2_100, 3, 5.0)]);
        assert!(decode(&row, 2).is_some());
        assert_eq!(decode(&row, 3), None);
        assert_eq!(decode(&row, 1), None);
        assert_eq!(decode(&row[..row.len() - 1], 2), None);
        let mut longer = row.clone();
        longer.push(0);
        assert_eq!(decode(&longer, 2), None);
        // A latitude past the pole.
        let mut out = Vec::new();
        put_varint(&mut out, 91 * 100_000);
        out.extend([0; 7]);
        assert_eq!(decode(&out, 1), None);
    }
}
