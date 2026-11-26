// The browser end of the WebSocket to `atc-server`. See docs/DESIGN.md
// sections 6 and 8.
//
// It is driven by the interface store and the WASM aircraft store, not by
// components, so nothing here imports React. `lib/traffic.ts` makes the
// page's one client; tests make their own with a fake socket, a fake
// aircraft store and a fake clock.
//
// What it does:
//
// - Connects, sends `hello` with the WASM module's protocol version, then
//   the viewport if the map has reported one, and again whenever the
//   interface store's viewport changes. The map paces those changes
//   (lib/viewport.ts), so nothing is debounced here.
// - Hands every binary frame to `store.ingest` with `performance.now()`,
//   the clock the render loop gives `advance`. It never reads a frame's
//   bytes itself: what it needs to know about one it asks the store.
// - Writes the connection status to the interface store, and the `sim`
//   message, the "replay restarted" notice, bytes per second and skipped
//   frames.
// - Reconnects with backoff, and gives up after MAX_RETRIES failures in a
//   row. `reconnectNow` starts again.
//
// A hidden tab is not treated differently. Browsers go on delivering
// socket messages to one, so frames are still ingested and the store's
// clock stays right with nothing drawn. Timers are throttled there, which
// can only make a retry late, so when the tab is shown again, or the
// browser comes back online, a retry that is waiting is made at once and a
// client that had given up starts again.

import type {
	ConnectionClosedReason,
	ConnectionStatus,
} from "@/lib/connection-status";
import type { InterfaceStore } from "@/lib/interface-store";
import type { Viewport } from "@/lib/viewport";

/** The first retry waits about this long, and each one after twice as long. */
export const BACKOFF_BASE_MS = 1_000;
/** No retry waits longer than this. */
export const BACKOFF_CAP_MS = 30_000;
/**
 * Retries in a row, with no frame between them, before the client gives up
 * and the status becomes `closed`. With the waits above that is between one
 * and two minutes.
 */
export const MAX_RETRIES = 8;
/**
 * A connection that has been silent this long is taken for dead and
 * replaced. The server writes every second, and a connection that has
 * died without a close (a laptop that slept, a network that changed) can
 * otherwise look open for minutes.
 */
export const STALE_AFTER_MS = 10_000;
/** How long the "replay restarted" notice stays up. */
export const REPLAY_NOTICE_MS = 4_000;
/** How often bytes per second and skipped frames are reported. */
export const REPORT_INTERVAL_MS = 1_000;
/** Bytes per second is the mean over this many of the newest ticks. */
export const RATE_TICKS = 3;
/**
 * Positions frames closer together than this are counted as one tick. The
 * server sends one a second, so frames this close are a backlog arriving at
 * once after a stall, and the few milliseconds between them are not time
 * the bytes took to come.
 */
export const RATE_MIN_TICK_MS = 500;
/** With no positions frame for this long, bytes per second reads zero. */
export const RATE_HOLD_MS = 2_500;

/** Close codes `atc-server` uses (section 6). */
export const CLOSE_HELLO_EXPECTED = 4000;
export const CLOSE_PROTOCOL_MISMATCH = 4001;
export const CLOSE_GOING_AWAY = 1001;

// `ingest` returns the frame's kind; 1 is a positions frame.
const KIND_POSITIONS = 1;

/**
 * How long to wait before retry number `retry`, counted from 0. The wait
 * doubles from BACKOFF_BASE_MS up to BACKOFF_CAP_MS, and `random`, in
 * [0, 1), then takes off up to half of it, so clients that lost the same
 * server do not all come back in the same instant.
 */
export function backoffDelayMs(retry: number, random: number): number {
	const full = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retry);
	return full / 2 + (full / 2) * random;
}

/** The messages a caller may send (section 6). `hello` is the client's own. */
export type ClientMessage =
	| { type: "viewport"; bbox: Viewport["bbox"]; zoom: number }
	| { type: "select"; id: number | null }
	| { type: "track"; id: number }
	| { type: "set_multiplier"; value: number };

/** The part of the WASM `AircraftStore` the client uses. */
export type FrameStore = {
	ingest(bytes: Uint8Array, receivedMs: number): number;
	reset(): void;
	frame_seq(): number;
	frame_new_pass(): boolean;
	/** How many aircraft the store holds. */
	len(): number;
};

/** The part of a `WebSocket` the client uses. */
export type SocketLike = {
	binaryType: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	send(data: string): void;
	close(): void;
};

