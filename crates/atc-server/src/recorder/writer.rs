//! The half of the recorder that talks to Postgres. See the parent module.
//!
//! Events are written in the order they were sent, in batches: a run of
//! flights that started becomes one `INSERT`, a run of track batches
//! another. An event leaves the queue only when its statement has
//! succeeded, so a database that goes away loses nothing that fits in the
//! queue: the writer waits, tries again, and carries on from where it was.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::postgres::PgPool;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use super::store::{self, TrackRow};
use super::{Event, FlightEnd, FlightStart};

/// Rows older than this are deleted: every pass flies the same flights
/// again, so a day is six copies of the recording.
pub const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the old rows are looked for.
const RETAIN_EVERY: Duration = Duration::from_secs(10 * 60);

/// What bounds the writer.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The most samples kept waiting for a database that is away. Past it
    /// the oldest track batches are dropped. The default is about an hour
    /// of the real picture: 8,000 aircraft, a sample each every 10 s, 20
    /// bytes a sample, so about 60 MB.
    pub max_waiting_samples: usize,
    /// The most rows in one statement.
    pub max_rows: usize,
    /// How long to wait before trying a failed write again.
    pub retry_after: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_waiting_samples: 3_000_000,
            max_rows: 2_000,
            retry_after: Duration::from_secs(5),
        }
    }
}

/// The events not yet written, oldest first, and how much they hold.
#[derive(Debug, Default)]
pub struct Queue {
    events: VecDeque<Event>,
    samples: usize,
}

impl Queue {
    pub fn push(&mut self, event: Event) {
        if let Event::Track(batch) = &event {
            self.samples += batch.samples.len();
        }
        self.events.push_back(event);
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// How many samples are waiting.
    pub fn samples(&self) -> usize {
        self.samples
    }

    /// Drops the oldest track batches until no more than `limit` samples
    /// wait. Flights starting and ending are kept: they are small, and
    /// without them the batches that are kept would belong to nothing.
    /// Returns the number of samples dropped.
    pub fn shed(&mut self, limit: usize) -> usize {
        if self.samples <= limit {
            return 0;
        }
        let mut excess = self.samples - limit;
        let mut dropped = 0;
        self.events.retain(|event| match event {
            Event::Track(batch) if excess > 0 => {
                excess = excess.saturating_sub(batch.samples.len());
                dropped += batch.samples.len();
                false
            }
            _ => true,
        });
        self.samples -= dropped;
        dropped
    }

    fn pop(&mut self) -> Option<Event> {
        let event = self.events.pop_front()?;
        if let Event::Track(batch) = &event {
            self.samples -= batch.samples.len();
        }
        Some(event)
    }

    fn front(&self) -> Option<&Event> {
        self.events.front()
    }
}

/// The writer's state between statements.
struct Writer {
    db: PgPool,
    limits: Limits,
    queue: Queue,
    /// The `flights` row of each aircraft that is flying.
    flight_ids: HashMap<u32, i64>,
    /// Whether the schema has been checked and old flights closed.
    prepared: bool,
    /// Set when the tables turn out to be wrong: nothing more is written.
    disabled: bool,
    /// Whether the last attempt failed, so the recovery is logged once.
    failing: bool,
    /// Samples dropped since the last log line about them.
    dropped_samples: usize,
}

/// Takes events for as long as the recorder lives, and writes them.
/// `prepared` says whether [`store::prepare`] has already succeeded.
pub async fn run(
    db: PgPool,
    mut events: mpsc::UnboundedReceiver<Event>,
    prepared: bool,
    limits: Limits,
) {
    let mut writer = Writer {
        db,
        limits,
        queue: Queue::default(),
        flight_ids: HashMap::new(),
        prepared,
        disabled: false,
        failing: false,
        dropped_samples: 0,
    };
    loop {
        // Wait for something to write, unless something already waits.
        if writer.queue.is_empty() {
            match events.recv().await {
                Some(event) => writer.queue.push(event),
                None => return,
            }
        }
        while let Ok(event) = events.try_recv() {
            writer.queue.push(event);
        }
        writer.shed();

        if writer.write_all().await.is_err() {
            // Wait, still taking events in so the limit is kept.
            let wait = tokio::time::sleep(writer.limits.retry_after);
            tokio::pin!(wait);
            loop {
                tokio::select! {
                    () = &mut wait => break,
                    event = events.recv() => match event {
                        Some(event) => {
                            writer.queue.push(event);
                            writer.shed();
                        }
                        None => return,
                    },
                }
            }
        }
    }
}

impl Writer {
    fn shed(&mut self) {
        let dropped = self.queue.shed(self.limits.max_waiting_samples);
        if dropped > 0 {
            self.dropped_samples += dropped;
            warn!(
                "recorder: dropped {dropped} of the oldest waiting samples; more than {} were \
                 waiting for the database. The tracks of that time have a gap",
                self.limits.max_waiting_samples
            );
        }
    }

