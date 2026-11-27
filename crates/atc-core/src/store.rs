//! The client's copy of the traffic picture: the last two samples of every
//! aircraft the server has sent, its metadata, the tracks of the selected and
//! hovered aircraft, and the current alerts.
//!
//! [`Store::ingest`] takes a frame as it came off the socket.
//! [`Store::advance`] works out where every aircraft is at a render time and
//! writes it into flat buffers, laid out as the renderer's attributes, which
//! the browser reads in place. Nothing here depends on WASM, so the same code
//! is tested natively.
//!
//! **Rows.** Each aircraft has a row. A row is an index into the output
//! buffers and nothing more: removing an aircraft moves the last row into
//! its place, so an aircraft is always named by its id. The output buffers,
//! [`Store::len`] and [`Store::id_at`] describe the rows as they were at the
//! last `advance`, which is what is on screen, so a pick made between a frame
//! arriving and the next `advance` still resolves to the aircraft that was
//! drawn.
//!
//! **Time.** The caller passes its own clock, in milliseconds, to both
//! `ingest` and `advance`. The store keeps the difference between that clock
//! and sim time, and renders [`RENDER_DELAY_MS`] behind the newest frame, so
//! in steady state it is always between two samples.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use crate::geo;
use crate::recording::SAMPLE_SPACING_S;
use crate::wire::units::{
    ALTITUDE_STEP_FT, DEGREE_STEP, TRACK_STEPS, VERTICAL_RATE_STEP_FPM, altitude_from_wire,
    degrees_from_wire, ground_speed_from_wire, track_from_wire,
};
use crate::wire::{
    Alert, DecodeError, FLAG_ON_GROUND, Frame, FrameKind, Metadata, Position, TrackSample,
};

/// How far behind the newest frame the picture is drawn: one update at the
/// server's 1 Hz.
pub const RENDER_DELAY_MS: f64 = 1_000.0;

/// The longest an aircraft is carried forward from its newest sample. Past
/// this it stops, so a dead connection does not fly the picture away.
pub const MAX_DEAD_RECKONING_MS: f64 = 5_000.0;

/// The most alerts kept, which is the most the server sends in a frame.
pub const MAX_ALERTS: usize = 500;

/// A frame that arrives later than the clock expected by more than this
/// resets the clock.
const CLOCK_RESET_MS: f64 = 2_000.0;
/// How much of a late frame's lateness the clock takes up. Frames arrive
/// unevenly, and following each late one exactly would put every aircraft
/// back by its lateness.
const CLOCK_GAIN: f64 = 0.1;

/// Rows the output buffers start with, so the first frames do not regrow
/// them over and over.
const MIN_CAPACITY: usize = 1_024;

/// Colour of an aircraft on the ground, as red, green, blue, alpha: a grey
/// that stands back from the bands on the dark map.
pub const GROUND_COLOR: [u8; 4] = [112, 120, 132, 255];

/// The altitude bands, lowest first: the height in feet above mean sea level
/// at which each ends, and its colour. The last has no ceiling.
///
/// The colours run warm to cool with height: vermilion, amber, yellow,
/// mint, sky blue, magenta. They were chosen over the map's blue-black
/// (`#0a0d12`) so that every pair, the ground grey included, stays apart
/// for the common colour-vision deficiencies as well as for full colour
/// vision: with protanopia and deuteranopia simulated (Machado, Oliveira
/// and Fernandes, 2009) the closest pair is 0.12 apart in Oklab, and with
/// tritanopia 0.08. Neighbouring bands differ in lightness as well as hue,
/// which is what carries them when the hue is lost. Each is at least 5:1
/// against the map.
pub const ALTITUDE_BANDS: [(f64, [u8; 4]); 6] = [
    (5_000.0, [245, 62, 6, 255]),
    (10_000.0, [239, 167, 29, 255]),
    (18_000.0, [253, 252, 59, 255]),
    (30_000.0, [101, 246, 184, 255]),
    (40_000.0, [134, 193, 254, 255]),
    (f64::INFINITY, [238, 26, 209, 255]),
];

/// The colour of an aircraft at a wire altitude with these flags.
pub fn altitude_color(altitude: i16, flags: u8) -> [u8; 4] {
    if flags & FLAG_ON_GROUND != 0 {
        return GROUND_COLOR;
    }
    let feet = altitude_from_wire(altitude);
    ALTITUDE_BANDS
        .iter()
        .find(|(ceiling, _)| feet < *ceiling)
        .map_or(GROUND_COLOR, |(_, color)| *color)
}

