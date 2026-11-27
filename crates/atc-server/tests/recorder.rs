//! The flight recorder against a real Postgres: what the replay of the
//! fixture leaves in `flights` and `flight_tracks`.
//!
//! Needs `DATABASE_URL`, as the health check's test does; without it every
//! test here passes without checking anything. Each test makes a database
//! of its own beside the one the URL names, applies the web app's
//! migrations to it, the real ones, and drops it at the end.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atc_core::fixture;
use atc_core::recording::{Flight, SAMPLE_SPACING_S, Sample};
use atc_core::wire::units::text_from_wire;
use atc_server::recorder::store::{self, TrackRow};
use atc_server::recorder::writer::{self, Limits};
use atc_server::recorder::{Event, FlightEnd, FlightStart, Recorder, codec};
use atc_server::sim::replay::Replay;
use atc_server::sim::{Feed, Tick};
use sqlx::Row;
use sqlx::postgres::{PgPool, PgPoolOptions};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// SQL built here from names this file made up, or read from the repo's
/// own migrations: none of it comes from outside.
fn dynamic(sql: String) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(sql)
}

/// A migrated database that lasts one test.
struct TestDb {
    admin: PgPool,
    name: String,
    pool: PgPool,
}

impl TestDb {
    /// `None` when there is no `DATABASE_URL`, and the test is skipped.
    async fn create() -> Option<TestDb> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipped: DATABASE_URL is not set");
            return None;
        };
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let name = format!(
            "atc_recorder_test_{}_{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        sqlx::query(dynamic(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .unwrap();
        let (server, _) = url.rsplit_once('/').unwrap();
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .acquire_timeout(Duration::from_secs(2))
            .connect(&format!("{server}/{name}"))
            .await
            .unwrap();
        let db = TestDb { admin, name, pool };
        db.migrate().await;
        Some(db)
    }

    /// Applies the web app's migrations, in order, as Drizzle would.
    async fn migrate(&self) {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/db/migrations");
        let mut files: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
            .collect();
        files.sort();
        assert!(files.len() >= 3, "the flights migration is missing");
        for file in files {
            let sql = std::fs::read_to_string(&file).unwrap();
            for statement in sql.split("--> statement-breakpoint") {
                if !statement.trim().is_empty() {
                    sqlx::query(dynamic(statement.to_owned()))
                        .execute(&self.pool)
                        .await
                        .unwrap();
                }
            }
        }
    }

    /// Makes the database refuse every connection, as if it were down, or
    /// lets it take them again.
    async fn set_reachable(&self, reachable: bool) {
        sqlx::query(dynamic(format!(
            "ALTER DATABASE {} ALLOW_CONNECTIONS {reachable}",
            self.name
        )))
        .execute(&self.admin)
        .await
        .unwrap();
        if !reachable {
            sqlx::query(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            )
            .bind(&self.name)
            .execute(&self.admin)
            .await
            .unwrap();
        }
    }

    async fn count(&self, table: &str) -> i64 {
        sqlx::query(dynamic(format!("SELECT count(*) FROM {table}")))
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .get(0)
    }

    async fn drop(self) {
        self.pool.close().await;
        sqlx::query(dynamic(format!("DROP DATABASE {} WITH (FORCE)", self.name)))
            .execute(&self.admin)
            .await
            .unwrap();
    }
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

fn quick() -> Limits {
    Limits {
        retry_after: Duration::from_millis(50),
        ..Limits::default()
    }
}

/// A recorder writing to `db`, and the replay of the fixture to feed it.
struct Run {
    replay: Replay,
    recorder: Recorder,
    tick: Tick,
}

impl Run {
    fn start(db: &TestDb, multiplier: u32, limits: Limits) -> Run {
        let (recorder, events) = Recorder::new(fixture::WINDOW_S);
        tokio::spawn(writer::run(db.pool.clone(), events, false, limits));
        Run {
            replay: Replay::with_multiplier(fixture::recording(), multiplier).unwrap(),
            recorder,
            tick: Tick::default(),
        }
    }

