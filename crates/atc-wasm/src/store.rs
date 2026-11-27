//! The aircraft store as the browser sees it: `atc_core::store::Store` with
//! pointers in place of slices and JavaScript values in place of records.
//!
//! JavaScript reads the buffers in place, through typed-array views over
//! `memory.buffer`:
//!
//! ```js
//! const positions = new Float32Array(memory.buffer, store.positions_ptr(), store.capacity() * 3);
//! ```
//!
//! A view goes stale in two ways: the store moves a buffer to grow it, or
//! WASM memory grows for any reason, which detaches every view over it
//! without raising an error. [`AircraftStore::view_generation`] changes in
//! both cases, so one comparison a frame, after `advance`, says whether to
//! build the views again.

use atc_core::store::Store;
use atc_core::wire::units::{
    altitude_from_wire, degrees_from_wire, ground_speed_from_wire, text_from_wire, track_from_wire,
    vertical_rate_from_wire,
};
use atc_core::wire::{FLAG_ON_GROUND, FLAG_SYNTHETIC, Metadata, Position};
use wasm_bindgen::prelude::*;

/// Pages of WASM memory. It only ever grows.
#[cfg(target_arch = "wasm32")]
fn memory_pages() -> u32 {
    core::arch::wasm32::memory_size(0) as u32
}

/// Native builds, which are for tests, have no memory to grow.
#[cfg(not(target_arch = "wasm32"))]
fn memory_pages() -> u32 {
    0
}

/// The browser's copy of the traffic picture.
///
/// Times are milliseconds on one clock of the caller's choosing, such as
/// `performance.now()`. Rows index the output buffers as of the last
/// `advance`; an aircraft is always named by its id.
#[wasm_bindgen]
#[derive(Default)]
pub struct AircraftStore {
    store: Store,
}