/// Hashes an aircraft id by one multiplication. Ids are small integers
/// handed out in order, which the default hasher is needlessly careful with:
/// at 50,000 lookups a frame the difference is milliseconds in the browser.
#[derive(Default)]
struct IdHasher(u64);

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 = (self.0 ^ u64::from(*byte)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }

    fn write_u32(&mut self, value: u32) {
        self.0 = u64::from(value).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

type IdMap<V> = HashMap<u32, V, BuildHasherDefault<IdHasher>>;

/// What the header of an ingested frame said.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameInfo {
    pub kind: FrameKind,
    /// The tick the frame was built from. A gap between one positions frame
    /// and the next means the server skipped ticks for this client.
    pub seq: u32,
    pub sim_time_ms: f64,
    /// Whether this is the first frame of a new pass through the recording.
    pub new_pass: bool,
    /// Records in the frame.
    pub count: u32,
}

/// The track an aircraft has flown, as the server sent it and as positions
/// frames have extended it since.
struct Track {
    id: u32,
    /// Sim time of each sample, in seconds.
    times: Vec<u32>,
    altitudes: Vec<i16>,
    /// lon, lat and scaled altitude of each sample.
    positions: Vec<f32>,
    /// Samples that are kept. One more may follow: the aircraft's newest
    /// position, replaced by each positions frame until it is far enough
    /// from the last kept sample to be kept itself.
    kept: usize,
    /// The trail to draw, written by `advance`: the samples the aircraft
    /// had flown by the time drawn, then the position its icon is drawn at.
    /// lon, lat and scaled altitude, like `positions`.
    trail: Vec<f32>,
}

impl Track {
    fn new(id: u32) -> Track {
        Track {
            id,
            times: Vec::new(),
            altitudes: Vec::new(),
            positions: Vec::new(),
            kept: 0,
            trail: Vec::new(),
        }
    }

    /// Makes room in `trail` for every sample and the icon's position, so
    /// that `advance`, which writes it, never allocates. Called whenever
    /// the track may have grown.
    fn reserve_trail(&mut self) {
        let needed = self.positions.len() + 3;
        self.trail.reserve(needed.saturating_sub(self.trail.len()));
    }

    /// Writes `trail` for the sim time `sim_ms`. `icon` is where the
    /// aircraft is drawn, if it is in the picture.
    ///
    /// The page draws a moment behind the newest frame, so the newest
    /// samples are ahead of the icon: they are left out until the icon has
    /// passed them, and the trail's last point is the icon's own position.
    /// Without that the line would run on past the aircraft.
    fn write_trail(&mut self, sim_ms: f64, icon: Option<[f32; 3]>) {
        let flown = self
            .times
            .partition_point(|&time_s| f64::from(time_s) * 1_000.0 <= sim_ms);
        self.trail.clear();
        self.trail.extend_from_slice(&self.positions[..flown * 3]);
        if let Some(icon) = icon {
            self.trail.extend_from_slice(&icon);
        }
    }

    fn truncate(&mut self, samples: usize) {
        self.times.truncate(samples);
        self.altitudes.truncate(samples);
        self.positions.truncate(samples * 3);
    }

    fn push(&mut self, time_s: u32, lat: i32, lon: i32, altitude: i16, altitude_scale: f32) {
        self.times.push(time_s);
        self.altitudes.push(altitude);
        self.positions.extend([
            degrees_from_wire(lon) as f32,
            degrees_from_wire(lat) as f32,
            scaled_altitude(altitude, altitude_scale),
        ]);
    }

    fn rescale(&mut self, altitude_scale: f32) {
        let (positions, _) = self.positions.as_chunks_mut::<3>();
        for (position, altitude) in positions.iter_mut().zip(&self.altitudes) {
            position[2] = scaled_altitude(*altitude, altitude_scale);
        }
    }
}

fn scaled_altitude(altitude: i16, altitude_scale: f32) -> f32 {
    f32::from(altitude) * ALTITUDE_STEP_FT as f32 * altitude_scale
}

