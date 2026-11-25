//! Counters that say whether the server is keeping up.
//!
//! Every part of the server that does timed or counted work holds the same
//! [`Metrics`] and adds to it without locking. A task in `main` takes a
//! [`Summary`] every [`SUMMARY_EVERY`] and logs it as one line.

use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

/// How often the summary line is logged.
pub const SUMMARY_EVERY: Duration = Duration::from_secs(30);

/// How long one kind of work takes: every run since the last summary, and
/// the latest run on its own.
#[derive(Debug, Default)]
pub struct Timing {
    runs: AtomicU64,
    total_nanos: AtomicU64,
    longest_nanos: AtomicU64,
    latest_nanos: AtomicU64,
}

impl Timing {
    pub fn record(&self, took: Duration) {
        let nanos = u64::try_from(took.as_nanos()).unwrap_or(u64::MAX);
        self.runs.fetch_add(1, Ordering::Relaxed);
        self.total_nanos.fetch_add(nanos, Ordering::Relaxed);
        self.longest_nanos.fetch_max(nanos, Ordering::Relaxed);
        self.latest_nanos.store(nanos, Ordering::Relaxed);
    }

    /// How long the latest run took; zero before the first.
    pub fn latest(&self) -> Duration {
        Duration::from_nanos(self.latest_nanos.load(Ordering::Relaxed))
    }

    /// The runs since this was last called, and starts counting afresh.
    fn take(&self) -> Timed {
        let runs = self.runs.swap(0, Ordering::Relaxed);
        let total = Duration::from_nanos(self.total_nanos.swap(0, Ordering::Relaxed));
        Timed {
            runs,
            mean: total.checked_div(runs as u32).unwrap_or_default(),
            longest: Duration::from_nanos(self.longest_nanos.swap(0, Ordering::Relaxed)),
        }
    }
}

/// One kind of work over one summary's stretch of time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Timed {
    pub runs: u64,
    pub mean: Duration,
    pub longest: Duration,
}

impl fmt::Display for Timed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ms = |d: Duration| d.as_secs_f64() * 1_000.0;
        write!(
            f,
            "{:.1} ms, longest {:.1} ms",
            ms(self.mean),
            ms(self.longest)
        )
    }
}

/// What the server counts.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Advancing the simulation one tick and updating the world state.
    pub tick: Timing,
    /// Building the whole-picture frame that connections share.
    pub picture: Timing,
    /// One pass of the conflict detector. Nothing records this until
    /// milestone 7.
    pub conflict_pass: Timing,
    aircraft: AtomicUsize,
    clients: AtomicUsize,
    frames_sent: AtomicU64,
    frames_skipped: AtomicU64,
    bytes_sent: AtomicU64,
}

impl Metrics {
    /// The number of aircraft in the latest tick.
    pub fn set_aircraft(&self, count: usize) {
        self.aircraft.store(count, Ordering::Relaxed);
    }

