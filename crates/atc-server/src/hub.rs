//! The WebSocket hub: one socket per client, and the frames sent down it.
//!
//! One task turns each tick's [`World`] into a [`Picture`]: the world and its
//! whole-picture positions frame, encoded once for every client. It publishes
//! the picture on a watch channel, which keeps only the newest.
//!
//! That channel is each connection's latest-wins slot. A connection takes the
//! newest picture when its socket has finished with the one before, so a
//! client that falls behind skips pictures and nothing queues up for it. A
//! connection builds its own frames only then, so no frame is ever built and
//! thrown away.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use atc_core::PROTOCOL_VERSION;
use atc_core::wire::{FRAME_NEW_PASS, Metadata, Position, encode_frame};
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::http::{HeaderMap, StatusCode, header::ORIGIN};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::AppState;
use crate::config::Auth;
use crate::world::{World, WorldReader};

/// Close code: the first message was not a `hello`, or none came in time.
pub const CLOSE_HELLO_EXPECTED: u16 = 4000;
/// Close code: the client's `hello` named a protocol version other than
/// [`PROTOCOL_VERSION`].
pub const CLOSE_PROTOCOL_MISMATCH: u16 = 4001;

/// How long a new connection has to send its `hello`.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long closing a connection may take before it is dropped instead.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// The largest message a client may send. Client messages are small JSON.
const MAX_CLIENT_MESSAGE: usize = 16 * 1024;

/// What the `sim` message tells a client about the simulator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SimInfo {
    /// The stress multiplier.
    pub multiplier: u32,
    /// The length of the recording, which is how long a pass lasts.
    pub window_s: u32,
}

/// What a signed-in user may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Viewer,
    Controller,
}

/// Who a connection belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub role: Role,
}

impl User {
    /// The user every connection is given when `ATC_AUTH=off`.
    pub fn dev() -> User {
        User {
            id: "dev".to_owned(),
            role: Role::Controller,
        }
    }
}

/// One tick, as the connections share it.
#[derive(Debug)]
struct Picture {
    /// Counts the pictures published, from 1. Each connection's `seq` is
    /// counted from the first one it was sent.
    number: u64,
    /// Counts the passes that have started since the hub did.
    pass: u32,
    world: Arc<World>,
    /// A positions frame holding every aircraft, with `seq` and flags left
    /// at zero for each connection to fill in.
    positions: Vec<u8>,
}

/// A handle on the hub. Cloning it is cheap.
#[derive(Debug, Clone)]
pub struct Hub {
    /// Never read from here, so a clone of it has seen nothing: it yields
    /// the newest picture at once, if there has been one.
    pictures: watch::Receiver<Arc<Picture>>,
    sim: SimInfo,
    clients: Arc<AtomicUsize>,
}

impl Hub {
    /// Starts the task that builds a picture from every tick `worlds` gives
    /// out. It ends, and every connection is closed, when the world's writer
    /// has gone.
    pub fn spawn(worlds: WorldReader, sim: SimInfo) -> Hub {
        let (sender, pictures) = watch::channel(Arc::new(Picture {
            number: 0,
            pass: 0,
            world: Arc::new(World::default()),
            positions: Vec::new(),
        }));
        tokio::spawn(publish(worlds, sender));
        Hub {
            pictures,
            sim,
            clients: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// How many clients are connected.
    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    /// Runs one client's connection until either side ends it.
    async fn serve(self, socket: WebSocket, user: User) {
        self.clients.fetch_add(1, Ordering::Relaxed);
        let mut connection = Connection {
            socket,
            user,
            first: None,
            pass: 0,
            told: HashSet::new(),
        };
        if let End::Close(code, reason) = connection.run(&self).await {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, connection.close(code, reason)).await;
        }
        self.clients.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Publishes a picture for every tick, until the world's writer has gone.
async fn publish(mut worlds: WorldReader, pictures: watch::Sender<Arc<Picture>>) {
    let mut records: Vec<Position> = Vec::new();
    let mut number = 0;
    let mut pass = 0;
    while let Some(world) = worlds.next().await {
        number += 1;
        pass += u32::from(world.new_pass());
        records.clear();
        records.extend((0..world.len()).map(|row| world.position(row)));
        let mut positions = Vec::new();
        encode_frame(&mut positions, 0, sim_time_ms(&world), 0, &records);
        pictures.send_replace(Arc::new(Picture {
            number,
            pass,
            world,
            positions,
        }));
    }
}

/// Sim time as a frame header carries it.
fn sim_time_ms(world: &World) -> f64 {
    f64::from(world.sim_time_s()) * 1_000.0
}

/// Writes a connection's own `seq` and flags into the header of a frame that
/// was encoded once for everyone. The offsets are those of
/// [`atc_core::wire::Header`].
fn stamp(frame: &mut [u8], seq: u32, flags: u32) {
    frame[4..8].copy_from_slice(&seq.to_le_bytes());
    frame[20..24].copy_from_slice(&flags.to_le_bytes());
}

/// `GET /ws`: checks where the request comes from and who sent it, then
/// upgrades it to a socket.
pub(crate) async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers, &state.allowed_origin) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let user = match authenticate(&state.auth) {
        Ok(user) => user,
        Err(refusal) => return refusal.into_response(),
    };
    let hub = state.hub.clone();
    upgrade
        .max_message_size(MAX_CLIENT_MESSAGE)
        .max_frame_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| hub.serve(socket, user))
}

