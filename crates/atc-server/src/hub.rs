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
//!
//! A client that has said where it is looking is sent the aircraft there and
//! the one it has selected. Until it says, and whenever that comes to every
//! aircraft there is, it is sent the frame that was encoded for everyone.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atc_core::PROTOCOL_VERSION;
use atc_core::wire::units::degrees_to_wire;
use atc_core::wire::{FRAME_NEW_PASS, Metadata, Position, encode_frame};
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::http::{HeaderMap, StatusCode, header::ORIGIN};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::AppState;
use crate::config::Auth;
use crate::metrics::Metrics;
use crate::sim::track::Tracks;
use crate::world::{Bbox, World, WorldReader};

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

/// The least a viewport is widened by on every side: a tenth of a degree,
/// in wire units.
const MIN_MARGIN: i64 = 1_000_000;
/// All the way round the world, in wire units.
const FULL_TURN: i64 = 3_600_000_000;

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
    tracks: Tracks,
    metrics: Arc<Metrics>,
}

impl Hub {
    /// Starts the task that builds a picture from every tick `worlds` gives
    /// out. It ends, and every connection is closed, when the world's writer
    /// has gone. `tracks` answers for the aircraft in those worlds.
    pub fn spawn(worlds: WorldReader, sim: SimInfo, tracks: Tracks) -> Hub {
        Hub::spawn_with(worlds, sim, tracks, Arc::default())
    }

    /// As [`Hub::spawn`], counting its work in `metrics`.
    pub fn spawn_with(
        worlds: WorldReader,
        sim: SimInfo,
        tracks: Tracks,
        metrics: Arc<Metrics>,
    ) -> Hub {
        let (sender, pictures) = watch::channel(Arc::new(Picture {
            number: 0,
            pass: 0,
            world: Arc::new(World::default()),
            positions: Vec::new(),
        }));
        tokio::spawn(publish(worlds, sender, metrics.clone()));
        Hub {
            pictures,
            sim,
            tracks,
            metrics,
        }
    }

    /// How many clients are connected.
    pub fn clients(&self) -> usize {
        self.metrics.clients()
    }

    /// Runs one client's connection until either side ends it.
    async fn serve(self, socket: WebSocket, user: User) {
        self.metrics.client_connected();
        let mut connection = Connection {
            socket,
            user,
            first: None,
            pass: 0,
            told: HashSet::new(),
            shown: None,
            selected: None,
            track: None,
            sent: None,
            metrics: self.metrics.clone(),
        };
        if let End::Close(code, reason) = connection.run(&self).await {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, connection.close(code, reason)).await;
        }
        self.metrics.client_gone();
    }
}

/// Publishes a picture for every tick, until the world's writer has gone.
async fn publish(
    mut worlds: WorldReader,
    pictures: watch::Sender<Arc<Picture>>,
    metrics: Arc<Metrics>,
) {
    let mut records: Vec<Position> = Vec::new();
    let mut number = 0;
    let mut pass = 0;
    while let Some(world) = worlds.next().await {
        let started = Instant::now();
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
        metrics.picture.record(started.elapsed());
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
    /// The box the client is looking at.
    Viewport(Bbox),
    /// The aircraft the client has selected, if it has one.
    Select(Option<u32>),
    /// A request for the track of an aircraft.
    Track(u32),
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
        "viewport" => {
            // The server thins nothing by zoom, so it only checks it.
            if !message.get("zoom").is_some_and(Value::is_number) {
                return Err("`viewport` needs a number as its `zoom`".to_owned());
            }
            match message.get("bbox").and_then(parse_bbox) {
                Some(bbox) => Ok(ClientMessage::Viewport(bbox)),
                None => Err(
                    "`viewport` needs `bbox` as [west, south, east, north] in degrees".to_owned(),
                ),
            }
        }
        "select" => match message.get("id") {
            Some(Value::Null) => Ok(ClientMessage::Select(None)),
            Some(id) if aircraft_id(id).is_some() => Ok(ClientMessage::Select(aircraft_id(id))),
            _ => Err("`select` needs an aircraft id or null as its `id`".to_owned()),
        },
        "track" => match message.get("id").and_then(aircraft_id) {
            Some(id) => Ok(ClientMessage::Track(id)),
            None => Err("`track` needs an aircraft id as its `id`".to_owned()),
        },
        "set_multiplier" => Ok(ClientMessage::Unsupported("set_multiplier")),
        other => Err(format!("unknown message type `{other}`")),
    }
}

