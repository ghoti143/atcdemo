//! The binary frame format the server sends to clients.
//!
//! A frame is a 24-byte header followed by `count` fixed-size records, all
//! little-endian. Every field sits on its natural alignment, so a browser can
//! also read a frame through typed-array views.
//!
//! The header carries the record size. A reader built against an older
//! version of a record reads the fields it knows from the front of each
//! record and steps over the rest, so fields can be appended to a record
//! without breaking it.
//!
//! Records hold the integers that go on the wire. [`units`] converts between
//! those and degrees, feet, knots and feet per minute.

use std::fmt;

use crate::PROTOCOL_VERSION;

/// Size of the frame header in bytes.
pub const HEADER_SIZE: usize = 24;

/// Header flag: this is the first frame of a new pass through the recording.
pub const FRAME_NEW_PASS: u32 = 1 << 0;

/// Position and track flag: the aircraft is on the ground.
pub const FLAG_ON_GROUND: u8 = 1 << 0;
/// Position and track flag: the aircraft is a stress-mode clone.
pub const FLAG_SYNTHETIC: u8 = 1 << 1;

/// What a frame's records are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    Positions = 1,
    Metadata = 2,
    Alerts = 3,
    Track = 4,
}

impl FrameKind {
    fn from_u8(value: u8) -> Option<FrameKind> {
        match value {
            1 => Some(FrameKind::Positions),
            2 => Some(FrameKind::Metadata),
            3 => Some(FrameKind::Alerts),
            4 => Some(FrameKind::Track),
            _ => None,
        }
    }
}

/// The frame header.
///
/// | Offset | Field | Type |
/// |---|---|---|
/// | 0 | version | u8 |
/// | 1 | kind | u8 |
/// | 2 | record size | u16 |
/// | 4 | seq | u32 |
/// | 8 | sim time | f64 |
/// | 16 | count | u32 |
/// | 20 | flags | u32 |
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Header {
    pub version: u8,
    pub kind: FrameKind,
    /// Bytes per record in this frame.
    pub record_size: u16,
    /// Per connection; a gap means the client skipped a frame.
    pub seq: u32,
    /// Milliseconds; never decreases.
    pub sim_time_ms: f64,
    pub count: u32,
    pub flags: u32,
}

impl Header {
    /// Whether this is the first frame of a new pass.
    pub fn is_new_pass(&self) -> bool {
        self.flags & FRAME_NEW_PASS != 0
    }
}

/// A fixed-size record that can go in a frame.
pub trait Record: Sized {
    const KIND: FrameKind;
    /// Bytes this version of the record occupies.
    const SIZE: usize;

    /// Writes the record into `out`, which is exactly [`Self::SIZE`] bytes.
    fn write(&self, out: &mut [u8]);

    /// Reads the record from `bytes`, which is exactly [`Self::SIZE`] bytes.
    fn read(bytes: &[u8]) -> Self;
}

/// One aircraft's state in a positions frame. 20 bytes.
///
/// | Offset | Field | Type | Unit |
/// |---|---|---|---|
/// | 0 | id | u32 | aircraft id |
/// | 4 | lat, lon | i32 × 2 | 1e-7 degrees |
/// | 12 | altitude | i16 | 25 ft |
/// | 14 | ground speed | u16 | knots |
/// | 16 | track | u16 | 360/65536 degrees |
/// | 18 | vertical rate | i8 | 64 ft/min |
/// | 19 | flags | u8 | [`FLAG_ON_GROUND`], [`FLAG_SYNTHETIC`] |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Position {
    pub id: u32,
    pub lat: i32,
    pub lon: i32,
    pub altitude: i16,
    pub ground_speed: u16,
    pub track: u16,
    pub vertical_rate: i8,
    pub flags: u8,
}

impl Record for Position {
    const KIND: FrameKind = FrameKind::Positions;
    const SIZE: usize = 20;

    fn write(&self, out: &mut [u8]) {
        put(out, 0, self.id.to_le_bytes());
        put(out, 4, self.lat.to_le_bytes());
        put(out, 8, self.lon.to_le_bytes());
        put(out, 12, self.altitude.to_le_bytes());
        put(out, 14, self.ground_speed.to_le_bytes());
        put(out, 16, self.track.to_le_bytes());
        put(out, 18, self.vertical_rate.to_le_bytes());
        put(out, 19, [self.flags]);
    }