/// Whether the request's `Origin` is the one allowed. A request with no
/// `Origin` is let through: browsers always send one, and the check is there
/// to stop pages on other sites, not programs.
fn origin_allowed(headers: &HeaderMap, allowed: &str) -> bool {
    let allowed = allowed.trim_end_matches('/');
    headers
        .get_all(ORIGIN)
        .iter()
        .all(|origin| origin.as_bytes() == allowed.as_bytes())
}

/// Who is connecting, or the response that turns them away.
fn authenticate(auth: &Auth) -> Result<User, (StatusCode, &'static str)> {
    match auth {
        Auth::Off => Ok(User::dev()),
        // Token verification goes here in milestone 4. Until it exists no
        // one can be shown to be anyone, so no one is let in.
        Auth::Jwks { .. } => Err((
            StatusCode::UNAUTHORIZED,
            "token verification is not built yet; run atc-server with ATC_AUTH=off",
        )),
    }
}

/// A message from the client, as far as the hub reads it.
#[derive(Debug, PartialEq, Eq)]
enum ClientMessage {
    Hello {
        protocol: u64,
    },
    /// A message of the design that the hub does not act on yet.
    Unsupported(&'static str),
}

/// Reads a client's text message, or says what is wrong with it.
fn parse(text: &str) -> Result<ClientMessage, String> {
    let Ok(Value::Object(message)) = serde_json::from_str(text) else {
        return Err("a message must be a JSON object".to_owned());
    };
    let Some(kind) = message.get("type").and_then(Value::as_str) else {
        return Err("a message needs a `type`".to_owned());
    };
    match kind {
        "hello" => match message.get("protocol").and_then(Value::as_u64) {
            Some(protocol) => Ok(ClientMessage::Hello { protocol }),
            None => Err("`hello` needs a whole number as its `protocol`".to_owned()),
        },
        "viewport" => Ok(ClientMessage::Unsupported("viewport")),
        "select" => Ok(ClientMessage::Unsupported("select")),
        "track" => Ok(ClientMessage::Unsupported("track")),
        "set_multiplier" => Ok(ClientMessage::Unsupported("set_multiplier")),
        other => Err(format!("unknown message type `{other}`")),
    }
}

/// Why a connection's loop stopped.
enum End {
    /// The client has gone, or the socket failed. Nothing more can be sent.
    Gone,
    /// The server is ending it, with this close code and reason.
    Close(u16, String),
}

impl From<axum::Error> for End {
    fn from(_: axum::Error) -> End {
        End::Gone
    }
}

/// One client's socket and what the server knows about that client.
///
/// The viewport and the selection will live here too.
struct Connection {
    socket: WebSocket,
    #[expect(dead_code, reason = "nothing is refused by role yet")]
    user: User,
    /// The number of the first picture sent. `seq` counts pictures from it.
    first: Option<u64>,
    /// The pass of the last picture sent.
    pass: u32,
    /// The aircraft whose metadata has been written to the socket.
    told: HashSet<u32>,
}

impl Connection {
    /// The connection's whole life after the upgrade. It only returns once
    /// the connection is over.
    async fn run(&mut self, hub: &Hub) -> End {
        match self.converse(hub).await {
            Ok(never) => match never {},
            Err(end) => end,
        }
    }

