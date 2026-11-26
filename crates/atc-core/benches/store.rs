//! Times the client's aircraft store, natively: `advance`, which the browser
//! calls every animation frame, and `ingest` of a whole-picture positions
//! frame, which it calls once a second. The design's target for `advance`
//! in the browser is under 2 ms at 50,000 aircraft.
//!
//! ```text
//! cargo bench -p atc-core --bench store
//! ```
//!
//! This is the native build. `bun tools/bench-store.ts` times the same
//! thing in the WASM build, which is the one the target is about.
//!
//! The aircraft are made up here: spread over the coverage area, each flying
//! straight, as fast and as high as real traffic does.

use std::hint::black_box;
use std::time::{Duration, Instant};

use atc_core::geo;
use atc_core::store::Store;
use atc_core::wire::units::{altitude_to_wire, degrees_to_wire, track_to_wire};
use atc_core::wire::{Position, encode_frame};

/// The stress target, and the picture at multiplier 7.
const SIZES: [u32; 2] = [50_000, 60_583];
/// Seconds played, at 60 frames each. The first few are left out.
const SECONDS: u32 = 25;
const WARM_UP_S: u32 = 5;
const FRAME_MS: f64 = 1_000.0 / 60.0;
const TARGET: Duration = Duration::from_millis(2);

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
}

struct Aircraft {
    lat: f64,
    lon: f64,
    track: f64,
    speed: f64,
    altitude: f64,
}

fn fleet(count: u32) -> Vec<Aircraft> {
    let mut random = Random(17);
    (0..count)
        .map(|_| Aircraft {
            lat: 25.0 + 24.0 * random.next(),
            lon: -124.0 + 57.0 * random.next(),
            track: 360.0 * random.next(),
            speed: 120.0 + 400.0 * random.next(),
            altitude: 1_000.0 + 40_000.0 * random.next(),
        })
        .collect()
}

/// Flies every aircraft on a second and returns the positions frame.
fn tick(fleet: &mut [Aircraft], seq: u32) -> Vec<u8> {
    let records: Vec<Position> = fleet
        .iter_mut()
        .enumerate()
        .map(|(id, aircraft)| {
            let (lat, lon) = geo::step(
                aircraft.lat,
                aircraft.lon,
                aircraft.track,
                aircraft.speed / 3_600.0,
            );
            (aircraft.lat, aircraft.lon) = (lat, lon);
            Position {
                id: id as u32,
                lat: degrees_to_wire(lat),
                lon: degrees_to_wire(lon),
                altitude: altitude_to_wire(aircraft.altitude),
                ground_speed: aircraft.speed as u16,
                track: track_to_wire(aircraft.track),
                vertical_rate: 0,
                flags: 0,
                barometric: altitude_to_wire(aircraft.altitude - 200.0),
            }
        })
        .collect();
    let mut bytes = Vec::new();
    encode_frame(&mut bytes, seq, f64::from(seq) * 1_000.0, 0, &records);
    bytes
}

/// The median, the 95th percentile and the longest, in milliseconds.
fn spread(times: &mut [Duration]) -> String {
    times.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1_000.0;
    format!(
        "median {:6.3} ms   95th {:6.3} ms   longest {:6.3} ms",
        ms(times[times.len() / 2]),
        ms(times[times.len() * 95 / 100]),
        ms(times[times.len() - 1]),
    )
}

fn timed(run: impl FnOnce()) -> Duration {
    let start = Instant::now();
    run();
    start.elapsed()
}

/// Times one size and returns the median `advance`.
fn measure(count: u32) -> Duration {
    let mut fleet = fleet(count);
    let mut store = Store::new();
    let (mut ingests, mut first, mut interpolating) = (Vec::new(), Vec::new(), Vec::new());
    let mut reckoning = Vec::new();

    for second in 0..SECONDS {
        let frame = tick(&mut fleet, second);
        let now_ms = f64::from(second) * 1_000.0;
        let took = timed(|| {
            store.ingest(black_box(&frame), now_ms).expect("it decodes");
        });
        for frame in 0..60 {
            let took = timed(|| store.advance(black_box(now_ms + f64::from(frame) * FRAME_MS)));
            if second < WARM_UP_S {
                continue;
            }
            // The first after a frame also takes up its rows and colours.
            if frame == 0 {
                first.push(took);
            } else {
                interpolating.push(took);
            }
        }
        if second >= WARM_UP_S {
            ingests.push(took);
        }
    }
    // The feed stops, and every frame from here is past the newest sample.
    let stopped_ms = f64::from(SECONDS) * 1_000.0;
    for frame in 0..240 {
        let took = timed(|| store.advance(black_box(stopped_ms + f64::from(frame) * FRAME_MS)));
        reckoning.push(took);
    }
    assert_eq!(store.len(), count as usize);
    black_box(store.positions());

    println!("{count} aircraft");
    println!("  advance, interpolating    {}", spread(&mut interpolating));
    println!("  advance, dead reckoning   {}", spread(&mut reckoning));
    println!("  advance, first after one  {}", spread(&mut first));
    println!("  ingest a positions frame  {}", spread(&mut ingests));
    interpolating[interpolating.len() / 2].max(reckoning[reckoning.len() / 2])
}

fn main() {
    let slowest = SIZES.map(measure).into_iter().max().expect("two sizes");
    if slowest > TARGET {
        println!("the median advance passed the {TARGET:?} target");
        std::process::exit(1);
    }
    println!("every median advance was under the {TARGET:?} target");
}
