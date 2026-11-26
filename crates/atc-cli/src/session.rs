//! One connection to the server, and what arrives on it.
//!
//! A [`Session`] connects, says hello, sends the requests the options ask
//! for, and then turns the server's messages into [`Event`]s. Frames are
//! decoded with `atc_core::wire`, the same code the server encodes them with.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use atc_core::PROTOCOL_VERSION;
use atc_core::wire::{Alert, DecodeError, Frame, FrameKind, Metadata, Position, TrackSample};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::args::Options;

/// How long the server may send nothing before the client gives up. The
/// server writes every second, so this much silence means it has hung.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long leaving may take before the socket is dropped instead.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// Why a session ended when it was not asked to.
#[derive(Debug)]
pub enum Error {
    /// No socket was opened: nothing is listening, or the URL is wrong.
    Connect { url: String, problem: String },
    /// The server answered the request with an HTTP status, not a socket.
    Refused { url: String, status: u16 },
    /// The server closed the socket.
    Closed { code: Option<u16>, reason: String },
    /// The connection ended with no close frame.
    Lost(String),
    /// Nothing arrived for [`SILENCE_TIMEOUT`].
    Silent,
    /// A binary frame that `atc_core::wire` could not decode.
    Decode(DecodeError),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Connect { url, problem } => write!(f, "could not connect to {url}: {problem}"),
            Error::Refused { url, status } => {
                write!(f, "{url} refused the connection with HTTP {status}")?;
                match status {
                    401 => write!(
                        f,
                        ": the server wants a token, which this client cannot send yet; \
                         run atc-server with ATC_AUTH=off"
                    ),
                    403 => write!(f, ": the server does not allow this origin"),
                    404 => write!(f, ": the socket is at /ws"),
                    _ => Ok(()),
                }
            }
            Error::Closed { code, reason } => {
                write!(f, "the server closed the connection")?;
                if let Some(code) = code {
                    write!(f, " with code {code}")?;
                    if let Some(meaning) = close_meaning(*code) {
                        write!(f, " ({meaning})")?;
                    }
                }
                if !reason.is_empty() {
                    write!(f, ": {reason}")?;
                }
                Ok(())
            }
            Error::Lost(problem) => write!(f, "the connection was lost: {problem}"),
            Error::Silent => write!(
                f,
                "the server sent nothing for {} s",
                SILENCE_TIMEOUT.as_secs()
            ),
            Error::Decode(problem) => write!(f, "a frame did not decode: {problem}"),
        }
    }
}

impl std::error::Error for Error {}

/// What the design says a close code means.
fn close_meaning(code: u16) -> Option<&'static str> {
    match code {
        4000 => Some("the first message was not a hello, or none came in time"),
        4001 => Some("the server speaks another protocol version"),
        1001 => Some("the simulator has stopped"),
        _ => None,
    }
}

/// One aircraft from a positions frame, with what the client was told of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Aircraft {
    pub position: Position,
    /// `None` if no metadata frame has named this aircraft.
    pub metadata: Option<Metadata>,
}

/// One tick as the client received it: a positions frame, and the metadata
/// frame before it if there was one.
#[derive(Debug, Clone, PartialEq)]
pub struct TickSummary {
    pub seq: u32,
    /// How many ticks the server did not send between the last one and this.
    pub skipped: u32,
    pub sim_time_ms: f64,
    /// How many aircraft the positions frame holds.
    pub aircraft: usize,
    /// How many aircraft the metadata frame announced.
    pub announced: usize,
    /// How many aircraft in the positions frame have never been announced.
    /// The server announces every one first, so anything but 0 is a fault.
    pub unannounced: usize,
    /// Whether the frame is marked as the first of a new pass.
    pub new_pass: bool,
    /// The size of the tick's metadata and positions frames together.
    pub bytes: usize,
    /// The first aircraft of the frame, as many as were asked for with
    /// `--dump`. The selected aircraft comes first if it is in the frame.
    pub sample: Vec<Aircraft>,
}

/// Something the server sent.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The `sim` message.
    Sim {
        multiplier: u64,
        window_s: u64,
    },
    /// An `error` message: the server refused a request.
    Refusal {
        code: String,
        message: String,
    },
    Tick(TickSummary),
    /// A track frame: one aircraft's samples, oldest first.
    Track {
        samples: Vec<TrackSample>,
        bytes: usize,
    },
    /// An alerts frame.
    Alerts {
        count: usize,
        bytes: usize,
    },
    /// A text message this client does not know.
    Unknown(String),
}