/// The struct-of-arrays aircraft store. See the module documentation.
pub struct Store {
    // One entry per row in each of these. Sample 0 is the older of an
    // aircraft's two samples and sample 1 the newer, both as wire integers.
    ids: Vec<u32>,
    lat0: Vec<i32>,
    lon0: Vec<i32>,
    altitude0: Vec<i16>,
    track0: Vec<u16>,
    lat1: Vec<i32>,
    lon1: Vec<i32>,
    altitude1: Vec<i16>,
    ground_speed: Vec<u16>,
    track1: Vec<u16>,
    vertical_rate: Vec<i8>,
    flags: Vec<u8>,
    /// Barometric altitude at sample 1. It is read by id and never drawn,
    /// so there is no sample 0 of it and `advance` does not touch it.
    barometric: Vec<i16>,
    /// Velocity at sample 1, in wire steps of latitude and longitude per
    /// millisecond, for dead reckoning.
    velocity_lat: Vec<f32>,
    velocity_lon: Vec<f32>,
    /// The positions frame that last named the row; see `frame_stamp`.
    stamp: Vec<u32>,

    rows: IdMap<u32>,
    metadata: IdMap<Metadata>,

    /// Counts positions frames, to tell which rows the newest one named.
    frame_stamp: u32,
    /// Sim times of samples 0 and 1. Every row shares them: an aircraft
    /// that was not in the frame before the newest is given a sample 0 by
    /// flying it backwards.
    older_ms: f64,
    newer_ms: f64,
    /// Sim time minus the caller's clock, once a positions frame has come.
    clock: Option<f64>,
    last_frame: Option<FrameInfo>,

    // The output buffers, each `capacity` rows long, of which the first
    // `rendered` are in use.
    capacity: usize,
    rendered: usize,
    out_ids: Vec<u32>,
    out_positions: Vec<f32>,
    out_angles: Vec<f32>,
    out_colors: Vec<u8>,
    /// Whether the rows have changed since the output buffers last took
    /// them up.
    rows_changed: bool,
    rows_version: u32,
    layout_version: u32,
    altitude_scale: f32,

    selected: Option<u32>,
    hovered: Option<u32>,
    tracks: Vec<Track>,

    alerts: Vec<Alert>,
    alert_ids: Vec<u32>,
    alert_positions: Vec<f32>,
    alert_details: Vec<f32>,
}

impl Default for Store {
    fn default() -> Self {
        Store::new()
    }
}

impl Store {
    pub fn new() -> Store {
        Store {
            ids: Vec::new(),
            lat0: Vec::new(),
            lon0: Vec::new(),
            altitude0: Vec::new(),
            track0: Vec::new(),
            lat1: Vec::new(),
            lon1: Vec::new(),
            altitude1: Vec::new(),
            ground_speed: Vec::new(),
            track1: Vec::new(),
            vertical_rate: Vec::new(),
            flags: Vec::new(),
            barometric: Vec::new(),
            velocity_lat: Vec::new(),
            velocity_lon: Vec::new(),
            stamp: Vec::new(),
            rows: IdMap::default(),
            metadata: IdMap::default(),
            frame_stamp: 0,
            older_ms: 0.0,
            newer_ms: 0.0,
            clock: None,
            last_frame: None,
            capacity: 0,
            rendered: 0,
            out_ids: Vec::new(),
            out_positions: Vec::new(),
            out_angles: Vec::new(),
            out_colors: Vec::new(),
            rows_changed: false,
            rows_version: 0,
            layout_version: 0,
            altitude_scale: 1.0,
            selected: None,
            hovered: None,
            tracks: Vec::new(),
            // Reserved once, so these three never move.
            alerts: Vec::with_capacity(MAX_ALERTS),
            alert_ids: Vec::with_capacity(MAX_ALERTS * 2),
            alert_positions: Vec::with_capacity(MAX_ALERTS * 6),
            alert_details: Vec::with_capacity(MAX_ALERTS * 3),
        }
    }

    /// Forgets everything the server sent, for a new connection: the server
    /// starts `seq` again and announces every aircraft again. The selection,
    /// the hover, the altitude scale and the output buffers' memory are
    /// kept.
    pub fn reset(&mut self) {
        while !self.ids.is_empty() {
            self.remove_row(self.ids.len() - 1);
        }
        self.metadata.clear();
        self.clock = None;
        self.last_frame = None;
        self.tracks.clear();
        self.alerts.clear();
        self.write_alerts();
        self.take_up_rows();
    }

    // Ingest.

