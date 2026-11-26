//! The client against the real hub, in process, on the fixture's replay.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use atc_cli::args::{Options, Viewport};
use atc_cli::session::{Error, Event, Session, TickSummary};
use atc_cli::{Failure, run};
use atc_core::fixture;
use atc_server::AppState;
use atc_server::config::Auth;
use atc_server::hub::{Hub, SimInfo};
use atc_server::sim::replay::Replay;
use atc_server::sim::track::Tracks;
use atc_server::sim::{Feed, Tick};
use atc_server::world::WorldWriter;
use tokio::net::TcpListener;

/// A server on a port of its own. The test plays the simulator: it publishes
/// ticks through `world` when it chooses to.
struct Server {
    addr: SocketAddr,
    world: WorldWriter,
}

async fn serve_with(auth: Auth) -> Server {
    let world = WorldWriter::new();
    let sim = SimInfo {
        multiplier: 1,
        window_s: fixture::WINDOW_S,
    };
    let state = AppState {
        // Never connected to: nothing here asks for the database.
        db: atc_server::connect_lazy("postgres://atc:atc@127.0.0.1:9/atc").unwrap(),
        // The same recording the tests replay, so a track can be asked for.
        hub: Hub::spawn(
            world.reader(),
            sim,
            Tracks::new(Arc::new(fixture::recording())),
        ),
        allowed_origin: "http://localhost:3000".to_owned(),
        auth,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, atc_server::app(state)).await });
    Server { addr, world }
}

async fn serve() -> Server {
    serve_with(Auth::Off).await
}

fn options(server: &Server) -> Options {
    Options {
        url: format!("ws://{}/ws", server.addr),
        ..Options::default()
    }
}