    /// Flies `seconds` of sim time, as fast as it will go.
    fn fly(&mut self, seconds: u32) {
        for _ in 0..seconds {
            self.replay.advance(&mut self.tick);
            self.recorder.observe(&self.tick);
        }
    }

    /// Waits until everything said so far is in the database.
    async fn written(&self) {
        tokio::time::timeout(Duration::from_secs(20), self.recorder.sync())
            .await
            .expect("the writer caught up")
            .unwrap();
    }
}

/// A flight's recorded samples by sim time, decoded from its rows.
async fn recorded_track(db: &TestDb, flight_id: i64) -> BTreeMap<u32, Sample> {
    let rows = sqlx::query(
        "SELECT first_sample_sim_s, sample_count, samples FROM flight_tracks \
         WHERE flight_id = $1 ORDER BY first_sample_sim_s",
    )
    .bind(flight_id)
    .fetch_all(&db.pool)
    .await
    .unwrap();
    let mut track = BTreeMap::new();
    for row in rows {
        let first = row.get::<i64, _>(0) as u32;
        let count = row.get::<i32, _>(1) as usize;
        let samples = codec::decode(&row.get::<Vec<u8>, _>(2), count).expect("a row decodes");
        for (n, sample) in samples.into_iter().enumerate() {
            let time = first + n as u32 * SAMPLE_SPACING_S;
            assert!(track.insert(time, sample).is_none(), "a sample twice");
        }
    }
    track
}

/// Whether a decoded sample is the one flown, to the row's resolution.
fn same(flown: &Sample, recorded: &Sample) -> bool {
    (flown.lat - recorded.lat).abs() <= 50
        && (flown.lon - recorded.lon).abs() <= 50
        && flown.altitude == recorded.altitude
        && flown.barometric == recorded.barometric
        && flown.ground_speed == recorded.ground_speed
        && (flown.track.wrapping_sub(recorded.track) as i16).abs() <= 92
        && flown.vertical_rate == recorded.vertical_rate
        && flown.flags == recorded.flags
}

fn callsign(flight: &Flight) -> &str {
    text_from_wire(&flight.callsign)
}

#[tokio::test]
async fn a_flight_that_has_finished_has_both_times_and_its_whole_track() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let before = now();
    let mut run = Run::start(&db, 1, quick());
    // A pass and a little more, so every flight of the first pass is over.
    run.fly(fixture::WINDOW_S + 20);
    run.written().await;

    let recording = fixture::recording();
    for flight in &recording.flights {
        let row = sqlx::query(
            "SELECT id, icao24, aircraft_type, origin, first_seen_sim_s, last_seen_sim_s, \
               extract(epoch FROM first_seen_at)::double precision, \
               extract(epoch FROM last_seen_at)::double precision \
             FROM flights WHERE callsign = $1 AND pass = 0",
        )
        .bind(callsign(flight))
        .fetch_one(&db.pool)
        .await
        .unwrap();
        let last_s = flight.end_s().min(fixture::WINDOW_S - 1);
        assert_eq!(row.get::<i32, _>(1) as u32, flight.icao24);
        assert_eq!(
            row.get::<String, _>(2),
            text_from_wire(&flight.aircraft_type)
        );
        let origin = text_from_wire(&flight.origin);
        assert_eq!(
            row.get::<Option<String>, _>(3).as_deref().unwrap_or(""),
            origin
        );
        assert_eq!(row.get::<i64, _>(4) as u32, flight.start_s());
        assert_eq!(row.get::<Option<i64>, _>(5), Some(i64::from(last_s)));
        let first_seen: f64 = row.get(6);
        let last_seen: f64 = row.get::<Option<f64>, _>(7).expect("an end time");
        assert!(before - 1.0 <= first_seen && first_seen <= last_seen && last_seen <= now() + 1.0);

        // The whole track, every sample flown at its time.
        let track = recorded_track(&db, row.get(0)).await;
        let flown: Vec<(u32, &Sample)> = flight
            .samples
            .iter()
            .enumerate()
            .map(|(n, sample)| (flight.start_s() + n as u32 * SAMPLE_SPACING_S, sample))
            .filter(|(time, _)| *time <= last_s)
            .collect();
        assert_eq!(track.len(), flown.len(), "{}", callsign(flight));
        for (time, sample) in flown {
            let recorded = track.get(&time).expect("a sample at that time");
            assert!(same(sample, recorded), "{} at {time} s", callsign(flight));
        }
    }
    // One row for each flight of the pass that is over, and no clones.
    let over: i64 = sqlx::query("SELECT count(*) FROM flights WHERE pass = 0")
        .fetch_one(&db.pool)
        .await
        .unwrap()
        .get(0);
    assert_eq!(over as usize, recording.flights.len());
    db.drop().await;
}