    /// Takes in one frame of any kind. `received_ms` is the caller's clock
    /// when the frame arrived, the same clock `advance` is given.
    ///
    /// A frame that cannot be decoded changes nothing.
    pub fn ingest(&mut self, bytes: &[u8], received_ms: f64) -> Result<FrameInfo, DecodeError> {
        let frame = Frame::decode(bytes)?;
        match frame.header.kind {
            FrameKind::Positions => self.ingest_positions(&frame, received_ms)?,
            FrameKind::Metadata => {
                for record in frame.records::<Metadata>()? {
                    self.metadata.insert(record.aircraft_id, record);
                }
            }
            FrameKind::Alerts => {
                let records = frame.records::<Alert>()?;
                self.alerts.clear();
                self.alerts.extend(records.take(MAX_ALERTS));
                self.write_alerts();
            }
            FrameKind::Track => self.ingest_track(&frame)?,
        }
        let info = FrameInfo {
            kind: frame.header.kind,
            seq: frame.header.seq,
            sim_time_ms: frame.header.sim_time_ms,
            new_pass: frame.header.is_new_pass(),
            count: frame.header.count,
        };
        self.last_frame = Some(info);
        Ok(info)
    }

    fn ingest_positions(&mut self, frame: &Frame, received_ms: f64) -> Result<(), DecodeError> {
        let records = frame.records::<Position>()?;
        let sim_ms = frame.header.sim_time_ms;

        // Sim time never goes back on one connection. If it has, or this is
        // the first frame, there is no older sample to move from.
        let fresh = self.clock.is_none() || sim_ms <= self.newer_ms;
        self.older_ms = if fresh {
            sim_ms - RENDER_DELAY_MS
        } else {
            self.newer_ms
        };
        self.newer_ms = sim_ms;
        let span_ms = self.newer_ms - self.older_ms;

        // The clock this frame would set if it had taken no longer to
        // arrive than any frame can.
        let on_time = sim_ms - RENDER_DELAY_MS - received_ms;
        self.clock = Some(match self.clock {
            // A frame can be held up but cannot arrive before it was sent.
            // So one that is late against the clock is taken as held up, and
            // moves the clock only a little. One that is early shows the
            // clock was behind, as it is after the first frame of a
            // connection, which is the picture as it stood and so up to a
            // second old. That is put right at once: left behind, the clock
            // would ask for a time before the older sample at every frame.
            Some(clock) if !fresh && on_time < clock && clock - on_time <= CLOCK_RESET_MS => {
                clock + (on_time - clock) * CLOCK_GAIN
            }
            _ => on_time,
        });

        self.frame_stamp = self.frame_stamp.wrapping_add(1);
        for record in records {
            match self.rows.get(&record.id) {
                Some(&row) => {
                    let row = row as usize;
                    if self.stamp[row] == self.frame_stamp {
                        // Named twice in one frame; the first stands.
                        continue;
                    }
                    self.lat0[row] = self.lat1[row];
                    self.lon0[row] = self.lon1[row];
                    self.altitude0[row] = self.altitude1[row];
                    self.track0[row] = self.track1[row];
                    self.set_newest(row, &record);
                    if fresh {
                        self.fly_back(row, span_ms);
                    }
                }
                None => {
                    let row = self.push_row(record.id);
                    self.set_newest(row, &record);
                    self.fly_back(row, span_ms);
                }
            }
        }

        // The frame is the whole picture: a row it did not name has gone.
        let mut row = 0;
        while row < self.ids.len() {
            if self.stamp[row] == self.frame_stamp {
                row += 1;
            } else {
                self.remove_row(row);
            }
        }

        self.reserve_output(self.ids.len());
        self.rows_changed = true;
        self.extend_tracks((sim_ms / 1_000.0) as u32);
        Ok(())
    }

    /// Adds a row for `id` with nothing in it yet.
    fn push_row(&mut self, id: u32) -> usize {
        let row = self.ids.len();
        self.ids.push(id);
        self.lat0.push(0);
        self.lon0.push(0);
        self.altitude0.push(0);
        self.track0.push(0);
        self.lat1.push(0);
        self.lon1.push(0);
        self.altitude1.push(0);
        self.ground_speed.push(0);
        self.track1.push(0);
        self.vertical_rate.push(0);
        self.flags.push(0);
        self.barometric.push(0);
        self.velocity_lat.push(0.0);
        self.velocity_lon.push(0.0);
        self.stamp.push(self.frame_stamp);
        self.rows.insert(id, row as u32);
        row
    }