#[wasm_bindgen]
impl AircraftStore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> AircraftStore {
        AircraftStore::default()
    }

    /// Forgets everything the server sent. Call it when the socket
    /// reconnects. The selection, the hover and the altitude scale stay.
    pub fn reset(&mut self) {
        self.store.reset();
    }

    // Frames in.

    /// Takes in one binary frame of any kind, which arrived at
    /// `received_ms`. Returns the frame's kind: 1 positions, 2 metadata,
    /// 3 alerts, 4 track. Throws, and changes nothing, if the frame cannot
    /// be decoded.
    pub fn ingest(&mut self, bytes: &[u8], received_ms: f64) -> Result<u8, JsError> {
        match self.store.ingest(bytes, received_ms) {
            Ok(info) => Ok(info.kind as u8),
            Err(error) => Err(JsError::new(&error.to_string())),
        }
    }

    /// `seq` of the last frame ingested. A gap between one positions frame
    /// and the next is that many ticks skipped.
    pub fn frame_seq(&self) -> u32 {
        self.store.last_frame().map_or(0, |frame| frame.seq)
    }

    /// Sim time of the last frame ingested, in milliseconds.
    pub fn frame_sim_time_ms(&self) -> f64 {
        self.store
            .last_frame()
            .map_or(0.0, |frame| frame.sim_time_ms)
    }

    /// Whether the last frame ingested was the first of a new pass.
    pub fn frame_new_pass(&self) -> bool {
        self.store.last_frame().is_some_and(|frame| frame.new_pass)
    }

    /// Records in the last frame ingested.
    pub fn frame_count(&self) -> u32 {
        self.store.last_frame().map_or(0, |frame| frame.count)
    }

    /// Aircraft in the newest positions frame: how many the store holds.
    /// It changes as soon as a frame is ingested. `len()` is the rows the
    /// last `advance` drew, so it is 0 until `advance` has run and trails
    /// this by a frame after that.
    pub fn aircraft_count(&self) -> usize {
        self.store.aircraft_count()
    }

    // The picture out.

    /// Writes where every aircraft is at `render_ms` into the output
    /// buffers. Allocates nothing.
    pub fn advance(&mut self, render_ms: f64) {
        self.store.advance(render_ms);
    }

    /// Aircraft in the output buffers: rows `0..len()` are in use.
    pub fn len(&self) -> usize {
        self.store.len()
    }

    /// Whether the output buffers hold no aircraft.
    pub fn is_empty(&self) -> bool {
        self.store.is_empty()
    }

    /// Rows each output buffer has room for, and so the length to give a
    /// view: `capacity() × 3` for positions, `× 1` for angles and ids, `× 4`
    /// for colours.
    pub fn capacity(&self) -> usize {
        self.store.capacity()
    }

    /// Changes whenever views over the output buffers must be built again.
    /// Compare it after `advance`, before the views are used.
    pub fn view_generation(&self) -> u32 {
        // Both parts only ever go up, so their sum changes when either does.
        self.store.layout_version().wrapping_add(memory_pages())
    }

    /// Changes whenever an `advance` took up a new positions frame: rows,
    /// ids and colours can change only then. Positions and angles change on
    /// every `advance`.
    pub fn rows_version(&self) -> u32 {
        self.store.rows_version()
    }

    /// f32 × 3 a row: lon, lat in degrees, then altitude in feet times the
    /// altitude scale.
    pub fn positions_ptr(&self) -> *const f32 {
        self.store.positions().as_ptr()
    }

    /// f32 a row: degrees counter-clockwise, the negative of track.
    pub fn angles_ptr(&self) -> *const f32 {
        self.store.angles().as_ptr()
    }

    /// u8 × 4 a row: red, green, blue, alpha, by altitude band.
    pub fn colors_ptr(&self) -> *const u8 {
        self.store.colors().as_ptr()
    }

    /// u32 a row: the aircraft's id.
    pub fn ids_ptr(&self) -> *const u32 {
        self.store.row_ids().as_ptr()
    }

    /// What altitude in feet is multiplied by in every position written:
    /// 0 for a flat 2D picture, 0.3048 times the vertical exaggeration for
    /// metres in 3D. It starts at 1.
    pub fn set_altitude_scale(&mut self, scale: f32) {
        self.store.set_altitude_scale(scale);
    }

    // Lookup.

    /// The aircraft drawn in a row, as a pick returns it.
    pub fn id_at(&self, row: usize) -> Option<u32> {
        self.store.id_at(row)
    }

    /// The row of an aircraft, if it is in the picture.
    pub fn row_of(&self, id: u32) -> Option<usize> {
        self.store.row_of(id)
    }

    // What the server said about an aircraft, kept after it leaves the
    // picture. Each is undefined for an aircraft never announced.

    pub fn callsign(&self, id: u32) -> Option<String> {
        self.text(id, |metadata| &metadata.callsign)
    }

    pub fn aircraft_type(&self, id: u32) -> Option<String> {
        self.text(id, |metadata| &metadata.aircraft_type)
    }

    pub fn origin(&self, id: u32) -> Option<String> {
        self.text(id, |metadata| &metadata.origin)
    }

    pub fn destination(&self, id: u32) -> Option<String> {
        self.text(id, |metadata| &metadata.destination)
    }

    /// The flight's number in the seed file, shared by a flight's clones.
    pub fn flight_id(&self, id: u32) -> Option<u32> {
        self.store.metadata(id).map(|metadata| metadata.flight_id)
    }

    pub fn icao24(&self, id: u32) -> Option<u32> {
        self.store.metadata(id).map(|metadata| metadata.icao24)
    }

    // An aircraft's newest sample, as the server sent it and not as drawn.
    // Each is undefined for an aircraft not in the picture.

    /// Degrees.
    pub fn latitude(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| degrees_from_wire(sample.lat))
    }

    /// Degrees.
    pub fn longitude(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| degrees_from_wire(sample.lon))
    }

    /// Feet above mean sea level.
    pub fn altitude_ft(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| altitude_from_wire(sample.altitude))
    }

    /// Barometric altitude in feet: what the altimeter reads at standard
    /// pressure, and the one a flight level is read from.
    pub fn barometric_ft(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| altitude_from_wire(sample.barometric))
    }

    /// Knots.
    pub fn ground_speed_kt(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| ground_speed_from_wire(sample.ground_speed))
    }

    /// Degrees clockwise from north.
    pub fn track_deg(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| track_from_wire(sample.track))
    }

    /// Feet per minute.
    pub fn vertical_rate_fpm(&self, id: u32) -> Option<f64> {
        self.newest(id, |sample| vertical_rate_from_wire(sample.vertical_rate))
    }

    pub fn on_ground(&self, id: u32) -> Option<bool> {
        self.newest(id, |sample| sample.flags & FLAG_ON_GROUND != 0)
    }

    /// Whether the aircraft is a stress-mode clone.
    pub fn synthetic(&self, id: u32) -> Option<bool> {
        self.newest(id, |sample| sample.flags & FLAG_SYNTHETIC != 0)
    }

    // Tracks.

    /// Names the selected aircraft, or none. Its track is held from the
    /// track frame that answers the socket's `track` request and extended
    /// by each positions frame.
    pub fn set_selected(&mut self, id: Option<u32>) {
        self.store.set_selected(id);
    }

    /// Names the hovered aircraft, or none; its track is held likewise.
    pub fn set_hovered(&mut self, id: Option<u32>) {
        self.store.set_hovered(id);
    }

    /// Samples in the held track of an aircraft; 0 if none is held.
    pub fn track_len(&self, id: u32) -> usize {
        self.store.track_len(id)
    }

    /// f32 × 3 a sample, oldest first: lon, lat, scaled altitude. The last
    /// is the aircraft's newest sample. Read the pointer again after every
    /// `ingest`: the buffer moves as the track grows.
    pub fn track_positions_ptr(&self, id: u32) -> *const f32 {
        self.store.track_positions(id).as_ptr()
    }

    /// u32 a sample: its sim time in seconds.
    pub fn track_times_ptr(&self, id: u32) -> *const u32 {
        self.store.track_times(id).as_ptr()
    }

    /// Points in the trail to draw for an aircraft whose track is held, as
    /// the last `advance` left it; 0 if none is held.
    pub fn trail_len(&self, id: u32) -> usize {
        self.store.trail_len(id)
    }

    /// f32 × 3 a point, oldest first: lon, lat, scaled altitude. The
    /// samples the aircraft had flown by the time last drawn, then the
    /// position its icon was drawn at, so a line through them ends on the
    /// icon. `advance` rewrites it every frame, and `ingest` may move it,
    /// so read the pointer again after either.
    pub fn trail_positions_ptr(&self, id: u32) -> *const f32 {
        self.store.trail_positions(id).as_ptr()
    }

    // Alerts. The three buffers never move.

    /// Alerts in the newest alerts frame, soonest first; at most 500.
    pub fn alert_count(&self) -> usize {
        self.store.alert_count()
    }

    /// u32 × 2 an alert: the two aircraft ids.
    pub fn alert_ids_ptr(&self) -> *const u32 {
        self.store.alert_ids().as_ptr()
    }

    /// f32 × 6 an alert: lon, lat, scaled altitude of the first aircraft,
    /// then of the second.
    pub fn alert_positions_ptr(&self) -> *const f32 {
        self.store.alert_positions().as_ptr()
    }

    /// f32 × 3 an alert: seconds to the closest approach, predicted lateral
    /// distance in nautical miles, predicted vertical separation in feet.
    pub fn alert_details_ptr(&self) -> *const f32 {
        self.store.alert_details().as_ptr()
    }
}

