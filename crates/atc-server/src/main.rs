use std::process::ExitCode;

use atc_server::config::{Auth, Config};
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

    match serve().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atc-server failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve() -> std::io::Result<()> {
    let listener = TcpListener::bind(BIND_ADDR).await?;
    println!(
        "atc-server listening on {BIND_ADDR} (protocol v{})",
        atc_core::PROTOCOL_VERSION
    );
    axum::serve(listener, atc_server::app()).await
}