    /// Writes everything waiting, in order. On an error what was not
    /// written is still waiting.
    async fn write_all(&mut self) -> Result<(), ()> {
        if self.disabled {
            self.discard();
            return Ok(());
        }
        let waiting = self.queue.samples();
        match self.try_write_all().await {
            Ok(()) => {
                if self.failing {
                    self.failing = false;
                    info!(
                        "recorder: the database is back; wrote what was waiting, {waiting} \
                         samples, with {} dropped while it was away",
                        self.dropped_samples
                    );
                    self.dropped_samples = 0;
                }
                Ok(())
            }
            Err(store::Error::Schema(problem)) => {
                error!("recorder: {problem}. Nothing more will be recorded");
                self.disabled = true;
                self.discard();
                Ok(())
            }
            Err(store::Error::Database(problem)) => {
                if !self.failing {
                    self.failing = true;
                    warn!(
                        "recorder: could not write to the database ({problem}); keeping what \
                         there is to write and trying again every {:?}",
                        self.limits.retry_after
                    );
                }
                Err(())
            }
        }
    }

    /// Drops everything waiting, answering anyone who asked to be told.
    fn discard(&mut self) {
        while let Some(event) = self.queue.pop() {
            if let Event::Sync(done) = event {
                let _ = done.send(());
            }
        }
    }

    async fn try_write_all(&mut self) -> Result<(), store::Error> {
        if !self.prepared {
            let closed = store::prepare(&self.db).await?;
            self.prepared = true;
            if closed > 0 {
                info!("recorder: closed {closed} flight(s) an earlier run left open");
            }
        }
        while let Some(front) = self.queue.front() {
            match front {
                Event::Started(_) => self.write_started().await?,
                Event::Track(_) => self.write_tracks().await?,
                Event::Ended(_) => self.write_ended().await?,
                Event::Sync(_) => {
                    if let Some(Event::Sync(done)) = self.queue.pop() {
                        let _ = done.send(());
                    }
                }
            }
        }
        Ok(())
    }

    /// How many events at the front of the queue are of the kind `is`, up
    /// to the most one statement takes.
    fn run_of(&self, is: fn(&Event) -> bool) -> usize {
        self.queue
            .events
            .iter()
            .take(self.limits.max_rows)
            .take_while(|event| is(event))
            .count()
    }

    async fn write_started(&mut self) -> Result<(), store::Error> {
        let count = self.run_of(|event| matches!(event, Event::Started(_)));
        let starts: Vec<&FlightStart> = self
            .queue
            .events
            .iter()
            .take(count)
            .filter_map(|event| match event {
                Event::Started(start) => Some(start),
                _ => None,
            })
            .collect();
        let ids = store::insert_flights(&self.db, &starts).await?;
        self.flight_ids.extend(ids);
        for _ in 0..count {
            self.queue.pop();
        }
        Ok(())
    }

    async fn write_tracks(&mut self) -> Result<(), store::Error> {
        let count = self.run_of(|event| matches!(event, Event::Track(_)));
        // Encoded here, off the simulation loop. A batch whose flight has no
        // row is skipped: its start was never sent, or its end came first.
        let rows: Vec<TrackRow> = self
            .queue
            .events
            .iter()
            .take(count)
            .filter_map(|event| match event {
                Event::Track(batch) => {
                    let flight_id = *self.flight_ids.get(&batch.aircraft_id)?;
                    Some(TrackRow::new(
                        flight_id,
                        batch.first_sample_sim_s,
                        &batch.samples,
                    ))
                }
                _ => None,
            })
            .collect();
        if !rows.is_empty() {
            store::insert_tracks(&self.db, &rows).await?;
        }
        for _ in 0..count {
            self.queue.pop();
        }
        Ok(())
    }

