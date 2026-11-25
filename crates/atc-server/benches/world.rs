//! Times the world state at 50,000 aircraft: building one tick's picture,
//! and the grid query for boxes of several sizes.
//!
//! ```text
//! cargo bench -p atc-server --bench world
//! ```
//!
//! The aircraft are made up here. One picture spreads them evenly over the
//! coverage area; the other gathers most of them round thirty points, as
//! real traffic gathers round airports, which fills some cells far more than
//! others.

use std::hint::black_box;
use std::time::{Duration, Instant};

use atc_core::wire::units::degrees_to_wire;
use atc_core::wire::{Metadata, Position};
use atc_server::sim::Tick;
use atc_server::world::{Bbox, COVERAGE, World, WorldWriter};

const AIRCRAFT: u32 = 50_000;
const HUBS: usize = 30;
const RUNS: usize = 200;

/// SplitMix64: small, fast and the same on every machine.
struct Random(u64);

impl Random {
    /// A number from 0 up to, not including, 1.
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }

    /// A point in the coverage area, in wire units.
    fn point(&mut self) -> (i32, i32) {
        let lat = f64::from(COVERAGE.north - COVERAGE.south) * self.next();
        let lon = f64::from(COVERAGE.east - COVERAGE.west) * self.next();
        (COVERAGE.south + lat as i32, COVERAGE.west + lon as i32)
    }
}

/// A tick in which `AIRCRAFT` aircraft have just appeared. With `clustered`,
/// four in five of them are within about a degree of one of the hubs.
fn tick(clustered: bool) -> Tick {
    let mut random = Random(17);
    let hubs: Vec<(i32, i32)> = (0..HUBS).map(|_| random.point()).collect();
    let mut tick = Tick::default();
    for id in 1..=AIRCRAFT {
        let (lat, lon) = if clustered && id % 5 != 0 {
            let (lat, lon) = hubs[id as usize % HUBS];
            // The sum of three even spreads is near enough a bell curve.
            let mut spread = || (random.next() + random.next() + random.next() - 1.5) * 1.5;
            (
                lat + degrees_to_wire(spread()),
                lon + degrees_to_wire(spread()),
            )
        } else {
            random.point()
        };
        tick.positions.push(Position {
            id,
            lat,
            lon,
            ..Position::default()
        });
        tick.appeared.push(Metadata {
            aircraft_id: id,
            ..Metadata::default()
        });
    }
    tick
}

/// Runs `work` `RUNS` times and prints the median and the slowest.
fn time<T>(name: &str, mut work: impl FnMut() -> T) {
    let mut times: Vec<Duration> = (0..RUNS)
        .map(|_| {
            let started = Instant::now();
            black_box(work());
            started.elapsed()
        })
        .collect();
    times.sort_unstable();
    println!(
        "  {name:<52} median {:>9.1?}  slowest {:>9.1?}",
        times[RUNS / 2],
        times[RUNS - 1]
    );
}

fn bbox(south: f64, west: f64, north: f64, east: f64) -> Bbox {
    Bbox {
        south: degrees_to_wire(south),
        west: degrees_to_wire(west),
        north: degrees_to_wire(north),
        east: degrees_to_wire(east),
    }
}

/// Copies out the positions a query finds, as the hub will to build a frame.
fn query(world: &World, bbox: Bbox, out: &mut Vec<Position>) -> usize {
    out.clear();
    out.extend(world.query(bbox, 0).map(|row| world.position(row)));
    out.len()
}

fn main() {
    for (name, clustered) in [("spread evenly", false), ("clustered", true)] {
        println!("{AIRCRAFT} aircraft, {name}");
        let mut tick = tick(clustered);
        let mut writer = WorldWriter::new();
        let reader = writer.reader();

        time("build the picture, every aircraft new", || {
            writer.update(&tick)
        });
        // From here on the metadata is carried over, as in most ticks.
        tick.appeared.clear();
        time("build the picture, none new", || writer.update(&tick));

        let world = reader.latest();
        let mut out = Vec::with_capacity(world.len());
        // The clustered picture's busiest hub, for the small boxes.
        let (lat, lon) = busiest_degree(&world);
        let boxes = [
            ("the whole coverage area", COVERAGE),
            (
                "a region, 10 by 15 degrees",
                bbox(33.0, -100.0, 43.0, -85.0),
            ),
            (
                "a metro area, 2 by 3 degrees",
                bbox(lat - 0.5, lon - 1.0, lat + 1.5, lon + 2.0),
            ),
            (
                "a terminal area, 0.5 by 0.75 degrees",
                bbox(lat + 0.25, lon + 0.1, lat + 0.75, lon + 0.85),
            ),
        ];
        for (name, bbox) in boxes {
            let count = query(&world, bbox, &mut out);
            time(&format!("query {name} ({count})"), || {
                query(&world, bbox, &mut out)
            });
        }
        time("scan every aircraft for the terminal area", || {
            let bbox = boxes[3].1;
            (0..world.len())
                .map(|row| world.position(row))
                .filter(|position| bbox.contains(position.lat, position.lon))
                .count()
        });
        println!();
    }
}

/// The south-west corner, in whole degrees, of the one degree square with
/// the most aircraft in it.
fn busiest_degree(world: &World) -> (f64, f64) {
    let mut busiest = (0, 0.0, 0.0);
    for lat in 24..50 {
        for lon in -125..-66 {
            let (lat, lon) = (f64::from(lat), f64::from(lon));
            let count = world.query(bbox(lat, lon, lat + 1.0, lon + 1.0), 0).count();
            if count > busiest.0 {
                busiest = (count, lat, lon);
            }
        }
    }
    (busiest.1, busiest.2)
}