fn aircraft_id(value: &Value) -> Option<u32> {
    u32::try_from(value.as_u64()?).ok()
}

/// Reads a `viewport`'s box: west, south, east and north, in degrees.
///
/// A map that has been dragged round the world gives longitudes beyond ±180,
/// so they are brought back into range. A box that then has its west to the
/// east of its east crosses the antimeridian, which a [`Bbox`] can say.
fn parse_bbox(value: &Value) -> Option<Bbox> {
    let mut corners = [0.0; 4];
    let given = value.as_array()?;
    if given.len() != corners.len() {
        return None;
    }
    for (corner, given) in corners.iter_mut().zip(given) {
        *corner = given.as_f64()?;
    }
    let [west, south, east, north] = corners;
    if west > east || south > north {
        return None;
    }
    let (west, east) = if east - west >= 360.0 {
        (-180.0, 180.0)
    } else {
        let wrap = |lon: f64| (lon + 180.0).rem_euclid(360.0) - 180.0;
        (wrap(west), wrap(east))
    };
    Some(Bbox {
        south: degrees_to_wire(south.clamp(-90.0, 90.0)),
        west: degrees_to_wire(west),
        north: degrees_to_wire(north.clamp(-90.0, 90.0)),
        east: degrees_to_wire(east),
    })
}

