use std::process::ExitCode;

use atc_server::{
    AppState,
    config::{Auth, Config},
    sim::{self, replay::Replay},
};
use tokio::net::TcpListener;

const BIND_ADDR: &str = "0.0.0.0:8080";

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    if config.auth == Auth::Off {
        eprintln!("warning: ATC_AUTH=off; every connection is treated as the dev user");
    }

    match serve(&config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atc-server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let state = AppState {
        db: atc_server::connect_lazy(&config.database_url)?,
    };
    // The fixture stands in for the seed file until its reader exists.
    let replay = Replay::new(atc_core::fixture::recording())?;
    let recording = replay.recording();
    println!(
        "replaying {} flights over a {} s window (the built-in fixture)",
        recording.flights.len(),
        recording.window_s
    );
    tokio::spawn(sim::run(replay, |tick| {
        if tick.new_pass {
            println!(
                "replay restarted at sim time {} s with {} aircraft",
                tick.sim_time_s,
                tick.positions.len()
            );
        }
    }));

    let listener = TcpListener::bind(BIND_ADDR).await?;
    println!(
        "atc-server listening on {BIND_ADDR} (protocol v{})",
        atc_core::PROTOCOL_VERSION
    );
    axum::serve(listener, atc_server::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
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