#[tokio::test]
async fn nothing_recorded_is_later_than_the_sim_time() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let mut run = Run::start(&db, 1, quick());
    let mut checked = 0;
    // Odd steps, so the checks fall on and off the five-minute writes.
    for step in [1, 9, 290, 1, 299, 1, 37, 263, 300, 7] {
        run.fly(step);
        run.written().await;
        let now_s = i64::from(run.tick.sim_time_s);
        let row = sqlx::query(
            "SELECT \
               (SELECT max(first_sample_sim_s + (sample_count - 1) * 10) FROM flight_tracks), \
               (SELECT max(first_seen_sim_s) FROM flights), \
               (SELECT max(last_seen_sim_s) FROM flights)",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();
        for column in 0..3 {
            if let Some(latest) = row.get::<Option<i64>, _>(column) {
                assert!(latest <= now_s, "column {column}: {latest} s at {now_s} s");
                checked += 1;
            }
        }
        // A flight still in the air has no end, and its track stops at or
        // before now.
        let open: i64 = sqlx::query("SELECT count(*) FROM flights WHERE last_seen_at IS NULL")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get(0);
        assert_eq!(open as usize, run.recorder.open_flights());
    }
    assert!(checked > 20);
    db.drop().await;
}

#[tokio::test]
async fn a_multiplier_writes_the_same_rows_as_none() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let seconds = fixture::WINDOW_S + 400;
    let mut counts = Vec::new();
    for multiplier in [1, 3] {
        let mut run = Run::start(&db, multiplier, quick());
        run.fly(seconds);
        run.written().await;
        let samples: i64 =
            sqlx::query("SELECT COALESCE(sum(sample_count), 0)::bigint FROM flight_tracks")
                .fetch_one(&db.pool)
                .await
                .unwrap()
                .get(0);
        counts.push((
            db.count("flights").await,
            db.count("flight_tracks").await,
            samples,
        ));
        sqlx::query("TRUNCATE flights CASCADE")
            .execute(&db.pool)
            .await
            .unwrap();
    }
    assert!(counts[0].0 > 0 && counts[0].1 > 0);
    assert_eq!(counts[0], counts[1]);
    db.drop().await;
}

#[tokio::test]
async fn a_database_that_goes_away_and_comes_back_loses_nothing() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let mut run = Run::start(&db, 1, quick());
    run.fly(250);
    run.written().await;
    let flights_before = db.count("flights").await;

    db.set_reachable(false).await;
    // Ten minutes of sim time with no database: two five-minute writes,
    // flights starting and flights ending. The simulation's side must not
    // wait for any of it.
    let started = Instant::now();
    run.fly(600);
    let observing = started.elapsed();
    assert!(
        observing < Duration::from_secs(2),
        "600 ticks took {observing:?}"
    );
    // The writer has tried and failed by now.
    tokio::time::sleep(Duration::from_millis(300)).await;

    db.set_reachable(true).await;
    run.fly(fixture::WINDOW_S + 20 - 850);
    run.written().await;

    // As if it had never been away: every flight, every sample.
    assert!(db.count("flights").await > flights_before);
    for flight in &fixture::recording().flights {
        let id: i64 = sqlx::query("SELECT id FROM flights WHERE callsign = $1 AND pass = 0")
            .bind(callsign(flight))
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get(0);
        let last_s = flight.end_s().min(fixture::WINDOW_S - 1);
        let flown = flight
            .samples
            .iter()
            .enumerate()
            .filter(|(n, _)| flight.start_s() + *n as u32 * SAMPLE_SPACING_S <= last_s)
            .count();
        assert_eq!(
            recorded_track(&db, id).await.len(),
            flown,
            "{}",
            callsign(flight)
        );
    }
    let open: i64 =
        sqlx::query("SELECT count(*) FROM flights WHERE pass = 0 AND last_seen_at IS NULL")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get(0);
    assert_eq!(open, 0);
    db.drop().await;
}

