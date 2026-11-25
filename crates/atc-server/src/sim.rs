//! The simulator: a clock that only moves forward, and the feed that says
//! where every aircraft is at each tick of it.

pub mod replay;
pub mod track;

use std::time::Duration;

use atc_core::wire::{FRAME_NEW_PASS, Metadata, Position};
use tokio::time::MissedTickBehavior;

/// Time between ticks. One tick is one second of sim time.
pub const TICK: Duration = Duration::from_secs(1);

/// The whole picture at one tick.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tick {
    /// Seconds since the feed started; one more than the tick before.
    pub sim_time_s: u32,
    /// Whether this is the first tick of a new pass through a recording.
    pub new_pass: bool,
    /// Every aircraft in the picture. One that is absent has gone.
    pub positions: Vec<Position>,
    /// The aircraft that are in `positions` for the first time.
    pub appeared: Vec<Metadata>,
}

impl Tick {
    /// Sim time as a frame header carries it.
    pub fn sim_time_ms(&self) -> f64 {
        f64::from(self.sim_time_s) * 1_000.0
    }

    /// The header flags of a frame built from this tick.
    pub fn frame_flags(&self) -> u32 {
        if self.new_pass { FRAME_NEW_PASS } else { 0 }
    }
}

/// A source of aircraft positions. The replay of a recording is one; a live
/// adapter could be another.
pub trait Feed {
    /// Moves sim time on one second and overwrites `tick` with the picture
    /// at the new time. The caller keeps one `Tick` and passes it back each
    /// time, so its buffers are reused.
    fn advance(&mut self, tick: &mut Tick);
}

/// Advances `feed` once a second, for ever, and hands each tick to `on_tick`.
///
/// If a tick runs late the ones it missed are skipped, not made up in a
/// burst, so sim time falls behind the wall clock and never jumps.
pub async fn run(mut feed: impl Feed, mut on_tick: impl FnMut(&Tick)) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut tick = Tick::default();
    loop {
        interval.tick().await;
        feed.advance(&mut tick);
        on_tick(&tick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reports sim time and nothing else.
    struct Clock(u32);

    impl Feed for Clock {
        fn advance(&mut self, tick: &mut Tick) {
            tick.sim_time_s = self.0;
            self.0 += 1;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn run_ticks_once_a_second() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let started = tokio::time::Instant::now();
        tokio::spawn(run(Clock(0), move |tick| {
            let _ = sender.send(tick.sim_time_s);
        }));

        for expected in 0..5 {
            assert_eq!(receiver.recv().await, Some(expected));
        }
        // The first tick is immediate, so five ticks take four seconds.
        assert_eq!(started.elapsed(), 4 * TICK);
    }

    #[test]
    fn a_tick_knows_its_frame_header_fields() {
        let mut tick = Tick {
            sim_time_s: 1_200,
            ..Tick::default()
        };
        assert_eq!(tick.sim_time_ms(), 1_200_000.0);
        assert_eq!(tick.frame_flags(), 0);

        tick.new_pass = true;
        assert_eq!(tick.frame_flags(), FRAME_NEW_PASS);
    }
}
