//! Reads the seed file: the recorded flights the simulator replays.
//!
//! The format is written by the bake script, and `tools/seed/format.ts` and
//! section 5 of the design document describe it. In short: one gzip stream
//! holding a 20-byte header, a 32-byte record per flight, and eight columns
//! of samples stored as differences.

use std::fmt;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use atc_core::recording::{Flight, Recording, SAMPLE_SPACING_S, Sample};
use atc_core::wire::FLAG_ON_GROUND;
use atc_core::wire::units::track_to_wire;
use flate2::read::GzDecoder;

const MAGIC: &[u8; 4] = b"ATCS";
/// The format version this code reads.
const VERSION: u8 = 1;
const HEADER_SIZE: usize = 20;
const FLIGHT_SIZE: usize = 32;
/// The file gives lat and lon in 1e-5 degrees; a sample holds 1e-7 degrees.
const DEGREE_SCALE: i64 = 100;

/// Why a seed file could not be used.
#[derive(Debug)]
pub enum SeedError {
    /// The file is missing or cannot be read or decompressed.
    Io { path: PathBuf, source: io::Error },
    /// The file was read, but its contents are not a usable recording.
    Invalid { path: PathBuf, problem: Problem },
}

/// What is wrong with a seed file's contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    NotASeedFile,
    Version(u8),
    Spacing(u8),
    Truncated,
    NoFlights,
    /// A flight's samples, or a value in them, are outside what the format
    /// allows.
    Flight {
        id: usize,
        what: &'static str,
    },
    /// A column has bytes left after every flight's samples were read.
    ColumnTooLong,
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Problem::NotASeedFile => write!(f, "it is not a seed file"),
            Problem::Version(version) => write!(
                f,
                "it is format version {version}, and this server reads version {VERSION}"
            ),
            Problem::Spacing(spacing) => write!(
                f,
                "its samples are {spacing} s apart, and this server needs {SAMPLE_SPACING_S} s"
            ),
            Problem::Truncated => write!(f, "it is cut short"),
            Problem::NoFlights => write!(f, "it holds no flights"),
            Problem::Flight { id, what } => write!(f, "flight {id} {what}"),
            Problem::ColumnTooLong => write!(f, "a column is longer than its flights need"),
        }
    }
}

impl fmt::Display for SeedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SeedError::Io { path, source } => {
                write!(f, "cannot read the seed file {}: {source}", path.display())
            }
            SeedError::Invalid { path, problem } => {
                write!(f, "cannot use the seed file {}: {problem}", path.display())
            }
        }
    }
}

impl std::error::Error for SeedError {}

/// Reads and decodes the seed file at `path`.
pub fn load(path: &Path) -> Result<Recording, SeedError> {
    let io = |source| SeedError::Io {
        path: path.to_owned(),
        source,
    };
    let mut bytes = Vec::new();
    GzDecoder::new(File::open(path).map_err(io)?)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    decode(&bytes).map_err(|problem| SeedError::Invalid {
        path: path.to_owned(),
        problem,
    })
}

/// A position in the file's bytes, or in one column of them.
struct Cursor<'a> {
    bytes: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Problem> {
        if self.bytes.len() < count {
            return Err(Problem::Truncated);
        }
        let (taken, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Ok(taken)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Problem> {
        let mut array = [0; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }

    fn u8(&mut self) -> Result<u8, Problem> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, Problem> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    /// A signed integer: seven bits to a byte, low bits first, then zigzag.
    fn varint(&mut self) -> Result<i64, Problem> {
        let mut bits: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            bits |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok((bits >> 1) as i64 ^ -((bits & 1) as i64));
            }
        }
        // Ten bytes without an end: not a number the bake script wrote.
        Err(Problem::Truncated)
    }

    /// The next length-prefixed column.
    fn column(&mut self) -> Result<Cursor<'a>, Problem> {
        let length = self.u32()? as usize;
        Ok(Cursor {
            bytes: self.take(length)?,
        })
    }

    fn finish(&self) -> Result<(), Problem> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(Problem::ColumnTooLong)
        }
    }
}