    /// Removes a row by moving the last row into its place.
    fn remove_row(&mut self, row: usize) {
        self.rows.remove(&self.ids[row]);
        self.ids.swap_remove(row);
        self.lat0.swap_remove(row);
        self.lon0.swap_remove(row);
        self.altitude0.swap_remove(row);
        self.track0.swap_remove(row);
        self.lat1.swap_remove(row);
        self.lon1.swap_remove(row);
        self.altitude1.swap_remove(row);
        self.ground_speed.swap_remove(row);
        self.track1.swap_remove(row);
        self.vertical_rate.swap_remove(row);
        self.flags.swap_remove(row);
        self.barometric.swap_remove(row);
        self.velocity_lat.swap_remove(row);
        self.velocity_lon.swap_remove(row);
        self.stamp.swap_remove(row);
        if let Some(&moved) = self.ids.get(row) {
            self.rows.insert(moved, row as u32);
        }
    }

    /// Writes a record as a row's sample 1, with the velocity it implies.
    fn set_newest(&mut self, row: usize, record: &Position) {
        self.lat1[row] = record.lat;
        self.lon1[row] = record.lon;
        self.altitude1[row] = record.altitude;
        self.ground_speed[row] = record.ground_speed;
        self.track1[row] = record.track;
        self.vertical_rate[row] = record.vertical_rate;
        self.flags[row] = record.flags;
        self.barometric[row] = record.barometric;
        self.stamp[row] = self.frame_stamp;

        // Where it would be a second on, by the same step the simulator's
        // fixture flies with.
        let (lat, lon) = (degrees_from_wire(record.lat), degrees_from_wire(record.lon));
        let nm_in_a_second = ground_speed_from_wire(record.ground_speed) / 3_600.0;
        let (next_lat, next_lon) =
            geo::step(lat, lon, track_from_wire(record.track), nm_in_a_second);
        self.velocity_lat[row] = ((next_lat - lat) / DEGREE_STEP / 1_000.0) as f32;
        self.velocity_lon[row] = ((next_lon - lon) / DEGREE_STEP / 1_000.0) as f32;
    }

    /// Gives a row a sample 0 by flying it back from sample 1 for `span_ms`,
    /// so an aircraft that has just appeared moves from its first frame.
    fn fly_back(&mut self, row: usize, span_ms: f64) {
        let back = |from: i32, velocity: f32| {
            (f64::from(from) - f64::from(velocity) * span_ms).round() as i32
        };
        self.lat0[row] = back(self.lat1[row], self.velocity_lat[row]);
        self.lon0[row] = back(self.lon1[row], self.velocity_lon[row]);
        let climbed = f64::from(self.vertical_rate[row]) * CLIMB_STEPS_PER_MS * span_ms;
        self.altitude0[row] = (f64::from(self.altitude1[row]) - climbed).round() as i16;
        self.track0[row] = self.track1[row];
    }

    fn ingest_track(&mut self, frame: &Frame) -> Result<(), DecodeError> {
        let mut track: Option<Track> = None;
        for record in frame.records::<TrackSample>()? {
            let track = track.get_or_insert_with(|| Track::new(record.id));
            if record.id == track.id {
                track.push(
                    record.sim_time_s,
                    record.lat,
                    record.lon,
                    record.altitude,
                    self.altitude_scale,
                );
            }
        }
        // An answer to a request made for an aircraft that is no longer
        // selected or hovered is dropped.
        let Some(mut track) = track.filter(|track| self.holds_track(track.id)) else {
            return Ok(());
        };
        // The last record is the aircraft's position now, not a sample on
        // the 10 s grid, unless it is the only one.
        track.kept = (track.times.len() - 1).max(1);
        track.reserve_trail();
        match self.tracks.iter_mut().find(|held| held.id == track.id) {
            Some(held) => *held = track,
            None => self.tracks.push(track),
        }
        Ok(())
    }

    /// Brings each held track up to the newest positions frame.
    fn extend_tracks(&mut self, sim_time_s: u32) {
        for track in &mut self.tracks {
            let Some(&row) = self.rows.get(&track.id) else {
                continue;
            };
            let row = row as usize;
            let last_kept_s = track.times[track.kept - 1];
            if sim_time_s <= last_kept_s {
                continue;
            }
            track.truncate(track.kept);
            track.push(
                sim_time_s,
                self.lat1[row],
                self.lon1[row],
                self.altitude1[row],
                self.altitude_scale,
            );
            if sim_time_s - last_kept_s >= SAMPLE_SPACING_S {
                track.kept += 1;
            }
            track.reserve_trail();
        }
    }

