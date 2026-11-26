//! `Store::advance` runs every animation frame, so it must not allocate.
//!
//! This is a test binary of its own because it counts every allocation the
//! process makes, and must be the only test running while it counts.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use atc_core::store::Store;
use atc_core::wire::{Position, encode_frame};

struct Counting;

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is passed straight to the system allocator.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn frame(sim_s: u32, aircraft: u32) -> Vec<u8> {
    let records: Vec<Position> = (0..aircraft)
        .map(|id| Position {
            id,
            lat: 400_000_000 + (id * 1_000 + sim_s * 500) as i32,
            lon: -1_000_000_000,
            altitude: (id % 1_600) as i16,
            ground_speed: 400,
            track: (id * 7) as u16,
            ..Position::default()
        })
        .collect();
    let mut bytes = Vec::new();
    encode_frame(&mut bytes, sim_s, f64::from(sim_s) * 1_000.0, 0, &records);
    bytes
}

#[test]
fn advance_allocates_nothing() {
    let mut store = Store::new();
    store.ingest(&frame(10, 5_000), 10_000.0).unwrap();
    // The aircraft change from frame to frame, as they do in a viewport.
    let frames = [frame(11, 4_000), frame(12, 5_000), frame(15, 4_500)];

    let before = ALLOCATIONS.load(Ordering::Relaxed);
    // The first frame, between two samples, then past the newest.
    for render_ms in [10_000.0, 10_500.0, 11_000.0, 11_700.0, 30_000.0] {
        store.advance(render_ms);
    }
    let advancing = ALLOCATIONS.load(Ordering::Relaxed) - before;
    assert_eq!(advancing, 0);
    assert_eq!(store.len(), 5_000);

    // Nor does it once frames come and go, the first advance after each
    // one included.
    let mut advancing = 0;
    for (bytes, received_ms) in frames.iter().zip([31_000.0, 32_000.0, 35_000.0]) {
        store.ingest(bytes, received_ms).unwrap();
        let before = ALLOCATIONS.load(Ordering::Relaxed);
        for frame in 0..90 {
            store.advance(received_ms + f64::from(frame) * 16.0);
        }
        advancing += ALLOCATIONS.load(Ordering::Relaxed) - before;
    }
    assert_eq!(advancing, 0);
    assert_eq!(store.len(), 4_500);

    // The count does see allocations: an ingest that grows the store makes
    // some.
    let before = ALLOCATIONS.load(Ordering::Relaxed);
    store.ingest(&frame(16, 20_000), 36_000.0).unwrap();
    assert!(ALLOCATIONS.load(Ordering::Relaxed) > before);
}
