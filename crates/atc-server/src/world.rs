//! The shared picture of where everything is, and a fast way to ask what is
//! inside a box.
//!
//! Each tick the simulator's picture is built into a new [`World`], which is
//! never changed afterwards. A [`WorldReader`] hands out the latest one, so a
//! reader works from one consistent tick for as long as it likes and never
//! holds the simulator up.

use std::collections::HashMap;
use std::sync::Arc;

use atc_core::wire::{Metadata, Position};
use tokio::sync::watch;

use crate::sim::Tick;

/// A box on the map, in wire units (1e-7 degrees). Its edges are inside it.
///
/// A box whose west is greater than its east crosses the antimeridian. One
/// whose south is greater than its north holds nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bbox {
    pub south: i32,
    pub west: i32,
    pub north: i32,
    pub east: i32,
}

impl Bbox {
    /// Whether the point is in the box.
    pub fn contains(&self, lat: i32, lon: i32) -> bool {
        let in_lon = if self.west <= self.east {
            self.west <= lon && lon <= self.east
        } else {
            lon >= self.west || lon <= self.east
        };
        self.south <= lat && lat <= self.north && in_lon
    }

    /// The box with every edge moved out by `margin`.
    pub fn grown(&self, margin: u32) -> Bbox {
        let mut west = self.west.saturating_sub_unsigned(margin);
        let mut east = self.east.saturating_add_unsigned(margin);
        if self.west > self.east && west <= east {
            // The two ends have met, so it now goes all the way round.
            (west, east) = (i32::MIN, i32::MAX);
        }
        Bbox {
            south: self.south.saturating_sub_unsigned(margin),
            west,
            north: self.north.saturating_add_unsigned(margin),
            east,
        }
    }
}

/// The coverage area: the continental United States.
pub const COVERAGE: Bbox = Bbox {
    south: 244_000_000,
    west: -1_250_000_000,
    north: 494_000_000,
    east: -669_000_000,
};

/// How far outside the coverage area the recording keeps a flight: half a
/// degree.
pub const COVERAGE_MARGIN: u32 = 5_000_000;

/// The side of a grid cell: half a degree, about 30 nm north to south.
const CELL: i64 = 5_000_000;

/// What the grid covers: the coverage area and its margin.
const GRID: Bbox = Bbox {
    south: COVERAGE.south - COVERAGE_MARGIN as i32,
    west: COVERAGE.west - COVERAGE_MARGIN as i32,
    north: COVERAGE.north + COVERAGE_MARGIN as i32,
    east: COVERAGE.east + COVERAGE_MARGIN as i32,
};
const ROWS: usize = cells_across(GRID.south, GRID.north);
const COLS: usize = cells_across(GRID.west, GRID.east);

const fn cells_across(low: i32, high: i32) -> usize {
    (high as i64 - low as i64)
        .unsigned_abs()
        .div_ceil(CELL as u64) as usize
}

/// The grid row or column of a coordinate. One that is off the grid goes in
/// the nearest edge cell, so no aircraft is ever left out.
fn cell_along(value: i32, low: i32, cells: usize) -> usize {
    let cell = (i64::from(value) - i64::from(low)).div_euclid(CELL);
    cell.clamp(0, cells as i64 - 1) as usize
}

/// The picture at one tick: every aircraft's state and metadata, held as one
/// column per field and ordered by grid cell.
///
/// A row is an aircraft's place in the columns. It means nothing in any other
/// `World`.
#[derive(Debug, Clone)]
pub struct World {
    sim_time_s: u32,
    new_pass: bool,
    ids: Vec<u32>,
    lat: Vec<i32>,
    lon: Vec<i32>,
    altitude: Vec<i16>,
    ground_speed: Vec<u16>,
    track: Vec<u16>,
    vertical_rate: Vec<i8>,
    flags: Vec<u8>,
    metadata: Vec<Metadata>,
    /// By cell, row-major from the south-west: its first row. The cell's
    /// rows end where the next cell's start, and there is one more entry
    /// than there are cells.
    cell_start: Vec<u32>,
    /// Every row, in order of aircraft id.
    by_id: Vec<u32>,
}

impl Default for World {
    /// The picture before the first tick: nothing.
    fn default() -> World {
        World::build(None, &Tick::default())
    }
}

