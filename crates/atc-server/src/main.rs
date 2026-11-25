use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;

use atc_server::{
    AppState,
    config::{Auth, Config},
    hub::{Hub, SimInfo},
    metrics::{Metrics, SUMMARY_EVERY},
    seed,
    sim::{self, replay::Replay},
    world::WorldWriter,
};
use tokio::net::TcpListener;
use tracing::{error, info, warn};

const BIND_ADDR: &str = "0.0.0.0:8080";

#[tokio::main]
async fn main() -> ExitCode {
    // Before logging starts, since the configuration says how much to log.
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    tracing_subscriber::fmt()
        .with_max_level(config.log_level)
        .with_target(false)
        // Colour only for a person at a terminal, not in `docker compose logs`.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    if config.auth == Auth::Off {
        warn!("ATC_AUTH=off: every connection is treated as the dev user");
    }

    match serve(&config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            error!("atc-server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let db = atc_server::connect_lazy(&config.database_url)?;
    // Read before anything listens: a server with no recording is no use.
    let replay = Replay::with_multiplier(seed::load(&config.seed_file)?, config.stress_multiplier)?;
    let recording = replay.recording();
    info!(
        "replaying {} flights over a {} s window from {}, at multiplier {}",
        recording.flights.len(),
        recording.window_s,
        config.seed_file.display(),
        replay.multiplier()
    );
    let metrics = Arc::new(Metrics::default());
    let mut world = WorldWriter::new();
    let sim = SimInfo {
        multiplier: config.stress_multiplier,
        window_s: recording.window_s,
    };
    let state = AppState {
        db,
        hub: Hub::spawn_with(world.reader(), sim, replay.tracks(), metrics.clone()),
        allowed_origin: config.allowed_origin.clone(),
        auth: config.auth.clone(),
    };
    tokio::spawn(sim::run(replay, metrics.clone(), move |tick| {
        world.update(tick);
        if tick.sim_time_s == 0 {
            info!("{} aircraft in the picture", tick.positions.len());
        }
        if tick.new_pass {
            info!(
                "replay restarted at sim time {} s with {} aircraft",
                tick.sim_time_s,
                tick.positions.len()
            );
        }
    }));
    tokio::spawn(summarise(metrics));

    let listener = TcpListener::bind(BIND_ADDR).await?;
    info!(
        "atc-server listening on {BIND_ADDR} (protocol v{})",
        atc_core::PROTOCOL_VERSION
    );
    axum::serve(listener, atc_server::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Logs what the server has done every [`SUMMARY_EVERY`], for ever.
async fn summarise(metrics: Arc<Metrics>) {
    let mut interval = tokio::time::interval(SUMMARY_EVERY);
    // The first tick of an interval is immediate, and has nothing to report.
    interval.tick().await;
    loop {
        interval.tick().await;
        info!("{}", metrics.summary(SUMMARY_EVERY));
    }
}

/// Resolves on Ctrl-C or SIGTERM, so `docker compose down` stops the server
/// at once and does not wait out the kill timeout.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate()).expect("install the SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