impl AircraftStore {
    /// The store underneath, for native callers, which read slices where
    /// JavaScript reads pointers.
    pub fn store(&self) -> &Store {
        &self.store
    }

    fn text<const N: usize>(&self, id: u32, field: fn(&Metadata) -> &[u8; N]) -> Option<String> {
        let metadata = self.store.metadata(id)?;
        Some(text_from_wire(field(metadata)).to_owned())
    }

    fn newest<T>(&self, id: u32, read: fn(&Position) -> T) -> Option<T> {
        self.store.newest(id).as_ref().map(read)
    }
}

#[cfg(test)]
mod tests {
    use atc_core::wire::units::{altitude_to_wire, degrees_to_wire, text_to_wire, track_to_wire};
    use atc_core::wire::{FrameKind, Record, encode_frame};

    use super::*;

    fn frame<R: Record>(seq: u32, sim_s: u32, records: &[R]) -> Vec<u8> {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, seq, f64::from(sim_s) * 1_000.0, 0, records);
        bytes
    }

    #[test]
    fn reads_an_aircraft_back_in_plain_units() {
        let mut store = AircraftStore::new();
        let metadata = Metadata {
            aircraft_id: 9,
            flight_id: 3,
            icao24: 0xA1_B2_C3,
            callsign: text_to_wire("JBU123"),
            aircraft_type: text_to_wire("A320"),
            origin: text_to_wire("KBOS"),
            destination: text_to_wire(""),
            ..Metadata::default()
        };
        let position = Position {
            id: 9,
            lat: degrees_to_wire(40.5),
            lon: degrees_to_wire(-73.75),
            altitude: altitude_to_wire(12_000.0),
            ground_speed: 250,
            track: track_to_wire(90.0),
            vertical_rate: -10,
            flags: FLAG_SYNTHETIC,
            barometric: altitude_to_wire(11_800.0),
        };
        let kind = store.ingest(&frame(4, 10, &[metadata]), 10_000.0);
        assert_eq!(kind.ok(), Some(FrameKind::Metadata as u8));
        let kind = store.ingest(&frame(4, 10, &[position]), 10_000.0);
        assert_eq!(kind.ok(), Some(FrameKind::Positions as u8));
        assert_eq!(store.frame_seq(), 4);
        assert_eq!(store.frame_sim_time_ms(), 10_000.0);
        assert_eq!(store.frame_count(), 1);
        assert!(!store.frame_new_pass());

        assert!(store.is_empty());
        let before = store.rows_version();
        store.advance(10_000.0);
        assert_eq!(store.len(), 1);
        assert_ne!(store.rows_version(), before);
        assert_eq!(store.row_of(9), Some(0));
        assert_eq!(store.id_at(0), Some(9));
        assert_eq!(store.id_at(1), None);

        assert_eq!(store.callsign(9).as_deref(), Some("JBU123"));
        assert_eq!(store.aircraft_type(9).as_deref(), Some("A320"));
        assert_eq!(store.origin(9).as_deref(), Some("KBOS"));
        assert_eq!(store.destination(9).as_deref(), Some(""));
        assert_eq!(store.flight_id(9), Some(3));
        assert_eq!(store.icao24(9), Some(0xA1_B2_C3));
        assert_eq!(store.callsign(8), None);

        assert_eq!(store.latitude(9), Some(40.5));
        assert_eq!(store.longitude(9), Some(-73.75));
        assert_eq!(store.altitude_ft(9), Some(12_000.0));
        assert_eq!(store.barometric_ft(9), Some(11_800.0));
        assert_eq!(store.ground_speed_kt(9), Some(250.0));
        assert_eq!(store.track_deg(9), Some(90.0));
        assert_eq!(store.vertical_rate_fpm(9), Some(-640.0));
        assert_eq!(store.on_ground(9), Some(false));
        assert_eq!(store.synthetic(9), Some(true));
        assert_eq!(store.altitude_ft(8), None);
        assert_eq!(store.barometric_ft(8), None);
    }

    #[test]
    fn the_aircraft_count_is_the_frames_before_anything_is_drawn() {
        let mut store = AircraftStore::new();
        assert_eq!(store.aircraft_count(), 0);

        let positions: Vec<Position> = (1..=3)
            .map(|id| Position {
                id,
                ..Position::default()
            })
            .collect();
        assert!(store.ingest(&frame(0, 10, &positions), 10_000.0).is_ok());

        // Nothing has been drawn yet, and the count is already the frame's.
        assert_eq!(store.aircraft_count(), 3);
        assert_eq!(store.len(), 0);

        store.advance(10_000.0);
        assert_eq!(store.aircraft_count(), 3);
        assert_eq!(store.len(), 3);

        // A smaller frame: the count follows it at once, the rows drawn
        // only at the next `advance`.
        assert!(
            store
                .ingest(&frame(1, 11, &positions[..1]), 11_000.0)
                .is_ok()
        );
        assert_eq!(store.aircraft_count(), 1);
        assert_eq!(store.len(), 3);

        store.reset();
        assert_eq!(store.aircraft_count(), 0);
    }

    #[test]
    fn the_view_generation_changes_when_the_buffers_grow() {
        let mut store = AircraftStore::new();
        let fleet = |count: u32| -> Vec<Position> {
            (0..count)
                .map(|id| Position {
                    id,
                    ..Position::default()
                })
                .collect()
        };
        let first = store.view_generation();
        assert!(store.ingest(&frame(0, 1, &fleet(10)), 1_000.0).is_ok());
        let grown = store.view_generation();
        assert_ne!(grown, first);
        assert_eq!(store.capacity(), 1_024);

        assert!(store.ingest(&frame(1, 2, &fleet(900)), 2_000.0).is_ok());
        store.advance(2_000.0);
        assert_eq!(store.view_generation(), grown);

        assert!(store.ingest(&frame(2, 3, &fleet(2_000)), 3_000.0).is_ok());
        assert_ne!(store.view_generation(), grown);
    }
}
