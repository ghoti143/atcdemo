//! Browser bindings for `atc-core`.

use wasm_bindgen::prelude::*;

mod store;

pub use store::AircraftStore;

/// The wire protocol version this module speaks.
#[wasm_bindgen]
pub fn protocol_version() -> u8 {
    atc_core::PROTOCOL_VERSION
}

/// A block of `f32` values owned by Rust, which JavaScript reads in place
/// through a `Float32Array` view over WASM memory.
///
/// This is the milestone 1 spike that proves the zero-copy path. The real
/// aircraft store replaces it in milestone 3.
#[wasm_bindgen]
pub struct SpikeBuffer {
    values: Vec<f32>,
}

#[wasm_bindgen]
impl SpikeBuffer {
    /// Allocates `count` values, all zero.
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize) -> SpikeBuffer {
        SpikeBuffer {
            values: vec![0.0; count],
        }
    }

    /// Sets value `i` to `i * scale`.
    pub fn fill(&mut self, scale: f32) {
        for (i, value) in self.values.iter_mut().enumerate() {
            *value = i as f32 * scale;
        }
    }

    /// Byte offset of the first value in WASM memory. It stays valid until
    /// the buffer is freed, but a view built on it detaches whenever WASM
    /// memory grows.
    pub fn ptr(&self) -> *const f32 {
        self.values.as_ptr()
    }

    /// Number of values.
    pub fn count(&self) -> usize {
        self.values.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_core_protocol_version() {
        assert_eq!(protocol_version(), atc_core::PROTOCOL_VERSION);
    }

    #[test]
    fn fill_scales_each_index() {
        let mut buffer = SpikeBuffer::new(4);
        buffer.fill(0.5);

        assert_eq!(buffer.count(), 4);
        assert_eq!(buffer.values, [0.0, 0.5, 1.0, 1.5]);
    }
}