    fn read(bytes: &[u8]) -> Self {
        Position {
            id: u32::from_le_bytes(get(bytes, 0)),
            lat: i32::from_le_bytes(get(bytes, 4)),
            lon: i32::from_le_bytes(get(bytes, 8)),
            altitude: i16::from_le_bytes(get(bytes, 12)),
            ground_speed: u16::from_le_bytes(get(bytes, 14)),
            track: u16::from_le_bytes(get(bytes, 16)),
            vertical_rate: i8::from_le_bytes(get(bytes, 18)),
            flags: bytes[19],
        }
    }
}

/// What the client is told once about each aircraft. 40 bytes.
///
/// | Offset | Field | Type | Unit |
/// |---|---|---|---|
/// | 0 | aircraft id | u32 | |
/// | 4 | flight id | u32 | the flight's number in the seed file |
/// | 8 | ICAO24 | u32 | |
/// | 12 | time shift | u32 | seconds |
/// | 16 | offset east, north | i16 × 2 | metres |
/// | 20 | callsign | 8 bytes | space-padded ASCII |
/// | 28 | type | 4 bytes | space-padded ASCII |
/// | 32 | origin | 4 bytes | space-padded ASCII |
/// | 36 | destination | 4 bytes | space-padded ASCII |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Metadata {
    pub aircraft_id: u32,
    pub flight_id: u32,
    pub icao24: u32,
    pub time_shift_s: u32,
    pub offset_east_m: i16,
    pub offset_north_m: i16,
    pub callsign: [u8; 8],
    pub aircraft_type: [u8; 4],
    pub origin: [u8; 4],
    pub destination: [u8; 4],
}

impl Record for Metadata {
    const KIND: FrameKind = FrameKind::Metadata;
    const SIZE: usize = 40;

    fn write(&self, out: &mut [u8]) {
        put(out, 0, self.aircraft_id.to_le_bytes());
        put(out, 4, self.flight_id.to_le_bytes());
        put(out, 8, self.icao24.to_le_bytes());
        put(out, 12, self.time_shift_s.to_le_bytes());
        put(out, 16, self.offset_east_m.to_le_bytes());
        put(out, 18, self.offset_north_m.to_le_bytes());
        put(out, 20, self.callsign);
        put(out, 28, self.aircraft_type);
        put(out, 32, self.origin);
        put(out, 36, self.destination);
    }

    fn read(bytes: &[u8]) -> Self {
        Metadata {
            aircraft_id: u32::from_le_bytes(get(bytes, 0)),
            flight_id: u32::from_le_bytes(get(bytes, 4)),
            icao24: u32::from_le_bytes(get(bytes, 8)),
            time_shift_s: u32::from_le_bytes(get(bytes, 12)),
            offset_east_m: i16::from_le_bytes(get(bytes, 16)),
            offset_north_m: i16::from_le_bytes(get(bytes, 18)),
            callsign: get(bytes, 20),
            aircraft_type: get(bytes, 28),
            origin: get(bytes, 32),
            destination: get(bytes, 36),
        }
    }
}

/// One active conflict between two aircraft. 36 bytes.
///
/// It carries both positions so the link can be drawn when one end is off
/// screen.
///
/// | Offset | Field | Type | Unit |
/// |---|---|---|---|
/// | 0 | aircraft ids | u32 × 2 | |
/// | 8 | lat, lon of the first | i32 × 2 | 1e-7 degrees |
/// | 16 | lat, lon of the second | i32 × 2 | 1e-7 degrees |
/// | 24 | altitudes | i16 × 2 | 25 ft |
/// | 28 | time to closest approach | u16 | seconds |
/// | 30 | predicted lateral distance | u16 | 0.01 nm |
/// | 32 | predicted vertical separation | u16 | 25 ft |
/// | 34 | flags | u16 | none defined yet |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Alert {
    pub aircraft_ids: [u32; 2],
    pub lats: [i32; 2],
    pub lons: [i32; 2],
    pub altitudes: [i16; 2],
    pub seconds_to_closest: u16,
    pub lateral_distance: u16,
    pub vertical_separation: u16,
    pub flags: u16,
}

impl Record for Alert {
    const KIND: FrameKind = FrameKind::Alerts;
    const SIZE: usize = 36;

    fn write(&self, out: &mut [u8]) {
        put(out, 0, self.aircraft_ids[0].to_le_bytes());
        put(out, 4, self.aircraft_ids[1].to_le_bytes());
        put(out, 8, self.lats[0].to_le_bytes());
        put(out, 12, self.lons[0].to_le_bytes());
        put(out, 16, self.lats[1].to_le_bytes());
        put(out, 20, self.lons[1].to_le_bytes());
        put(out, 24, self.altitudes[0].to_le_bytes());
        put(out, 26, self.altitudes[1].to_le_bytes());
        put(out, 28, self.seconds_to_closest.to_le_bytes());
        put(out, 30, self.lateral_distance.to_le_bytes());
        put(out, 32, self.vertical_separation.to_le_bytes());
        put(out, 34, self.flags.to_le_bytes());
    }

