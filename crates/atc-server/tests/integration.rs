//! The server end to end, through its public interface only: the fixture
//! replay feeds the world state, the hub serves it on a real socket, and a
//! real WebSocket client reads what a browser would.
//!
//! The test plays the clock: it advances the replay and publishes each tick
//! itself, so nothing here waits a second for one.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::time::Duration;

use atc_core::PROTOCOL_VERSION;
use atc_core::fixture::{
    self, BAROMETRIC_LESS_ALTITUDE_FT, CONFLICT_LAT, CONFLICT_LON, CONFLICT_PAIR,
};
use atc_core::recording::SAMPLE_SPACING_S;
use atc_core::wire::units::{altitude_from_wire, degrees_from_wire};
use atc_core::wire::{
    FLAG_ON_GROUND, FLAG_SYNTHETIC, Frame, FrameKind, Header, Metadata, Position, TrackSample,
};
use atc_server::AppState;
use atc_server::config::Auth;
use atc_server::hub::{Hub, SimInfo};
use atc_server::sim::replay::Replay;
use atc_server::sim::{Feed, Tick};
use atc_server::world::WorldWriter;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{self, Message};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// How long the test waits for the server before calling it stuck.
const PATIENCE: Duration = Duration::from_secs(10);

/// A server on a port of its own, replaying the fixture when told to.
struct Server {
    addr: SocketAddr,
    replay: Replay,
    world: WorldWriter,
    hub: Hub,
    /// The tick most recently published.
    tick: Tick,
}

impl Server {
    async fn start(multiplier: u32, auth: Auth) -> Server {
        Server::start_with(multiplier, auth, atc_server::hub::WRITE_TIMEOUT).await
    }

    /// As `start`, giving a client `write_timeout` to take each write.
    async fn start_with(multiplier: u32, auth: Auth, write_timeout: Duration) -> Server {
        let replay = Replay::with_multiplier(fixture::recording(), multiplier).unwrap();
        let world = WorldWriter::new();
        let sim = SimInfo {
            multiplier,
            window_s: fixture::WINDOW_S,
        };
        let hub =
            Hub::spawn(world.reader(), sim, replay.tracks()).with_write_timeout(write_timeout);
        let state = AppState {
            // Never connected to: nothing here asks for the database.
            db: atc_server::connect_lazy("postgres://atc:atc@127.0.0.1:9/atc").unwrap(),
            hub: hub.clone(),
            allowed_origin: "http://localhost:3000".to_owned(),
            auth,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, atc_server::app(state)).await });
        Server {
            addr,
            replay,
            world,
            hub,
            tick: Tick::default(),
        }
    }

    /// One second of sim time: the next tick, published.
    fn advance(&mut self) {
        self.replay.advance(&mut self.tick);
        self.world.update(&self.tick);
    }

    async fn connect(&self) -> Result<Client, tungstenite::Error> {
        let url = format!("ws://{}/ws", self.addr);
        let (client, _) = tokio_tungstenite::connect_async(url).await?;
        Ok(client)
    }

    /// A client that has said hello and been told about the simulation.
    async fn join(&self) -> Client {
        let mut client = self.connect().await.unwrap();
        send(
            &mut client,
            json!({ "type": "hello", "protocol": PROTOCOL_VERSION }),
        )
        .await;
        let sim = next_json(&mut client).await;
        assert_eq!(sim["type"], "sim");
        assert_eq!(sim["windowSeconds"], fixture::WINDOW_S);
        client
    }
}

async fn send(client: &mut Client, message: Value) {
    client
        .send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
}

async fn next(client: &mut Client) -> Message {
    tokio::time::timeout(PATIENCE, client.next())
        .await
        .expect("the server sent nothing")
        .expect("the server closed the connection")
        .expect("the socket failed")
}

async fn next_json(client: &mut Client) -> Value {
    match next(client).await {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected a text message, got {other:?}"),
    }
}

/// What arrived up to and including one positions frame.
struct Picture {
    header: Header,
    metadata: Vec<Metadata>,
    positions: Vec<Position>,
    /// Track frames that arrived on the way.
    tracks: Vec<(Header, Vec<TrackSample>)>,
    /// `error` messages that arrived on the way.
    errors: Vec<Value>,
}

