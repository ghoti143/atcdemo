//! The lines the client prints. Each function returns one line, without its
//! line ending.

use atc_core::wire::units::{
    altitude_from_wire, degrees_from_wire, ground_speed_from_wire, text_from_wire, track_from_wire,
    vertical_rate_from_wire,
};
use atc_core::wire::{FLAG_ON_GROUND, FLAG_SYNTHETIC, TrackSample};

use crate::session::{Aircraft, TickSummary, Totals};

/// A whole number with its thousands separated: `-1,984`.
pub fn grouped(number: i64) -> String {
    let digits = number.unsigned_abs().to_string();
    let mut text = String::from(if number < 0 { "-" } else { "" });
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    text
}

/// Sim time as hours, minutes and seconds: `01:02:03`.
pub fn clock(sim_time_ms: f64) -> String {
    let seconds = (sim_time_ms / 1_000.0) as u64;
    let (hours, minutes) = (seconds / 3_600, seconds / 60 % 60);
    format!("{hours:02}:{minutes:02}:{:02}", seconds % 60)
}

/// The `sim` message.
pub fn sim_line(multiplier: u64, window_s: u64) -> String {
    format!(
        "sim: multiplier {multiplier}, a pass lasts {} ({} s)",
        clock(window_s as f64 * 1_000.0),
        grouped(window_s as i64)
    )
}

/// An `error` message.
pub fn refusal_line(code: &str, message: &str) -> String {
    format!("error {code}: {message}")
}

/// One tick. The columns are always there; what follows them is only there
/// when it is not the usual: skipped ticks, aircraft that were never
/// announced, and the start of a new pass.
pub fn tick_line(tick: &TickSummary) -> String {
    let mut line = format!(
        "seq {:>6}  t {}  aircraft {:>6}  new {:>6}  {:>9} B",
        tick.seq,
        clock(tick.sim_time_ms),
        grouped(tick.aircraft as i64),
        grouped(tick.announced as i64),
        grouped(tick.bytes as i64),
    );
    if tick.skipped > 0 {
        line += &format!("  skipped {}", grouped(i64::from(tick.skipped)));
    }
    if tick.unannounced > 0 {
        line += &format!("  unannounced {}", grouped(tick.unannounced as i64));
    }
    if tick.new_pass {
        line += "  NEW PASS";
    }
    line
}

/// One aircraft of a tick, for `--dump`. Altitude is feet above mean sea
/// level.
pub fn aircraft_line(aircraft: &Aircraft) -> String {
    let position = &aircraft.position;
    let (callsign, aircraft_type, route) = match &aircraft.metadata {
        Some(metadata) => {
            let origin = text_from_wire(&metadata.origin);
            let destination = text_from_wire(&metadata.destination);
            let route = if origin.is_empty() && destination.is_empty() {
                String::new()
            } else {
                format!("  {origin}-{destination}")
            };
            let callsign = text_from_wire(&metadata.callsign);
            (callsign, text_from_wire(&metadata.aircraft_type), route)
        }
        None => ("?", "?", String::new()),
    };
    format!(
        "  {callsign:<8}  {aircraft_type:<4}  id {:<6}  {}  {route}",
        position.id,
        state(
            position.lat,
            position.lon,
            position.altitude,
            position.ground_speed,
            position.track,
            position.vertical_rate,
            position.flags
        ),
    )
    .trim_end()
    .to_owned()
}

/// Where an aircraft is and how it is moving, in the units a person reads.
fn state(
    lat: i32,
    lon: i32,
    altitude: i16,
    ground_speed: u16,
    track: u16,
    vertical_rate: i8,
    flags: u8,
) -> String {
    let mut text = format!(
        "{:>8.4} {:>9.4}  {:>6} ft  {:>3} kt  track {:03.0}  {:>6} ft/min",
        degrees_from_wire(lat),
        degrees_from_wire(lon),
        grouped(altitude_from_wire(altitude) as i64),
        ground_speed_from_wire(ground_speed),
        // 359.6 is shown as 000, not 360.
        track_from_wire(track).round() % 360.0,
        grouped(vertical_rate_from_wire(vertical_rate) as i64),
    );
    if flags & FLAG_ON_GROUND != 0 {
        text += "  on ground";
    }
    if flags & FLAG_SYNTHETIC != 0 {
        text += "  clone";
    }
    text
}

