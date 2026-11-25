//! Positions on the Earth's surface, in degrees and nautical miles.

const EARTH_RADIUS_NM: f64 = 3_440.065;
/// One minute of latitude is one nautical mile.
const NM_PER_DEGREE: f64 = 60.0;

/// Great-circle distance between two points, in nautical miles.
pub fn distance_nm(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    let (lat_a, lat_b) = (lat_a.to_radians(), lat_b.to_radians());
    let half_lat = (lat_b - lat_a) / 2.0;
    let half_lon = (lon_b - lon_a).to_radians() / 2.0;
    let h = half_lat.sin().powi(2) + lat_a.cos() * lat_b.cos() * half_lon.sin().powi(2);
    2.0 * EARTH_RADIUS_NM * h.sqrt().asin()
}

/// The point `distance_nm` from a point along a constant track, as
/// `(lat, lon)`. It treats the ground as flat over the step, so it is meant
/// for the few miles an aircraft covers between samples, away from the poles.
pub fn step(lat: f64, lon: f64, track_deg: f64, distance_nm: f64) -> (f64, f64) {
    let track = track_deg.to_radians();
    let north = distance_nm * track.cos() / NM_PER_DEGREE;
    let east = distance_nm * track.sin() / (NM_PER_DEGREE * lat.to_radians().cos());
    (lat + north, lon + east)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_degree_of_latitude_is_sixty_miles() {
        let d = distance_nm(40.0, -75.0, 41.0, -75.0);
        assert!((d - 60.0).abs() < 0.1, "{d}");
    }

    #[test]
    fn a_degree_of_longitude_shrinks_with_latitude() {
        let d = distance_nm(60.0, 10.0, 60.0, 11.0);
        assert!((d - 30.0).abs() < 0.1, "{d}");
    }

    #[test]
    fn a_step_covers_its_distance_along_its_track() {
        for track in [0.0, 45.0, 90.0, 200.0, 315.0] {
            let (lat, lon) = step(40.0, -75.0, track, 1.25);
            let d = distance_nm(40.0, -75.0, lat, lon);
            assert!((d - 1.25).abs() < 0.005, "track {track}: {d}");
        }
        let (lat, lon) = step(40.0, -75.0, 0.0, 60.0);
        assert!((lat - 41.0).abs() < 1e-9 && (lon + 75.0).abs() < 1e-9);
        let (lat, lon) = step(40.0, -75.0, 90.0, 1.0);
        assert!((lat - 40.0).abs() < 1e-9 && lon > -75.0);
    }
}