    fn read(bytes: &[u8]) -> Self {
        Alert {
            aircraft_ids: [
                u32::from_le_bytes(get(bytes, 0)),
                u32::from_le_bytes(get(bytes, 4)),
            ],
            lats: [
                i32::from_le_bytes(get(bytes, 8)),
                i32::from_le_bytes(get(bytes, 16)),
            ],
            lons: [
                i32::from_le_bytes(get(bytes, 12)),
                i32::from_le_bytes(get(bytes, 20)),
            ],
            altitudes: [
                i16::from_le_bytes(get(bytes, 24)),
                i16::from_le_bytes(get(bytes, 26)),
            ],
            seconds_to_closest: u16::from_le_bytes(get(bytes, 28)),
            lateral_distance: u16::from_le_bytes(get(bytes, 30)),
            vertical_separation: u16::from_le_bytes(get(bytes, 32)),
            flags: u16::from_le_bytes(get(bytes, 34)),
        }
    }
}

/// One sample of the track an aircraft has flown. 24 bytes.
///
/// After the sample time the fields are the position record's, from lat and
/// lon onwards, in the same units.
///
/// | Offset | Field | Type | Unit |
/// |---|---|---|---|
/// | 0 | id | u32 | aircraft id |
/// | 4 | sim time | u32 | seconds |
/// | 8 | lat, lon | i32 × 2 | 1e-7 degrees |
/// | 16 | altitude | i16 | 25 ft |
/// | 18 | ground speed | u16 | knots |
/// | 20 | track | u16 | 360/65536 degrees |
/// | 22 | vertical rate | i8 | 64 ft/min |
/// | 23 | flags | u8 | [`FLAG_ON_GROUND`], [`FLAG_SYNTHETIC`] |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TrackSample {
    pub id: u32,
    pub sim_time_s: u32,
    pub lat: i32,
    pub lon: i32,
    pub altitude: i16,
    pub ground_speed: u16,
    pub track: u16,
    pub vertical_rate: i8,
    pub flags: u8,
}

impl Record for TrackSample {
    const KIND: FrameKind = FrameKind::Track;
    const SIZE: usize = 24;

    fn write(&self, out: &mut [u8]) {
        put(out, 0, self.id.to_le_bytes());
        put(out, 4, self.sim_time_s.to_le_bytes());
        put(out, 8, self.lat.to_le_bytes());
        put(out, 12, self.lon.to_le_bytes());
        put(out, 16, self.altitude.to_le_bytes());
        put(out, 18, self.ground_speed.to_le_bytes());
        put(out, 20, self.track.to_le_bytes());
        put(out, 22, self.vertical_rate.to_le_bytes());
        put(out, 23, [self.flags]);
    }

    fn read(bytes: &[u8]) -> Self {
        TrackSample {
            id: u32::from_le_bytes(get(bytes, 0)),
            sim_time_s: u32::from_le_bytes(get(bytes, 4)),
            lat: i32::from_le_bytes(get(bytes, 8)),
            lon: i32::from_le_bytes(get(bytes, 12)),
            altitude: i16::from_le_bytes(get(bytes, 16)),
            ground_speed: u16::from_le_bytes(get(bytes, 18)),
            track: u16::from_le_bytes(get(bytes, 20)),
            vertical_rate: i8::from_le_bytes(get(bytes, 22)),
            flags: bytes[23],
        }
    }
}

fn put<const N: usize>(out: &mut [u8], offset: usize, bytes: [u8; N]) {
    out[offset..offset + N].copy_from_slice(&bytes);
}

fn get<const N: usize>(bytes: &[u8], offset: usize) -> [u8; N] {
    let mut field = [0; N];
    field.copy_from_slice(&bytes[offset..offset + N]);
    field
}

/// Appends one frame to `out`: the header, then every record.
///
/// # Panics
///
/// If there are more than `u32::MAX` records.
pub fn encode_frame<R: Record>(
    out: &mut Vec<u8>,
    seq: u32,
    sim_time_ms: f64,
    flags: u32,
    records: &[R],
) {
    let count = u32::try_from(records.len()).expect("too many records for one frame");
    let start = out.len();
    out.resize(start + HEADER_SIZE + records.len() * R::SIZE, 0);
    let frame = &mut out[start..];

    frame[0] = PROTOCOL_VERSION;
    frame[1] = R::KIND as u8;
    put(frame, 2, (R::SIZE as u16).to_le_bytes());
    put(frame, 4, seq.to_le_bytes());
    put(frame, 8, sim_time_ms.to_le_bytes());
    put(frame, 16, count.to_le_bytes());
    put(frame, 20, flags.to_le_bytes());

    for (record, slot) in records
        .iter()
        .zip(frame[HEADER_SIZE..].chunks_exact_mut(R::SIZE))
    {
        record.write(slot);
    }
}