/// A track frame: whose it is and the time it covers.
pub fn track_line(samples: &[TrackSample], bytes: usize) -> String {
    let size = grouped(bytes as i64);
    let (Some(first), Some(last)) = (samples.first(), samples.last()) else {
        return format!("track: no samples, {size} B");
    };
    let at = |sample: &TrackSample| clock(f64::from(sample.sim_time_s) * 1_000.0);
    format!(
        "track: aircraft {}, {} samples, t {} to {}, {size} B",
        first.id,
        grouped(samples.len() as i64),
        at(first),
        at(last),
    )
}

/// One sample of a track, for `--dump`.
pub fn sample_line(sample: &TrackSample) -> String {
    format!(
        "  t {}  {}",
        clock(f64::from(sample.sim_time_s) * 1_000.0),
        state(
            sample.lat,
            sample.lon,
            sample.altitude,
            sample.ground_speed,
            sample.track,
            sample.vertical_rate,
            sample.flags
        ),
    )
}

/// An alerts frame.
pub fn alerts_line(count: usize, bytes: usize) -> String {
    format!(
        "alerts: {}, {} B",
        grouped(count as i64),
        grouped(bytes as i64)
    )
}

/// The two lines printed when the client stops.
pub fn totals_lines(totals: &Totals) -> [String; 2] {
    let plural = |count: u64, one: &str, many: &str| {
        let noun = if count == 1 { one } else { many };
        format!("{} {noun}", grouped(count as i64))
    };
    let rate = match totals.rate_hz() {
        Some(rate) => format!(
            " in {:.1} s ({rate:.2} a second)",
            totals.span.as_secs_f64()
        ),
        None => String::new(),
    };
    [
        format!(
            "{}{rate}, {} skipped, {}",
            plural(totals.ticks, "tick", "ticks"),
            grouped(totals.skipped as i64),
            plural(totals.new_passes, "new pass", "new passes"),
        ),
        format!(
            "{} aircraft in the last tick, {} announced, {} never announced, {} bytes",
            grouped(totals.aircraft as i64),
            grouped(totals.announced as i64),
            grouped(totals.unannounced as i64),
            grouped(totals.bytes as i64),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use atc_core::wire::units::{
        altitude_to_wire, degrees_to_wire, text_to_wire, track_to_wire, vertical_rate_to_wire,
    };
    use atc_core::wire::{Metadata, Position};

    use super::*;

    #[test]
    fn numbers_are_grouped_in_thousands() {
        for (number, text) in [
            (0, "0"),
            (999, "999"),
            (1_000, "1,000"),
            (50_123, "50,123"),
            (1_234_567, "1,234,567"),
            (-25, "-25"),
            (-1_984, "-1,984"),
        ] {
            assert_eq!(grouped(number), text);
        }
    }

    #[test]
    fn sim_time_is_shown_as_a_clock() {
        assert_eq!(clock(0.0), "00:00:00");
        assert_eq!(clock(59_999.0), "00:00:59");
        assert_eq!(clock(3_723_000.0), "01:02:03");
        assert_eq!(clock(14_400_000.0), "04:00:00");
    }

    fn tick() -> TickSummary {
        TickSummary {
            seq: 12,
            skipped: 0,
            sim_time_ms: 312_000.0,
            aircraft: 8_012,
            announced: 4,
            unannounced: 0,
            new_pass: false,
            bytes: 160_448,
            sample: Vec::new(),
        }
    }

    #[test]
    fn a_tick_is_one_line_of_fixed_columns() {
        assert_eq!(
            tick_line(&tick()),
            "seq     12  t 00:05:12  aircraft  8,012  new      4    160,448 B"
        );
        // The columns hold at stress-mode sizes.
        let crowded = TickSummary {
            seq: 123_456,
            aircraft: 56_084,
            announced: 56_084,
            bytes: 3_365_088,
            ..tick()
        };
        assert_eq!(
            tick_line(&crowded),
            "seq 123456  t 00:05:12  aircraft 56,084  new 56,084  3,365,088 B"
        );
    }

    #[test]
    fn a_tick_line_ends_with_what_is_out_of_the_ordinary() {
        let odd = TickSummary {
            skipped: 3,
            unannounced: 1,
            new_pass: true,
            ..tick()
        };
        let line = tick_line(&odd);
        assert!(line.starts_with(&tick_line(&tick())));
        assert!(line.ends_with(" B  skipped 3  unannounced 1  NEW PASS"));
    }

    fn aircraft() -> Aircraft {
        Aircraft {
            position: Position {
                id: 42,
                lat: degrees_to_wire(40.6413),
                lon: degrees_to_wire(-73.7781),
                altitude: altitude_to_wire(35_000.0),
                ground_speed: 451,
                track: track_to_wire(271.4),
                vertical_rate: vertical_rate_to_wire(-1_984.0),
                flags: 0,
            },
            metadata: Some(Metadata {
                aircraft_id: 42,
                callsign: text_to_wire("UAL123"),
                aircraft_type: text_to_wire("B738"),
                // The seed file has no origins or destinations.
                origin: text_to_wire(""),
                destination: text_to_wire(""),
                ..Metadata::default()
            }),
        }
    }

    #[test]
    fn an_aircraft_is_shown_in_the_units_a_person_reads() {
        assert_eq!(
            aircraft_line(&aircraft()),
            "  UAL123    B738  id 42       40.6413  -73.7781  35,000 ft  451 kt  track 271  -1,984 ft/min"
        );
    }

    #[test]
    fn an_aircraft_line_carries_its_route_and_flags_when_it_has_them() {
        let mut aircraft = aircraft();
        aircraft.position.flags = FLAG_ON_GROUND | FLAG_SYNTHETIC;
        aircraft.position.altitude = altitude_to_wire(-25.0);
        aircraft.position.track = track_to_wire(359.8);
        let metadata = aircraft.metadata.as_mut().unwrap();
        metadata.origin = text_to_wire("KJFK");
        metadata.destination = text_to_wire("KLAX");

        let line = aircraft_line(&aircraft);
        assert!(line.contains("    -25 ft"), "{line}");
        assert!(line.contains("track 000"), "{line}");
        assert!(
            line.ends_with("ft/min  on ground  clone    KJFK-KLAX"),
            "{line}"
        );
    }

    #[test]
    fn an_aircraft_that_was_never_announced_has_no_name() {
        let unnamed = Aircraft {
            metadata: None,
            ..aircraft()
        };
        assert!(aircraft_line(&unnamed).starts_with("  ?         ?     id 42 "));
    }

    #[test]
    fn a_track_line_says_whose_it_is_and_what_it_covers() {
        let samples = [10, 20, 3_723].map(|sim_time_s| TrackSample {
            id: 7,
            sim_time_s,
            ..TrackSample::default()
        });
        assert_eq!(
            track_line(&samples, 96),
            "track: aircraft 7, 3 samples, t 00:00:10 to 01:02:03, 96 B"
        );
        assert_eq!(track_line(&[], 24), "track: no samples, 24 B");
        assert!(sample_line(&samples[2]).starts_with("  t 01:02:03    0.0000"));
    }

    #[test]
    fn the_servers_messages_each_have_a_line() {
        assert_eq!(
            sim_line(7, 14_400),
            "sim: multiplier 7, a pass lasts 04:00:00 (14,400 s)"
        );
        assert_eq!(
            refusal_line("unsupported", "`viewport` is not supported yet"),
            "error unsupported: `viewport` is not supported yet"
        );
        assert_eq!(alerts_line(2, 96), "alerts: 2, 96 B");
    }

    #[test]
    fn the_totals_are_two_lines() {
        let totals = Totals {
            ticks: 30,
            skipped: 2,
            new_passes: 1,
            announced: 8_100,
            unannounced: 0,
            bytes: 4_812_345,
            aircraft: 8_012,
            span: Duration::from_millis(29_000),
        };
        assert_eq!(
            totals_lines(&totals),
            [
                "30 ticks in 29.0 s (1.00 a second), 2 skipped, 1 new pass",
                "8,012 aircraft in the last tick, 8,100 announced, 0 never announced, 4,812,345 bytes",
            ]
        );
        // One tick has no rate.
        let one = Totals {
            ticks: 1,
            new_passes: 0,
            span: Duration::ZERO,
            ..totals
        };
        assert_eq!(totals_lines(&one)[0], "1 tick, 2 skipped, 0 new passes");
    }
}
