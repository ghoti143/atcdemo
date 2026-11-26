//! Shared core for the ATC demo: the wire format, kinematics, prediction and
//! conflict maths. It does no I/O, so it compiles natively into the server and
//! to WASM for the browser.

pub mod fixture;
pub mod geo;
pub mod recording;
pub mod store;
pub mod wire;

/// Version of the binary wire protocol, sent in every frame header and checked
/// against the client's `hello` message.
pub const PROTOCOL_VERSION: u8 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_set() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }
}