/// Why a frame could not be decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer bytes than the header, or than the header's count needs.
    Truncated { needed: usize, got: usize },
    /// The frame is from a protocol version this code does not speak.
    Version(u8),
    /// The kind byte is not one this code knows.
    UnknownKind(u8),
    /// The frame holds a different kind of record from the one asked for.
    WrongKind { expected: FrameKind, got: FrameKind },
    /// The frame's records are smaller than the fields this code needs.
    RecordTooSmall { needed: usize, got: usize },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::Truncated { needed, got } => {
                write!(f, "frame is truncated: needs {needed} bytes, got {got}")
            }
            DecodeError::Version(version) => write!(
                f,
                "frame has protocol version {version}, expected {PROTOCOL_VERSION}"
            ),
            DecodeError::UnknownKind(kind) => write!(f, "unknown frame kind {kind}"),
            DecodeError::WrongKind { expected, got } => {
                write!(f, "expected a {expected:?} frame, got {got:?}")
            }
            DecodeError::RecordTooSmall { needed, got } => write!(
                f,
                "records are {got} bytes, but at least {needed} are needed"
            ),
        }
    }
}

impl std::error::Error for DecodeError {}

/// A decoded header and the record bytes that follow it, still borrowed.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
    pub header: Header,
    records: &'a [u8],
}

impl<'a> Frame<'a> {
    /// Checks the header and that every record it counts is present. Bytes
    /// after the last record are ignored.
    pub fn decode(bytes: &'a [u8]) -> Result<Frame<'a>, DecodeError> {
        if bytes.len() < HEADER_SIZE {
            return Err(DecodeError::Truncated {
                needed: HEADER_SIZE,
                got: bytes.len(),
            });
        }
        if bytes[0] != PROTOCOL_VERSION {
            return Err(DecodeError::Version(bytes[0]));
        }
        let header = Header {
            version: bytes[0],
            kind: FrameKind::from_u8(bytes[1]).ok_or(DecodeError::UnknownKind(bytes[1]))?,
            record_size: u16::from_le_bytes(get(bytes, 2)),
            seq: u32::from_le_bytes(get(bytes, 4)),
            sim_time_ms: f64::from_le_bytes(get(bytes, 8)),
            count: u32::from_le_bytes(get(bytes, 16)),
            flags: u32::from_le_bytes(get(bytes, 20)),
        };

        // u64, because count × record size can pass usize on wasm32.
        let needed = HEADER_SIZE as u64 + u64::from(header.count) * u64::from(header.record_size);
        if (bytes.len() as u64) < needed {
            return Err(DecodeError::Truncated {
                needed: usize::try_from(needed).unwrap_or(usize::MAX),
                got: bytes.len(),
            });
        }
        Ok(Frame {
            header,
            records: &bytes[HEADER_SIZE..needed as usize],
        })
    }

    /// The frame's records, read as `R`.
    ///
    /// The frame's records may be larger than `R`: the fields `R` knows are
    /// read from the front of each one and the rest is skipped.
    pub fn records<R: Record>(
        &self,
    ) -> Result<impl ExactSizeIterator<Item = R> + use<'a, R>, DecodeError> {
        if self.header.kind != R::KIND {
            return Err(DecodeError::WrongKind {
                expected: R::KIND,
                got: self.header.kind,
            });
        }
        let record_size = usize::from(self.header.record_size);
        if record_size < R::SIZE {
            return Err(DecodeError::RecordTooSmall {
                needed: R::SIZE,
                got: record_size,
            });
        }
        Ok(self
            .records
            .chunks_exact(record_size)
            .map(|record| R::read(&record[..R::SIZE])))
    }
}

/// Conversions between wire integers and the units the rest of the code
/// works in. Values outside a field's range are clamped, never wrapped.
pub mod units {
    /// Largest vertical rate the wire can carry, in feet per minute.
    pub const MAX_VERTICAL_RATE_FPM: f64 = 127.0 * VERTICAL_RATE_STEP_FPM;