    async fn converse(&mut self, hub: &Hub) -> Result<std::convert::Infallible, End> {
        self.hello().await?;
        self.send_json(json!({
            "type": "sim",
            "multiplier": hub.sim.multiplier,
            "windowSeconds": hub.sim.window_s,
        }))
        .await?;

        let mut pictures = hub.pictures.clone();
        loop {
            // A send is never one of the futures raced here, so it is never
            // dropped half done: a frame is written whole or the connection
            // ends. While one is being written nothing is read, and the
            // channel holds on to the newest picture only.
            tokio::select! {
                changed = pictures.changed() => {
                    if changed.is_err() {
                        let reason = "the simulator has stopped".to_owned();
                        return Err(End::Close(close_code::AWAY, reason));
                    }
                    let picture = pictures.borrow_and_update().clone();
                    self.send_picture(&picture).await?;
                }
                message = self.socket.recv() => match message.ok_or(End::Gone)?? {
                    Message::Text(text) => self.refuse(text.as_str()).await?,
                    Message::Binary(_) => {
                        self.send_error("bad_message", "client messages are JSON text").await?;
                    }
                    // Pings are answered, and a close is echoed, by the
                    // socket itself. After a close the next read ends it.
                    Message::Ping(_) | Message::Pong(_) | Message::Close(_) => {}
                },
            }
        }
    }

    /// Waits for the client's `hello` and checks its protocol version.
    async fn hello(&mut self) -> Result<(), End> {
        let first_message = async {
            loop {
                match self.socket.recv().await {
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    other => break other,
                }
            }
        };
        let expected = |why: &str| End::Close(CLOSE_HELLO_EXPECTED, why.to_owned());
        let message = tokio::time::timeout(HELLO_TIMEOUT, first_message)
            .await
            .map_err(|_| expected("no hello arrived in time"))?
            .ok_or(End::Gone)??;
        let Message::Text(text) = message else {
            return Err(expected("the first message must be a hello"));
        };
        match parse(text.as_str()) {
            Ok(ClientMessage::Hello { protocol }) if protocol == u64::from(PROTOCOL_VERSION) => {
                Ok(())
            }
            Ok(ClientMessage::Hello { .. }) => Err(End::Close(
                CLOSE_PROTOCOL_MISMATCH,
                format!("this server speaks protocol {PROTOCOL_VERSION}"),
            )),
            _ => Err(expected("the first message must be a hello")),
        }
    }

    /// Answers a message that came after the `hello`. None is acted on yet,
    /// so every one is refused.
    async fn refuse(&mut self, text: &str) -> Result<(), End> {
        match parse(text) {
            Ok(ClientMessage::Hello { .. }) => {
                self.send_error("bad_message", "hello was already sent")
                    .await
            }
            Ok(ClientMessage::Unsupported(kind)) => {
                let message = format!("`{kind}` is not supported yet");
                self.send_error("unsupported", &message).await
            }
            Err(problem) => self.send_error("bad_message", &problem).await,
        }
    }

    /// Sends the frames of one picture: metadata for the aircraft the client
    /// has not been told about, then the positions of every aircraft.
    async fn send_picture(&mut self, picture: &Picture) -> Result<(), End> {
        let world = &picture.world;
        let first = *self.first.get_or_insert(picture.number);
        // Every frame of a picture carries the picture's seq.
        let seq = (picture.number - first) as u32;

        let untold: Vec<Metadata> = (0..world.len())
            .map(|row| *world.metadata(row))
            .filter(|metadata| !self.told.contains(&metadata.aircraft_id))
            .collect();
        if !untold.is_empty() {
            let mut frame = Vec::new();
            encode_frame(&mut frame, seq, sim_time_ms(world), 0, &untold);
            self.socket.send(Message::Binary(frame.into())).await?;
            // Only now that the frame has been written are they told.
            self.told
                .extend(untold.iter().map(|metadata| metadata.aircraft_id));
        }
        // Forget the aircraft that have gone, once they are the larger part.
        if self.told.len() > 2 * world.len() {
            self.told.retain(|&id| world.row_of(id).is_some());
        }

        // A client that skipped the first picture of a pass is still told
        // of the new pass, by the first picture of it that it gets.
        let new_pass = world.new_pass() || (seq > 0 && picture.pass != self.pass);
        let mut frame = picture.positions.clone();
        stamp(&mut frame, seq, if new_pass { FRAME_NEW_PASS } else { 0 });
        self.socket.send(Message::Binary(frame.into())).await?;
        self.pass = picture.pass;
        Ok(())
    }