/** The part of the interface store the client uses. */
export type InterfaceStoreLike = {
	getState(): InterfaceStore;
	subscribe<T>(
		selector: (state: InterfaceStore) => T,
		listener: (value: T) => void,
	): () => void;
};

export type Timers = {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
};

export type Log = Pick<Console, "info" | "warn" | "error">;

export type SocketClientOptions = {
	/**
	 * Where to connect, asked before every attempt. Milestones 2 and 3 run
	 * with `ATC_AUTH=off`, so today this is the server's address and no more.
	 * In milestone 4 it becomes the place a fresh token is fetched and put in
	 * the query string (section 11). A rejection counts as a failed attempt.
	 */
	resolveUrl: () => string | Promise<string>;
	/** The WASM module's `protocol_version()`, sent in `hello`. */
	protocolVersion: number;
	store: FrameStore;
	interfaceStore: InterfaceStoreLike;

	// Everything below has a browser default and is given only by tests.
	createSocket?: (url: string) => SocketLike;
	/** The clock for `ingest` and the readings: `performance.now()`. */
	now?: () => number;
	timers?: Timers;
	/** In [0, 1), for the backoff's jitter. */
	random?: () => number;
	/**
	 * Calls back when a waiting retry should be made at once: the tab has
	 * been shown again, or the browser has come back online. Returns the way
	 * to stop listening.
	 */
	onWake?: (wake: () => void) => () => void;
	log?: Log;
};

export type SocketClient = {
	/** Connects, and keeps connected until `stop`. */
	start(): void;
	/** Closes the socket and cancels every timer. `start` may follow. */
	stop(): void;
	/**
	 * Connects at once with a fresh run of retries: for a button, after the
	 * client has given up. Does nothing while a connection is open or being
	 * made.
	 */
	reconnectNow(): void;
	/**
	 * Sends one message, and says whether it was written. It is not when no
	 * connection is open; nothing is queued.
	 *
	 * A new connection knows nothing the last one was told. The client sends
	 * the viewport again itself. A caller that sends `select` must send it
	 * again when the interface store's `connectionStatus` becomes `open`.
	 */
	send(message: ClientMessage): boolean;
};

// Where the client is between `start` and `stop`.
type Phase =
	// Not started, or stopped.
	| "stopped"
	// Resolving the address, or holding a socket: connecting or connected.
	| "attempting"
	// Waiting out a backoff.
	| "waiting"
	// Given up.
	| "closed";