impl World {
    /// The picture at `tick`. Metadata for an aircraft that did not appear
    /// in this tick is carried over from `previous`, the tick before.
    fn build(previous: Option<&World>, tick: &Tick) -> World {
        let count = tick.positions.len();
        let cell_of = |position: &Position| {
            cell_along(position.lat, GRID.south, ROWS) * COLS
                + cell_along(position.lon, GRID.west, COLS)
        };

        // A counting sort by cell: count each cell's aircraft, turn the
        // counts into each cell's first row, then deal the aircraft out.
        let mut cell_start = vec![0u32; ROWS * COLS + 1];
        for position in &tick.positions {
            cell_start[cell_of(position) + 1] += 1;
        }
        for cell in 0..ROWS * COLS {
            cell_start[cell + 1] += cell_start[cell];
        }

        let mut world = World {
            sim_time_s: tick.sim_time_s,
            new_pass: tick.new_pass,
            ids: vec![0; count],
            lat: vec![0; count],
            lon: vec![0; count],
            altitude: vec![0; count],
            ground_speed: vec![0; count],
            track: vec![0; count],
            vertical_rate: vec![0; count],
            flags: vec![0; count],
            metadata: Vec::with_capacity(count),
            by_id: (0..count as u32).collect(),
            cell_start,
        };
        let mut next_row = world.cell_start.clone();
        for position in &tick.positions {
            let next = &mut next_row[cell_of(position)];
            let row = *next as usize;
            *next += 1;
            world.ids[row] = position.id;
            world.lat[row] = position.lat;
            world.lon[row] = position.lon;
            world.altitude[row] = position.altitude;
            world.ground_speed[row] = position.ground_speed;
            world.track[row] = position.track;
            world.vertical_rate[row] = position.vertical_rate;
            world.flags[row] = position.flags;
        }
        let ids = &world.ids;
        world.by_id.sort_unstable_by_key(|&row| ids[row as usize]);

        let appeared: HashMap<u32, &Metadata> = tick
            .appeared
            .iter()
            .map(|metadata| (metadata.aircraft_id, metadata))
            .collect();
        world.metadata.extend(ids.iter().map(|&id| {
            let carried = || previous.and_then(|world| Some(*world.metadata(world.row_of(id)?)));
            // A feed that never announced the aircraft has broken its
            // promise; the aircraft is kept, with nothing known about it.
            appeared
                .get(&id)
                .map(|metadata| **metadata)
                .or_else(carried)
                .unwrap_or(Metadata {
                    aircraft_id: id,
                    ..Metadata::default()
                })
        }));
        world
    }

    /// Seconds of sim time at this tick.
    pub fn sim_time_s(&self) -> u32 {
        self.sim_time_s
    }

    /// Whether this is the first tick of a new pass through a recording.
    pub fn new_pass(&self) -> bool {
        self.new_pass
    }

    /// How many aircraft are in the picture. Rows run from 0 to this.
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// The row of the aircraft `id`, if it is in the picture.
    pub fn row_of(&self, id: u32) -> Option<usize> {
        let found = self
            .by_id
            .binary_search_by_key(&id, |&row| self.ids[row as usize]);
        found.ok().map(|index| self.by_id[index] as usize)
    }

    /// The state of the aircraft in `row`, as a positions frame carries it.
    pub fn position(&self, row: usize) -> Position {
        Position {
            id: self.ids[row],
            lat: self.lat[row],
            lon: self.lon[row],
            altitude: self.altitude[row],
            ground_speed: self.ground_speed[row],
            track: self.track[row],
            vertical_rate: self.vertical_rate[row],
            flags: self.flags[row],
        }
    }

    /// What a client is told once about the aircraft in `row`.
    pub fn metadata(&self, row: usize) -> &Metadata {
        &self.metadata[row]
    }

    /// The rows of the aircraft inside `bbox` grown by `margin`, which is in
    /// wire units like the box.
    pub fn query(&self, bbox: Bbox, margin: u32) -> impl Iterator<Item = usize> + '_ {
        let bbox = bbox.grown(margin);
        let rows =
            cell_along(bbox.south, GRID.south, ROWS)..=cell_along(bbox.north, GRID.south, ROWS);
        let (first_col, last_col) = if bbox.west <= bbox.east {
            (
                cell_along(bbox.west, GRID.west, COLS),
                cell_along(bbox.east, GRID.west, COLS),
            )
        } else {
            (0, COLS - 1)
        };
        // Cells that are side by side hold a single run of rows.
        rows.flat_map(move |row| {
            let start = self.cell_start[row * COLS + first_col] as usize;
            let end = self.cell_start[row * COLS + last_col + 1] as usize;
            start..end
        })
        .filter(move |&row| bbox.contains(self.lat[row], self.lon[row]))
    }
}