    async fn send_error(&mut self, code: &str, message: &str) -> Result<(), End> {
        self.send_json(json!({ "type": "error", "code": code, "message": message }))
            .await
    }

    async fn send_json(&mut self, message: Value) -> Result<(), End> {
        let text = message.to_string();
        Ok(self.socket.send(Message::Text(text.into())).await?)
    }

    /// Sends a close frame and waits for the client to answer it.
    async fn close(&mut self, code: u16, reason: String) {
        let frame = CloseFrame {
            code,
            reason: reason.into(),
        };
        if self.socket.send(Message::Close(Some(frame))).await.is_ok() {
            while let Some(Ok(_)) = self.socket.recv().await {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use atc_core::fixture;
    use atc_core::wire::{Frame, FrameKind, HEADER_SIZE, Header};
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::{self, Message as ClientFrame};
    use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

    use super::*;
    use crate::sim::replay::Replay;
    use crate::sim::{Feed, Tick};
    use crate::world::WorldWriter;

    const ORIGIN_ALLOWED: &str = "http://localhost:3000";
    const SIM: SimInfo = SimInfo {
        multiplier: 1,
        window_s: fixture::WINDOW_S,
    };
    /// How long a test waits for the server before it fails.
    const PATIENCE: Duration = Duration::from_secs(10);

    type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

    /// A server on a port of its own. The test plays the simulator: it
    /// publishes ticks through `world` when it chooses to.
    struct Server {
        addr: SocketAddr,
        world: WorldWriter,
        hub: Hub,
    }

    async fn serve_with(auth: Auth) -> Server {
        let world = WorldWriter::new();
        let hub = Hub::spawn(world.reader(), SIM);
        let state = AppState {
            // Never connected to: nothing here asks for the database.
            db: crate::connect_lazy("postgres://atc:atc@127.0.0.1:9/atc").unwrap(),
            hub: hub.clone(),
            allowed_origin: ORIGIN_ALLOWED.to_owned(),
            auth,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, crate::app(state)).await });
        Server { addr, world, hub }
    }

    async fn serve() -> Server {
        serve_with(Auth::Off).await
    }

    async fn connect(server: &Server, origin: Option<&str>) -> Result<Client, tungstenite::Error> {
        let url = format!("ws://{}/ws", server.addr);
        let mut request = url.into_client_request().unwrap();
        if let Some(origin) = origin {
            let headers = request.headers_mut();
            headers.insert("Origin", origin.parse().unwrap());
        }
        let (client, _) = tokio_tungstenite::connect_async(request).await?;
        Ok(client)
    }

    /// The HTTP status a connection attempt is refused with.
    async fn refusal(server: &Server, origin: Option<&str>) -> u16 {
        match connect(server, origin).await {
            Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
            other => panic!("expected an HTTP refusal, got {other:?}"),
        }
    }

    async fn send(client: &mut Client, message: Value) {
        let text = message.to_string();
        client.send(ClientFrame::Text(text.into())).await.unwrap();
    }

    /// The next message from the server, pings aside.
    async fn next(client: &mut Client) -> ClientFrame {
        loop {
            let message = tokio::time::timeout(PATIENCE, client.next())
                .await
                .expect("the server sent nothing")
                .expect("the server hung up")
                .unwrap();
            if !matches!(message, ClientFrame::Ping(_) | ClientFrame::Pong(_)) {
                return message;
            }
        }
    }

    async fn next_json(client: &mut Client) -> Value {
        match next(client).await {
            ClientFrame::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
            other => panic!("expected a text message, got {other:?}"),
        }
    }

    /// The code the server closes the connection with.
    async fn next_close(client: &mut Client) -> u16 {
        match next(client).await {
            ClientFrame::Close(Some(frame)) => frame.code.into(),
            other => panic!("expected a close frame, got {other:?}"),
        }
    }

    /// Connects, says hello and reads the `sim` message that answers it.
    async fn join(server: &Server) -> Client {
        let mut client = connect(server, Some(ORIGIN_ALLOWED)).await.unwrap();
        let hello = json!({ "type": "hello", "protocol": PROTOCOL_VERSION });
        send(&mut client, hello).await;
        assert_eq!(next_json(&mut client).await["type"], "sim");
        client
    }

    /// The frames of one picture, decoded with `atc_core::wire`.
    struct Received {
        /// The positions frame's header.
        header: Header,
        /// The metadata frame that came before the positions, if one did.
        metadata: Vec<Metadata>,
        positions: Vec<Position>,
    }

    /// Reads up to and including the next positions frame.
    async fn next_picture(client: &mut Client) -> Received {
        let mut metadata = Vec::new();
        let mut metadata_seq = None;
        loop {
            let ClientFrame::Binary(bytes) = next(client).await else {
                panic!("expected a binary frame");
            };
            let frame = Frame::decode(&bytes).unwrap();
            let header = frame.header;
            let records = header.count as usize * usize::from(header.record_size);
            assert_eq!(bytes.len(), HEADER_SIZE + records);
            match header.kind {
                FrameKind::Metadata => {
                    assert!(metadata.is_empty(), "two metadata frames for one picture");
                    assert!(header.count > 0);
                    metadata.extend(frame.records::<Metadata>().unwrap());
                    metadata_seq = Some((header.seq, header.sim_time_ms));
                }
                FrameKind::Positions => {
                    // A picture's frames share its seq and sim time.
                    let seq = (header.seq, header.sim_time_ms);
                    assert_eq!(metadata_seq.unwrap_or(seq), seq);
                    return Received {
                        header,
                        metadata,
                        positions: frame.records().unwrap().collect(),
                    };
                }
                other => panic!("unexpected {other:?} frame"),
            }
        }
    }

    fn by_id(mut positions: Vec<Position>) -> Vec<Position> {
        positions.sort_unstable_by_key(|position| position.id);
        positions
    }

    fn ids(metadata: &[Metadata]) -> Vec<u32> {
        let mut ids: Vec<u32> = metadata.iter().map(|m| m.aircraft_id).collect();
        ids.sort_unstable();
        ids
    }

    #[test]
    fn client_messages_are_parsed_as_far_as_they_are_needed() {
        assert_eq!(
            parse(r#"{"type":"hello","protocol":1}"#),
            Ok(ClientMessage::Hello { protocol: 1 })
        );
        assert_eq!(
            parse(r#"{"type":"viewport","bbox":[-80,38,-70,43],"zoom":7}"#),
            Ok(ClientMessage::Unsupported("viewport"))
        );
        for kind in ["select", "track", "set_multiplier"] {
            let text = json!({ "type": kind, "id": 7, "value": 7 }).to_string();
            assert_eq!(parse(&text), Ok(ClientMessage::Unsupported(kind)));
        }
        for bad in [
            "",
            "hello",
            "[1]",
            "{}",
            r#"{"type":1}"#,
            r#"{"type":"hello"}"#,
            r#"{"type":"hello","protocol":"1"}"#,
            r#"{"type":"hello","protocol":-1}"#,
            r#"{"type":"hello","protocol":1.5}"#,
            r#"{"type":"goodbye"}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_allowed_origin_passes_and_no_origin_at_all() {
        let headers = |origins: &[&str]| {
            let mut headers = HeaderMap::new();
            for origin in origins {
                headers.append(ORIGIN, origin.parse().unwrap());
            }
            headers
        };
        assert!(origin_allowed(&headers(&[ORIGIN_ALLOWED]), ORIGIN_ALLOWED));
        assert!(origin_allowed(&headers(&[]), ORIGIN_ALLOWED));
        let with_slash = "http://localhost:3000/";
        assert!(origin_allowed(&headers(&[ORIGIN_ALLOWED]), with_slash));
        for other in [
            "http://localhost:3001",
            "https://localhost:3000",
            "http://localhost:3000.evil.example",
            "http://evil.example",
            "null",
        ] {
            assert!(!origin_allowed(&headers(&[other]), ORIGIN_ALLOWED));
            let both = headers(&[ORIGIN_ALLOWED, other]);
            assert!(!origin_allowed(&both, ORIGIN_ALLOWED));
        }
    }

    #[tokio::test]
    async fn hello_is_answered_with_the_sim_message() {
        let server = serve().await;
        let mut client = connect(&server, Some(ORIGIN_ALLOWED)).await.unwrap();
        let hello = json!({ "type": "hello", "protocol": PROTOCOL_VERSION });
        send(&mut client, hello).await;

        assert_eq!(
            next_json(&mut client).await,
            json!({ "type": "sim", "multiplier": 1, "windowSeconds": fixture::WINDOW_S })
        );
    }

    #[tokio::test]
    async fn another_protocol_version_is_closed_with_its_own_code() {
        let server = serve().await;
        let mut client = connect(&server, Some(ORIGIN_ALLOWED)).await.unwrap();
        let hello = json!({ "type": "hello", "protocol": PROTOCOL_VERSION + 1 });
        send(&mut client, hello).await;

        assert_eq!(next_close(&mut client).await, CLOSE_PROTOCOL_MISMATCH);
        assert_eq!(CLOSE_PROTOCOL_MISMATCH, 4001);
        // The close handshake completes and the stream ends.
        assert!(client.next().await.is_none());
    }

    #[tokio::test]
    async fn anything_but_a_hello_first_is_closed() {
        let mut server = serve().await;
        let mut tick = Tick::default();
        let mut replay = Replay::new(fixture::recording()).unwrap();
        replay.advance(&mut tick);
        server.world.update(&tick);

        for first in [
            ClientFrame::Text(r#"{"type":"viewport"}"#.into()),
            ClientFrame::Text("not json".into()),
            ClientFrame::Text(r#"{"type":"hello"}"#.into()),
            ClientFrame::Binary(vec![1, 2, 3].into()),
        ] {
            let mut client = connect(&server, Some(ORIGIN_ALLOWED)).await.unwrap();
            client.send(first).await.unwrap();
            // No frame is sent before the hello, though a picture is ready.
            assert_eq!(next_close(&mut client).await, CLOSE_HELLO_EXPECTED);
        }
        assert_eq!(CLOSE_HELLO_EXPECTED, 4000);
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_never_says_hello_is_closed() {
        let server = serve().await;
        let mut client = connect(&server, Some(ORIGIN_ALLOWED)).await.unwrap();

        // The paused clock jumps to the timeout once both ends are idle.
        let started = tokio::time::Instant::now();
        let Some(Ok(ClientFrame::Close(Some(frame)))) = client.next().await else {
            panic!("expected a close frame");
        };
        assert_eq!(u16::from(frame.code), CLOSE_HELLO_EXPECTED);
        assert!(started.elapsed() >= HELLO_TIMEOUT);
    }

    /// `docker compose down` must not wait for the browsers to leave.
    #[tokio::test]
    async fn a_graceful_shutdown_does_not_wait_for_open_sockets() {
        let world = WorldWriter::new();
        let hub = Hub::spawn(world.reader(), SIM);
        let state = AppState {
            db: crate::connect_lazy("postgres://atc:atc@127.0.0.1:9/atc").unwrap(),
            hub: hub.clone(),
            allowed_origin: ORIGIN_ALLOWED.to_owned(),
            auth: Auth::Off,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let serving = tokio::spawn(async move {
            axum::serve(listener, crate::app(state))
                .with_graceful_shutdown(async { drop(stopped.await) })
                .await
        });
        let server = Server { addr, world, hub };
        let _client = join(&server).await;

        stop.send(()).unwrap();
        let served = tokio::time::timeout(PATIENCE, serving).await;
        assert!(served.expect("still serving").unwrap().is_ok());
    }

    #[tokio::test]
    async fn another_origin_is_refused_before_the_upgrade() {
        let server = serve().await;

        assert_eq!(refusal(&server, Some("http://evil.example")).await, 403);
        assert_eq!(refusal(&server, Some("http://localhost:3001")).await, 403);
        assert!(connect(&server, Some(ORIGIN_ALLOWED)).await.is_ok());
        assert!(connect(&server, None).await.is_ok());
    }

    #[tokio::test]
    async fn no_one_is_let_in_while_tokens_cannot_be_verified() {
        let auth = Auth::Jwks {
            url: "http://localhost:3000/api/auth/jwks".to_owned(),
        };
        let server = serve_with(auth).await;

        assert_eq!(refusal(&server, Some(ORIGIN_ALLOWED)).await, 401);
    }

    #[tokio::test]
    async fn messages_that_are_not_supported_yet_are_answered_with_an_error() {
        let server = serve().await;
        let mut client = join(&server).await;

        for kind in ["viewport", "select", "track", "set_multiplier"] {
            send(&mut client, json!({ "type": kind })).await;
            let error = next_json(&mut client).await;
            assert_eq!(error["type"], "error");
            assert_eq!(error["code"], "unsupported");
            assert!(error["message"].as_str().unwrap().contains(kind));
        }
        for bad in [json!({ "type": "hello", "protocol": 1 }), json!([1, 2])] {
            send(&mut client, bad).await;
            let error = next_json(&mut client).await;
            assert_eq!(error["type"], "error");
            assert_eq!(error["code"], "bad_message");
        }
        let binary = ClientFrame::Binary(vec![0].into());
        client.send(binary).await.unwrap();
        assert_eq!(next_json(&mut client).await["code"], "bad_message");
    }

    #[tokio::test]
    async fn every_tick_arrives_as_a_positions_frame_with_the_next_seq() {
        let mut server = serve().await;
        let mut client = join(&server).await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();

        for seq in 0..30 {
            replay.advance(&mut tick);
            server.world.update(&tick);
            let picture = next_picture(&mut client).await;

            assert_eq!(picture.header.seq, seq);
            assert_eq!(picture.header.sim_time_ms, tick.sim_time_ms());
            assert_eq!(picture.header.flags, 0);
            assert!(!picture.positions.is_empty());
            assert_eq!(by_id(picture.positions), by_id(tick.positions.clone()));
        }
    }

    #[tokio::test]
    async fn metadata_arrives_once_for_every_aircraft_and_before_its_position() {
        let mut server = serve().await;
        let mut client = join(&server).await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        let mut told = HashSet::new();
        let mut new_passes = 0;

        // Past the end of the first pass, where every aircraft is replaced.
        for seq in 0..fixture::WINDOW_S + 60 {
            replay.advance(&mut tick);
            server.world.update(&tick);
            let picture = next_picture(&mut client).await;

            assert_eq!(picture.header.seq, seq);
            assert_eq!(picture.header.is_new_pass(), tick.new_pass);
            new_passes += u32::from(tick.new_pass);
            // Exactly the aircraft that have just appeared, as announced.
            assert_eq!(ids(&picture.metadata), ids(&tick.appeared));
            for metadata in &picture.metadata {
                assert!(tick.appeared.contains(metadata));
                assert!(told.insert(metadata.aircraft_id), "told twice");
            }
            for position in &picture.positions {
                assert!(told.contains(&position.id));
            }
        }
        assert_eq!(new_passes, 1);
        assert!(told.len() > fixture::recording().flights.len());
    }

    #[tokio::test]
    async fn a_client_that_joins_late_gets_the_picture_at_once() {
        let mut server = serve().await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        for _ in 0..=300 {
            replay.advance(&mut tick);
            server.world.update(&tick);
        }

        // No tick is published after it joins.
        let mut client = join(&server).await;
        let picture = next_picture(&mut client).await;

        assert_eq!(picture.header.seq, 0);
        assert_eq!(picture.header.sim_time_ms, 300_000.0);
        assert_eq!(picture.header.flags, 0);
        let in_the_picture: Vec<u32> = by_id(tick.positions.clone())
            .iter()
            .map(|position| position.id)
            .collect();
        assert_eq!(ids(&picture.metadata), in_the_picture);
        assert_eq!(by_id(picture.positions), by_id(tick.positions));
    }

    /// A tick of `count` aircraft spread over the coverage area, all of them
    /// new.
    fn crowded_tick(count: u32) -> Tick {
        let mut tick = Tick::default();
        for id in 1..=count {
            tick.positions.push(Position {
                id,
                lat: 300_000_000 + (id % 1_000) as i32 * 100_000,
                lon: -1_200_000_000 + (id / 1_000) as i32 * 1_000_000,
                ..Position::default()
            });
            tick.appeared.push(Metadata {
                aircraft_id: id,
                ..Metadata::default()
            });
        }
        tick
    }

    #[tokio::test]
    async fn a_client_that_does_not_read_skips_frames_and_loses_no_metadata() {
        // 400 kB a frame, and 48 MB over the run: far more than the socket
        // buffers between the server and a client that is not reading.
        const AIRCRAFT: u32 = 20_000;
        const TICKS: u32 = 120;
        const NEW_PASS_AT: u32 = 60;

        let mut server = serve().await;
        let mut client = join(&server).await;
        let mut tick = crowded_tick(AIRCRAFT);
        for sim_time_s in 0..TICKS {
            tick.sim_time_s = sim_time_s;
            tick.new_pass = sim_time_s == NEW_PASS_AT;
            if sim_time_s > 0 {
                // One aircraft appears each tick, most of them in ticks
                // the client never sees.
                let id = AIRCRAFT + sim_time_s;
                tick.appeared.clear();
                tick.positions.push(Position {
                    id,
                    lat: 400_000_000,
                    lon: -1_000_000_000,
                    ..Position::default()
                });
                tick.appeared.push(Metadata {
                    aircraft_id: id,
                    ..Metadata::default()
                });
            }
            server.world.update(&tick);
            // Lets the server run, which it would in a second of real time.
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // Now the client reads everything the server managed to send it.
        let mut told = HashSet::new();
        let mut seqs = Vec::new();
        let mut new_passes = Vec::new();
        loop {
            let picture = next_picture(&mut client).await;
            for metadata in &picture.metadata {
                assert!(told.insert(metadata.aircraft_id), "told twice");
            }
            for position in &picture.positions {
                assert!(told.contains(&position.id), "never told");
            }
            let sim_time_s = (picture.header.sim_time_ms / 1_000.0) as u32;
            assert_eq!(picture.positions.len() as u32, AIRCRAFT + sim_time_s);
            if picture.header.is_new_pass() {
                new_passes.push(sim_time_s);
            }
            seqs.push(picture.header.seq);
            if sim_time_s == TICKS - 1 {
                break;
            }
        }

        assert!(seqs.is_sorted_by(|a, b| a < b), "{seqs:?}");
        // It got far fewer pictures than there were, and the gaps show.
        assert!(seqs.len() < TICKS as usize / 2, "{seqs:?}");
        assert!(*seqs.last().unwrap() as usize >= seqs.len(), "{seqs:?}");
        assert_eq!(told.len() as u32, AIRCRAFT + TICKS - 1);
        // It is told of the new pass once, by the first picture it gets
        // from that pass, whether or not that is the pass's first.
        assert_eq!(new_passes.len(), 1, "{new_passes:?}");
        assert!(new_passes[0] >= NEW_PASS_AT);
    }

    #[tokio::test]
    async fn a_client_that_leaves_is_forgotten() {
        let mut server = serve().await;
        let client = join(&server).await;
        let mut staying = join(&server).await;
        assert_eq!(server.hub.clients(), 2);

        drop(client);
        let gone = async {
            while server.hub.clients() > 1 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(PATIENCE, gone).await.unwrap();

        // The one that stayed is still served.
        server.world.update(&Tick::default());
        let picture = next_picture(&mut staying).await;
        assert_eq!(picture.header.seq, 0);
    }

    #[tokio::test]
    async fn clients_are_closed_when_the_simulator_stops() {
        let server = serve().await;
        let mut client = join(&server).await;

        drop(server.world);

        assert_eq!(next_close(&mut client).await, close_code::AWAY);
    }
}