    fn holds_track(&self, id: u32) -> bool {
        self.selected == Some(id) || self.hovered == Some(id)
    }

    fn write_alerts(&mut self) {
        self.alert_ids.clear();
        self.alert_positions.clear();
        self.alert_details.clear();
        for alert in &self.alerts {
            self.alert_ids.extend(alert.aircraft_ids);
            for end in 0..2 {
                self.alert_positions.extend([
                    degrees_from_wire(alert.lons[end]) as f32,
                    degrees_from_wire(alert.lats[end]) as f32,
                    scaled_altitude(alert.altitudes[end], self.altitude_scale),
                ]);
            }
            self.alert_details.extend([
                f32::from(alert.seconds_to_closest),
                crate::wire::units::lateral_distance_from_wire(alert.lateral_distance) as f32,
                crate::wire::units::vertical_separation_from_wire(alert.vertical_separation) as f32,
            ]);
        }
    }

    // Advance.

    /// Works out where every aircraft is at `render_ms` on the caller's
    /// clock and writes the output buffers. It allocates nothing.
    ///
    /// - Between the two samples it interpolates, turning the short way.
    /// - Past the newest sample, because the next frame is late, it carries
    ///   each aircraft on at its reported speed, track and vertical rate,
    ///   for at most [`MAX_DEAD_RECKONING_MS`].
    /// - However long it is since the last call, it draws the picture as it
    ///   now is, with nothing to catch up: `ingest` keeps the clock, so a
    ///   render loop that stops, as in a hidden tab, resumes in step.
    pub fn advance(&mut self, render_ms: f64) {
        if self.rows_changed {
            self.take_up_rows();
        }
        let Some(clock) = self.clock else {
            return;
        };
        if !render_ms.is_finite() {
            return;
        }
        let sim_ms = render_ms + clock;

        let rows = self.rendered;
        let feet = ALTITUDE_STEP_FT as f32 * self.altitude_scale;
        let (positions, _) = self.out_positions[..rows * 3].as_chunks_mut::<3>();
        let angles = &mut self.out_angles[..rows];
        let (lat1, lon1) = (&self.lat1[..rows], &self.lon1[..rows]);
        let (altitude1, track1) = (&self.altitude1[..rows], &self.track1[..rows]);

        if sim_ms <= self.newer_ms {
            let (lat0, lon0) = (&self.lat0[..rows], &self.lon0[..rows]);
            let (altitude0, track0) = (&self.altitude0[..rows], &self.track0[..rows]);
            let fraction = ((sim_ms - self.older_ms) / (self.newer_ms - self.older_ms)).max(0.0);
            let fraction_f32 = fraction as f32;
            for (row, (position, angle)) in positions.iter_mut().zip(angles).enumerate() {
                let mix = |from: i32, to: i32| {
                    let from = f64::from(from);
                    ((from + (f64::from(to) - from) * fraction) * DEGREE_STEP) as f32
                };
                position[0] = mix(lon0[row], lon1[row]);
                position[1] = mix(lat0[row], lat1[row]);
                let from = f32::from(altitude0[row]);
                position[2] = (from + (f32::from(altitude1[row]) - from) * fraction_f32) * feet;
                // The wrapped difference, read as signed, is the short way
                // round.
                let turn = f32::from(track1[row].wrapping_sub(track0[row]) as i16);
                *angle = -(f32::from(track0[row]) + turn * fraction_f32) * DEGREES_PER_TRACK_STEP;
            }
        } else {
            let (velocity_lat, velocity_lon) =
                (&self.velocity_lat[..rows], &self.velocity_lon[..rows]);
            let vertical_rate = &self.vertical_rate[..rows];
            let ahead_ms = (sim_ms - self.newer_ms).min(MAX_DEAD_RECKONING_MS);
            let climb = (CLIMB_STEPS_PER_MS * ahead_ms) as f32;
            for (row, (position, angle)) in positions.iter_mut().zip(angles).enumerate() {
                let carry = |from: i32, velocity: f32| {
                    ((f64::from(from) + f64::from(velocity) * ahead_ms) * DEGREE_STEP) as f32
                };
                position[0] = carry(lon1[row], velocity_lon[row]);
                position[1] = carry(lat1[row], velocity_lat[row]);
                position[2] =
                    (f32::from(altitude1[row]) + f32::from(vertical_rate[row]) * climb) * feet;
                *angle = -f32::from(track1[row]) * DEGREES_PER_TRACK_STEP;
            }
        }

        // The trails, which end where the icons were just put.
        for track in &mut self.tracks {
            let icon = self
                .rows
                .get(&track.id)
                .map(|&row| row as usize)
                .filter(|&row| row < rows)
                .map(|row| {
                    let at = &self.out_positions[row * 3..row * 3 + 3];
                    [at[0], at[1], at[2]]
                });
            track.write_trail(sim_ms, icon);
        }
    }