/// The simulator's end of the world state. It builds each tick's [`World`]
/// and publishes it to the readers.
#[derive(Debug)]
pub struct WorldWriter {
    latest: watch::Sender<Arc<World>>,
}

impl Default for WorldWriter {
    fn default() -> WorldWriter {
        WorldWriter::new()
    }
}

impl WorldWriter {
    /// A writer whose readers see an empty picture until the first tick.
    pub fn new() -> WorldWriter {
        WorldWriter {
            latest: watch::Sender::new(Arc::new(World::default())),
        }
    }

    /// A handle on whatever this writer publishes.
    pub fn reader(&self) -> WorldReader {
        WorldReader {
            latest: self.latest.subscribe(),
        }
    }

    /// Replaces the picture with the one at `tick`. Readers still holding
    /// an older one keep it.
    pub fn update(&mut self, tick: &Tick) {
        let previous = self.latest.borrow().clone();
        let next = World::build(Some(&previous), tick);
        self.latest.send_replace(Arc::new(next));
    }
}

/// A snapshot handle: gives out the latest [`World`]. Cloning it is cheap,
/// and each clone keeps track of what it has seen by itself.
#[derive(Debug, Clone)]
pub struct WorldReader {
    latest: watch::Receiver<Arc<World>>,
}

impl WorldReader {
    /// The picture at the latest tick. It never changes, however long it is
    /// held.
    pub fn latest(&self) -> Arc<World> {
        self.latest.borrow().clone()
    }