/// Decodes a seed file's bytes, after decompression.
pub fn decode(bytes: &[u8]) -> Result<Recording, Problem> {
    let mut input = Cursor { bytes };
    if bytes.len() < MAGIC.len() || input.take(4)? != MAGIC {
        return Err(Problem::NotASeedFile);
    }
    let version = input.u8()?;
    if version != VERSION {
        return Err(Problem::Version(version));
    }
    let spacing = input.u8()?;
    if u32::from(spacing) != SAMPLE_SPACING_S {
        return Err(Problem::Spacing(spacing));
    }
    input.take(2)?; // reserved
    let _window_start = input.u32()?;
    let window_s = input.u32()?;
    let flight_count = input.u32()? as usize;
    if flight_count == 0 {
        return Err(Problem::NoFlights);
    }
    // Checked before anything is allocated from a count the file supplied.
    if bytes.len() < HEADER_SIZE + flight_count.saturating_mul(FLIGHT_SIZE) {
        return Err(Problem::Truncated);
    }

    let last_index = u64::from(window_s / SAMPLE_SPACING_S);
    let mut flights = Vec::with_capacity(flight_count);
    let mut total_samples: usize = 0;
    for id in 0..flight_count {
        let mut flight = Flight {
            icao24: input.u32()?,
            callsign: input.array()?,
            aircraft_type: input.array()?,
            origin: input.array()?,
            destination: input.array()?,
            first_sample: input.u32()?,
            samples: Vec::new(),
        };
        let count = input.u32()?;
        if count == 0 {
            return Err(Problem::Flight {
                id,
                what: "has no samples",
            });
        }
        if u64::from(flight.first_sample) + u64::from(count) - 1 > last_index {
            return Err(Problem::Flight {
                id,
                what: "has samples after the end of the window",
            });
        }
        // Every sample takes at least seven bytes, one in each number column.
        total_samples = total_samples.saturating_add(count as usize);
        if total_samples.saturating_mul(7) > bytes.len() {
            return Err(Problem::Truncated);
        }
        flight.samples = vec![Sample::default(); count as usize];
        flights.push(flight);
    }

    // Each column is read for every flight in turn. `store` puts one decoded
    // value into its sample, or says why it cannot.
    let mut numbers = |second_differences: bool,
                       wraps: bool,
                       store: fn(&mut Sample, i64) -> Result<(), &'static str>|
     -> Result<(), Problem> {
        let mut column = input.column()?;
        for (id, flight) in flights.iter_mut().enumerate() {
            let mut value: i64 = 0;
            let mut step: i64 = 0;
            for (n, sample) in flight.samples.iter_mut().enumerate() {
                let stored = column.varint()?;
                if n == 0 {
                    value = stored;
                } else if second_differences {
                    step = step.wrapping_add(stored);
                    value = value.wrapping_add(step);
                } else {
                    value = value.wrapping_add(stored);
                }
                if wraps {
                    value = value.rem_euclid(360);
                }
                store(sample, value).map_err(|what| Problem::Flight { id, what })?;
            }
        }
        column.finish()
    };

    numbers(true, false, |sample, lat| {
        sample.lat = degrees(lat, 90).ok_or("has a latitude out of range")?;
        Ok(())
    })?;
    numbers(true, false, |sample, lon| {
        sample.lon = degrees(lon, 180).ok_or("has a longitude out of range")?;
        Ok(())
    })?;
    numbers(false, false, |sample, altitude| {
        sample.altitude = i16::try_from(altitude).map_err(|_| "has an altitude out of range")?;
        Ok(())
    })?;
    // Stored as barometric altitude less the altitude above sea level.
    numbers(false, false, |sample, difference| {
        sample.barometric = i16::try_from(i64::from(sample.altitude) + difference)
            .map_err(|_| "has a barometric altitude out of range")?;
        Ok(())
    })?;
    numbers(false, false, |sample, speed| {
        sample.ground_speed = u16::try_from(speed).map_err(|_| "has a speed out of range")?;
        Ok(())
    })?;
    numbers(false, true, |sample, track| {
        sample.track = track_to_wire(track as f64);
        Ok(())
    })?;
    numbers(false, false, |sample, rate| {
        // The wire carries ±127 steps; the file may hold a little more.
        sample.vertical_rate = rate.clamp(-127, 127) as i8;
        Ok(())
    })?;

    let mut bits = input.column()?;
    for flight in &mut flights {
        for group in flight.samples.chunks_mut(8) {
            let byte = bits.u8()?;
            for (bit, sample) in group.iter_mut().enumerate() {
                if byte & (1 << bit) != 0 {
                    sample.flags = FLAG_ON_GROUND;
                }
            }
        }
    }
    bits.finish()?;

    Ok(Recording { window_s, flights })
}