#[tokio::test]
async fn past_the_limit_the_oldest_samples_are_dropped_and_the_rest_is_written() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let limits = Limits {
        max_waiting_samples: 40,
        ..quick()
    };
    let mut run = Run::start(&db, 1, limits);
    db.set_reachable(false).await;
    run.fly(900);
    tokio::time::sleep(Duration::from_millis(300)).await;
    db.set_reachable(true).await;
    run.fly(fixture::WINDOW_S + 20 - 900);
    run.written().await;

    // Every flight has its row and its end, and some samples are missing.
    let flights = fixture::recording().flights.len() as i64;
    let over: i64 =
        sqlx::query("SELECT count(*) FROM flights WHERE pass = 0 AND last_seen_at IS NOT NULL")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get(0);
    assert_eq!(over, flights);
    let recorded: i64 =
        sqlx::query("SELECT COALESCE(sum(sample_count), 0)::bigint FROM flight_tracks")
            .fetch_one(&db.pool)
            .await
            .unwrap()
            .get(0);
    let flown: usize = fixture::recording()
        .flights
        .iter()
        .map(|f| f.samples.len())
        .sum();
    assert!(
        recorded > 0 && (recorded as usize) < flown,
        "{recorded} of {flown}"
    );
    db.drop().await;
}

fn flight(aircraft_id: u32, callsign: &str, sim_time_s: u32, at: f64) -> FlightStart {
    FlightStart {
        aircraft_id,
        icao24: 0xabc123,
        callsign: callsign.to_owned(),
        aircraft_type: "B738".to_owned(),
        origin: None,
        destination: Some("KJFK".to_owned()),
        pass: 0,
        sim_time_s,
        at,
    }
}

#[tokio::test]
async fn rows_more_than_a_day_old_are_deleted_with_their_tracks() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let hour = 3_600.0;
    let starts = [
        flight(1, "OLD", 0, now() - 30.0 * hour),
        flight(2, "EDGE", 0, now() - 26.0 * hour),
        flight(3, "RECENT", 0, now() - 2.0 * hour),
        flight(4, "FLYING", 0, now() - 1.0 * hour),
    ];
    let ids: BTreeMap<u32, i64> =
        store::insert_flights(&db.pool, &starts.iter().collect::<Vec<_>>())
            .await
            .unwrap()
            .into_iter()
            .collect();
    let samples = fixture::recording().flights[0].samples.clone();
    let rows: Vec<TrackRow> = ids
        .values()
        .map(|id| TrackRow::new(*id, 0, &samples))
        .collect();
    store::insert_tracks(&db.pool, &rows).await.unwrap();
    // OLD ended 29 hours ago. EDGE started 26 hours ago and ended 23 hours
    // ago, so it is kept: age is counted from when a flight was last seen.
    let end = |aircraft_id, hours_ago: f64| FlightEnd {
        aircraft_id,
        sim_time_s: 600,
        at: now() - hours_ago * hour,
    };
    let (old, edge, recent) = (end(1, 29.0), end(2, 23.0), end(3, 1.5));
    store::close_flights(
        &db.pool,
        &[(ids[&1], &old), (ids[&2], &edge), (ids[&3], &recent)],
    )
    .await
    .unwrap();

    let deleted = store::delete_flights_before(&db.pool, now() - 24.0 * hour)
        .await
        .unwrap();
    assert_eq!(deleted, 1);
    let left: Vec<String> = sqlx::query("SELECT callsign FROM flights ORDER BY callsign")
        .fetch_all(&db.pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(left, ["EDGE", "FLYING", "RECENT"]);
    assert_eq!(db.count("flight_tracks").await, 3);
    // Again: nothing more to delete.
    assert_eq!(
        store::delete_flights_before(&db.pool, now() - 24.0 * hour)
            .await
            .unwrap(),
        0
    );
    db.drop().await;
}

