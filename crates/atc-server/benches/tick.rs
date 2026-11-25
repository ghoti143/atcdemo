//! Times one server tick on the committed recording at multiplier 7, which
//! is about 60,000 aircraft: advancing the simulation, updating the world
//! state, and building the whole-picture frame every client shares. The
//! design's target for the three together is under 100 ms.
//!
//! ```text
//! cargo bench -p atc-server --bench tick
//! ```
//!
//! It also times the whole-area grid query on the same picture, which is
//! what a zoomed-out client with a viewport costs.

use std::hint::black_box;
use std::path::Path;
use std::time::{Duration, Instant};

use atc_server::hub::whole_picture;
use atc_server::seed;
use atc_server::sim::replay::Replay;
use atc_server::sim::{Feed, Tick};
use atc_server::world::{COVERAGE, COVERAGE_MARGIN, WorldWriter};

const MULTIPLIER: u32 = 7;
/// Ticks left out of the figures: the first announces every aircraft.
const WARM_UP: usize = 5;
const TICKS: usize = 300;
const TARGET: Duration = Duration::from_millis(100);

/// The median, the 95th percentile and the longest, in milliseconds.
fn spread(mut times: Vec<Duration>) -> String {
    times.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1_000.0;
    format!(
        "median {:6.2} ms   95th {:6.2} ms   longest {:6.2} ms",
        ms(times[times.len() / 2]),
        ms(times[times.len() * 95 / 100]),
        ms(times[times.len() - 1]),
    )
}

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/seed/flights.bin.gz");
    let recording = seed::load(&path).expect("the committed seed file");
    let mut replay = Replay::with_multiplier(recording, MULTIPLIER).expect("a recording");
    let mut world = WorldWriter::new();
    let reader = world.reader();
    let mut tick = Tick::default();
    let mut records = Vec::new();

    let (mut advance, mut update, mut picture, mut whole, mut query) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut aircraft = 0;
    let mut frame_bytes = 0;
    for n in 0..WARM_UP + TICKS {
        let started = Instant::now();
        replay.advance(&mut tick);
        let advanced = Instant::now();
        world.update(&tick);
        let updated = Instant::now();
        let snapshot = reader.latest();
        let frame = whole_picture(&snapshot, &mut records);
        let built = Instant::now();
        let in_view = snapshot.query(COVERAGE, COVERAGE_MARGIN).count();
        let queried = Instant::now();
        black_box((&frame, in_view));

        if n >= WARM_UP {
            advance.push(advanced - started);
            update.push(updated - advanced);
            picture.push(built - updated);
            whole.push(built - started);
            query.push(queried - built);
        }
        aircraft = tick.positions.len();
        frame_bytes = frame.len();
    }

    println!(
        "{aircraft} aircraft at multiplier {MULTIPLIER}, {TICKS} ticks, a frame of {frame_bytes} bytes"
    );
    println!("advance the simulation    {}", spread(advance));
    println!("update the world state    {}", spread(update));
    println!("build the whole picture   {}", spread(picture));
    println!("the three together        {}", spread(whole.clone()));
    println!("query the whole area      {}", spread(query));

    let longest = whole.iter().max().copied().unwrap_or_default();
    if longest > TARGET {
        println!("OVER the {TARGET:?} target: the longest tick took {longest:?}");
        std::process::exit(1);
    }
    println!("every tick was under the {TARGET:?} target");
}