/// 1e-5 degrees from the file as 1e-7 degrees, if within ±`limit` degrees.
fn degrees(value: i64, limit: i64) -> Option<i32> {
    if value.abs() > limit * 100_000 {
        return None;
    }
    i32::try_from(value * DEGREE_SCALE).ok()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use atc_core::wire::units::{
        altitude_from_wire, degrees_from_wire, text_from_wire, track_from_wire,
        vertical_rate_from_wire,
    };
    use flate2::{Compression, write::GzEncoder};

    use super::*;

    fn repo_file(path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path)
    }

    /// The values `bun run bake:tracks dump data/sample/flights.bin.gz` and
    /// `... dump data/sample/flights.bin.gz 0` print.
    #[test]
    fn reads_the_sample_seed_file() {
        let recording = load(&repo_file("data/sample/flights.bin.gz")).unwrap();
        assert_eq!(recording.window_s, 14_400);
        assert_eq!(recording.flights.len(), 39);

        let first = &recording.flights[0];
        assert_eq!(first.icao24, 0xa0a17b);
        assert_eq!(text_from_wire(&first.callsign), "N14MS");
        assert_eq!(text_from_wire(&first.aircraft_type), "C337");
        assert_eq!(text_from_wire(&first.origin), "");
        assert_eq!(first.first_sample, 0);
        assert_eq!(first.samples.len(), 383);

        // time_s,lat,lon,altitude_ft,barometric_ft,ground_speed_kt,track_deg,vertical_rate_fpm,on_ground
        let expected = [
            (39.13324, -77.70289, 2175.0, 1775.0, 130, 277.0, -128.0),
            (39.13391, -77.71038, 2200.0, 1800.0, 126, 276.0, 448.0),
            (39.13460, -77.71805, 2300.0, 1875.0, 121, 276.0, 192.0),
            (39.13520, -77.72516, 2350.0, 1925.0, 122, 276.0, 704.0),
        ];
        for (sample, (lat, lon, altitude, barometric, speed, track, rate)) in
            first.samples.iter().zip(expected)
        {
            assert!((degrees_from_wire(sample.lat) - lat).abs() < 1e-9);
            assert!((degrees_from_wire(sample.lon) - lon).abs() < 1e-9);
            assert_eq!(altitude_from_wire(sample.altitude), altitude);
            assert_eq!(altitude_from_wire(sample.barometric), barometric);
            assert_eq!(sample.ground_speed, speed);
            assert!((track_from_wire(sample.track) - track).abs() < 0.01);
            assert_eq!(vertical_rate_from_wire(sample.vertical_rate), rate);
            assert!(!sample.on_ground());
        }

        // 2,ac3be5,N888DN,SR22,,,310,831
        let third = &recording.flights[2];
        assert_eq!(third.icao24, 0xac3be5);
        assert_eq!(text_from_wire(&third.callsign), "N888DN");
        assert_eq!(third.start_s(), 310);
        assert_eq!(third.samples.len(), 831);

        for (id, flight) in recording.flights.iter().enumerate() {
            assert!(flight.end_s() <= recording.window_s, "flight {id}");
            assert!(flight.samples.iter().any(|s| !s.on_ground()), "flight {id}");
        }
        // The sample was chosen to include aircraft on the ground.
        assert!(
            recording
                .flights
                .iter()
                .any(|f| f.samples.iter().any(Sample::on_ground))
        );
    }

    /// A seed file's bytes, built by hand: one flight of three samples.
    fn small_seed() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"ATCS");
        bytes.extend_from_slice(&[1, 10, 0, 0]);
        bytes.extend_from_slice(&1_795_194_000u32.to_le_bytes());
        bytes.extend_from_slice(&600u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        // The flight record.
        bytes.extend_from_slice(&0xa1b2c3u32.to_le_bytes());
        bytes.extend_from_slice(b"JBU123  A320        ");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&3u32.to_le_bytes());
        // The same columns as the layout test in tools/seed/format.test.ts.
        let columns: [&[u8]; 8] = [
            &[200, 1, 20, 2], // lat: 100, 110, 121
            &[199, 1, 20, 0], // lon: -100, -90, -80
            &[80, 0, 4],      // altitude: 40, 40, 42
            &[19, 0, 2],      // barometric less altitude: -10, -10, -9
            &[244, 3, 1, 0],  // ground speed: 250, 249, 249
            &[206, 5, 4, 1],  // track: 359, 1, 0
            &[0, 4, 5],       // vertical rate: 0, 2, -1
            &[0b101],         // on ground: yes, no, yes
        ];
        for column in columns {
            bytes.extend_from_slice(&(column.len() as u32).to_le_bytes());
            bytes.extend_from_slice(column);
        }
        bytes
    }

    #[test]
    fn decodes_differences_and_second_differences() {
        let recording = decode(&small_seed()).unwrap();
        assert_eq!(recording.window_s, 600);
        let flight = &recording.flights[0];
        assert_eq!(flight.icao24, 0xa1b2c3);
        assert_eq!(&flight.callsign, b"JBU123  ");
        assert_eq!(&flight.aircraft_type, b"A320");
        assert_eq!(flight.first_sample, 2);

        let column = |f: fn(&Sample) -> i64| flight.samples.iter().map(f).collect::<Vec<_>>();
        assert_eq!(column(|s| s.lat.into()), [10_000, 11_000, 12_100]);
        assert_eq!(column(|s| s.lon.into()), [-10_000, -9_000, -8_000]);
        assert_eq!(column(|s| s.altitude.into()), [40, 40, 42]);
        assert_eq!(column(|s| s.barometric.into()), [30, 30, 33]);
        assert_eq!(column(|s| s.ground_speed.into()), [250, 249, 249]);
        assert_eq!(
            column(|s| s.track.into()),
            [359.0, 1.0, 0.0].map(|degrees| i64::from(track_to_wire(degrees)))
        );
        assert_eq!(column(|s| s.vertical_rate.into()), [0, 2, -1]);
        assert_eq!(column(|s| s.on_ground().into()), [1, 0, 1]);
    }

    #[test]
    fn refuses_what_is_not_a_seed_file() {
        assert_eq!(decode(b"").err(), Some(Problem::NotASeedFile));
        assert_eq!(
            decode(b"icao24,callsign,type\n").err(),
            Some(Problem::NotASeedFile)
        );
    }

    #[test]
    fn refuses_another_version_and_another_spacing() {
        let mut bytes = small_seed();
        bytes[4] = 2;
        assert_eq!(decode(&bytes).err(), Some(Problem::Version(2)));

        let mut bytes = small_seed();
        bytes[5] = 15;
        assert_eq!(decode(&bytes).err(), Some(Problem::Spacing(15)));
    }

    #[test]
    fn refuses_a_file_cut_short_anywhere() {
        let bytes = small_seed();
        for length in 4..bytes.len() {
            assert_eq!(
                decode(&bytes[..length]).err(),
                Some(Problem::Truncated),
                "cut to {length} bytes"
            );
        }
    }

    #[test]
    fn refuses_a_file_with_no_flights() {
        let mut bytes = small_seed();
        bytes[16..20].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&bytes).err(), Some(Problem::NoFlights));
    }

    #[test]
    fn refuses_samples_outside_the_window() {
        // Samples 58, 59 and 60 of a 600 s window are the last that fit.
        let mut bytes = small_seed();
        bytes[44..48].copy_from_slice(&58u32.to_le_bytes());
        assert!(decode(&bytes).is_ok());

        bytes[44..48].copy_from_slice(&59u32.to_le_bytes());
        assert_eq!(
            decode(&bytes).err(),
            Some(Problem::Flight {
                id: 0,
                what: "has samples after the end of the window"
            })
        );
    }

    #[test]
    fn refuses_a_position_off_the_globe() {
        let mut bytes = small_seed();
        // Latitude 100: 10,000,000 in 1e-5 degrees, as a zigzag varint.
        let column = [0x80, 0xda, 0xc4, 0x09];
        bytes[56..60].copy_from_slice(&column);
        assert_eq!(
            decode(&bytes).err(),
            Some(Problem::Flight {
                id: 0,
                what: "has a latitude out of range"
            })
        );
    }

    #[test]
    fn refuses_a_column_with_bytes_left_over() {
        let mut bytes = small_seed();
        // Give the last column a second byte.
        let length_at = bytes.len() - 5;
        bytes[length_at..length_at + 4].copy_from_slice(&2u32.to_le_bytes());
        bytes.push(0);
        assert_eq!(decode(&bytes).err(), Some(Problem::ColumnTooLong));
    }

    #[test]
    fn a_missing_file_is_named_in_the_error() {
        let path = repo_file("data/seed/no-such-file.bin.gz");
        let message = load(&path).unwrap_err().to_string();
        assert!(
            message.starts_with("cannot read the seed file"),
            "{message}"
        );
        assert!(message.contains("no-such-file.bin.gz"), "{message}");
    }

    #[test]
    fn an_unusable_file_is_named_with_the_reason() {
        let dir = std::env::temp_dir();
        let cases: [(&str, Vec<u8>, &str); 3] = [
            (
                "not-gzip",
                b"plain text".to_vec(),
                "cannot read the seed file",
            ),
            ("not-a-seed", gzip(b"plain text"), "it is not a seed file"),
            (
                "empty",
                gzip(&{
                    let mut bytes = small_seed();
                    bytes[16..20].copy_from_slice(&0u32.to_le_bytes());
                    bytes
                }),
                "it holds no flights",
            ),
        ];
        for (name, contents, expected) in cases {
            let path = dir.join(format!(
                "atc-seed-test-{}-{name}.bin.gz",
                std::process::id()
            ));
            std::fs::write(&path, contents).unwrap();
            let message = load(&path).unwrap_err().to_string();
            std::fs::remove_file(&path).unwrap();

            assert!(message.contains(expected), "{message}");
            assert!(message.contains(path.to_str().unwrap()), "{message}");
        }
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// The committed recording, all of it. Slow in a debug build, so it is
    /// run by name: `cargo test -p atc-server --release -- --ignored real_seed`
    #[test]
    #[ignore = "reads the 40 MB seed file"]
    fn reads_the_real_seed_file() {
        let recording = load(&repo_file("data/seed/flights.bin.gz")).unwrap();
        assert_eq!(recording.window_s, 14_400);
        assert_eq!(recording.flights.len(), 39_716);
        let samples: usize = recording.flights.iter().map(|f| f.samples.len()).sum();
        assert_eq!(samples, 12_560_536);
    }
}