    /// Degrees in one step of latitude or longitude.
    pub const DEGREE_STEP: f64 = 1e-7;
    /// Feet in one step of altitude.
    pub const ALTITUDE_STEP_FT: f64 = 25.0;
    /// Steps of track in a full turn.
    pub const TRACK_STEPS: f64 = 65536.0;
    /// Feet per minute in one step of vertical rate.
    pub const VERTICAL_RATE_STEP_FPM: f64 = 64.0;
    const LATERAL_STEP_NM: f64 = 0.01;

    /// Latitude or longitude in degrees to 1e-7 degrees.
    pub fn degrees_to_wire(degrees: f64) -> i32 {
        // `as` saturates at the ends of the target type, here and below.
        (degrees / DEGREE_STEP).round() as i32
    }

    pub fn degrees_from_wire(wire: i32) -> f64 {
        f64::from(wire) * DEGREE_STEP
    }

    /// Altitude in feet above mean sea level to 25 ft steps. Signed: a few
    /// airports are below it.
    pub fn altitude_to_wire(feet: f64) -> i16 {
        (feet / ALTITUDE_STEP_FT).round() as i16
    }

    pub fn altitude_from_wire(wire: i16) -> f64 {
        f64::from(wire) * ALTITUDE_STEP_FT
    }

    /// Ground speed in knots, to the nearest knot.
    pub fn ground_speed_to_wire(knots: f64) -> u16 {
        knots.round() as u16
    }

    pub fn ground_speed_from_wire(wire: u16) -> f64 {
        f64::from(wire)
    }

    /// Track in degrees, any value, to 360/65536 degree steps in 0..360.
    pub fn track_to_wire(degrees: f64) -> u16 {
        let steps = (degrees.rem_euclid(360.0) / 360.0 * TRACK_STEPS).round();
        // Just under 360 rounds up to a full turn, which is 0.
        if steps >= TRACK_STEPS {
            0
        } else {
            steps as u16
        }
    }

    pub fn track_from_wire(wire: u16) -> f64 {
        f64::from(wire) * 360.0 / TRACK_STEPS
    }

    /// Vertical rate in feet per minute to 64 ft/min steps, the resolution
    /// ADS-B itself reports, clamped to ±[`MAX_VERTICAL_RATE_FPM`].
    pub fn vertical_rate_to_wire(feet_per_minute: f64) -> i8 {
        (feet_per_minute / VERTICAL_RATE_STEP_FPM)
            .round()
            .clamp(-127.0, 127.0) as i8
    }

    pub fn vertical_rate_from_wire(wire: i8) -> f64 {
        f64::from(wire) * VERTICAL_RATE_STEP_FPM
    }

    /// An alert's lateral distance in nautical miles to 0.01 nm steps.
    pub fn lateral_distance_to_wire(nautical_miles: f64) -> u16 {
        (nautical_miles / LATERAL_STEP_NM).round() as u16
    }

    pub fn lateral_distance_from_wire(wire: u16) -> f64 {
        f64::from(wire) * LATERAL_STEP_NM
    }

    /// An alert's vertical separation in feet to 25 ft steps.
    pub fn vertical_separation_to_wire(feet: f64) -> u16 {
        (feet / ALTITUDE_STEP_FT).round() as u16
    }

    pub fn vertical_separation_from_wire(wire: u16) -> f64 {
        f64::from(wire) * ALTITUDE_STEP_FT
    }

    /// Text to a space-padded ASCII field. Text that is too long is cut, and
    /// a character outside printable ASCII becomes `?`.
    pub fn text_to_wire<const N: usize>(text: &str) -> [u8; N] {
        let mut field = [b' '; N];
        for (slot, c) in field.iter_mut().zip(text.chars()) {
            *slot = if c.is_ascii_graphic() || c == ' ' {
                c as u8
            } else {
                b'?'
            };
        }
        field
    }

    /// A space-padded ASCII field to text, without the padding. Bytes that
    /// are not ASCII end the text.
    pub fn text_from_wire(field: &[u8]) -> &str {
        let ascii = field
            .iter()
            .position(|b| !b.is_ascii())
            .unwrap_or(field.len());
        // ASCII is always valid UTF-8.
        std::str::from_utf8(&field[..ascii])
            .unwrap_or("")
            .trim_end_matches(' ')
    }
}

#[cfg(test)]
mod tests {
    use super::units::*;
    use super::*;

    fn position(id: u32) -> Position {
        Position {
            id,
            lat: degrees_to_wire(40.6413),
            lon: degrees_to_wire(-73.7781),
            altitude: altitude_to_wire(-25.0),
            ground_speed: 451,
            track: track_to_wire(271.5),
            vertical_rate: vertical_rate_to_wire(-1984.0),
            flags: FLAG_SYNTHETIC,
        }
    }