    /// Makes the output buffers describe the rows as they now are: their
    /// ids and their colours, which change only when a frame arrives.
    fn take_up_rows(&mut self) {
        let rows = self.ids.len();
        self.out_ids[..rows].copy_from_slice(&self.ids);
        let (colors, _) = self.out_colors[..rows * 4].as_chunks_mut::<4>();
        for (color, (altitude, flags)) in colors
            .iter_mut()
            .zip(self.altitude1.iter().zip(&self.flags))
        {
            *color = altitude_color(*altitude, *flags);
        }
        self.rendered = rows;
        self.rows_changed = false;
        self.rows_version = self.rows_version.wrapping_add(1);
    }

    /// Grows the output buffers to hold `rows`. This is the only place they
    /// can move, and it is never reached from `advance`.
    fn reserve_output(&mut self, rows: usize) {
        if rows <= self.capacity {
            return;
        }
        let capacity = rows.next_power_of_two().max(MIN_CAPACITY);
        self.out_ids.resize(capacity, 0);
        self.out_positions.resize(capacity * 3, 0.0);
        self.out_angles.resize(capacity, 0.0);
        self.out_colors.resize(capacity * 4, 0);
        self.capacity = capacity;
        self.layout_version = self.layout_version.wrapping_add(1);
    }

    // The output buffers.

    /// Rows in use in the output buffers: the aircraft drawn by the last
    /// `advance`.
    pub fn len(&self) -> usize {
        self.rendered
    }

    pub fn is_empty(&self) -> bool {
        self.rendered == 0
    }

    /// Rows the output buffers have room for. Each buffer is this many rows
    /// long, whatever [`Store::len`] is, so a view over one stays good until
    /// [`Store::layout_version`] changes.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Goes up whenever the output buffers have been moved or resized.
    pub fn layout_version(&self) -> u32 {
        self.layout_version
    }

    /// Goes up whenever an `advance` has taken up a new positions frame, and
    /// so whenever rows, ids and colours may have changed. Positions and
    /// angles change on every `advance`.
    pub fn rows_version(&self) -> u32 {
        self.rows_version
    }

    /// The whole position buffer, `capacity × 3`: lon and lat in degrees and
    /// altitude in feet times the altitude scale.
    pub fn positions(&self) -> &[f32] {
        &self.out_positions
    }

    /// The whole angle buffer, `capacity`: degrees counter-clockwise, the
    /// negative of track.
    pub fn angles(&self) -> &[f32] {
        &self.out_angles
    }

    /// The whole colour buffer, `capacity × 4`: red, green, blue, alpha by
    /// altitude band.
    pub fn colors(&self) -> &[u8] {
        &self.out_colors
    }

    /// The whole id buffer, `capacity`: the aircraft id of each row.
    pub fn row_ids(&self) -> &[u32] {
        &self.out_ids
    }

    /// Sets what altitude in feet is multiplied by in every position this
    /// store writes. 1 leaves feet; 0 lays the picture flat for 2D; 0.3048
    /// times the vertical exaggeration gives the metres 3D wants. It takes
    /// effect for aircraft at the next `advance`, and at once for tracks and
    /// alerts.
    pub fn set_altitude_scale(&mut self, scale: f32) {
        self.altitude_scale = scale;
        for track in &mut self.tracks {
            track.rescale(scale);
        }
        self.write_alerts();
    }

    // Lookup.

    /// The aircraft in a row of the output buffers, as a pick returns it.
    pub fn id_at(&self, row: usize) -> Option<u32> {
        self.out_ids[..self.rendered].get(row).copied()
    }

    /// The row of an aircraft, if it is in the newest positions frame. It
    /// indexes the output buffers once `advance` has run after that frame.
    pub fn row_of(&self, id: u32) -> Option<usize> {
        self.rows.get(&id).map(|row| *row as usize)
    }

