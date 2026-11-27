//! The recorder's SQL. Queries are checked at run time, not at build time,
//! so [`prepare`] looks for the columns they name before anything is
//! written: the tables belong to the web app's migrations
//! (`apps/web/db/flight-schema.ts`), and a change there cannot fail this
//! build.

use std::collections::HashSet;
use std::fmt;

use atc_core::recording::SAMPLE_SPACING_S;
use sqlx::Row;
use sqlx::postgres::PgPool;

use super::{FlightEnd, FlightStart, codec};

/// The columns this module reads or writes, by table.
const NEEDED: [(&str, &[&str]); 2] = [
    (
        "flights",
        &[
            "id",
            "aircraft_id",
            "icao24",
            "callsign",
            "aircraft_type",
            "origin",
            "destination",
            "pass",
            "first_seen_sim_s",
            "first_seen_at",
            "last_seen_sim_s",
            "last_seen_at",
        ],
    ),
    (
        "flight_tracks",
        &["flight_id", "first_sample_sim_s", "sample_count", "samples"],
    ),
];

#[derive(Debug)]
pub enum Error {
    /// The tables are not as this code needs them. Trying again cannot help.
    Schema(String),
    /// The database could not be reached, or refused a query.
    Database(sqlx::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Schema(problem) => f.write_str(problem),
            Error::Database(error) => write!(f, "{error}"),
        }
    }
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Error {
        Error::Database(error)
    }
}

/// Checks that every needed column exists, in the schema the connection
/// uses.
pub async fn check_schema(db: &PgPool) -> Result<(), Error> {
    let tables: Vec<String> = NEEDED
        .iter()
        .map(|(table, _)| (*table).to_owned())
        .collect();
    let rows = sqlx::query(
        "SELECT table_name::text, column_name::text FROM information_schema.columns \
         WHERE table_schema = current_schema() AND table_name = ANY($1)",
    )
    .bind(&tables)
    .fetch_all(db)
    .await?;
    let found: HashSet<(String, String)> = rows
        .iter()
        .map(|row| (row.get::<String, _>(0), row.get::<String, _>(1)))
        .collect();

    let mut missing = Vec::new();
    for (table, columns) in NEEDED {
        for column in columns {
            if !found.contains(&((*table).to_owned(), (*column).to_owned())) {
                missing.push(format!("{table}.{column}"));
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(Error::Schema(format!(
        "the database lacks columns the flight recorder writes: {}. Apply the migrations \
         (`docker compose up setup`, or `bun --filter web db:migrate`); if they are applied, \
         apps/web/db/flight-schema.ts and crates/atc-server/src/recorder/store.rs disagree",
        missing.join(", ")
    )))
}

/// Closes the flights an earlier run left open, at the last moment each is
/// known to have been flying: the end of its recorded track, or where it
/// started if it has none. Returns how many.
pub async fn close_open_flights(db: &PgPool) -> Result<u64, Error> {
    let closed = sqlx::query(
        "WITH ends AS ( \
           SELECT f.id, COALESCE( \
             (SELECT max(t.first_sample_sim_s + (t.sample_count - 1) * $1) \
                FROM flight_tracks t WHERE t.flight_id = f.id), \
             f.first_seen_sim_s) AS last_sim_s \
           FROM flights f WHERE f.last_seen_at IS NULL) \
         UPDATE flights f SET \
           last_seen_sim_s = ends.last_sim_s, \
           last_seen_at = f.first_seen_at \
             + make_interval(secs => (ends.last_sim_s - f.first_seen_sim_s)::double precision) \
         FROM ends WHERE f.id = ends.id",
    )
    .bind(i64::from(SAMPLE_SPACING_S))
    .execute(db)
    .await?;
    Ok(closed.rows_affected())
}

/// What has to be so before the first write: the tables are right, and no
/// flight is open from an earlier run. Returns how many were closed.
pub async fn prepare(db: &PgPool) -> Result<u64, Error> {
    check_schema(db).await?;
    close_open_flights(db).await
}

/// Inserts a row for each flight and returns each one's id, with the
/// aircraft id it was given for.
pub async fn insert_flights(
    db: &PgPool,
    flights: &[&FlightStart],
) -> Result<Vec<(u32, i64)>, Error> {
    let column = |value: fn(&FlightStart) -> i64| -> Vec<i64> {
        flights.iter().map(|flight| value(flight)).collect()
    };
    let text = |value: fn(&FlightStart) -> Option<String>| -> Vec<Option<String>> {
        flights.iter().map(|flight| value(flight)).collect()
    };
    let at: Vec<f64> = flights.iter().map(|flight| flight.at).collect();
    let rows = sqlx::query(
        "INSERT INTO flights (aircraft_id, icao24, callsign, aircraft_type, origin, \
           destination, pass, first_seen_sim_s, first_seen_at) \
         SELECT u.aircraft_id, u.icao24::integer, u.callsign, u.aircraft_type, u.origin, \
           u.destination, u.pass::integer, u.sim_s, to_timestamp(u.at) \
         FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[], \
           $6::text[], $7::bigint[], $8::bigint[], $9::double precision[]) \
           AS u(aircraft_id, icao24, callsign, aircraft_type, origin, destination, pass, \
             sim_s, at) \
         RETURNING aircraft_id, id",
    )
    .bind(column(|flight| i64::from(flight.aircraft_id)))
    .bind(column(|flight| i64::from(flight.icao24)))
    .bind(text(|flight| Some(flight.callsign.clone())))
    .bind(text(|flight| Some(flight.aircraft_type.clone())))
    .bind(text(|flight| flight.origin.clone()))
    .bind(text(|flight| flight.destination.clone()))
    .bind(column(|flight| i64::from(flight.pass)))
    .bind(column(|flight| i64::from(flight.sim_time_s)))
    .bind(at)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get::<i64, _>(0) as u32, row.get::<i64, _>(1)))
        .collect())
}