    fn metadata(aircraft_id: u32) -> Metadata {
        Metadata {
            aircraft_id,
            flight_id: 7,
            icao24: 0xA1_B2_C3,
            time_shift_s: 3_600,
            offset_east_m: -1_200,
            offset_north_m: 800,
            callsign: text_to_wire("JBU123"),
            aircraft_type: text_to_wire("A320"),
            origin: text_to_wire("KBOS"),
            destination: text_to_wire(""),
        }
    }

    fn alert(first: u32) -> Alert {
        Alert {
            aircraft_ids: [first, first + 1],
            lats: [degrees_to_wire(40.1), degrees_to_wire(40.2)],
            lons: [degrees_to_wire(-74.1), degrees_to_wire(-74.2)],
            altitudes: [altitude_to_wire(11_000.0), altitude_to_wire(11_500.0)],
            seconds_to_closest: 95,
            lateral_distance: lateral_distance_to_wire(2.75),
            vertical_separation: vertical_separation_to_wire(500.0),
            flags: 0,
        }
    }

    fn track_sample(sim_time_s: u32) -> TrackSample {
        TrackSample {
            id: 42,
            sim_time_s,
            lat: degrees_to_wire(42.3656),
            lon: degrees_to_wire(-71.0096),
            altitude: altitude_to_wire(35_000.0),
            ground_speed: 480,
            track: track_to_wire(90.0),
            vertical_rate: 0,
            flags: 0,
        }
    }

    /// Encodes `records`, decodes them again and checks nothing changed.
    fn round_trip<R: Record + Clone + PartialEq + fmt::Debug>(records: &[R]) {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 9, 123_456.5, FRAME_NEW_PASS, records);
        assert_eq!(bytes.len(), HEADER_SIZE + records.len() * R::SIZE);