    async fn write_ended(&mut self) -> Result<(), store::Error> {
        let count = self.run_of(|event| matches!(event, Event::Ended(_)));
        let ended: Vec<(i64, &FlightEnd)> = self
            .queue
            .events
            .iter()
            .take(count)
            .filter_map(|event| match event {
                Event::Ended(end) => Some((*self.flight_ids.get(&end.aircraft_id)?, end)),
                _ => None,
            })
            .collect();
        if !ended.is_empty() {
            store::close_flights(&self.db, &ended).await?;
        }
        for _ in 0..count {
            if let Some(Event::Ended(end)) = self.queue.pop() {
                self.flight_ids.remove(&end.aircraft_id);
            }
        }
        Ok(())
    }
}

/// Deletes rows older than [`RETENTION`], now and every ten minutes, for
/// ever. A failure is tried again at the next turn.
pub async fn retain(db: PgPool) {
    let mut interval = tokio::time::interval(RETAIN_EVERY);
    loop {
        interval.tick().await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |since| since.as_secs_f64());
        match store::delete_flights_before(&db, now - RETENTION.as_secs_f64()).await {
            Ok(0) | Err(_) => {}
            Ok(deleted) => info!("recorder: deleted {deleted} flight(s) more than a day old"),
        }
    }
}

#[cfg(test)]
mod tests {
    use atc_core::recording::Sample;

    use super::super::TrackBatch;
    use super::*;

    fn track(aircraft_id: u32, samples: usize) -> Event {
        Event::Track(TrackBatch {
            aircraft_id,
            first_sample_sim_s: 0,
            samples: vec![Sample::default(); samples],
        })
    }

    fn start(aircraft_id: u32) -> Event {
        Event::Started(FlightStart {
            aircraft_id,
            icao24: 1,
            callsign: "TEST".to_owned(),
            aircraft_type: "B738".to_owned(),
            origin: None,
            destination: None,
            pass: 0,
            sim_time_s: 0,
            at: 0.0,
        })
    }

    fn kinds(queue: &Queue) -> Vec<String> {
        queue
            .events
            .iter()
            .map(|event| match event {
                Event::Started(start) => format!("start {}", start.aircraft_id),
                Event::Track(batch) => {
                    format!("track {} x{}", batch.aircraft_id, batch.samples.len())
                }
                Event::Ended(end) => format!("end {}", end.aircraft_id),
                Event::Sync(_) => "sync".to_owned(),
            })
            .collect()
    }

    #[test]
    fn the_queue_counts_the_samples_waiting() {
        let mut queue = Queue::default();
        queue.push(start(1));
        queue.push(track(1, 30));
        queue.push(track(1, 12));
        assert_eq!(queue.samples(), 42);
        assert!(matches!(queue.pop(), Some(Event::Started(_))));
        assert!(matches!(queue.pop(), Some(Event::Track(_))));
        assert_eq!(queue.samples(), 12);
    }

    #[test]
    fn under_the_limit_nothing_is_dropped() {
        let mut queue = Queue::default();
        queue.push(track(1, 30));
        queue.push(track(2, 30));
        assert_eq!(queue.shed(60), 0);
        assert_eq!(queue.samples(), 60);
    }

    #[test]
    fn past_the_limit_the_oldest_batches_go_and_the_flights_stay() {
        let mut queue = Queue::default();
        queue.push(start(1));
        queue.push(track(1, 30));
        queue.push(start(2));
        queue.push(track(2, 30));
        queue.push(track(1, 30));
        queue.push(track(2, 30));

        // Room for 70: the two oldest batches go, which leaves 60.
        assert_eq!(queue.shed(70), 60);
        assert_eq!(queue.samples(), 60);
        assert_eq!(
            kinds(&queue),
            ["start 1", "start 2", "track 1 x30", "track 2 x30"]
        );
        assert_eq!(queue.shed(70), 0);
    }
}
