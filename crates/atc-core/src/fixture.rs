//! A small made-up recording for tests, so they need neither the adsb.lol
//! download nor a database.
//!
//! [`recording`] builds the same few dozen flights every time, by flying
//! simple plans in 10 s steps: straight, turning, climbing and descending,
//! one that takes off and one that lands. Two of them, [`CONFLICT_PAIR`], fly
//! through the same point at the same height at [`CONFLICT_TIME_S`]. No other
//! two flights ever come near each other.

use crate::geo;
use crate::recording::{Flight, Recording, SAMPLE_SPACING_S, Sample};
use crate::wire::FLAG_ON_GROUND;
use crate::wire::units::{
    altitude_to_wire, degrees_to_wire, ground_speed_to_wire, text_to_wire, track_to_wire,
    vertical_rate_to_wire,
};

/// Length of the fixture's window in seconds.
pub const WINDOW_S: u32 = 1_200;

/// Flight ids of the two flights that converge.
pub const CONFLICT_PAIR: (usize, usize) = (0, 1);
/// Seconds into the window at which the pair is closest, under half a mile
/// apart and level with each other.
pub const CONFLICT_TIME_S: u32 = 600;
/// Where the pair meets.
pub const CONFLICT_LAT: f64 = 41.0;
pub const CONFLICT_LON: f64 = -90.0;

/// Barometric altitude less the altitude above sea level, in feet, for every
/// sample: the altimeter reads 200 ft low, much as it did along the east
/// coast on the day the seed file was baked. It is the same everywhere, so
/// two flights are as far apart by one altitude as by the other.
pub const BAROMETRIC_LESS_ALTITUDE_FT: f64 = -200.0;

/// One stretch of a plan, flown with everything held steady.
#[derive(Clone, Copy, Default)]
struct Leg {
    seconds: u32,
    /// Degrees per second; positive turns right.
    turn: f64,
    /// Feet per minute.
    climb: f64,
    /// Altitude at which a climb or descent stops, in feet.
    level_off: f64,
    /// Knots per second.
    accelerate: f64,
    on_ground: bool,
}

/// Where a flight starts and the legs it flies from there.
struct Plan<'a> {
    aircraft_type: &'a str,
    /// Seconds into the window; a multiple of the sample spacing.
    start_s: u32,
    lat: f64,
    lon: f64,
    track: f64,
    altitude: f64,
    speed: f64,
    legs: &'a [Leg],
}

/// Flies a plan and samples it. The flight ends with its last leg or at the
/// end of the window, whichever comes first.
fn fly(number: u32, plan: &Plan) -> Flight {
    let step = f64::from(SAMPLE_SPACING_S);
    let (mut lat, mut lon) = (plan.lat, plan.lon);
    let (mut track, mut altitude, mut speed) = (plan.track, plan.altitude, plan.speed);
    let mut time = plan.start_s;
    let mut samples = Vec::new();

    let sample = |lat, lon, track, altitude, speed, climb, on_ground| Sample {
        lat: degrees_to_wire(lat),
        lon: degrees_to_wire(lon),
        altitude: altitude_to_wire(altitude),
        barometric: altitude_to_wire(altitude + BAROMETRIC_LESS_ALTITUDE_FT),
        ground_speed: ground_speed_to_wire(speed),
        track: track_to_wire(track),
        vertical_rate: vertical_rate_to_wire(climb),
        flags: if on_ground { FLAG_ON_GROUND } else { 0 },
    };

    'legs: for leg in plan.legs {
        for _ in 0..leg.seconds / SAMPLE_SPACING_S {
            if time > WINDOW_S {
                break 'legs;
            }
            // A climb or descent stops at the leg's level-off altitude.
            let wanted = altitude + leg.climb * step / 60.0;
            let next_altitude = if leg.climb > 0.0 {
                wanted.min(leg.level_off)
            } else if leg.climb < 0.0 {
                wanted.max(leg.level_off)
            } else {
                altitude
            };
            let climb = if next_altitude == altitude {
                0.0
            } else {
                leg.climb
            };
            samples.push(sample(
                lat,
                lon,
                track,
                altitude,
                speed,
                climb,
                leg.on_ground,
            ));

            // Move along the track and speed halfway through the step.
            let next_speed = (speed + leg.accelerate * step).max(0.0);
            let distance = (speed + next_speed) / 2.0 * step / 3_600.0;
            (lat, lon) = geo::step(lat, lon, track + leg.turn * step / 2.0, distance);
            track += leg.turn * step;
            speed = next_speed;
            altitude = next_altitude;
            time += SAMPLE_SPACING_S;
        }
    }
    // The state the last leg ended in.
    if time <= WINDOW_S {
        let on_ground = plan.legs.last().is_some_and(|leg| leg.on_ground);
        samples.push(sample(lat, lon, track, altitude, speed, 0.0, on_ground));
    }

    Flight {
        // An address block no real aircraft uses.
        icao24: 0xF0_0000 + number,
        callsign: text_to_wire(&format!("FIX{number:03}")),
        aircraft_type: text_to_wire(plan.aircraft_type),
        origin: text_to_wire(""),
        destination: text_to_wire(""),
        first_sample: plan.start_s / SAMPLE_SPACING_S,
        samples,
    }
}