/// The counts kept over a whole session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Totals {
    pub ticks: u64,
    pub skipped: u64,
    pub new_passes: u64,
    /// Aircraft announced in metadata frames.
    pub announced: u64,
    /// Positions that arrived for an aircraft never announced, over all ticks.
    pub unannounced: u64,
    /// Bytes of every binary frame.
    pub bytes: u64,
    /// How many aircraft the last tick held.
    pub aircraft: usize,
    /// How long it was from the first tick to the last.
    pub span: Duration,
}

impl Totals {
    /// Ticks received per second, once there are two to measure between.
    pub fn rate_hz(&self) -> Option<f64> {
        (self.ticks > 1 && !self.span.is_zero())
            .then(|| (self.ticks - 1) as f64 / self.span.as_secs_f64())
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// An open connection that has said hello.
pub struct Session {
    socket: Socket,
    reader: Reader,
}

/// What a session has learnt from the frames so far. It is apart from the
/// socket so that frames can be read without one.
#[derive(Debug, Default)]
struct Reader {
    dump: usize,
    selected: Option<u32>,
    /// Every aircraft a metadata frame has named. Nothing is ever removed:
    /// the server announces an aircraft once, so one forgotten here could
    /// not be named again if it came back into view.
    known: HashMap<u32, Metadata>,
    /// The metadata frame that is waiting for its positions frame: how many
    /// aircraft it announced and its size.
    pending: (usize, usize),
    last_seq: Option<u32>,
    first_tick: Option<Instant>,
    totals: Totals,
}

impl Session {
    /// Connects, says hello and sends the viewport, selection and track
    /// request the options ask for.
    pub async fn connect(options: &Options) -> Result<Session, Error> {
        let connect_error = |problem: String| Error::Connect {
            url: options.url.clone(),
            problem,
        };
        // No `Origin` header is sent, which the server accepts from a
        // program. A token goes on this request once the server verifies
        // them, in milestone 4.
        let request = options
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| connect_error(error.to_string()))?;
        let (socket, _) = match tokio_tungstenite::connect_async(request).await {
            Ok(connected) => connected,
            Err(tungstenite::Error::Http(response)) => {
                return Err(Error::Refused {
                    url: options.url.clone(),
                    status: response.status().as_u16(),
                });
            }
            Err(error) => return Err(connect_error(error.to_string())),
        };
        let mut session = Session {
            socket,
            reader: Reader::new(options.dump, options.select),
        };
        for message in requests(options) {
            let text = message.to_string();
            let sent = session.socket.send(Message::Text(text.into())).await;
            sent.map_err(|error| Error::Lost(error.to_string()))?;
        }
        Ok(session)
    }

    /// The counts so far.
    pub fn totals(&self) -> &Totals {
        &self.reader.totals
    }

    /// Waits for the next thing the server sends. A metadata frame is not an
    /// event of its own: it is counted in the tick its positions frame ends.
    pub async fn next(&mut self) -> Result<Event, Error> {
        loop {
            let message = tokio::time::timeout(SILENCE_TIMEOUT, self.socket.next())
                .await
                .map_err(|_| Error::Silent)?
                .ok_or_else(|| Error::Lost("the stream ended".to_owned()))?
                .map_err(|error| Error::Lost(error.to_string()))?;
            match message {
                Message::Text(text) => return Ok(read_text(text.as_str())),
                Message::Binary(bytes) => {
                    if let Some(event) = self.reader.read_frame(&bytes)? {
                        return Ok(event);
                    }
                }
                Message::Close(frame) => {
                    return Err(match frame {
                        Some(frame) => Error::Closed {
                            code: Some(frame.code.into()),
                            reason: frame.reason.to_string(),
                        },
                        None => Error::Closed {
                            code: None,
                            reason: String::new(),
                        },
                    });
                }
                // The socket answers a ping itself.
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
    }

    /// Leaves: sends a close frame and waits a moment for the server's.
    pub async fn close(mut self) {
        let leave = async {
            if self.socket.close(None).await.is_ok() {
                while let Some(Ok(_)) = self.socket.next().await {}
            }
        };
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, leave).await;
    }
}

impl Reader {
    fn new(dump: usize, selected: Option<u32>) -> Reader {
        Reader {
            dump,
            selected,
            ..Reader::default()
        }
    }

    /// Decodes one binary frame. A metadata frame gives nothing yet: it is
    /// counted in the tick its positions frame ends.
    fn read_frame(&mut self, bytes: &[u8]) -> Result<Option<Event>, Error> {
        let frame = Frame::decode(bytes).map_err(Error::Decode)?;
        self.totals.bytes += bytes.len() as u64;
        match frame.header.kind {
            FrameKind::Metadata => {
                let records = frame.records::<Metadata>().map_err(Error::Decode)?;
                self.pending.0 += records.len();
                self.pending.1 += bytes.len();
                self.totals.announced += records.len() as u64;
                self.known
                    .extend(records.map(|metadata| (metadata.aircraft_id, metadata)));
                Ok(None)
            }
            FrameKind::Positions => self.read_positions(&frame, bytes.len()).map(Some),
            FrameKind::Track => Ok(Some(Event::Track {
                samples: frame.records().map_err(Error::Decode)?.collect(),
                bytes: bytes.len(),
            })),
            FrameKind::Alerts => {
                let alerts = frame.records::<Alert>().map_err(Error::Decode)?;
                Ok(Some(Event::Alerts {
                    count: alerts.len(),
                    bytes: bytes.len(),
                }))
            }
        }
    }

    /// A positions frame ends a tick.
    fn read_positions(&mut self, frame: &Frame<'_>, bytes: usize) -> Result<Event, Error> {
        let header = frame.header;
        let positions = frame.records::<Position>().map_err(Error::Decode)?;
        let aircraft = positions.len();
        let with_metadata = |position: Position| Aircraft {
            position,
            metadata: self.known.get(&position.id).copied(),
        };

        let mut unannounced = 0;
        let mut sample = Vec::with_capacity(self.dump.min(aircraft));
        let mut selected = None;
        for position in positions {
            unannounced += usize::from(!self.known.contains_key(&position.id));
            if Some(position.id) == self.selected {
                selected = Some(with_metadata(position));
            } else if sample.len() < self.dump {
                sample.push(with_metadata(position));
            }
        }
        if let Some(selected) = selected
            && self.dump > 0
        {
            sample.truncate(self.dump - 1);
            sample.insert(0, selected);
        }

        // A seq that does not move forward is not counted as a gap.
        let skipped = match self.last_seq {
            Some(last) => header.seq.saturating_sub(last).saturating_sub(1),
            None => 0,
        };
        self.last_seq = Some(header.seq);
        let (announced, metadata_bytes) = std::mem::take(&mut self.pending);

        let now = Instant::now();
        self.totals.span = now - *self.first_tick.get_or_insert(now);
        self.totals.ticks += 1;
        self.totals.skipped += u64::from(skipped);
        self.totals.new_passes += u64::from(header.is_new_pass());
        self.totals.unannounced += unannounced as u64;
        self.totals.aircraft = aircraft;

        Ok(Event::Tick(TickSummary {
            seq: header.seq,
            skipped,
            sim_time_ms: header.sim_time_ms,
            aircraft,
            announced,
            unannounced,
            new_pass: header.is_new_pass(),
            bytes: bytes + metadata_bytes,
            sample,
        }))
    }
}

/// The messages a session opens with, in the order they are sent: `hello`
/// always, then whichever of `viewport`, `select` and `track` were asked for.
pub fn requests(options: &Options) -> Vec<Value> {
    let mut requests = vec![json!({ "type": "hello", "protocol": PROTOCOL_VERSION })];
    if let Some(viewport) = options.viewport {
        requests.push(json!({
            "type": "viewport",
            "bbox": [viewport.west, viewport.south, viewport.east, viewport.north],
            "zoom": options.zoom,
        }));
    }
    if let Some(id) = options.select {
        requests.push(json!({ "type": "select", "id": id }));
    }
    if let Some(id) = options.track {
        requests.push(json!({ "type": "track", "id": id }));
    }
    requests
}

/// Reads one of the server's text messages.
fn read_text(text: &str) -> Event {
    let unknown = || Event::Unknown(text.to_owned());
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return unknown();
    };
    match message["type"].as_str() {
        Some("sim") => {
            let multiplier = message["multiplier"].as_u64();
            let window_s = message["windowSeconds"].as_u64();
            match (multiplier, window_s) {
                (Some(multiplier), Some(window_s)) => Event::Sim {
                    multiplier,
                    window_s,
                },
                _ => unknown(),
            }
        }
        Some("error") => Event::Refusal {
            code: message["code"].as_str().unwrap_or("").to_owned(),
            message: message["message"].as_str().unwrap_or("").to_owned(),
        },
        _ => unknown(),
    }
}

#[cfg(test)]
mod tests {
    use atc_core::wire::{FRAME_NEW_PASS, encode_frame};