/// One batch of a flight's samples, ready to be a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackRow {
    pub flight_id: i64,
    pub first_sample_sim_s: u32,
    pub sample_count: usize,
    pub samples: Vec<u8>,
}

impl TrackRow {
    /// Encodes `samples` as the row of flight `flight_id`.
    pub fn new(
        flight_id: i64,
        first_sample_sim_s: u32,
        samples: &[atc_core::recording::Sample],
    ) -> TrackRow {
        TrackRow {
            flight_id,
            first_sample_sim_s,
            sample_count: samples.len(),
            samples: codec::encode(samples),
        }
    }
}

/// Appends track rows.
pub async fn insert_tracks(db: &PgPool, rows: &[TrackRow]) -> Result<(), Error> {
    let flight: Vec<i64> = rows.iter().map(|row| row.flight_id).collect();
    let first: Vec<i64> = rows
        .iter()
        .map(|row| i64::from(row.first_sample_sim_s))
        .collect();
    let count: Vec<i32> = rows.iter().map(|row| row.sample_count as i32).collect();
    let samples: Vec<&[u8]> = rows.iter().map(|row| row.samples.as_slice()).collect();
    sqlx::query(
        "INSERT INTO flight_tracks (flight_id, first_sample_sim_s, sample_count, samples) \
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::integer[], $4::bytea[])",
    )
    .bind(flight)
    .bind(first)
    .bind(count)
    .bind(samples)
    .execute(db)
    .await?;
    Ok(())
}

/// Sets the last-seen times of flights that have ended, by flight id.
pub async fn close_flights(db: &PgPool, ended: &[(i64, &FlightEnd)]) -> Result<(), Error> {
    let id: Vec<i64> = ended.iter().map(|(id, _)| *id).collect();
    let sim: Vec<i64> = ended
        .iter()
        .map(|(_, end)| i64::from(end.sim_time_s))
        .collect();
    let at: Vec<f64> = ended.iter().map(|(_, end)| end.at).collect();
    sqlx::query(
        "UPDATE flights f SET last_seen_sim_s = u.sim_s, last_seen_at = to_timestamp(u.at) \
         FROM UNNEST($1::bigint[], $2::bigint[], $3::double precision[]) AS u(id, sim_s, at) \
         WHERE f.id = u.id",
    )
    .bind(id)
    .bind(sim)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes the flights last seen before `cutoff`, in seconds since the
/// epoch, and their tracks with them. A flight still in the air is aged by
/// when it was first seen. Returns how many flights went.
pub async fn delete_flights_before(db: &PgPool, cutoff: f64) -> Result<u64, Error> {
    let deleted = sqlx::query(
        "DELETE FROM flights WHERE COALESCE(last_seen_at, first_seen_at) < to_timestamp($1)",
    )
    .bind(cutoff)
    .execute(db)
    .await?;
    Ok(deleted.rows_affected())
}