/// How far a viewport is widened on every side, in wire units: a quarter of
/// its longer side, and at least a tenth of a degree.
///
/// What a client pans to before its next `viewport` arrives is in proportion
/// to what it can see, so the margin is too.
fn margin(bbox: &Bbox) -> u32 {
    let height = i64::from(bbox.north) - i64::from(bbox.south);
    let mut width = i64::from(bbox.east) - i64::from(bbox.west);
    if width < 0 {
        width += FULL_TURN;
    }
    (height.max(width) / 4).clamp(MIN_MARGIN, FULL_TURN) as u32
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
    /// The client's viewport and its margin. Until the client has sent a
    /// `viewport` it is shown everything.
    shown: Option<Bbox>,
    /// The selected aircraft, which is sent wherever it is.
    selected: Option<u32>,
    /// The aircraft whose track has been asked for and not yet sent.
    track: Option<u32>,
    /// The last picture sent: the present, as far as the client knows.
    sent: Option<Arc<Picture>>,
    metrics: Arc<Metrics>,
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
                    Message::Text(text) => self.receive(text.as_str()).await?,
                    Message::Binary(_) => {
                        self.send_error("bad_message", "client messages are JSON text").await?;
                    }
                    // Pings are answered, and a close is echoed, by the
                    // socket itself. After a close the next read ends it.
                    Message::Ping(_) | Message::Pong(_) | Message::Close(_) => {}
                },
            }
            // Here the socket is free, and what was asked for is still
            // wanted: a later `track` replaces an earlier one unanswered.
            self.send_track(&hub.tracks).await?;
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

    /// Acts on a message that came after the `hello`. A viewport or a
    /// selection takes effect in the next picture sent.
    async fn receive(&mut self, text: &str) -> Result<(), End> {
        match parse(text) {
            Ok(ClientMessage::Hello { .. }) => {
                self.send_error("bad_message", "hello was already sent")
                    .await
            }
            Ok(ClientMessage::Viewport(bbox)) => {
                self.shown = Some(bbox.grown(margin(&bbox)));
                Ok(())
            }
            Ok(ClientMessage::Select(id)) => {
                self.selected = id;
                Ok(())
            }
            Ok(ClientMessage::Track(id)) => {
                self.track = Some(id);
                Ok(())
            }
            Ok(ClientMessage::Unsupported(kind)) => {
                let message = format!("`{kind}` is not supported yet");
                self.send_error("unsupported", &message).await
            }
            Err(problem) => self.send_error("bad_message", &problem).await,
        }
    }

    /// The rows of the aircraft this client is sent, or `None` if that is
    /// every aircraft in `world`.
    fn rows_shown(&self, world: &World) -> Option<Vec<usize>> {
        let shown = self.shown?;
        let mut rows: Vec<usize> = world.query(shown, 0).collect();
        if let Some(row) = self.selected.and_then(|id| world.row_of(id)) {
            let position = world.position(row);
            if !shown.contains(position.lat, position.lon) {
                rows.push(row);
            }
        }
        (rows.len() < world.len()).then_some(rows)
    }

    /// The metadata of those of `rows` the client has not been told about.
    fn untold(&self, world: &World, rows: impl Iterator<Item = usize>) -> Vec<Metadata> {
        rows.map(|row| *world.metadata(row))
            .filter(|metadata| !self.told.contains(&metadata.aircraft_id))
            .collect()
    }

    /// Writes one binary frame, and counts it.
    async fn send_frame(&mut self, frame: Vec<u8>) -> Result<(), End> {
        let bytes = frame.len();
        self.socket.send(Message::Binary(frame.into())).await?;
        self.metrics.frame_sent(bytes);
        Ok(())
    }

    /// Sends the frames of one picture: metadata for the aircraft in it the
    /// client has not been told about, then the positions of the aircraft
    /// the client is shown.
    async fn send_picture(&mut self, picture: &Arc<Picture>) -> Result<(), End> {
        let world = &picture.world;
        // The pictures that came and went while the last one was written.
        if let Some(sent) = &self.sent {
            self.metrics
                .pictures_skipped(picture.number.saturating_sub(sent.number + 1));
        }
        let first = *self.first.get_or_insert(picture.number);
        // Every frame of a picture carries the picture's seq.
        let seq = (picture.number - first) as u32;

        let rows = self.rows_shown(world);
        let untold = match &rows {
            Some(rows) => self.untold(world, rows.iter().copied()),
            None => self.untold(world, 0..world.len()),
        };
        if !untold.is_empty() {
            let mut frame = Vec::new();
            encode_frame(&mut frame, seq, sim_time_ms(world), 0, &untold);
            self.send_frame(frame).await?;
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
        let flags = if new_pass { FRAME_NEW_PASS } else { 0 };
        let frame = match rows {
            Some(rows) => {
                let records: Vec<Position> = rows.iter().map(|&row| world.position(row)).collect();
                let mut frame = Vec::new();
                encode_frame(&mut frame, seq, sim_time_ms(world), flags, &records);
                frame
            }
            // The frame that was encoded once for everyone.
            None => {
                let mut frame = picture.positions.clone();
                stamp(&mut frame, seq, flags);
                frame
            }
        };
        self.send_frame(frame).await?;
        self.pass = picture.pass;
        self.sent = Some(picture.clone());
        Ok(())
    }

    /// Answers the `track` request, if one is waiting and a picture has been
    /// sent to answer it from. The track ends where the client last saw the
    /// aircraft, so it holds nothing later than the client's own present.
    async fn send_track(&mut self, tracks: &Tracks) -> Result<(), End> {
        let (Some(id), Some(picture), Some(first)) = (self.track, self.sent.clone(), self.first)
        else {
            return Ok(());
        };
        let world = &picture.world;
        match world.row_of(id) {
            Some(row) => {
                let track = tracks.track(
                    world.metadata(row),
                    world.appeared_s(row),
                    world.sim_time_s(),
                    world.position(row),
                );
                let seq = (picture.number - first) as u32;
                let mut frame = Vec::new();
                encode_frame(&mut frame, seq, sim_time_ms(world), 0, &track);
                self.send_frame(frame).await?;
            }
            None => {
                let message = format!("aircraft {id} is not in the picture");
                self.send_error("unknown_aircraft", &message).await?;
            }
        }
        // Only now that it has been written is the request answered.
        self.track = None;
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

    use atc_core::fixture::{self, CONFLICT_TIME_S};
    use atc_core::wire::{Frame, FrameKind, HEADER_SIZE, Header, TrackSample};
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

    /// The tracks of the fixture, which is what most tests here replay.
    fn tracks() -> Tracks {
        Tracks::new(Arc::new(fixture::recording()))
    }

    /// A server on a port of its own. The test plays the simulator: it
    /// publishes ticks through `world` when it chooses to.
    struct Server {
        addr: SocketAddr,
        world: WorldWriter,
        hub: Hub,
    }

    async fn serve_with(auth: Auth) -> Server {
        let world = WorldWriter::new();
        let hub = Hub::spawn(world.reader(), SIM, tracks());
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

    /// Reads a track frame, which must be the next thing the server sends.
    async fn next_track(client: &mut Client) -> (Header, Vec<TrackSample>) {
        let ClientFrame::Binary(bytes) = next(client).await else {
            panic!("expected a binary frame");
        };
        let frame = Frame::decode(&bytes).unwrap();
        assert_eq!(frame.header.kind, FrameKind::Track);
        (frame.header, frame.records().unwrap().collect())
    }

    /// Waits until the server has acted on everything sent so far. It takes
    /// messages in order and answers one it cannot read, so that answer
    /// comes after the rest have had their effect.
    async fn heard(client: &mut Client) {
        send(client, json!({ "type": "are you there" })).await;
        assert_eq!(next_json(client).await["code"], "bad_message");
    }

    async fn look_at(client: &mut Client, bbox: [f64; 4]) {
        send(
            client,
            json!({ "type": "viewport", "bbox": bbox, "zoom": 7 }),
        )
        .await;
        heard(client).await;
    }

    async fn select(client: &mut Client, id: Option<u32>) {
        send(client, json!({ "type": "select", "id": id })).await;
        heard(client).await;
    }

    /// A tick at `sim_time_s` with aircraft 1, 2, 3 and so on at the given
    /// latitudes and longitudes, all of them announced if it is the first.
    fn tick_at(sim_time_s: u32, points: &[(f64, f64)]) -> Tick {
        let mut tick = Tick {
            sim_time_s,
            ..Tick::default()
        };
        for (index, &(lat, lon)) in points.iter().enumerate() {
            let id = index as u32 + 1;
            tick.positions.push(Position {
                id,
                lat: degrees_to_wire(lat),
                lon: degrees_to_wire(lon),
                ..Position::default()
            });
            if sim_time_s == 0 {
                tick.appeared.push(Metadata {
                    aircraft_id: id,
                    ..Metadata::default()
                });
            }
        }
        tick
    }

    fn position_ids(positions: &[Position]) -> Vec<u32> {
        let mut ids: Vec<u32> = positions.iter().map(|position| position.id).collect();
        ids.sort_unstable();
        ids
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
            parse(r#"{"type":"viewport","bbox":[-80,38,-70,43.5],"zoom":7.25}"#),
            Ok(ClientMessage::Viewport(Bbox {
                south: 380_000_000,
                west: -800_000_000,
                north: 435_000_000,
                east: -700_000_000,
            }))
        );
        assert_eq!(
            parse(r#"{"type":"select","id":7}"#),
            Ok(ClientMessage::Select(Some(7)))
        );
        assert_eq!(
            parse(r#"{"type":"select","id":null}"#),
            Ok(ClientMessage::Select(None))
        );
        assert_eq!(
            parse(r#"{"type":"track","id":7}"#),
            Ok(ClientMessage::Track(7))
        );
        assert_eq!(
            parse(r#"{"type":"set_multiplier","value":7}"#),
            Ok(ClientMessage::Unsupported("set_multiplier"))
        );
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
            r#"{"type":"viewport"}"#,
            r#"{"type":"viewport","bbox":[-80,38,-70,43]}"#,
            r#"{"type":"viewport","bbox":[-80,38,-70,43],"zoom":"7"}"#,
            r#"{"type":"viewport","bbox":[-80,38,-70],"zoom":7}"#,
            r#"{"type":"viewport","bbox":[-80,38,-70,43,0],"zoom":7}"#,
            r#"{"type":"viewport","bbox":[-80,38,-70,"43"],"zoom":7}"#,
            r#"{"type":"viewport","bbox":[-70,38,-80,43],"zoom":7}"#,
            r#"{"type":"viewport","bbox":[-80,43,-70,38],"zoom":7}"#,
            r#"{"type":"viewport","bbox":{"west":-80},"zoom":7}"#,
            r#"{"type":"select"}"#,
            r#"{"type":"select","id":"7"}"#,
            r#"{"type":"select","id":-7}"#,
            r#"{"type":"select","id":4294967296}"#,
            r#"{"type":"track"}"#,
            r#"{"type":"track","id":null}"#,
            r#"{"type":"track","id":7.5}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_viewport_is_brought_onto_the_globe() {
        let viewport = |bbox: [f64; 4]| {
            let text = json!({ "type": "viewport", "bbox": bbox, "zoom": 3 }).to_string();
            match parse(&text) {
                Ok(ClientMessage::Viewport(bbox)) => bbox,
                other => panic!("expected a viewport, got {other:?}"),
            }
        };
        let degrees = |south: f64, west: f64, north: f64, east: f64| Bbox {
            south: degrees_to_wire(south),
            west: degrees_to_wire(west),
            north: degrees_to_wire(north),
            east: degrees_to_wire(east),
        };

        // A map dragged once round to the west shows the same place.
        assert_eq!(
            viewport([-440.0, 38.0, -430.0, 43.0]),
            degrees(38.0, -80.0, 43.0, -70.0)
        );
        // One that straddles the antimeridian has its west east of its east.
        assert_eq!(
            viewport([170.0, -10.0, 190.0, 10.0]),
            degrees(-10.0, 170.0, 10.0, -170.0)
        );
        // One that shows the whole world, or more, is the whole world.
        assert_eq!(
            viewport([-300.0, -100.0, 300.0, 100.0]),
            degrees(-90.0, -180.0, 90.0, 180.0)
        );
    }

    #[test]
    fn the_margin_is_a_quarter_of_the_longer_side_and_never_tiny() {
        let bbox = |south, west, north, east| Bbox {
            south,
            west,
            north,
            east,
        };

        // 4 degrees wide and 2 high: a degree.
        let wide = bbox(400_000_000, -1_000_000_000, 420_000_000, -960_000_000);
        assert_eq!(margin(&wide), 10_000_000);
        // 2 degrees wide and 8 high: two degrees.
        let tall = bbox(360_000_000, -1_000_000_000, 440_000_000, -980_000_000);
        assert_eq!(margin(&tall), 20_000_000);
        // A hundredth of a degree each way: the least there is.
        let airport = bbox(400_000_000, -1_000_000_000, 400_100_000, -999_900_000);
        assert_eq!(margin(&airport), 1_000_000);
        // 20 degrees wide, across the antimeridian.
        let crossing = bbox(-100_000_000, 1_700_000_000, 0, -1_700_000_000);
        assert_eq!(margin(&crossing), 50_000_000);
        // Nothing overflows for the whole world.
        let world = bbox(-900_000_000, -1_800_000_000, 900_000_000, 1_800_000_000);
        assert_eq!(margin(&world), 900_000_000);
        assert!(world.grown(margin(&world)).contains(0, 0));
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
        // Read before connecting. The paused clock jumps to the timeout as
        // soon as every task is waiting, and waiting on the socket counts, so
        // the jump can come while `connect` is still returning.
        let started = tokio::time::Instant::now();
        let mut client = connect(&server, Some(ORIGIN_ALLOWED)).await.unwrap();

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
        let hub = Hub::spawn(world.reader(), SIM, tracks());
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
    async fn messages_that_cannot_be_acted_on_are_answered_with_an_error() {
        let server = serve().await;
        let mut client = join(&server).await;

        send(&mut client, json!({ "type": "set_multiplier", "value": 2 })).await;
        let error = next_json(&mut client).await;
        assert_eq!(error["type"], "error");
        assert_eq!(error["code"], "unsupported");
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains("set_multiplier")
        );
        for bad in [
            json!({ "type": "hello", "protocol": 1 }),
            json!([1, 2]),
            json!({ "type": "viewport" }),
            json!({ "type": "select" }),
            json!({ "type": "track" }),
        ] {
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

    /// Runs a client that reads nothing until 120 ticks have gone by.
    /// `viewport` is what it looks at, if not everything, and `shown` how
    /// many of the aircraft of the first tick that takes in.
    async fn a_client_that_does_not_read(viewport: Option<[f64; 4]>, shown: u32) {
        // At least 200 kB a frame, and 24 MB over the run: far more than the
        // socket buffers between the server and a client that is not reading.
        const AIRCRAFT: u32 = 20_000;
        const TICKS: u32 = 120;
        const NEW_PASS_AT: u32 = 60;

        let mut server = serve().await;
        let mut client = join(&server).await;
        if let Some(bbox) = viewport {
            look_at(&mut client, bbox).await;
        }
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
                    lat: 320_000_000,
                    lon: -1_190_000_000,
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
            assert_eq!(picture.positions.len() as u32, shown + sim_time_s);
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
        assert_eq!(told.len() as u32, shown + TICKS - 1);
        // It is told of the new pass once, by the first picture it gets
        // from that pass, whether or not that is the pass's first.
        assert_eq!(new_passes.len(), 1, "{new_passes:?}");
        assert!(new_passes[0] >= NEW_PASS_AT);
    }

    #[tokio::test]
    async fn a_client_that_does_not_read_skips_frames_and_loses_no_metadata() {
        a_client_that_does_not_read(None, 20_000).await;
    }

    /// The crowd is spread from 30°N to 40°N in a thousand steps. With its
    /// margin of a degree the box takes in 29°N to 35°N at every longitude
    /// the crowd is at: 501 of every thousand, and so frames built for this
    /// client alone.
    #[tokio::test]
    async fn a_client_with_a_viewport_that_does_not_read_loses_no_metadata() {
        a_client_that_does_not_read(Some([-120.5, 30.0, -118.5, 34.0]), 10_020).await;
    }

    /// The box is 4 degrees by 2, so its margin is a degree. Aircraft 1 is in
    /// it, 2 and 4 are in the margin, 3 and 5 are just outside, and 6 is far
    /// away.
    const BOX: [f64; 4] = [-100.0, 40.0, -96.0, 42.0];
    const POINTS: [(f64, f64); 6] = [
        (41.0, -98.0),
        (42.9, -98.0),
        (43.1, -98.0),
        (41.0, -100.9),
        (41.0, -101.1),
        (30.0, -80.0),
    ];

    #[tokio::test]
    async fn a_viewport_narrows_the_picture_to_its_box_and_margin() {
        let mut server = serve().await;
        let mut client = join(&server).await;

        // Until it says where it is looking it gets everything.
        server.world.update(&tick_at(0, &POINTS));
        let picture = next_picture(&mut client).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 3, 4, 5, 6]);
        assert_eq!(ids(&picture.metadata), [1, 2, 3, 4, 5, 6]);

        look_at(&mut client, BOX).await;
        let tick = tick_at(1, &POINTS);
        server.world.update(&tick);
        let picture = next_picture(&mut client).await;
        assert_eq!(picture.header.seq, 1);
        assert_eq!(position_ids(&picture.positions), [1, 2, 4]);
        for position in &picture.positions {
            assert!(tick.positions.contains(position));
        }

        // A box over the whole coverage area is everything again.
        look_at(&mut client, [-130.0, 20.0, -60.0, 55.0]).await;
        server.world.update(&tick_at(2, &POINTS));
        let picture = next_picture(&mut client).await;
        assert_eq!(by_id(picture.positions), tick_at(2, &POINTS).positions);

        // And one with nothing in it is an empty frame, not silence.
        look_at(&mut client, [0.0, 0.0, 1.0, 1.0]).await;
        server.world.update(&tick_at(3, &POINTS));
        let picture = next_picture(&mut client).await;
        assert_eq!(picture.header.seq, 3);
        assert_eq!(picture.positions, []);
    }

    #[tokio::test]
    async fn metadata_arrives_once_when_an_aircraft_first_comes_into_view() {
        let mut server = serve().await;
        let mut client = join(&server).await;
        look_at(&mut client, BOX).await;
        let mut points = POINTS;

        server.world.update(&tick_at(0, &points));
        let picture = next_picture(&mut client).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 4]);
        assert_eq!(ids(&picture.metadata), [1, 2, 4]);

        // Aircraft 3 crosses into the margin, long after it appeared.
        points[2] = (42.9, -97.0);
        server.world.update(&tick_at(1, &points));
        let picture = next_picture(&mut client).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 3, 4]);
        assert_eq!(ids(&picture.metadata), [3]);

        // Aircraft 1 leaves, and 6 arrives.
        points[0] = (50.0, -98.0);
        points[5] = (41.5, -97.5);
        server.world.update(&tick_at(2, &points));
        let picture = next_picture(&mut client).await;
        assert_eq!(position_ids(&picture.positions), [2, 3, 4, 6]);
        assert_eq!(ids(&picture.metadata), [6]);

        // Aircraft 1 comes back, and the client knows it already.
        points[0] = (41.0, -98.0);
        server.world.update(&tick_at(3, &points));
        let picture = next_picture(&mut client).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 3, 4, 6]);
        assert_eq!(ids(&picture.metadata), [0u32; 0]);
    }

    /// The fixture's pair meet at 41°N 90°W, ten minutes in. The box is a
    /// degree each way around there, so its margin is a quarter of one.
    #[tokio::test]
    async fn a_viewport_on_the_replay_shows_exactly_what_is_there_each_tick() {
        let bbox = [-90.5, 40.5, -89.5, 41.5];
        let shown = Bbox {
            south: degrees_to_wire(40.25),
            west: degrees_to_wire(-90.75),
            north: degrees_to_wire(41.75),
            east: degrees_to_wire(-89.25),
        };
        let mut server = serve().await;
        let mut client = join(&server).await;
        look_at(&mut client, bbox).await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        let mut told = HashSet::new();
        let mut came_into_view_later = 0;
        let mut out_of_view = 0;

        // Into the second pass, far enough for the pair to come by again.
        for seq in 0..fixture::WINDOW_S + CONFLICT_TIME_S {
            replay.advance(&mut tick);
            server.world.update(&tick);
            let picture = next_picture(&mut client).await;

            assert_eq!(picture.header.seq, seq);
            assert_eq!(picture.header.is_new_pass(), tick.new_pass);
            let mut in_view = tick.positions.clone();
            in_view.retain(|position| shown.contains(position.lat, position.lon));
            out_of_view += tick.positions.len() - in_view.len();
            assert_eq!(by_id(picture.positions), by_id(in_view.clone()));
            // Metadata for exactly those in view for the first time.
            let mut untold = position_ids(&in_view);
            untold.retain(|id| !told.contains(id));
            assert_eq!(ids(&picture.metadata), untold);
            for metadata in &picture.metadata {
                came_into_view_later += usize::from(!tick.appeared.contains(metadata));
            }
            told.extend(untold);
        }
        // The pair, once in each pass, and none of them there from the start.
        assert!(told.len() >= 4, "{told:?}");
        assert!(came_into_view_later >= 4);
        assert!(out_of_view > 0);
    }

    #[tokio::test]
    async fn a_selected_aircraft_is_sent_wherever_it_is_until_it_is_deselected() {
        let mut server = serve().await;
        let mut client = join(&server).await;
        look_at(&mut client, BOX).await;
        let mut points = POINTS;
        let mut sim_time_s = 0;
        let mut after_tick = async |client: &mut Client, points: &[(f64, f64)]| {
            server.world.update(&tick_at(sim_time_s, points));
            sim_time_s += 1;
            next_picture(client).await
        };

        let picture = after_tick(&mut client, &points).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 4]);

        // Aircraft 6 is nowhere near, and is told of when first sent.
        select(&mut client, Some(6)).await;
        let picture = after_tick(&mut client, &points).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 4, 6]);
        assert_eq!(ids(&picture.metadata), [6]);

        // Aircraft 1 is selected in view, and then flies out of it.
        select(&mut client, Some(1)).await;
        let picture = after_tick(&mut client, &points).await;
        assert_eq!(position_ids(&picture.positions), [1, 2, 4]);
        points[0] = (50.0, -98.0);
        for _ in 0..3 {
            let picture = after_tick(&mut client, &points).await;
            assert_eq!(position_ids(&picture.positions), [1, 2, 4]);
            let selected = picture.positions.iter().find(|position| position.id == 1);
            assert_eq!(selected.unwrap().lat, degrees_to_wire(50.0));
            assert_eq!(ids(&picture.metadata), [0u32; 0]);
        }

        select(&mut client, None).await;
        let picture = after_tick(&mut client, &points).await;
        assert_eq!(position_ids(&picture.positions), [2, 4]);

        // Selecting an aircraft that is not there changes nothing.
        select(&mut client, Some(99)).await;
        let picture = after_tick(&mut client, &points).await;
        assert_eq!(position_ids(&picture.positions), [2, 4]);
    }

    /// The aircraft flying `flight_id`, from the tick it appeared in.
    fn aircraft_of(tick: &Tick, flight_id: u32) -> Option<u32> {
        let mut appeared = tick.appeared.iter();
        let metadata = appeared.find(|metadata| metadata.flight_id == flight_id)?;
        Some(metadata.aircraft_id)
    }

    /// Flight 5 joins a minute in.
    #[tokio::test]
    async fn a_track_request_is_answered_once_with_the_track_so_far() {
        let mut server = serve().await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        let mut id = None;
        let mut at = Vec::new();
        for _ in 0..=307 {
            replay.advance(&mut tick);
            server.world.update(&tick);
            id = id.or(aircraft_of(&tick, 5));
            at.push(tick.positions.iter().copied().find(|p| Some(p.id) == id));
        }
        let id = id.unwrap();
        let mut client = join(&server).await;
        let picture = next_picture(&mut client).await;

        send(&mut client, json!({ "type": "track", "id": id })).await;
        let (header, track) = next_track(&mut client).await;

        assert_eq!(header.record_size, 24);
        assert_eq!(header.seq, picture.header.seq);
        assert_eq!(header.sim_time_ms, 307_000.0);
        // Oldest first and 10 s apart, from when it appeared up to now.
        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        let mut expected: Vec<u32> = (60..=300).step_by(10).collect();
        expected.push(307);
        assert_eq!(times, expected);
        // Each sample is where the aircraft was at its time, and the last
        // is where the client has just been told it is.
        for sample in &track {
            let then = at[sample.sim_time_s as usize].unwrap();
            let position = Position {
                id: sample.id,
                lat: sample.lat,
                lon: sample.lon,
                altitude: sample.altitude,
                ground_speed: sample.ground_speed,
                track: sample.track,
                vertical_rate: sample.vertical_rate,
                flags: sample.flags,
            };
            assert_eq!(position, then);
        }
        assert!(picture.positions.contains(&at[307].unwrap()));

        // Nothing more comes of the request: the next ticks bring pictures,
        // and after them the next thing sent is the answer to `heard`.
        for seq in 1..=3 {
            replay.advance(&mut tick);
            server.world.update(&tick);
            assert_eq!(next_picture(&mut client).await.header.seq, seq);
        }
        heard(&mut client).await;
    }

    #[tokio::test]
    async fn a_track_asked_for_before_any_picture_is_answered_after_the_first() {
        let mut server = serve().await;
        let mut client = join(&server).await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        replay.advance(&mut tick);
        let (first, second) = (tick.positions[0], tick.positions[1]);

        // The second request replaces the first, which is never answered.
        send(&mut client, json!({ "type": "track", "id": first.id })).await;
        send(&mut client, json!({ "type": "track", "id": second.id })).await;
        heard(&mut client).await;

        for _ in 0..=25 {
            server.world.update(&tick);
            replay.advance(&mut tick);
        }
        // However many of those ticks the server skipped, the answer is
        // built from the picture the client is sent, and comes after it.
        let picture = next_picture(&mut client).await;
        let (header, track) = next_track(&mut client).await;
        assert_eq!(header.seq, picture.header.seq);
        assert_eq!(header.sim_time_ms, picture.header.sim_time_ms);
        let now = (header.sim_time_ms / 1_000.0) as u32;
        assert!(track.iter().all(|sample| sample.id == second.id));
        assert!(track.iter().all(|sample| sample.sim_time_s <= now));
        assert!(track.is_sorted_by(|a, b| a.sim_time_s < b.sim_time_s));
        assert_eq!(track[0].sim_time_s, 0);
        assert_eq!((track[0].lat, track[0].lon), (second.lat, second.lon));
        let last = track.last().unwrap();
        assert_eq!(last.sim_time_s, now);
        let current = picture.positions.iter().find(|p| p.id == second.id);
        assert_eq!(
            (last.lat, last.lon),
            current.map(|p| (p.lat, p.lon)).unwrap()
        );

        // It is answered once. Whatever pictures are still to come, no track
        // comes with them.
        server.world.update(&tick);
        while next_picture(&mut client).await.header.sim_time_ms < 26_000.0 {}
        heard(&mut client).await;
    }

    /// Flight 0 flies the whole window, and is a new aircraft in each pass.
    #[tokio::test]
    async fn a_track_request_for_an_aircraft_not_in_the_picture_is_refused() {
        let mut server = serve().await;
        let mut replay = Replay::new(fixture::recording()).unwrap();
        let mut tick = Tick::default();
        let mut flown_as = Vec::new();
        for _ in 0..=fixture::WINDOW_S + 25 {
            replay.advance(&mut tick);
            server.world.update(&tick);
            flown_as.extend(aircraft_of(&tick, 0));
        }
        let [departed, flying] = flown_as[..] else {
            panic!("expected two aircraft, got {flown_as:?}");
        };
        let mut client = join(&server).await;
        next_picture(&mut client).await;

        for id in [departed, 4_000_000] {
            send(&mut client, json!({ "type": "track", "id": id })).await;
            let error = next_json(&mut client).await;
            assert_eq!(error["type"], "error");
            assert_eq!(error["code"], "unknown_aircraft");
            assert!(error["message"].as_str().unwrap().contains(&id.to_string()));
        }

        // The aircraft that took its place has only this pass behind it.
        send(&mut client, json!({ "type": "track", "id": flying })).await;
        let (_, track) = next_track(&mut client).await;
        let times: Vec<u32> = track.iter().map(|sample| sample.sim_time_s).collect();
        let start = fixture::WINDOW_S;
        assert_eq!(times, [start, start + 10, start + 20, start + 25]);
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