impl Picture {
    fn ids(&self) -> HashSet<u32> {
        self.positions.iter().map(|p| p.id).collect()
    }

    fn sim_time_s(&self) -> u32 {
        (self.header.sim_time_ms / 1_000.0) as u32
    }
}

async fn next_picture(client: &mut Client) -> Picture {
    let mut metadata = Vec::new();
    let mut tracks = Vec::new();
    let mut errors = Vec::new();
    loop {
        let bytes = match next(client).await {
            Message::Binary(bytes) => bytes,
            Message::Text(text) => {
                errors.push(serde_json::from_str(text.as_str()).unwrap());
                continue;
            }
            other => panic!("unexpected message {other:?}"),
        };
        let frame = Frame::decode(&bytes).unwrap();
        match frame.header.kind {
            FrameKind::Metadata => metadata.extend(frame.records::<Metadata>().unwrap()),
            FrameKind::Track => {
                let samples = frame.records::<TrackSample>().unwrap().collect();
                tracks.push((frame.header, samples));
            }
            FrameKind::Positions => {
                return Picture {
                    header: frame.header,
                    metadata,
                    positions: frame.records::<Position>().unwrap().collect(),
                    tracks,
                    errors,
                };
            }
            FrameKind::Alerts => panic!("no alerts are sent yet"),
        }
    }
}

fn lat_lon(position: &Position) -> (f64, f64) {
    (
        degrees_from_wire(position.lat),
        degrees_from_wire(position.lon),
    )
}

/// Barometric altitude less the altitude above sea level, in feet.
fn barometric_less_altitude(position: &Position) -> f64 {
    altitude_from_wire(position.barometric) - altitude_from_wire(position.altitude)
}

/// The rule that holds for every picture: an aircraft is announced once, and
/// before its first position.
fn announce(told: &mut HashMap<u32, Metadata>, picture: &Picture) {
    for metadata in &picture.metadata {
        assert!(
            told.insert(metadata.aircraft_id, *metadata).is_none(),
            "aircraft {} announced twice",
            metadata.aircraft_id
        );
    }
    for position in &picture.positions {
        assert!(told.contains_key(&position.id), "never announced");
    }
}

