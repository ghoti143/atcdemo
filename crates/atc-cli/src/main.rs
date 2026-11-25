use std::process::ExitCode;

use atc_cli::args::{self, Command};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let options = match args::parse(std::env::args().skip(1)) {
        Ok(Command::Run(options)) => options,
        Ok(Command::Help) => {
            println!("{}", args::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(problem) => {
            eprintln!("atc-cli: {problem}\nRun `atc-cli --help` for the options.");
            return ExitCode::from(2);
        }
    };

    match atc_cli::run(&options, &mut std::io::stdout(), ctrl_c()).await {
        Ok(_) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("atc-cli: {failure}");
            ExitCode::FAILURE
        }
    }
}

/// Resolves on Ctrl-C, so the totals are printed before the client leaves.
async fn ctrl_c() {
    if tokio::signal::ctrl_c().await.is_err() {
        // Without the handler Ctrl-C ends the process the usual way.
        std::future::pending::<()>().await;
    }
}
