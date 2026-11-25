//! The command-line client: it connects to `atc-server`'s WebSocket, says
//! hello and prints a running summary of what arrives, one line per tick.

pub mod args;
pub mod report;
pub mod session;

use std::fmt;
use std::io::{self, Write};

use args::Options;
use session::{Event, Session, Totals};

/// Why a run failed.
#[derive(Debug)]
pub enum Failure {
    /// The connection failed or the server sent something wrong.
    Session(session::Error),
    /// The summary could not be written, for example to a closed pipe.
    Output(io::Error),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::Session(error) => error.fmt(f),
            Failure::Output(error) => write!(f, "could not write the summary: {error}"),
        }
    }
}

impl std::error::Error for Failure {}

impl From<session::Error> for Failure {
    fn from(error: session::Error) -> Failure {
        Failure::Session(error)
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Failure {
        Failure::Output(error)
    }
}

/// Connects and prints to `out` until `options.frames` ticks have arrived or
/// `stop` resolves, then prints the totals. If the connection fails first,
/// the totals so far are still printed.
pub async fn run(
    options: &Options,
    out: &mut impl Write,
    stop: impl Future<Output = ()>,
) -> Result<Totals, Failure> {
    let mut session = Session::connect(options).await?;
    writeln!(out, "connected to {}", options.url)?;

    let watched = watch(&mut session, options, out, stop).await;
    let totals = session.totals().clone();
    session.close().await;
    let written = report::totals_lines(&totals)
        .iter()
        .try_for_each(|line| writeln!(out, "{line}"));
    watched?;
    written?;
    Ok(totals)
}

/// Prints every event until it is time to stop.
async fn watch(
    session: &mut Session,
    options: &Options,
    out: &mut impl Write,
    stop: impl Future<Output = ()>,
) -> Result<(), Failure> {
    tokio::pin!(stop);
    loop {
        let event = tokio::select! {
            event = session.next() => event?,
            () = &mut stop => return Ok(()),
        };
        match event {
            Event::Sim {
                multiplier,
                window_s,
            } => writeln!(out, "{}", report::sim_line(multiplier, window_s))?,
            Event::Refusal { code, message } => {
                writeln!(out, "{}", report::refusal_line(&code, &message))?;
            }
            Event::Tick(tick) => {
                writeln!(out, "{}", report::tick_line(&tick))?;
                for aircraft in &tick.sample {
                    writeln!(out, "{}", report::aircraft_line(aircraft))?;
                }
                if Some(session.totals().ticks) == options.frames {
                    return Ok(());
                }
            }
            Event::Track { samples, bytes } => {
                writeln!(out, "{}", report::track_line(&samples, bytes))?;
                // The newest samples, since the track ends where the
                // aircraft is now.
                let newest = samples.len().saturating_sub(options.dump);
                for sample in &samples[newest..] {
                    writeln!(out, "{}", report::sample_line(sample))?;
                }
            }
            Event::Alerts { count, bytes } => {
                writeln!(out, "{}", report::alerts_line(count, bytes))?;
            }
            Event::Unknown(text) => writeln!(out, "unknown message: {text}")?,
        }
    }
}