/// Publishes the replay's ticks, far faster than once a second, until the
/// test ends.
fn replay_quickly(mut world: WorldWriter) {
    tokio::spawn(async move {
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        loop {
            replay.advance(&mut tick);
            world.update(&tick);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
}

/// The next tick the session is sent, past any other event.
async fn next_tick(session: &mut Session) -> TickSummary {
    loop {
        if let Event::Tick(tick) = session.next().await.unwrap() {
            return tick;
        }
    }
}

/// Runs the client to its end and returns what it printed with its result.
async fn run_to_end(options: &Options) -> (String, Result<atc_cli::session::Totals, Failure>) {
    let mut out = Vec::new();
    let result = run(options, &mut out, std::future::pending()).await;
    (String::from_utf8(out).unwrap(), result)
}

#[tokio::test]
async fn every_tick_of_the_replay_is_summarised_through_a_pass_boundary() {
    let mut server = serve().await;
    let mut session = Session::connect(&options(&server)).await.unwrap();
    assert_eq!(
        session.next().await.unwrap(),
        Event::Sim {
            multiplier: 1,
            window_s: u64::from(fixture::WINDOW_S),
        }
    );

    let mut replay = Replay::new(fixture::recording()).unwrap();
    let mut tick = Tick::default();
    let mut announced = 0;
    // Past the end of the first pass, where every aircraft is replaced.
    for seq in 0..fixture::WINDOW_S + 60 {
        replay.advance(&mut tick);
        server.world.update(&tick);
        let Event::Tick(summary) = session.next().await.unwrap() else {
            panic!("expected a tick");
        };

        assert_eq!(summary.seq, seq);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.sim_time_ms, tick.sim_time_ms());
        assert_eq!(summary.aircraft, tick.positions.len());
        assert_eq!(summary.announced, tick.appeared.len());
        assert_eq!(summary.unannounced, 0);
        assert_eq!(summary.new_pass, tick.new_pass);
        // A positions frame, and a metadata frame if anything is new.
        let metadata = match tick.appeared.len() {
            0 => 0,
            new => 24 + 40 * new,
        };
        assert_eq!(summary.bytes, 24 + 24 * tick.positions.len() + metadata);
        if seq == 0 {
            // The first tick announces every aircraft in it.
            assert!(summary.aircraft > 0);
            assert_eq!(summary.announced, summary.aircraft);
        }
        announced += tick.appeared.len() as u64;
    }

    let totals = session.totals();
    assert_eq!(totals.ticks, u64::from(fixture::WINDOW_S) + 60);
    assert_eq!((totals.skipped, totals.new_passes), (0, 1));
    assert_eq!((totals.announced, totals.unannounced), (announced, 0));
    assert!(announced > fixture::recording().flights.len() as u64);
    assert_eq!(totals.aircraft, tick.positions.len());
    session.close().await;
}

#[tokio::test]
async fn a_run_prints_a_line_per_tick_and_stops_after_the_frames_asked_for() {
    let server = serve().await;
    let options = Options {
        frames: Some(5),
        dump: 2,
        ..options(&server)
    };
    replay_quickly(server.world);

    let (printed, result) = run_to_end(&options).await;
    // Shown by `cargo test -- --nocapture`.
    println!("{printed}");
    let totals = result.unwrap();

    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(lines[0], format!("connected to {}", options.url));
    assert_eq!(
        lines[1],
        "sim: multiplier 1, a pass lasts 00:20:00 (1,200 s)"
    );
    let ticks: Vec<&&str> = lines.iter().filter(|l| l.starts_with("seq ")).collect();
    assert_eq!(ticks.len(), 5);
    assert!(ticks[0].starts_with("seq      0  t 00:00:"), "{}", ticks[0]);
    // Two aircraft under every tick, each with a callsign and both altitudes.
    let dumped: Vec<&&str> = lines.iter().filter(|l| l.starts_with("  ")).collect();
    assert_eq!(dumped.len(), 10);
    for line in dumped {
        assert!(!line.starts_with("  ?"), "{line}");
        assert!(
            line.contains(" ft  baro ") && line.contains(" kt  "),
            "{line}"
        );
    }
    assert!(lines[lines.len() - 2].starts_with("5 ticks in "));
    assert!(lines[lines.len() - 1].contains(" never announced, "));

    assert_eq!(totals.ticks, 5);
    assert_eq!(totals.unannounced, 0);
    assert!(totals.aircraft > 0);
    assert!(totals.announced >= totals.aircraft as u64);
}

/// The server may refuse these requests or act on them. Either way the
/// connection stays open and the ticks keep coming.
#[tokio::test]
async fn a_viewport_a_selection_and_a_track_request_are_sent_and_the_stream_goes_on() {
    let server = serve().await;
    let options = Options {
        viewport: Some(Viewport {
            west: -180.0,
            south: -90.0,
            east: 180.0,
            north: 90.0,
        }),
        select: Some(1),
        track: Some(1),
        ..options(&server)
    };
    replay_quickly(server.world);

    let mut session = Session::connect(&options).await.unwrap();
    let mut last = next_tick(&mut session).await;
    for _ in 0..3 {
        let tick = next_tick(&mut session).await;
        assert!(tick.seq > last.seq);
        assert!(tick.sim_time_ms > last.sim_time_ms);
        last = tick;
    }
}

#[tokio::test]
async fn a_server_that_closes_the_connection_fails_the_run_with_its_code() {
    let mut server = serve().await;
    let mut replay = Replay::new(fixture::recording()).unwrap();
    let mut tick = Tick::default();
    replay.advance(&mut tick);
    server.world.update(&tick);
    let options = options(&server);
    // The simulator stops, most likely after the client's first tick.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(server.world);
    });

    let (printed, result) = run_to_end(&options).await;

    let Err(Failure::Session(error)) = result else {
        panic!("expected the run to fail");
    };
    assert!(matches!(
        error,
        Error::Closed {
            code: Some(1001),
            ..
        }
    ));
    assert!(error.to_string().contains("code 1001"));
    // The totals are printed all the same.
    assert!(printed.contains(" skipped, 0 new passes\n"), "{printed}");
}

#[tokio::test]
async fn a_server_that_wants_a_token_fails_the_run_with_the_http_status() {
    let auth = Auth::Jwks {
        url: "http://localhost:3000/api/auth/jwks".to_owned(),
    };
    let server = serve_with(auth).await;

    let (printed, result) = run_to_end(&options(&server)).await;

    let Err(Failure::Session(error)) = result else {
        panic!("expected the run to fail");
    };
    assert!(matches!(error, Error::Refused { status: 401, .. }));
    assert!(error.to_string().contains("HTTP 401"));
    assert_eq!(printed, "");
}

#[tokio::test]
async fn nothing_listening_fails_the_run_and_names_the_url() {
    // A port that was free a moment ago.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    drop(listener);
    let options = Options {
        url: url.clone(),
        ..Options::default()
    };

    let (_, result) = run_to_end(&options).await;

    let Err(Failure::Session(error)) = result else {
        panic!("expected the run to fail");
    };
    assert!(matches!(error, Error::Connect { .. }));
    let message = error.to_string();
    assert!(message.starts_with(&format!("could not connect to {url}: ")));
}