/// The whole picture, then a viewport, a selection and a track, on one
/// connection, with every aircraft announced exactly once.
#[tokio::test]
async fn a_client_watches_filters_selects_and_asks_for_a_track() {
    let mut server = Server::start(1, Auth::Off).await;
    let mut client = server.join().await;
    let mut told: HashMap<u32, Metadata> = HashMap::new();
    // With no viewport, every aircraft, every second, in order.
    for seq in 0..5 {
        server.advance();
        let picture = next_picture(&mut client).await;
        announce(&mut told, &picture);
        assert_eq!(picture.header.seq, seq);
        assert_eq!(picture.sim_time_s(), server.tick.sim_time_s);
        let sent: HashSet<u32> = server.tick.positions.iter().map(|p| p.id).collect();
        assert_eq!(picture.ids(), sent);
        // Each record carries both altitudes, 24 bytes in all. The fixture's
        // altimeters read low, so the barometric one is below zero on the
        // ground.
        assert_eq!(picture.header.record_size, 24);
        for position in &picture.positions {
            assert_eq!(
                barometric_less_altitude(position),
                BAROMETRIC_LESS_ALTITUDE_FT
            );
            let sent = server.tick.positions.iter().find(|p| p.id == position.id);
            assert_eq!(Some(position), sent);
        }
        let on_ground = |p: &&Position| p.flags & FLAG_ON_GROUND != 0;
        let parked = picture.positions.iter().find(on_ground);
        assert!(parked.expect("a flight starts on the ground").barometric < 0);
    }
    let everything = server.tick.positions.len();

    // A viewport two degrees square round the point where the pair meets.
    // Its margin is a quarter of its side, half a degree.
    let (south, west, north, east) = (
        CONFLICT_LAT - 1.0,
        CONFLICT_LON - 1.0,
        CONFLICT_LAT + 1.0,
        CONFLICT_LON + 1.0,
    );
    send(
        &mut client,
        json!({ "type": "viewport", "bbox": [west, south, east, north], "zoom": 8 }),
    )
    .await;
    let within = |position: &Position, margin: f64| {
        let (lat, lon) = lat_lon(position);
        (south - margin..=north + margin).contains(&lat)
            && (west - margin..=east + margin).contains(&lon)
    };
    // The viewport takes effect in the first picture built after the server
    // has read it, which may not be the very next one.
    let mut filtered = None;
    for _ in 0..10 {
        server.advance();
        let picture = next_picture(&mut client).await;
        announce(&mut told, &picture);
        if picture.positions.len() < everything {
            filtered = Some(picture);
            break;
        }
    }
    let picture = filtered.expect("the viewport never took effect");
    assert!(picture.errors.is_empty(), "{:?}", picture.errors);
    assert!(!picture.positions.is_empty());
    // Everything in the box is there, and nothing from beyond its margin.
    let in_box: HashSet<u32> = server
        .tick
        .positions
        .iter()
        .filter(|p| within(p, 0.0))
        .map(|p| p.id)
        .collect();
    assert!(in_box.is_subset(&picture.ids()));
    assert!(picture.positions.iter().all(|p| within(p, 0.5001)));

    // Select an aircraft far outside the viewport: it comes too.
    let outside = server
        .tick
        .positions
        .iter()
        .find(|p| !within(p, 5.0))
        .expect("the fixture has flights far from the pair")
        .id;
    assert!(!picture.ids().contains(&outside));
    send(&mut client, json!({ "type": "select", "id": outside })).await;
    let mut selected = false;
    for _ in 0..10 {
        server.advance();
        let picture = next_picture(&mut client).await;
        announce(&mut told, &picture);
        if picture.ids().contains(&outside) {
            // It is the one aircraft from outside the margin.
            let beyond: Vec<u32> = picture
                .positions
                .iter()
                .filter(|p| !within(p, 0.5001))
                .map(|p| p.id)
                .collect();
            assert_eq!(beyond, [outside]);
            selected = true;
            break;
        }
    }
    assert!(selected, "the selected aircraft never arrived");

    // Run on past a few samples, then ask for the track of one of the pair.
    while server.tick.sim_time_s < 47 {
        server.advance();
        announce(&mut told, &next_picture(&mut client).await);
    }
    // The northbound one, which is coming up through the viewport's margin.
    let pair = told
        .values()
        .find(|m| m.flight_id == CONFLICT_PAIR.1 as u32)
        .expect("the pair was announced")
        .aircraft_id;
    send(&mut client, json!({ "type": "track", "id": pair })).await;
    let mut track = None;
    for _ in 0..10 {
        server.advance();
        let mut picture = next_picture(&mut client).await;
        announce(&mut told, &picture);
        if let Some(answer) = picture.tracks.pop() {
            assert!(picture.tracks.is_empty(), "the request was answered twice");
            track = Some(answer);
            break;
        }
    }
    let (header, samples) = track.expect("the track never arrived");
    let now = (header.sim_time_ms / 1_000.0) as u32;
    assert!(samples.iter().all(|sample| sample.id == pair));
    assert_eq!(header.record_size, 28);
    for sample in &samples {
        let less = altitude_from_wire(sample.barometric) - altitude_from_wire(sample.altitude);
        assert_eq!(less, BAROMETRIC_LESS_ALTITUDE_FT);
    }
    // Oldest first, on the recording's ten second grid from when the
    // aircraft appeared, then where it is now: nothing from the future.
    let times: Vec<u32> = samples.iter().map(|sample| sample.sim_time_s).collect();
    let mut expected: Vec<u32> = (0..now).step_by(SAMPLE_SPACING_S as usize).collect();
    expected.push(now);
    assert_eq!(times, expected);
    assert!(now <= server.tick.sim_time_s);
    // The flight is heading north: each sample is further north than the last.
    assert!(samples.windows(2).all(|pair| pair[1].lat > pair[0].lat));

    // A track for an aircraft that does not exist is refused, not ignored.
    send(
        &mut client,
        json!({ "type": "track", "id": 4_000_000_000u32 }),
    )
    .await;
    let mut refused = None;
    for _ in 0..10 {
        server.advance();
        let mut picture = next_picture(&mut client).await;
        if let Some(error) = picture.errors.pop() {
            refused = Some(error);
            break;
        }
    }
    let error = refused.expect("no error arrived");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "unknown_aircraft");

    assert_eq!(server.hub.clients(), 1);
}