export function createSocketClient(options: SocketClientOptions): SocketClient {
	const { resolveUrl, protocolVersion, store, interfaceStore } = options;
	const createSocket = options.createSocket ?? browserSocket;
	const now = options.now ?? (() => performance.now());
	const timers = options.timers ?? browserTimers;
	const random = options.random ?? Math.random;
	const onWake = options.onWake ?? browserWake;
	const log = options.log ?? console;

	let phase: Phase = "stopped";
	// Goes up whenever an attempt begins or ends, so a callback from an
	// earlier attempt can tell it is no longer wanted.
	let attempt = 0;
	let socket: SocketLike | null = null;
	// True once this connection's `hello` is sent, so `send` may write.
	let ready = false;
	// True once this connection has delivered a frame.
	let receiving = false;
	// True once any connection has: there is a picture on screen.
	let hadPicture = false;
	let retries = 0;
	let retryTimer: unknown;
	// When this attempt last showed life: began, opened or sent a message.
	let lastActivityMs = 0;
	// The newest positions frame's `seq` on this connection. A connection's
	// first tick is 0.
	let lastSeq = -1;

	let skippedFrames = 0;
	// Bytes are measured from one positions frame to the next, not over the
	// report's second: the server sends once a second, so a second on the
	// page's own clock holds no tick, or one, or two, and the reading would
	// swing between nothing and double. `ticks` holds when each of the newest
	// positions frames came and the bytes that had come since the one before.
	let bytesSinceTick = 0;
	let ticks: { atMs: number; bytes: number }[] = [];
	let reportTimer: unknown;
	let noticeTimer: unknown;
	let stopListening: (() => void)[] = [];

	function setStatus(
		status: ConnectionStatus,
		closedReason?: ConnectionClosedReason,
	) {
		interfaceStore.getState().setConnectionStatus(status, closedReason);
	}

	/** `connecting` until there has been a picture, `reconnecting` after. */
	function setTrying() {
		setStatus(hadPicture ? "reconnecting" : "connecting");
	}

	function connect() {
		timers.clearTimeout(retryTimer);
		const mine = ++attempt;
		phase = "attempting";
		lastActivityMs = now();
		setTrying();
		// Always a turn of the event loop later, even with nothing to fetch:
		// React's development double mount starts, stops and starts within
		// one turn, and so opens one socket, not two.
		Promise.resolve()
			.then(resolveUrl)
			.then(
				(url) => {
					if (mine === attempt) open(url, mine);
				},
				(cause: unknown) => {
					if (mine !== attempt) return;
					log.warn("[socket] could not get the address to connect to", cause);
					ended();
				},
			);
	}

	function open(url: string, mine: number) {
		let opened: SocketLike;
		try {
			opened = createSocket(url);
		} catch (cause) {
			log.error(`[socket] could not open ${url}`, cause);
			ended();
			return;
		}
		socket = opened;
		opened.binaryType = "arraybuffer";
		opened.onopen = () => {
			if (mine !== attempt) return;
			lastActivityMs = now();
			// A new connection starts from nothing: its first frames are the
			// whole picture, and its `seq` starts again at 0. Until here the
			// last connection's picture stayed up.
			store.reset();
			lastSeq = -1;
			bytesSinceTick = 0;
			ticks = [];
			opened.send(JSON.stringify({ type: "hello", protocol: protocolVersion }));
			ready = true;
			const viewport = interfaceStore.getState().viewport;
			if (viewport) sendViewport(viewport);
		};
		opened.onmessage = (event) => {
			if (mine !== attempt) return;
			lastActivityMs = now();
			if (typeof event.data === "string") {
				bytesSinceTick += event.data.length;
				onText(event.data);
			} else if (event.data instanceof ArrayBuffer) {
				bytesSinceTick += event.data.byteLength;
				onFrame(new Uint8Array(event.data));
			}
		};
		opened.onclose = (event) => {
			if (mine === attempt) ended(event.code, event.reason);
		};
	}

	function onFrame(bytes: Uint8Array) {
		let kind: number;
		try {
			kind = store.ingest(bytes, now());
		} catch (cause) {
			// The store took nothing from it. The next frame is a whole
			// picture, so there is nothing to recover.
			log.warn("[socket] dropped a frame the store could not read", cause);
			return;
		}
		if (!receiving) {
			receiving = true;
			hadPicture = true;
			retries = 0;
			setStatus("open");
		}
		if (kind !== KIND_POSITIONS) return;

		const atMs = now();
		const newest = ticks[ticks.length - 1];
		if (newest && atMs - newest.atMs < RATE_MIN_TICK_MS) {
			// Part of the same burst: its bytes join that tick's, and the span
			// they are averaged over stays as long as it was.
			newest.bytes += bytesSinceTick;
		} else {
			ticks.push({ atMs, bytes: bytesSinceTick });
			// One more than the intervals measured: the oldest only marks a
			// start.
			if (ticks.length > RATE_TICKS + 1) ticks.shift();
		}
		bytesSinceTick = 0;

		// One positions frame a tick, so a jump in `seq` is ticks this
		// connection was never sent. The other kinds repeat a tick's `seq`.
		const seq = store.frame_seq();
		if (seq > lastSeq + 1) skippedFrames += seq - lastSeq - 1;
		lastSeq = seq;

		if (store.frame_new_pass()) {
			interfaceStore.getState().setReplayRestarted(true);
			timers.clearTimeout(noticeTimer);
			noticeTimer = timers.setTimeout(() => {
				interfaceStore.getState().setReplayRestarted(false);
			}, REPLAY_NOTICE_MS);
		}
	}

	function onText(text: string) {
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			log.warn("[socket] the server sent text that is not JSON", text);
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const { type, multiplier, windowSeconds, code } = message as Record<
			string,
			unknown
		>;
		if (type === "sim") {
			if (typeof multiplier === "number" && typeof windowSeconds === "number") {
				interfaceStore.getState().setSim({ multiplier, windowSeconds });
			}
		} else if (type === "error") {
			// The connection stays open after either. `unsupported` is a request
			// this server does not act on yet, which is expected while the
			// project is being built; anything else is a mistake in a message
			// this page sent.
			if (code === "unsupported") {
				log.info("[socket] the server does not support a request yet", message);
			} else {
				log.warn("[socket] the server refused a request", message);
			}
		}
	}

	/** The attempt is over, by a close or by never starting. Decides what next. */
	function ended(code?: number, reason?: string) {
		attempt += 1;
		socket = null;
		ready = false;
		receiving = false;

		if (code === CLOSE_PROTOCOL_MISMATCH) {
			// Retrying cannot help: this page's WASM module and the server
			// disagree until the page is loaded again.
			log.error(
				`[socket] the server does not speak protocol ${protocolVersion}; not retrying`,
				reason,
			);
			phase = "closed";
			setStatus("closed", "protocol-mismatch");
			return;
		}
		if (code === CLOSE_HELLO_EXPECTED) {
			// Ours was late or missing, which is a fault here, but one a new
			// connection may not repeat.
			log.warn("[socket] the server did not get a hello in time", reason);
		} else if (code === CLOSE_GOING_AWAY) {
			log.info("[socket] the simulator has stopped");
		} else if (code !== undefined) {
			// 1006 is a connection that was refused or lost without a close.
			log.info(`[socket] the connection closed with code ${code}`);
		}

		if (retries >= MAX_RETRIES) {
			log.warn(`[socket] gave up after ${retries} retries`);
			phase = "closed";
			setStatus("closed", "unreachable");
			return;
		}
		phase = "waiting";
		setTrying();
		retryTimer = timers.setTimeout(connect, backoffDelayMs(retries, random()));
		retries += 1;
	}

	/** Lets go of the socket without waiting for it to say it has closed. */
	function dropSocket() {
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			// Already closed.
		}
		socket = null;
	}

	function sendViewport(viewport: Viewport) {
		send({ type: "viewport", bbox: viewport.bbox, zoom: viewport.zoom });
	}

	function send(message: ClientMessage): boolean {
		if (!socket || !ready) return false;
		socket.send(JSON.stringify(message));
		return true;
	}

	function isStale() {
		return phase === "attempting" && now() - lastActivityMs > STALE_AFTER_MS;
	}

	function report() {
		const nowMs = now();
		interfaceStore.getState().reportPerformance(
			{
				bytesPerSecond: bytesPerSecond(nowMs),
				skippedFrames,
				// As of the newest frame taken in. The render loop (#30) may
				// report it too, from the same store.
				aircraftCount: store.len(),
			},
			nowMs,
		);

		if (isStale()) {
			log.warn("[socket] nothing received for 10 s; connecting again");
			dropSocket();
			ended();
		}
	}

	function bytesPerSecond(nowMs: number): number {
		const newest = ticks[ticks.length - 1];
		if (!newest || nowMs - newest.atMs > RATE_HOLD_MS) {
			ticks = [];
			return 0;
		}
		const spanMs = newest.atMs - ticks[0].atMs;
		if (spanMs <= 0) return 0;
		// The oldest tick's bytes came before the span began.
		let bytes = 0;
		for (let i = 1; i < ticks.length; i += 1) bytes += ticks[i].bytes;
		return Math.round((bytes * 1_000) / spanMs);
	}

	function reconnectNow() {
		if (phase === "stopped" || phase === "attempting") return;
		retries = 0;
		connect();
	}

	function wake() {
		if (phase === "waiting") {
			reconnectNow();
		} else if (phase === "closed") {
			const { connectionClosedReason } = interfaceStore.getState();
			if (connectionClosedReason !== "protocol-mismatch") reconnectNow();
		} else if (isStale()) {
			dropSocket();
			ended();
		}
	}

	return {
		start() {
			if (phase !== "stopped") return;
			retries = 0;
			reportTimer = timers.setInterval(report, REPORT_INTERVAL_MS);
			stopListening = [
				interfaceStore.subscribe(
					(state) => state.viewport,
					(viewport) => {
						if (viewport) sendViewport(viewport);
					},
				),
				onWake(wake),
			];
			connect();
		},

		stop() {
			if (phase === "stopped") return;
			phase = "stopped";
			attempt += 1;
			timers.clearTimeout(retryTimer);
			timers.clearTimeout(noticeTimer);
			timers.clearInterval(reportTimer);
			for (const stop of stopListening) stop();
			stopListening = [];
			dropSocket();
			ready = false;
			receiving = false;
			interfaceStore.getState().setReplayRestarted(false);
		},

		reconnectNow,
		send,
	};
}

function browserSocket(url: string): SocketLike {
	// `SocketLike` is `WebSocket` with its events narrowed to what is read
	// from them, which TypeScript will not take as the same handler type.
	return new WebSocket(url) as unknown as SocketLike;
}

const browserTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as number | undefined),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as number | undefined),
};

function browserWake(wake: () => void): () => void {
	const onVisibility = () => {
		if (document.visibilityState === "visible") wake();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("online", wake);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("online", wake);
	};
}
