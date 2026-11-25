//! Browser bindings for `atc-core`.

use wasm_bindgen::prelude::*;

/// The wire protocol version this module speaks.
#[wasm_bindgen]
pub fn protocol_version() -> u8 {
    atc_core::PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_core_protocol_version() {
        assert_eq!(protocol_version(), atc_core::PROTOCOL_VERSION);
    }
}