/// A leg flown level and straight.
fn cruise(seconds: u32) -> Leg {
    Leg {
        seconds,
        ..Leg::default()
    }
}

/// The fixture: 34 flights in a 20 minute window.
///
/// | Flight ids | What they do |
/// |---|---|
/// | 0, 1 | The converging pair, level at 41,000 ft |
/// | 2 to 11 | Straight and level, 20,000 to 38,000 ft, 2,000 ft apart |
/// | 12 to 19 | Turning: orbits and S-turns, 6,000 to 13,000 ft |
/// | 20 to 26 | Climbing to between 11,000 and 17,000 ft; 20 takes off |
/// | 27 to 33 | Descending from 18,000 ft; 27 lands |
pub fn recording() -> Recording {
    let mut flights = Vec::new();
    let mut add = |plan: Plan| {
        let number = flights.len() as u32;
        flights.push(fly(number, &plan));
    };

    // The pair. One flies east and one north, timed to reach the same point
    // together.
    let seconds_out = f64::from(CONFLICT_TIME_S);
    let (east_speed, north_speed) = (480.0, 420.0);
    let east_run = east_speed * seconds_out / 3_600.0;
    let north_run = north_speed * seconds_out / 3_600.0;
    add(Plan {
        aircraft_type: "B738",
        start_s: 0,
        lat: CONFLICT_LAT,
        lon: geo::step(CONFLICT_LAT, CONFLICT_LON, 270.0, east_run).1,
        track: 90.0,
        altitude: 41_000.0,
        speed: east_speed,
        legs: &[cruise(WINDOW_S)],
    });
    add(Plan {
        aircraft_type: "A320",
        start_s: 0,
        lat: geo::step(CONFLICT_LAT, CONFLICT_LON, 180.0, north_run).0,
        lon: CONFLICT_LON,
        track: 0.0,
        altitude: 41_000.0,
        speed: north_speed,
        legs: &[cruise(WINDOW_S)],
    });

    // Straight and level. Each has its own flight level, so they can cross.
    // Some join late and some leave early.
    let starts = [0, 0, 0, 60, 120, 300, 0, 0, 480, 0];
    let lengths = [1_200, 1_200, 900, 1_140, 600, 900, 1_200, 400, 720, 1_200];
    for i in 0..10u32 {
        let n = f64::from(i);
        add(Plan {
            aircraft_type: if i % 2 == 0 { "B738" } else { "A321" },
            start_s: starts[i as usize],
            lat: 39.0 + 0.3 * f64::from(i % 5),
            lon: -80.0 + 0.5 * n,
            track: 10.0 + 36.0 * n,
            altitude: 20_000.0 + 2_000.0 * n,
            speed: 400.0 + 10.0 * n,
            legs: &[cruise(lengths[i as usize])],
        });
    }

    // Turning, a degree of longitude apart and each at its own altitude.
    // The first four orbit; the rest fly straight, turn one way, then back.
    let rates = [3.0, -3.0, 1.5, -1.5];
    for i in 0..8u32 {
        let n = f64::from(i);
        let rate = rates[(i % 4) as usize];
        let turn = |seconds, turn| Leg {
            seconds,
            turn,
            ..Leg::default()
        };
        let orbit = [turn(WINDOW_S, rate)];
        let s_turn = [
            cruise(240),
            turn(60, rate),
            cruise(180),
            turn(60, -rate),
            cruise(360),
        ];
        add(Plan {
            aircraft_type: if i < 4 { "C172" } else { "E75L" },
            start_s: 30 * i,
            lat: 35.0,
            lon: -84.0 + n,
            track: 45.0 * n,
            altitude: 6_000.0 + 1_000.0 * n,
            speed: if i < 4 { 110.0 + 10.0 * n } else { 220.0 },
            legs: if i < 4 { &orbit } else { &s_turn },
        });
    }

    // Climbing, eastbound on parallel lanes half a degree apart.
    for i in 0..7u32 {
        let n = f64::from(i);
        let climb = Leg {
            seconds: WINDOW_S,
            climb: 1_500.0 + 200.0 * n,
            level_off: 11_000.0 + 1_000.0 * n,
            ..Leg::default()
        };
        // Flight 20 starts its take-off roll, lifts off and speeds up.
        let take_off = [
            Leg {
                seconds: 40,
                accelerate: 3.5,
                on_ground: true,
                ..Leg::default()
            },
            Leg {
                seconds: 200,
                climb: 2_000.0,
                level_off: 11_000.0,
                accelerate: 0.5,
                ..Leg::default()
            },
            climb,
        ];
        add(Plan {
            aircraft_type: "A320",
            start_s: 60 * i,
            lat: 43.0 + 0.5 * n,
            lon: -95.0,
            track: 90.0,
            altitude: if i == 0 { 0.0 } else { 3_000.0 },
            speed: if i == 0 { 10.0 } else { 250.0 + 10.0 * n },
            legs: if i == 0 { &take_off } else { &take_off[2..] },
        });
    }

    // Descending, westbound on parallel lanes half a degree apart.
    for i in 0..7u32 {
        let n = f64::from(i);
        let descend = [Leg {
            seconds: WINDOW_S,
            climb: -(1_200.0 + 100.0 * n),
            level_off: 3_000.0 + 500.0 * n,
            ..Leg::default()
        }];
        // Flight 27 is on final approach, touches down and slows.
        let land = [
            Leg {
                seconds: 300,
                climb: -800.0,
                level_off: 0.0,
                ..Leg::default()
            },
            Leg {
                seconds: 60,
                accelerate: -2.0,
                on_ground: true,
                ..Leg::default()
            },
        ];
        add(Plan {
            aircraft_type: "B739",
            start_s: 90 * i,
            lat: 31.0 - 0.5 * n,
            lon: -90.0,
            track: 270.0,
            altitude: if i == 0 { 4_000.0 } else { 18_000.0 },
            speed: if i == 0 { 140.0 } else { 280.0 },
            legs: if i == 0 { &land } else { &descend },
        });
    }

    Recording {
        window_s: WINDOW_S,
        flights,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::units::{
        altitude_from_wire, degrees_from_wire, ground_speed_from_wire, text_from_wire,
        track_from_wire, vertical_rate_from_wire,
    };

    fn lat_lon(sample: &Sample) -> (f64, f64) {
        (degrees_from_wire(sample.lat), degrees_from_wire(sample.lon))
    }

    fn distance(a: &Sample, b: &Sample) -> f64 {
        let (a, b) = (lat_lon(a), lat_lon(b));
        geo::distance_nm(a.0, a.1, b.0, b.1)
    }

    /// Total change of track over a flight, in degrees, counting every turn.
    fn turned(flight: &Flight) -> f64 {
        flight
            .samples
            .windows(2)
            .map(|pair| {
                let change = track_from_wire(pair[1].track) - track_from_wire(pair[0].track);
                ((change + 540.0) % 360.0 - 180.0).abs()
            })
            .sum()
    }

    #[test]
    fn the_fixture_is_identical_on_every_run() {
        assert_eq!(recording(), recording());
    }

    #[test]
    fn it_holds_a_few_dozen_flights_inside_the_window() {
        let recording = recording();
        assert_eq!(recording.window_s, WINDOW_S);
        assert_eq!(recording.flights.len(), 34);
        for (id, flight) in recording.flights.iter().enumerate() {
            assert!(flight.samples.len() >= 6, "flight {id} is too short");
            assert!(flight.end_s() <= WINDOW_S, "flight {id} leaves the window");
            assert_eq!(
                text_from_wire(&flight.callsign),
                format!("FIX{id:03}"),
                "flight {id}"
            );
        }
        // Some flights are cut by the window's edges and some are not.
        let whole = |f: &&Flight| f.start_s() == 0 && f.end_s() == WINDOW_S;
        assert!(recording.flights.iter().filter(whole).count() >= 5);
        assert!(recording.flights.iter().any(|f| f.start_s() > 0));
        assert!(recording.flights.iter().any(|f| f.end_s() < WINDOW_S));
    }

    #[test]
    fn straight_flights_hold_their_track_and_height() {
        let recording = recording();
        for flight in &recording.flights[2..12] {
            assert!(turned(flight) < 0.01);
            assert!(
                flight
                    .samples
                    .iter()
                    .all(|s| s.altitude == flight.samples[0].altitude && s.vertical_rate == 0)
            );
        }
    }

    #[test]
    fn turning_flights_turn() {
        let recording = recording();
        // An orbit goes round at least once; an S-turn turns out and back.
        for flight in &recording.flights[12..16] {
            assert!(turned(flight) > 360.0, "{}", turned(flight));
        }
        for flight in &recording.flights[16..20] {
            let first = track_from_wire(flight.samples[0].track);
            let last = track_from_wire(flight.samples.last().unwrap().track);
            assert!(turned(flight) > 170.0, "{}", turned(flight));
            assert!((first - last).abs() < 0.01);
        }
    }

    #[test]
    fn climbing_flights_climb_and_level_off() {
        let recording = recording();
        for flight in &recording.flights[20..27] {
            let first = flight.samples[0];
            let last = flight.samples.last().unwrap();
            assert!(last.altitude > first.altitude);
            assert!(flight.samples.iter().any(|s| s.vertical_rate > 0));
            assert!(
                flight
                    .samples
                    .windows(2)
                    .all(|p| p[1].altitude >= p[0].altitude)
            );
            assert!(altitude_from_wire(last.altitude) <= 17_000.0);
        }
        // The first six have time to reach their level; the last starts late.
        for flight in &recording.flights[20..26] {
            assert_eq!(flight.samples.last().unwrap().vertical_rate, 0);
        }
    }

    #[test]
    fn descending_flights_descend() {
        let recording = recording();
        for flight in &recording.flights[27..34] {
            let first = flight.samples[0];
            let last = flight.samples.last().unwrap();
            assert!(last.altitude < first.altitude);
            assert!(flight.samples.iter().any(|s| s.vertical_rate < 0));
            assert!(
                flight
                    .samples
                    .windows(2)
                    .all(|p| p[1].altitude <= p[0].altitude)
            );
        }
    }

    #[test]
    fn the_altimeter_reads_low_by_the_same_amount_everywhere() {
        let recording = recording();
        let samples = recording.flights.iter().flat_map(|f| &f.samples);
        for sample in samples {
            let less = altitude_from_wire(sample.barometric) - altitude_from_wire(sample.altitude);
            assert_eq!(less, BAROMETRIC_LESS_ALTITUDE_FT);
        }
        // On the ground it reads below zero.
        assert_eq!(recording.flights[20].samples[0].barometric, -8);
    }

    #[test]
    fn one_flight_takes_off_and_one_lands() {
        let recording = recording();

        let departure = &recording.flights[20];
        assert!(departure.samples[0].on_ground());
        assert_eq!(departure.samples[0].altitude, 0);
        let airborne = departure.samples.iter().position(|s| !s.on_ground());
        assert_eq!(airborne, Some(4));
        assert!(departure.samples[4..].iter().all(|s| !s.on_ground()));
        assert!(ground_speed_from_wire(departure.samples[4].ground_speed) == 150.0);

        let arrival = &recording.flights[27];
        assert!(!arrival.samples[0].on_ground());
        let touchdown = arrival.samples.iter().position(Sample::on_ground).unwrap();
        assert_eq!(arrival.samples[touchdown].altitude, 0);
        assert!(arrival.samples[touchdown..].iter().all(Sample::on_ground));
        let stopped = arrival.samples.last().unwrap();
        assert!(ground_speed_from_wire(stopped.ground_speed) < 30.0);

        // Nobody else touches the ground.
        for (id, flight) in recording.flights.iter().enumerate() {
            if id != 20 && id != 27 {
                assert!(flight.samples.iter().all(|s| !s.on_ground()), "flight {id}");
            }
        }
    }

    /// Each sample's speed, track and vertical rate describe the move to the
    /// next sample, as they would in a real recording.
    #[test]
    fn the_samples_agree_with_the_motion_between_them() {
        let recording = recording();
        let hours = f64::from(SAMPLE_SPACING_S) / 3_600.0;
        for (id, flight) in recording.flights.iter().enumerate() {
            for (n, pair) in flight.samples.windows(2).enumerate() {
                let moved = distance(&pair[0], &pair[1]);
                let slow = ground_speed_from_wire(pair[0].ground_speed.min(pair[1].ground_speed));
                let fast = ground_speed_from_wire(pair[0].ground_speed.max(pair[1].ground_speed));
                assert!(
                    moved >= (slow - 1.0) * hours - 0.01 && moved <= (fast + 1.0) * hours + 0.01,
                    "flight {id} sample {n}: moved {moved} nm at {slow} to {fast} kt"
                );

                let climbed =
                    altitude_from_wire(pair[1].altitude) - altitude_from_wire(pair[0].altitude);
                let rate = vertical_rate_from_wire(pair[0].vertical_rate);
                let expected = rate * f64::from(SAMPLE_SPACING_S) / 60.0;
                // Altitude is in 25 ft steps and the rate in 64 ft/min steps,
                // and a level-off can fall inside the step.
                assert!(
                    (climbed - expected).abs() <= 50.0 || climbed.abs() < expected.abs(),
                    "flight {id} sample {n}: climbed {climbed} ft at {rate} ft/min"
                );
            }
        }
    }

    #[test]
    fn the_pair_meets_at_the_stated_time_and_place() {
        let recording = recording();
        let a = &recording.flights[CONFLICT_PAIR.0];
        let b = &recording.flights[CONFLICT_PAIR.1];

        let closest = (0..=WINDOW_S / SAMPLE_SPACING_S)
            .min_by(|&x, &y| {
                let at = |i| distance(a.sample_at(i).unwrap(), b.sample_at(i).unwrap());
                at(x).total_cmp(&at(y))
            })
            .unwrap();
        assert_eq!(closest * SAMPLE_SPACING_S, CONFLICT_TIME_S);

        let (sa, sb) = (a.sample_at(closest).unwrap(), b.sample_at(closest).unwrap());
        assert!(distance(sa, sb) < 0.5, "{}", distance(sa, sb));
        assert_eq!(sa.altitude, sb.altitude);
        let (lat, lon) = lat_lon(sa);
        assert!(geo::distance_nm(lat, lon, CONFLICT_LAT, CONFLICT_LON) < 0.5);

        // They start well apart, so a detector has something to predict.
        let start = distance(&a.samples[0], &b.samples[0]);
        assert!(start > 100.0, "{start}");
    }

    /// The pair is the only conflict: no other two flights are ever within
    /// 10 nm and 1,500 ft of each other, twice the usual separation minima.
    #[test]
    fn no_other_two_flights_come_close() {
        let recording = recording();
        let flights = &recording.flights;
        for i in 0..flights.len() {
            for j in i + 1..flights.len() {
                if (i, j) == CONFLICT_PAIR {
                    continue;
                }
                for grid in 0..=WINDOW_S / SAMPLE_SPACING_S {
                    let (Some(a), Some(b)) =
                        (flights[i].sample_at(grid), flights[j].sample_at(grid))
                    else {
                        continue;
                    };
                    let vertical =
                        (altitude_from_wire(a.altitude) - altitude_from_wire(b.altitude)).abs();
                    assert!(
                        distance(a, b) > 10.0 || vertical > 1_500.0,
                        "flights {i} and {j} are {} nm and {vertical} ft apart at {} s",
                        distance(a, b),
                        grid * SAMPLE_SPACING_S
                    );
                }
            }
        }
    }
}