    /// Aircraft in the newest positions frame.
    pub fn aircraft_count(&self) -> usize {
        self.ids.len()
    }

    /// An aircraft's newest sample, as the positions frame gave it.
    pub fn newest(&self, id: u32) -> Option<Position> {
        let row = self.row_of(id)?;
        Some(Position {
            id,
            lat: self.lat1[row],
            lon: self.lon1[row],
            altitude: self.altitude1[row],
            ground_speed: self.ground_speed[row],
            track: self.track1[row],
            vertical_rate: self.vertical_rate[row],
            flags: self.flags[row],
            barometric: self.barometric[row],
        })
    }

    /// What the server said about an aircraft. It is told once per
    /// connection, so this is kept after the aircraft leaves the picture,
    /// until [`Store::reset`].
    pub fn metadata(&self, id: u32) -> Option<&Metadata> {
        self.metadata.get(&id)
    }

    /// The header of the last frame ingested.
    pub fn last_frame(&self) -> Option<FrameInfo> {
        self.last_frame
    }

    // Tracks.

    /// Names the selected aircraft, whose track is held when it arrives.
    pub fn set_selected(&mut self, id: Option<u32>) {
        self.selected = id;
        self.drop_unheld_tracks();
    }

    /// Names the hovered aircraft, whose track is held when it arrives.
    pub fn set_hovered(&mut self, id: Option<u32>) {
        self.hovered = id;
        self.drop_unheld_tracks();
    }

    fn drop_unheld_tracks(&mut self) {
        let (selected, hovered) = (self.selected, self.hovered);
        self.tracks
            .retain(|track| selected == Some(track.id) || hovered == Some(track.id));
    }

    /// Samples in the held track of an aircraft; 0 if none is held.
    pub fn track_len(&self, id: u32) -> usize {
        self.track_times(id).len()
    }

    /// lon, lat and scaled altitude of each sample of a held track, oldest
    /// first. The last is the aircraft's newest sample. The buffer may move
    /// whenever a frame is ingested.
    pub fn track_positions(&self, id: u32) -> &[f32] {
        self.track(id).map_or(&[], |track| &track.positions)
    }

    /// Sim time in seconds of each sample of a held track.
    pub fn track_times(&self, id: u32) -> &[u32] {
        self.track(id).map_or(&[], |track| &track.times)
    }

    /// Points in the trail of a held track as the last `advance` left it;
    /// 0 if none is held.
    pub fn trail_len(&self, id: u32) -> usize {
        self.trail_positions(id).len() / 3
    }

    /// The trail to draw for a held track: lon, lat and scaled altitude of
    /// each sample the aircraft had flown by the time last drawn, oldest
    /// first, then the position its icon was drawn at, so the line ends on
    /// the icon. Written by `advance`; the buffer may move whenever a frame
    /// is ingested.
    pub fn trail_positions(&self, id: u32) -> &[f32] {
        self.track(id).map_or(&[], |track| &track.trail)
    }

    fn track(&self, id: u32) -> Option<&Track> {
        self.tracks.iter().find(|track| track.id == id)
    }

    // Alerts.

    /// Alerts in the newest alerts frame, soonest first, at most
    /// [`MAX_ALERTS`].
    pub fn alert_count(&self) -> usize {
        self.alerts.len()
    }

    /// Two aircraft ids for each alert. This buffer and the two below never
    /// move.
    pub fn alert_ids(&self) -> &[u32] {
        &self.alert_ids
    }

    /// Six values for each alert: lon, lat and scaled altitude of the first
    /// aircraft, then of the second.
    pub fn alert_positions(&self) -> &[f32] {
        &self.alert_positions
    }

    /// Three values for each alert: seconds to the closest approach, the
    /// predicted lateral distance in nautical miles, and the predicted
    /// vertical separation in feet.
    pub fn alert_details(&self) -> &[f32] {
        &self.alert_details
    }
}

/// Degrees in one wire step of track.
const DEGREES_PER_TRACK_STEP: f32 = (360.0 / TRACK_STEPS) as f32;

/// Wire steps of altitude gained in a millisecond at one wire step of
/// vertical rate.
const CLIMB_STEPS_PER_MS: f64 = VERTICAL_RATE_STEP_FPM / ALTITUDE_STEP_FT / 60_000.0;

#[cfg(test)]
mod tests;