    /// Waits for a picture this reader has not been given by `next` before,
    /// and returns the latest. A reader that falls behind skips ticks. `None`
    /// once the writer has gone.
    pub async fn next(&mut self) -> Option<Arc<World>> {
        self.latest.changed().await.ok()?;
        Some(self.latest.borrow_and_update().clone())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::sim::Feed;
    use crate::sim::replay::Replay;
    use atc_core::fixture;
    use atc_core::wire::units::degrees_to_wire;

    fn bbox(south: f64, west: f64, north: f64, east: f64) -> Bbox {
        Bbox {
            south: degrees_to_wire(south),
            west: degrees_to_wire(west),
            north: degrees_to_wire(north),
            east: degrees_to_wire(east),
        }
    }

    /// A tick in which aircraft 1, 2, 3 and so on have just appeared at the
    /// given latitudes and longitudes.
    fn tick_at(points: &[(f64, f64)]) -> Tick {
        let mut tick = Tick::default();
        for (index, &(lat, lon)) in points.iter().enumerate() {
            let id = index as u32 + 1;
            tick.positions.push(Position {
                id,
                lat: degrees_to_wire(lat),
                lon: degrees_to_wire(lon),
                ..Position::default()
            });
            tick.appeared.push(Metadata {
                aircraft_id: id,
                flight_id: index as u32,
                ..Metadata::default()
            });
        }
        tick
    }

    fn world_at(points: &[(f64, f64)]) -> World {
        World::build(None, &tick_at(points))
    }

    /// The ids a query finds, in order.
    fn found(world: &World, bbox: Bbox, margin: u32) -> Vec<u32> {
        let mut ids: Vec<u32> = world
            .query(bbox, margin)
            .map(|row| world.position(row).id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// The ids of the positions in the box, found the slow way.
    fn expected(positions: &[Position], bbox: Bbox) -> Vec<u32> {
        let inside = positions
            .iter()
            .filter(|position| bbox.contains(position.lat, position.lon));
        let mut ids: Vec<u32> = inside.map(|position| position.id).collect();
        ids.sort_unstable();
        ids
    }

    #[test]
    fn the_grid_covers_the_coverage_area_and_its_margin() {
        assert_eq!(GRID, COVERAGE.grown(COVERAGE_MARGIN));
        // 26 degrees of latitude and 59.1 of longitude, in half degrees.
        assert_eq!((ROWS, COLS), (52, 119));
    }

    #[test]
    fn a_world_holds_every_aircraft_in_the_tick() {
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        for _ in 0..=300 {
            replay.advance(&mut tick);
        }
        let world = World::build(None, &tick);

        assert_eq!(world.sim_time_s(), 300);
        assert!(!world.new_pass());
        assert_eq!(world.len(), tick.positions.len());
        assert!(!world.is_empty());
        for position in &tick.positions {
            let row = world.row_of(position.id).unwrap();
            assert_eq!(world.position(row), *position);
        }
        assert_eq!(world.row_of(0), None);
        assert_eq!(world.row_of(u32::MAX), None);
    }

    #[test]
    fn a_query_finds_what_a_scan_of_every_aircraft_finds() {
        let boxes = [
            COVERAGE,
            bbox(38.0, -92.0, 43.0, -85.0),
            bbox(39.0, -80.0, 40.2, -76.0),
            bbox(40.9, -90.1, 41.1, -89.9),
            bbox(25.0, -124.0, 30.0, -110.0),
            bbox(-90.0, -180.0, 90.0, 180.0),
        ];
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut writer = WorldWriter::new();
        let reader = writer.reader();
        let mut tick = Tick::default();
        let mut some_found = false;
        for _ in 0..fixture::WINDOW_S + 60 {
            replay.advance(&mut tick);
            writer.update(&tick);
            let world = reader.latest();
            for bbox in boxes {
                let ids = found(&world, bbox, 0);
                assert_eq!(ids, expected(&tick.positions, bbox));
                some_found |= !ids.is_empty() && ids.len() < world.len();
            }
        }
        assert!(some_found);
    }

    #[test]
    fn the_edges_of_a_box_are_inside_it() {
        let world = world_at(&[
            (40.0, -100.0),
            (40.0, -99.0),
            (41.0, -100.0),
            (41.0, -99.0),
            (40.5, -99.5),
        ]);
        assert_eq!(
            found(&world, bbox(40.0, -100.0, 41.0, -99.0), 0),
            [1, 2, 3, 4, 5]
        );

        // One wire unit in from each edge leaves only the middle.
        let inner = Bbox {
            south: degrees_to_wire(40.0) + 1,
            west: degrees_to_wire(-100.0) + 1,
            north: degrees_to_wire(41.0) - 1,
            east: degrees_to_wire(-99.0) - 1,
        };
        assert_eq!(found(&world, inner, 0), [5]);
        assert_eq!(found(&world, inner, 1), [1, 2, 3, 4, 5]);
    }

    #[test]
    fn the_margin_widens_the_box_on_every_side() {
        let world = world_at(&[
            (40.5, -99.5),
            (39.8, -99.5),
            (41.2, -99.5),
            (40.5, -100.2),
            (40.5, -98.8),
            (39.0, -99.5),
        ]);
        let viewport = bbox(40.0, -100.0, 41.0, -99.0);

        assert_eq!(found(&world, viewport, 0), [1]);
        assert_eq!(
            found(&world, viewport, degrees_to_wire(0.25) as u32),
            [1, 2, 3, 4, 5]
        );
        assert_eq!(found(&world, viewport, u32::MAX), [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn aircraft_at_the_edges_of_the_coverage_area_are_found() {
        // The four corners of the coverage area, then the four corners of
        // its margin, which are the corners of the grid.
        let world = world_at(&[
            (24.4, -125.0),
            (24.4, -66.9),
            (49.4, -125.0),
            (49.4, -66.9),
            (23.9, -125.5),
            (23.9, -66.4),
            (49.9, -125.5),
            (49.9, -66.4),
        ]);

        assert_eq!(found(&world, COVERAGE, 0), [1, 2, 3, 4]);
        assert_eq!(
            found(&world, COVERAGE, COVERAGE_MARGIN),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert_eq!(found(&world, bbox(49.0, -70.0, 50.0, -66.0), 0), [4, 8]);
        assert_eq!(found(&world, bbox(23.9, -125.5, 23.9, -125.5), 0), [5]);
        // A box with one corner on the coverage area's corner.
        assert_eq!(found(&world, bbox(24.4, -125.0, 25.0, -124.0), 0), [1]);
    }

    #[test]
    fn aircraft_off_the_grid_are_kept_and_found_where_they_are() {
        let world = world_at(&[
            (20.0, -100.0),
            (55.0, -100.0),
            (40.0, -130.0),
            (40.0, -60.0),
            (60.0, -140.0),
            (-90.0, -180.0),
            (90.0, 180.0),
            (40.0, -100.0),
        ]);
        assert_eq!(world.len(), 8);

        assert_eq!(found(&world, COVERAGE, COVERAGE_MARGIN), [8]);
        assert_eq!(found(&world, bbox(19.0, -101.0, 21.0, -99.0), 0), [1]);
        assert_eq!(found(&world, bbox(54.0, -101.0, 56.0, -99.0), 0), [2]);
        assert_eq!(found(&world, bbox(39.0, -131.0, 41.0, -129.0), 0), [3]);
        assert_eq!(found(&world, bbox(39.0, -61.0, 41.0, -59.0), 0), [4]);
        assert_eq!(found(&world, bbox(50.0, -150.0, 70.0, -126.0), 0), [5]);
        // A box wholly off the grid looks in the edge cells and finds only
        // what is really inside it.
        assert_eq!(found(&world, bbox(50.0, -100.5, 54.0, -99.5), 0), [0u32; 0]);
        assert_eq!(
            found(&world, bbox(-90.0, -180.0, 90.0, 180.0), 0),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
        let everywhere = Bbox {
            south: i32::MIN,
            west: i32::MIN,
            north: i32::MAX,
            east: i32::MAX,
        };
        assert_eq!(found(&world, everywhere, u32::MAX).len(), 8);
    }

    #[test]
    fn a_box_can_cross_the_antimeridian_and_an_upside_down_one_is_empty() {
        let world = world_at(&[(40.0, -100.0), (40.0, -70.0), (40.0, -124.0)]);

        // From 100°E eastwards over the Pacific to 90°W.
        let pacific = bbox(30.0, 100.0, 50.0, -90.0);
        assert_eq!(found(&world, pacific, 0), [1, 3]);
        // Its ends meet once it has grown far enough.
        assert_eq!(pacific.grown(degrees_to_wire(100.0) as u32).west, i32::MIN);
        assert_eq!(
            found(&world, pacific, degrees_to_wire(100.0) as u32),
            [1, 2, 3]
        );

        assert_eq!(found(&world, bbox(41.0, -101.0, 39.0, -99.0), 0), [0u32; 0]);
    }

    #[test]
    fn metadata_is_kept_for_as_long_as_an_aircraft_is_in_the_picture() {
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut writer = WorldWriter::new();
        let reader = writer.reader();
        let mut tick = Tick::default();
        let mut announced: HashMap<u32, Metadata> = HashMap::new();
        let mut carried_over = 0;
        // Past the end of the first pass, where every aircraft is replaced.
        for _ in 0..fixture::WINDOW_S + 60 {
            replay.advance(&mut tick);
            writer.update(&tick);
            for metadata in &tick.appeared {
                announced.insert(metadata.aircraft_id, *metadata);
            }

            let world = reader.latest();
            assert_eq!(world.new_pass(), tick.new_pass);
            assert_eq!(world.len(), tick.positions.len());
            for position in &tick.positions {
                let row = world.row_of(position.id).unwrap();
                assert_eq!(world.metadata(row), &announced[&position.id]);
            }
            carried_over += tick.positions.len() - tick.appeared.len();
        }
        assert!(carried_over > 0);
    }

    #[test]
    fn an_aircraft_that_was_never_announced_is_kept_with_only_its_id() {
        let mut tick = tick_at(&[(40.0, -100.0), (41.0, -100.0)]);
        tick.appeared.truncate(1);
        let world = World::build(None, &tick);

        let row = world.row_of(2).unwrap();
        let unknown = Metadata {
            aircraft_id: 2,
            ..Metadata::default()
        };
        assert_eq!(world.metadata(row), &unknown);
    }

    #[test]
    fn a_snapshot_does_not_change_while_the_simulator_moves_on() {
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut writer = WorldWriter::new();
        let reader = writer.reader();
        assert!(reader.latest().is_empty());

        let mut tick = Tick::default();
        replay.advance(&mut tick);
        writer.update(&tick);
        let held = reader.latest();
        let first = tick.clone();

        for _ in 0..30 {
            replay.advance(&mut tick);
            writer.update(&tick);
        }
        assert_eq!(held.sim_time_s(), 0);
        for position in &first.positions {
            let row = held.row_of(position.id).unwrap();
            assert_eq!(held.position(row), *position);
        }
        assert_eq!(reader.latest().sim_time_s(), 30);
    }

    #[tokio::test]
    async fn a_reader_waits_for_the_next_tick_and_skips_the_ones_it_missed() {
        let mut writer = WorldWriter::new();
        let mut reader = writer.reader();
        let mut tick = Tick::default();

        for sim_time_s in 1..=3 {
            tick.sim_time_s = sim_time_s;
            writer.update(&tick);
        }
        assert_eq!(reader.next().await.unwrap().sim_time_s(), 3);

        let waiting = tokio::spawn(async move { reader.next().await.map(|w| w.sim_time_s()) });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        tick.sim_time_s = 4;
        writer.update(&tick);
        assert_eq!(waiting.await.unwrap(), Some(4));

        let mut reader = writer.reader();
        drop(writer);
        assert!(reader.next().await.is_none());
    }
}