/// A client that stops reading is not sent every picture when it starts
/// again: it gets the newest, the gaps show in `seq`, and it has still been
/// told about every aircraft it is shown.
#[tokio::test]
async fn a_client_that_falls_behind_skips_to_the_newest_picture() {
    // 34 flights 600 times over: about 15,000 aircraft and 300 kB a frame,
    // more than the socket's buffers hold for long.
    const TICKS: u32 = 150;
    let mut server = Server::start(600, Auth::Off).await;
    let mut client = server.join().await;

    for _ in 0..TICKS {
        server.advance();
        // Lets the server run, as it would in a second of real time.
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let last = server.tick.sim_time_s;

    let mut told = HashSet::new();
    let mut seqs = Vec::new();
    loop {
        let picture = next_picture(&mut client).await;
        for metadata in &picture.metadata {
            assert!(told.insert(metadata.aircraft_id), "announced twice");
        }
        assert!(picture.positions.iter().all(|p| told.contains(&p.id)));
        // Most of the picture is clones.
        let clones = picture
            .positions
            .iter()
            .filter(|p| p.flags & FLAG_SYNTHETIC != 0);
        assert!(clones.count() > picture.positions.len() / 2);
        seqs.push(picture.header.seq);
        if picture.sim_time_s() == last {
            // The newest picture is the whole of the newest tick.
            assert_eq!(picture.positions.len(), server.tick.positions.len());
            break;
        }
    }

    assert!(seqs.is_sorted_by(|a, b| a < b), "{seqs:?}");
    assert!(
        seqs.len() < TICKS as usize / 2,
        "it was sent {} pictures",
        seqs.len()
    );
    assert_eq!(*seqs.last().unwrap(), TICKS - 1);
    // The server counted the same gaps the client saw.
    let skipped = server
        .hub
        .metrics()
        .summary(Duration::from_secs(1))
        .frames_skipped;
    assert_eq!(skipped, u64::from(TICKS) - seqs.len() as u64);
}

/// A client that is connected but reads nothing at all is dropped once a
/// write to it has been stuck for the write timeout, so it cannot hold a
/// picture in memory for ever. Other clients are untouched.
#[tokio::test]
async fn a_client_that_never_reads_is_dropped() {
    let mut server = Server::start_with(600, Auth::Off, Duration::from_millis(300)).await;
    let stuck = server.join().await;
    let mut reader = server.join().await;
    assert_eq!(server.hub.clients(), 2);

    // Far more than the socket's buffers hold, so a write to `stuck` blocks.
    let started = tokio::time::Instant::now();
    let mut read = 0;
    while server.hub.clients() == 2 {
        assert!(
            started.elapsed() < PATIENCE,
            "the stuck client was never dropped"
        );
        server.advance();
        next_picture(&mut reader).await;
        read += 1;
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(server.hub.clients(), 1);
    // Not before the timeout: it was given its time.
    assert!(started.elapsed() >= Duration::from_millis(300));

    // The client that reads has had every picture and still does.
    server.advance();
    let picture = next_picture(&mut reader).await;
    assert_eq!(picture.header.seq, read);
    assert_eq!(picture.positions.len(), server.tick.positions.len());
    drop(stuck);
}

/// Until tokens can be verified (milestone 4), a server that is not told
/// `ATC_AUTH=off` lets nobody in.
#[tokio::test]
async fn without_auth_off_the_socket_is_refused() {
    let auth = Auth::Jwks {
        url: "http://localhost:3000/api/auth/jwks".to_owned(),
    };
    let server = Server::start(1, auth).await;
    match server.connect().await {
        Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), 401),
        other => panic!("expected a 401, got {other:?}"),
    }
    assert_eq!(server.hub.clients(), 0);
}