    use super::*;
    use crate::args::Viewport;

    #[test]
    fn a_session_opens_with_hello_and_then_what_was_asked_for() {
        let hello = json!({ "type": "hello", "protocol": 2 });
        assert_eq!(requests(&Options::default()), std::slice::from_ref(&hello));

        let options = Options {
            viewport: Some(Viewport {
                west: -80.0,
                south: 38.0,
                east: -70.5,
                north: 43.0,
            }),
            zoom: 7.0,
            select: Some(12),
            track: Some(34),
            ..Options::default()
        };
        assert_eq!(
            requests(&options),
            [
                hello,
                json!({ "type": "viewport", "bbox": [-80.0, 38.0, -70.5, 43.0], "zoom": 7.0 }),
                json!({ "type": "select", "id": 12 }),
                json!({ "type": "track", "id": 34 }),
            ]
        );
    }

    #[test]
    fn the_servers_text_messages_are_read() {
        assert_eq!(
            read_text(r#"{"type":"sim","multiplier":7,"windowSeconds":14400}"#),
            Event::Sim {
                multiplier: 7,
                window_s: 14_400,
            }
        );
        assert_eq!(
            read_text(r#"{"type":"error","code":"unsupported","message":"not yet"}"#),
            Event::Refusal {
                code: "unsupported".to_owned(),
                message: "not yet".to_owned(),
            }
        );
        for other in ["not json", r#"{"type":"sim"}"#, r#"{"type":"later"}"#, "[]"] {
            assert_eq!(read_text(other), Event::Unknown(other.to_owned()));
        }
    }

    #[test]
    fn a_refusal_and_a_close_say_what_they_mean() {
        let refused = |status| Error::Refused {
            url: "ws://h/ws".to_owned(),
            status,
        };
        assert!(refused(401).to_string().contains("ATC_AUTH=off"));
        assert!(refused(403).to_string().contains("origin"));
        assert_eq!(
            refused(500).to_string(),
            "ws://h/ws refused the connection with HTTP 500"
        );

        let closed = Error::Closed {
            code: Some(4001),
            reason: "this server speaks protocol 2".to_owned(),
        };
        assert_eq!(
            closed.to_string(),
            "the server closed the connection with code 4001 (the server speaks another \
             protocol version): this server speaks protocol 2"
        );
        let closed = Error::Closed {
            code: None,
            reason: String::new(),
        };
        assert_eq!(closed.to_string(), "the server closed the connection");
    }

    fn frame<R: atc_core::wire::Record>(seq: u32, flags: u32, records: &[R]) -> Vec<u8> {
        let mut bytes = Vec::new();
        encode_frame(&mut bytes, seq, f64::from(seq) * 1_000.0, flags, records);
        bytes
    }

    fn positions(ids: impl IntoIterator<Item = u32>) -> Vec<Position> {
        let position = |id| Position {
            id,
            ..Position::default()
        };
        ids.into_iter().map(position).collect()
    }

    fn metadata(ids: impl IntoIterator<Item = u32>) -> Vec<Metadata> {
        let metadata = |aircraft_id| Metadata {
            aircraft_id,
            ..Metadata::default()
        };
        ids.into_iter().map(metadata).collect()
    }

    fn tick(event: Option<Event>) -> TickSummary {
        match event {
            Some(Event::Tick(tick)) => tick,
            other => panic!("expected a tick, got {other:?}"),
        }
    }

    #[test]
    fn a_tick_is_its_metadata_frame_and_its_positions_frame() {
        let mut reader = Reader::new(0, None);
        let announcing = frame(0, 0, &metadata(1..=3));
        let first = frame(0, 0, &positions(1..=3));

        assert_eq!(reader.read_frame(&announcing).unwrap(), None);
        let summary = tick(reader.read_frame(&first).unwrap());

        assert_eq!(summary.seq, 0);
        assert_eq!(summary.skipped, 0);
        assert_eq!((summary.aircraft, summary.announced), (3, 3));
        assert_eq!(summary.unannounced, 0);
        assert!(!summary.new_pass);
        assert_eq!(summary.bytes, announcing.len() + first.len());
        assert_eq!(summary.bytes, 24 + 3 * 40 + 24 + 3 * 24);
        assert!(summary.sample.is_empty());
    }

    #[test]
    fn gaps_new_passes_and_unannounced_aircraft_are_counted() {
        let mut reader = Reader::new(0, None);
        reader.read_frame(&frame(0, 0, &metadata(1..=2))).unwrap();
        tick(reader.read_frame(&frame(0, 0, &positions(1..=2))).unwrap());

        // Three ticks were skipped, a pass began, and aircraft 9 was never
        // announced.
        let late = frame(4, FRAME_NEW_PASS, &positions([1, 2, 9]));
        let summary = tick(reader.read_frame(&late).unwrap());
        assert_eq!((summary.seq, summary.skipped), (4, 3));
        assert_eq!(summary.sim_time_ms, 4_000.0);
        assert!(summary.new_pass);
        assert_eq!((summary.announced, summary.unannounced), (0, 1));
        assert_eq!(summary.bytes, late.len());

        let next = tick(reader.read_frame(&frame(5, 0, &positions([1]))).unwrap());
        assert_eq!(next.skipped, 0);

        let totals = &reader.totals;
        assert_eq!((totals.ticks, totals.skipped), (3, 3));
        assert_eq!((totals.new_passes, totals.announced), (1, 2));
        assert_eq!((totals.unannounced, totals.aircraft), (1, 1));
    }

    #[test]
    fn the_sample_is_the_first_few_aircraft_led_by_the_selected_one() {
        let mut reader = Reader::new(2, Some(4));
        reader.read_frame(&frame(0, 0, &metadata(1..=5))).unwrap();
        let summary = tick(reader.read_frame(&frame(0, 0, &positions(1..=5))).unwrap());

        let ids: Vec<u32> = summary.sample.iter().map(|a| a.position.id).collect();
        assert_eq!(ids, [4, 1]);
        assert!(summary.sample.iter().all(|a| a.metadata.is_some()));

        // Without the selected aircraft in the frame, the first two.
        let summary = tick(reader.read_frame(&frame(1, 0, &positions(1..=3))).unwrap());
        let ids: Vec<u32> = summary.sample.iter().map(|a| a.position.id).collect();
        assert_eq!(ids, [1, 2]);
    }

    #[test]
    fn track_and_alert_frames_are_events_of_their_own() {
        let mut reader = Reader::new(0, None);
        let samples = [10, 20, 30].map(|sim_time_s| TrackSample {
            id: 7,
            sim_time_s,
            ..TrackSample::default()
        });
        let track = frame(3, 0, &samples);
        assert_eq!(
            reader.read_frame(&track).unwrap(),
            Some(Event::Track {
                samples: samples.to_vec(),
                bytes: track.len(),
            })
        );

        let alerts = frame(3, 0, &[Alert::default(); 2]);
        assert_eq!(
            reader.read_frame(&alerts).unwrap(),
            Some(Event::Alerts {
                count: 2,
                bytes: alerts.len(),
            })
        );
        assert_eq!(reader.totals.bytes as usize, track.len() + alerts.len());
        assert_eq!(reader.totals.ticks, 0);
    }

    #[test]
    fn a_frame_that_does_not_decode_is_an_error() {
        let mut reader = Reader::new(0, None);
        let mut bytes = frame(0, 0, &positions(1..=3));

        let cut = &bytes[..bytes.len() - 1];
        assert!(matches!(
            reader.read_frame(cut),
            Err(Error::Decode(DecodeError::Truncated { .. }))
        ));
        bytes[0] = PROTOCOL_VERSION + 1;
        let error = reader.read_frame(&bytes).unwrap_err();
        assert!(matches!(error, Error::Decode(DecodeError::Version(_))));
        assert!(error.to_string().starts_with("a frame did not decode: "));
        assert_eq!(reader.totals, Totals::default());
    }
}