    pub fn client_connected(&self) {
        self.clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn client_gone(&self) {
        self.clients.fetch_sub(1, Ordering::Relaxed);
    }

    /// How many clients are connected.
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// A frame of `bytes` was written to a client.
    pub fn frame_sent(&self, bytes: usize) {
        self.frames_sent.fetch_add(1, Ordering::Relaxed);
        self.bytes_sent.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    /// A client was not sent `pictures` ticks, because it was still being
    /// written an earlier one when they came and went.
    pub fn pictures_skipped(&self, pictures: u64) {
        self.frames_skipped.fetch_add(pictures, Ordering::Relaxed);
    }

    /// Everything since the last summary, `over` that stretch of time. The
    /// counts start again from zero.
    pub fn summary(&self, over: Duration) -> Summary {
        Summary {
            over,
            tick: self.tick.take(),
            picture: self.picture.take(),
            conflict_pass: self.conflict_pass.take(),
            aircraft: self.aircraft.load(Ordering::Relaxed),
            clients: self.clients(),
            frames_sent: self.frames_sent.swap(0, Ordering::Relaxed),
            frames_skipped: self.frames_skipped.swap(0, Ordering::Relaxed),
            bytes_sent: self.bytes_sent.swap(0, Ordering::Relaxed),
        }
    }
}

/// The server's work over one stretch of time, as the summary line shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub over: Duration,
    pub tick: Timed,
    pub picture: Timed,
    pub conflict_pass: Timed,
    pub aircraft: usize,
    pub clients: usize,
    pub frames_sent: u64,
    pub frames_skipped: u64,
    pub bytes_sent: u64,
}

impl Summary {
    /// Bytes a second written to each client, on average.
    pub fn bytes_per_client_per_second(&self) -> f64 {
        let seconds = self.over.as_secs_f64();
        if self.clients == 0 || seconds == 0.0 {
            return 0.0;
        }
        self.bytes_sent as f64 / self.clients as f64 / seconds
    }
}

impl fmt::Display for Summary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} ticks, tick {}, picture {}; {} aircraft; {} clients, {} frames sent, \
             {} skipped, {:.0} kB/s per client",
            self.tick.runs,
            self.tick,
            self.picture,
            self.aircraft,
            self.clients,
            self.frames_sent,
            self.frames_skipped,
            self.bytes_per_client_per_second() / 1_000.0,
        )?;
        if self.conflict_pass.runs > 0 {
            write!(f, "; conflict pass {}", self.conflict_pass)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn a_timing_reports_the_mean_the_longest_and_the_latest() {
        let timing = Timing::default();
        assert_eq!(timing.latest(), Duration::ZERO);
        for took in [2 * MS, 9 * MS, 4 * MS] {
            timing.record(took);
        }
        assert_eq!(timing.latest(), 4 * MS);
        assert_eq!(
            timing.take(),
            Timed {
                runs: 3,
                mean: 5 * MS,
                longest: 9 * MS
            }
        );
        // Taking starts the count again, but the latest run is still known.
        assert_eq!(timing.take(), Timed::default());
        assert_eq!(timing.latest(), 4 * MS);
    }

    #[test]
    fn a_summary_counts_since_the_one_before() {
        let metrics = Metrics::default();
        metrics.tick.record(3 * MS);
        metrics.picture.record(MS);
        metrics.set_aircraft(7_978);
        metrics.client_connected();
        metrics.client_connected();
        metrics.frame_sent(600_000);
        metrics.frame_sent(600_000);
        metrics.pictures_skipped(4);

        let summary = metrics.summary(Duration::from_secs(30));
        assert_eq!(summary.tick.runs, 1);
        assert_eq!(summary.frames_sent, 2);
        assert_eq!(summary.frames_skipped, 4);
        assert_eq!(summary.bytes_sent, 1_200_000);
        // 1.2 MB between two clients over 30 s.
        assert_eq!(summary.bytes_per_client_per_second(), 20_000.0);
        assert_eq!(
            summary.to_string(),
            "1 ticks, tick 3.0 ms, longest 3.0 ms, picture 1.0 ms, longest 1.0 ms; \
             7978 aircraft; 2 clients, 2 frames sent, 4 skipped, 20 kB/s per client"
        );

        // Counts start again; the aircraft and the clients are as they are.
        metrics.client_gone();
        let next = metrics.summary(Duration::from_secs(30));
        assert_eq!(
            (next.frames_sent, next.frames_skipped, next.bytes_sent),
            (0, 0, 0)
        );
        assert_eq!((next.aircraft, next.clients), (7_978, 1));
    }

    #[test]
    fn the_conflict_pass_shows_once_something_records_it() {
        let metrics = Metrics::default();
        assert!(!metrics.summary(MS).to_string().contains("conflict"));
        metrics.conflict_pass.record(250 * MS);
        let line = metrics.summary(MS).to_string();
        assert!(
            line.ends_with("; conflict pass 250.0 ms, longest 250.0 ms"),
            "{line}"
        );
    }

    #[test]
    fn nobody_connected_is_no_bytes_a_second() {
        let metrics = Metrics::default();
        assert_eq!(metrics.summary(MS).bytes_per_client_per_second(), 0.0);
    }
}