#[tokio::test]
async fn flights_an_earlier_run_left_open_are_closed_where_their_tracks_end() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let began = now() - 1_000.0;
    let starts = [
        flight(1, "TRACKED", 100, began),
        flight(2, "BARE", 250, began),
        flight(3, "DONE", 100, began),
    ];
    let ids: BTreeMap<u32, i64> =
        store::insert_flights(&db.pool, &starts.iter().collect::<Vec<_>>())
            .await
            .unwrap()
            .into_iter()
            .collect();
    let samples = vec![Sample::default(); 30];
    store::insert_tracks(
        &db.pool,
        &[
            TrackRow::new(ids[&1], 100, &samples),
            // Its last sample is at 400 + 11 × 10 = 510 s.
            TrackRow::new(ids[&1], 400, &samples[..12]),
        ],
    )
    .await
    .unwrap();
    let done = FlightEnd {
        aircraft_id: 3,
        sim_time_s: 180,
        at: began + 80.0,
    };
    store::close_flights(&db.pool, &[(ids[&3], &done)])
        .await
        .unwrap();

    assert_eq!(store::prepare(&db.pool).await.unwrap(), 2);

    let rows = sqlx::query(
        "SELECT callsign, last_seen_sim_s, \
           extract(epoch FROM last_seen_at - first_seen_at)::double precision \
         FROM flights ORDER BY callsign",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    let closed: Vec<(String, Option<i64>, Option<f64>)> = rows
        .iter()
        .map(|row| (row.get(0), row.get(1), row.get(2)))
        .collect();
    assert_eq!(
        closed,
        [
            // No track: closed where it started.
            ("BARE".to_owned(), Some(250), Some(0.0)),
            // Already closed: left alone.
            ("DONE".to_owned(), Some(180), Some(80.0)),
            // Closed at its last recorded sample, 410 s after it started.
            ("TRACKED".to_owned(), Some(510), Some(410.0)),
        ]
    );
    // A second start finds nothing open.
    assert_eq!(store::prepare(&db.pool).await.unwrap(), 0);
    db.drop().await;
}

#[tokio::test]
async fn a_table_without_a_column_the_recorder_writes_is_named() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    assert!(store::check_schema(&db.pool).await.is_ok());

    sqlx::query("ALTER TABLE flights RENAME COLUMN callsign TO call_sign")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE flight_tracks DROP COLUMN sample_count")
        .execute(&db.pool)
        .await
        .unwrap();
    let Err(store::Error::Schema(problem)) = store::check_schema(&db.pool).await else {
        panic!("expected the schema to be refused");
    };
    assert!(
        problem.contains("flights.callsign, flight_tracks.sample_count"),
        "{problem}"
    );
    assert!(!problem.contains("flights.icao24"), "{problem}");

    // And that stops the recorder from starting at all.
    let started = atc_server::recorder::start(db.pool.clone(), fixture::WINDOW_S).await;
    assert!(
        started
            .unwrap_err()
            .to_string()
            .contains("flights.callsign")
    );
    db.drop().await;
}