        let frame = Frame::decode(&bytes).unwrap();
        assert_eq!(
            frame.header,
            Header {
                version: PROTOCOL_VERSION,
                kind: R::KIND,
                record_size: R::SIZE as u16,
                seq: 9,
                sim_time_ms: 123_456.5,
                count: records.len() as u32,
                flags: FRAME_NEW_PASS,
            }
        );
        assert!(frame.header.is_new_pass());
        let decoded: Vec<R> = frame.records().unwrap().collect();
        assert_eq!(decoded, records);
    }

    #[test]
    fn positions_round_trip() {
        round_trip(&[position(1), position(2), position(u32::MAX)]);
    }

    #[test]
    fn metadata_round_trips() {
        round_trip(&[metadata(1), metadata(2)]);
    }

    #[test]
    fn alerts_round_trip() {
        round_trip(&[alert(1), alert(3)]);
    }

    #[test]
    fn track_round_trips() {
        round_trip(&[track_sample(10), track_sample(20), track_sample(30)]);
    }

    #[test]
    fn empty_frame_round_trips() {
        round_trip::<Position>(&[]);
    }

    #[test]
    fn encode_appends_to_the_buffer() {
        let mut bytes = vec![0xEE];
        encode_frame(&mut bytes, 0, 0.0, 0, &[position(1)]);
        assert_eq!(bytes[0], 0xEE);
        assert!(Frame::decode(&bytes[1..]).is_ok());
    }

    /// The offsets and sizes in the design document's tables, checked against
    /// bytes built by hand from distinct values.
    #[test]
    fn header_layout_matches_the_design() {
        let mut bytes = Vec::new();
        encode_frame(
            &mut bytes,
            0x0403_0201,
            1.5,
            0x0C0B_0A09,
            &[position(1), position(2)],
        );

        assert_eq!(HEADER_SIZE, 24);
        assert_eq!(bytes[0], PROTOCOL_VERSION);
        assert_eq!(bytes[1], 1);
        assert_eq!(bytes[2..4], 20u16.to_le_bytes());
        assert_eq!(bytes[4..8], [1, 2, 3, 4]);
        assert_eq!(bytes[8..16], 1.5f64.to_le_bytes());
        assert_eq!(bytes[16..20], 2u32.to_le_bytes());
        assert_eq!(bytes[20..24], [9, 10, 11, 12]);
    }

    #[test]
    fn kind_bytes_are_fixed() {
        assert_eq!(FrameKind::Positions as u8, 1);
        assert_eq!(FrameKind::Metadata as u8, 2);
        assert_eq!(FrameKind::Alerts as u8, 3);
        assert_eq!(FrameKind::Track as u8, 4);
    }

    #[test]
    fn position_layout_matches_the_design() {
        let record = Position {
            id: 0x0403_0201,
            lat: 0x0807_0605,
            lon: 0x0C0B_0A09,
            altitude: 0x0E0D,
            ground_speed: 0x100F,
            track: 0x1211,
            vertical_rate: 0x13,
            flags: 0x14,
        };
        let mut bytes = [0; Position::SIZE];
        record.write(&mut bytes);

        assert_eq!(Position::SIZE, 20);
        // Each field was given the bytes of its own offsets, counted from 1.
        let expected: Vec<u8> = (1..=20).collect();
        assert_eq!(bytes.as_slice(), expected);
    }

    #[test]
    fn metadata_layout_matches_the_design() {
        let record = Metadata {
            aircraft_id: 0x0403_0201,
            flight_id: 0x0807_0605,
            icao24: 0x0C0B_0A09,
            time_shift_s: 0x100F_0E0D,
            offset_east_m: 0x1211,
            offset_north_m: 0x1413,
            callsign: [21, 22, 23, 24, 25, 26, 27, 28],
            aircraft_type: [29, 30, 31, 32],
            origin: [33, 34, 35, 36],
            destination: [37, 38, 39, 40],
        };
        let mut bytes = [0; Metadata::SIZE];
        record.write(&mut bytes);

        assert_eq!(Metadata::SIZE, 40);
        let expected: Vec<u8> = (1..=40).collect();
        assert_eq!(bytes.as_slice(), expected);
    }

    #[test]
    fn alert_layout_matches_the_design() {
        let record = Alert {
            aircraft_ids: [0x0403_0201, 0x0807_0605],
            lats: [0x0C0B_0A09, 0x1413_1211],
            lons: [0x100F_0E0D, 0x1817_1615],
            altitudes: [0x1A19, 0x1C1B],
            seconds_to_closest: 0x1E1D,
            lateral_distance: 0x201F,
            vertical_separation: 0x2221,
            flags: 0x2423,
        };
        let mut bytes = [0; Alert::SIZE];
        record.write(&mut bytes);

        assert_eq!(Alert::SIZE, 36);
        let expected: Vec<u8> = (1..=36).collect();
        assert_eq!(bytes.as_slice(), expected);
    }

    #[test]
    fn track_layout_matches_the_design() {
        let record = TrackSample {
            id: 0x0403_0201,
            sim_time_s: 0x0807_0605,
            lat: 0x0C0B_0A09,
            lon: 0x100F_0E0D,
            altitude: 0x1211,
            ground_speed: 0x1413,
            track: 0x1615,
            vertical_rate: 0x17,
            flags: 0x18,
        };
        let mut bytes = [0; TrackSample::SIZE];
        record.write(&mut bytes);

        assert_eq!(TrackSample::SIZE, 24);
        let expected: Vec<u8> = (1..=24).collect();
        assert_eq!(bytes.as_slice(), expected);
    }

    /// A track sample is a position with the sample time in front: the
    /// fields from lat onwards are the same bytes.
    #[test]
    fn track_sample_shares_the_position_fields() {
        let position = position(42);
        let sample = TrackSample {
            id: position.id,
            sim_time_s: 600,
            lat: position.lat,
            lon: position.lon,
            altitude: position.altitude,
            ground_speed: position.ground_speed,
            track: position.track,
            vertical_rate: position.vertical_rate,
            flags: position.flags,
        };
        let mut position_bytes = [0; Position::SIZE];
        let mut sample_bytes = [0; TrackSample::SIZE];
        position.write(&mut position_bytes);
        sample.write(&mut sample_bytes);

        assert_eq!(position_bytes[4..], sample_bytes[8..]);
    }

    /// A later protocol revision appends fields to a record. This reader
    /// still gets the fields it knows.
    #[test]
    fn larger_records_are_read_and_the_extra_bytes_skipped() {
        const LARGER: usize = Position::SIZE + 8;
        let records = [position(1), position(2), position(3)];

        let mut bytes = Vec::new();
        encode_frame::<Position>(&mut bytes, 1, 0.0, 0, &[]);
        bytes[2..4].copy_from_slice(&(LARGER as u16).to_le_bytes());
        bytes[16..20].copy_from_slice(&(records.len() as u32).to_le_bytes());
        for record in &records {
            let mut larger = [0xFF; LARGER];
            record.write(&mut larger[..Position::SIZE]);
            bytes.extend_from_slice(&larger);
        }

        let frame = Frame::decode(&bytes).unwrap();
        assert_eq!(usize::from(frame.header.record_size), LARGER);
        let decoded: Vec<Position> = frame.records().unwrap().collect();
        assert_eq!(decoded, records);
    }

    #[test]
    fn smaller_records_are_refused() {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 1, 0.0, 0, &[position(1)]);
        bytes[2..4].copy_from_slice(&16u16.to_le_bytes());

        let frame = Frame::decode(&bytes).unwrap();
        assert_eq!(
            frame.records::<Position>().err(),
            Some(DecodeError::RecordTooSmall {
                needed: 20,
                got: 16
            })
        );
    }

    #[test]
    fn a_short_header_is_refused() {
        assert_eq!(
            Frame::decode(&[PROTOCOL_VERSION; 10]).err(),
            Some(DecodeError::Truncated {
                needed: 24,
                got: 10
            })
        );
    }

    #[test]
    fn missing_records_are_refused() {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 1, 0.0, 0, &[position(1), position(2)]);
        bytes.truncate(bytes.len() - 1);

        assert_eq!(
            Frame::decode(&bytes).err(),
            Some(DecodeError::Truncated {
                needed: 64,
                got: 63
            })
        );
    }

    #[test]
    fn another_version_is_refused() {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 1, 0.0, 0, &[position(1)]);
        bytes[0] = PROTOCOL_VERSION + 1;

        assert_eq!(
            Frame::decode(&bytes).err(),
            Some(DecodeError::Version(PROTOCOL_VERSION + 1))
        );
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 1, 0.0, 0, &[position(1)]);
        bytes[1] = 99;

        assert_eq!(
            Frame::decode(&bytes).err(),
            Some(DecodeError::UnknownKind(99))
        );
    }

    #[test]
    fn reading_the_wrong_kind_is_refused() {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, 1, 0.0, 0, &[position(1)]);

        let frame = Frame::decode(&bytes).unwrap();
        assert_eq!(
            frame.records::<Metadata>().err(),
            Some(DecodeError::WrongKind {
                expected: FrameKind::Metadata,
                got: FrameKind::Positions
            })
        );
    }

    #[test]
    fn degrees_keep_their_precision() {
        for degrees in [0.0, 40.6413, -73.7781, 90.0, -180.0, 179.999_999_9] {
            let back = degrees_from_wire(degrees_to_wire(degrees));
            assert!((back - degrees).abs() < 1e-7, "{degrees} came back {back}");
        }
    }

    #[test]
    fn altitude_is_signed_and_in_25_ft_steps() {
        assert_eq!(altitude_to_wire(35_000.0), 1_400);
        assert_eq!(altitude_to_wire(-30.0), -1);
        assert_eq!(altitude_from_wire(-1), -25.0);
        assert_eq!(altitude_to_wire(1e9), i16::MAX);
    }

    #[test]
    fn track_wraps_into_one_turn() {
        assert_eq!(track_to_wire(0.0), 0);
        assert_eq!(track_to_wire(360.0), 0);
        assert_eq!(track_to_wire(359.999), 0);
        assert_eq!(track_to_wire(-90.0), track_to_wire(270.0));
        assert_eq!(track_from_wire(track_to_wire(180.0)), 180.0);
        assert_eq!(track_from_wire(0x4000), 90.0);
    }

    #[test]
    fn vertical_rate_is_clamped() {
        assert_eq!(MAX_VERTICAL_RATE_FPM, 8_128.0);
        assert_eq!(vertical_rate_to_wire(640.0), 10);
        assert_eq!(vertical_rate_to_wire(20_000.0), 127);
        assert_eq!(vertical_rate_to_wire(-20_000.0), -127);
        assert_eq!(vertical_rate_from_wire(-127), -8_128.0);
    }

    #[test]
    fn ground_speed_and_alert_distances_clamp() {
        assert_eq!(ground_speed_to_wire(450.4), 450);
        assert_eq!(ground_speed_to_wire(-5.0), 0);
        assert_eq!(ground_speed_from_wire(450), 450.0);
        assert_eq!(lateral_distance_to_wire(2.75), 275);
        assert_eq!(lateral_distance_from_wire(275), 2.75);
        assert_eq!(lateral_distance_to_wire(1e6), u16::MAX);
        assert_eq!(vertical_separation_to_wire(500.0), 20);
        assert_eq!(vertical_separation_from_wire(20), 500.0);
    }

    #[test]
    fn text_is_padded_cut_and_trimmed() {
        assert_eq!(text_to_wire::<8>("JBU123"), *b"JBU123  ");
        assert_eq!(text_to_wire::<4>("B738X"), *b"B738");
        assert_eq!(text_to_wire::<4>("é1"), *b"?1  ");
        assert_eq!(text_from_wire(b"JBU123  "), "JBU123");
        assert_eq!(text_from_wire(b"    "), "");
        assert_eq!(text_from_wire(&[b'A', 0xFF, b'B', b' ']), "A");
    }
}