#[tokio::test]
async fn with_no_database_the_recorder_still_starts_and_the_simulation_is_not_held_up() {
    // Port 9 is the discard service; nothing listens there.
    let dead = atc_server::connect_lazy("postgres://atc:atc@127.0.0.1:9/atc").unwrap();
    let started = Instant::now();
    let mut recorder = atc_server::recorder::start(dead, fixture::WINDOW_S)
        .await
        .expect("an unreachable database is not an error");
    assert!(started.elapsed() < Duration::from_secs(10));

    let mut replay = Replay::new(fixture::recording()).unwrap();
    let mut tick = Tick::default();
    let flying = Instant::now();
    for _ in 0..fixture::WINDOW_S {
        replay.advance(&mut tick);
        recorder.observe(&tick);
    }
    assert!(
        flying.elapsed() < Duration::from_secs(2),
        "{:?}",
        flying.elapsed()
    );
}

/// What the recorder writes for one pass of the committed recording, and
/// how big it is. Slow, so not part of the usual run:
///
///   cargo test --release -p atc-server --test recorder -- --ignored --nocapture
#[tokio::test]
#[ignore = "measures a whole pass of the committed recording; takes minutes"]
async fn measure_a_pass_of_the_committed_recording() {
    let Some(db) = TestDb::create().await else {
        return;
    };
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/seed/flights.bin.gz");
    let recording = atc_server::seed::load(&path).unwrap();
    let window_s = recording.window_s;
    // ATC_MEASURE_MULTIPLIER flies it with clones, which are not recorded:
    // the rows are the same and `observe` has more aircraft to pass over.
    let multiplier = std::env::var("ATC_MEASURE_MULTIPLIER")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let mut replay = Replay::with_multiplier(recording, multiplier).unwrap();
    let (mut recorder, events) = Recorder::new(window_s);
    tokio::spawn(writer::run(
        db.pool.clone(),
        events,
        false,
        Limits::default(),
    ));

    let mut tick = Tick::default();
    let (mut slowest, mut total) = (Duration::ZERO, Duration::ZERO);
    let started = Instant::now();
    // One pass exactly: the tick after it would start the next pass's
    // flights.
    for second in 0..window_s {
        replay.advance(&mut tick);
        let observing = Instant::now();
        recorder.observe(&tick);
        let took = observing.elapsed();
        slowest = slowest.max(took);
        total += took;
        // Let the writer keep up, as a second between ticks would.
        if second % 300 == 0 {
            recorder.sync().await.unwrap();
        }
    }
    recorder.sync().await.unwrap();
    let elapsed = started.elapsed();

    let row = sqlx::query(
        "SELECT (SELECT count(*) FROM flights), (SELECT count(*) FROM flight_tracks), \
           (SELECT sum(sample_count)::bigint FROM flight_tracks), \
           (SELECT sum(length(samples))::bigint FROM flight_tracks), \
           pg_total_relation_size('flight_tracks'), pg_total_relation_size('flights'), \
           pg_relation_size('flight_tracks'), pg_indexes_size('flight_tracks')",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let n = |column: usize| row.get::<i64, _>(column);
    let mb = |bytes: i64| bytes as f64 / 1e6;
    println!("one pass of {window_s} s at multiplier {multiplier}, flown in {elapsed:.1?}");
    println!(
        "observe(): mean {:.3?} a tick, slowest {slowest:.3?}",
        total / window_s
    );
    println!("flights rows        {}", n(0));
    println!("flight_tracks rows  {}", n(1));
    println!("samples             {}", n(2));
    println!(
        "sample bytes        {:.1} MB, {:.2} a sample, {:.0} a row",
        mb(n(3)),
        n(3) as f64 / n(2) as f64,
        n(3) as f64 / n(1) as f64
    );
    println!(
        "flight_tracks       {:.1} MB in all: {:.1} table, {:.1} indexes",
        mb(n(4)),
        mb(n(6)),
        mb(n(7))
    );
    println!("flights             {:.1} MB in all", mb(n(5)));
    println!("a day, six passes   {:.2} GB", mb((n(4) + n(5)) * 6) / 1e3);
    db.drop().await;
}

// `Event` is part of the recorder's interface and is named here so a change
// to it shows up in this file.
#[allow(dead_code)]
fn events_are_public(_: Event) {}
