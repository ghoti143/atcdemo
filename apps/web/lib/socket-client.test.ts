import { describe, expect, test } from "bun:test";
import { createInterfaceStore } from "./interface-store";
import {
	BACKOFF_BASE_MS,
	BACKOFF_CAP_MS,
	backoffDelayMs,
	createSocketClient,
	type FrameStore,
	MAX_RETRIES,
	RATE_HOLD_MS,
	RATE_TICKS,
	REPLAY_NOTICE_MS,
	REPORT_INTERVAL_MS,
	type SocketLike,
	STALE_AFTER_MS,
	type Timers,
} from "./socket-client";

// The client against a fake socket, a fake aircraft store and a fake clock.
// A fake frame is four bytes the fake store reads: kind, seq, new-pass flag,
// and whether to throw.

const POSITIONS = 1;
const METADATA = 2;

function frame(
	kind: number,
	seq: number,
	{ newPass = false, bad = false } = {},
): ArrayBuffer {
	return new Uint8Array([kind, seq, newPass ? 1 : 0, bad ? 1 : 0]).buffer;
}

class FakeStore implements FrameStore {
	ingested: { kind: number; seq: number; receivedMs: number }[] = [];
	resets = 0;
	private last = { seq: 0, newPass: false };

	ingest(bytes: Uint8Array, receivedMs: number): number {
		const [kind, seq, newPass, bad] = bytes;
		if (bad) throw new Error("bad frame");
		this.ingested.push({ kind, seq, receivedMs });
		this.last = { seq, newPass: newPass === 1 };
		return kind;
	}
	reset() {
		this.resets += 1;
	}
	frame_seq() {
		return this.last.seq;
	}
	frame_new_pass() {
		return this.last.newPass;
	}
}

class FakeSocket implements SocketLike {
	binaryType = "blob";
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	sent: unknown[] = [];
	closed = false;

	constructor(readonly url: string) {}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}

	// What the server does.
	open() {
		this.onopen?.();
	}
	message(data: unknown) {
		this.onmessage?.({ data });
	}
	serverClose(code = 1006, reason = "") {
		this.onclose?.({ code, reason });
	}
}

/** Timers that fire only when the test moves the clock. */
class FakeClock implements Timers {
	nowMs = 1_000;
	private next = 1;
	private pending = new Map<
		number,
		{ at: number; every?: number; callback: () => void }
	>();

	now = () => this.nowMs;

	setTimeout(callback: () => void, ms: number) {
		this.pending.set(this.next, { at: this.nowMs + ms, callback });
		return this.next++;
	}
	setInterval(callback: () => void, ms: number) {
		this.pending.set(this.next, { at: this.nowMs + ms, every: ms, callback });
		return this.next++;
	}
	clearTimeout(handle: unknown) {
		this.pending.delete(handle as number);
	}
	clearInterval(handle: unknown) {
		this.pending.delete(handle as number);
	}

	/** Timeouts waiting, by how long they have left. Intervals are left out. */
	timeouts(): number[] {
		return [...this.pending.values()]
			.filter((timer) => timer.every === undefined)
			.map((timer) => timer.at - this.nowMs);
	}

	/** Moves the clock on, firing what falls due in order. */
	async advance(ms: number) {
		const end = this.nowMs + ms;
		for (;;) {
			const due = [...this.pending.entries()]
				.filter(([, timer]) => timer.at <= end)
				.sort(([, a], [, b]) => a.at - b.at)[0];
			if (!due) break;
			const [handle, timer] = due;
			this.nowMs = timer.at;
			if (timer.every === undefined) this.pending.delete(handle);
			else timer.at += timer.every;
			timer.callback();
			await flush();
		}
		this.nowMs = end;
	}
}

/** Lets the client's promise for the address settle. */
async function flush() {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function setup({ random = 1 }: { random?: number } = {}) {
	const clock = new FakeClock();
	const store = new FakeStore();
	const interfaceStore = createInterfaceStore();
	const sockets: FakeSocket[] = [];
	const logged: { level: string; text: string }[] = [];
	const log = (level: string) => (text: string) => {
		logged.push({ level, text });
	};
	let wake = () => {};
	let listening = false;

	const client = createSocketClient({
		resolveUrl: () => "ws://test/ws",
		protocolVersion: 7,
		store,
		interfaceStore,
		createSocket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		now: clock.now,
		timers: clock,
		// 1 gives the full wait, so the schedule reads as the plain doubling.
		random: () => random,
		onWake: (callback) => {
			wake = callback;
			listening = true;
			return () => {
				listening = false;
			};
		},
		log: { info: log("info"), warn: log("warn"), error: log("error") },
	});

	return {
		client,
		clock,
		store,
		interfaceStore,
		sockets,
		logged,
		wake: () => wake(),
		isListening: () => listening,
		state: () => interfaceStore.getState(),
		/** The newest socket. */
		socket: () => sockets[sockets.length - 1],
		/** Starts the client and takes it as far as a first frame. */
		async live() {
			client.start();
			await flush();
			sockets[sockets.length - 1].open();
			sockets[sockets.length - 1].message(frame(POSITIONS, 0));
		},
	};
}

const VIEWPORT = { bbox: [-80, 30, -70, 40] as const, zoom: 6 };

describe("backoffDelayMs", () => {
	test("doubles from the base to the cap", () => {
		const waits = Array.from({ length: 8 }, (_, retry) =>
			backoffDelayMs(retry, 1),
		);
		expect(waits).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
		]);
		expect(waits[0]).toBe(BACKOFF_BASE_MS);
		expect(waits[7]).toBe(BACKOFF_CAP_MS);
	});

	test("jitter takes off up to half", () => {
		expect(backoffDelayMs(2, 0)).toBe(2_000);
		expect(backoffDelayMs(2, 0.5)).toBe(3_000);
		expect(backoffDelayMs(9, 0)).toBe(BACKOFF_CAP_MS / 2);
	});
});

describe("connecting", () => {
	test("opens one socket to the address and sends hello first", async () => {
		const t = setup();
		t.client.start();
		expect(t.sockets).toHaveLength(0);
		await flush();

		expect(t.sockets).toHaveLength(1);
		expect(t.socket().url).toBe("ws://test/ws");
		expect(t.socket().binaryType).toBe("arraybuffer");
		expect(t.socket().sent).toEqual([]);
		expect(t.state().connectionStatus).toBe("connecting");

		t.socket().open();
		expect(t.socket().sent).toEqual([{ type: "hello", protocol: 7 }]);
	});

	test("the status is open at the first frame, not when the socket opens", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.socket().open();
		t.socket().message('{"type":"sim","multiplier":1,"windowSeconds":14400}');
		expect(t.state().connectionStatus).toBe("connecting");

		t.socket().message(frame(METADATA, 0));
		expect(t.state().connectionStatus).toBe("open");
	});

	test("start, stop, start within one turn opens one socket", async () => {
		// What React's development double mount does.
		const t = setup();
		t.client.start();
		t.client.stop();
		t.client.start();
		await flush();
		expect(t.sockets).toHaveLength(1);
	});

	test("starting twice changes nothing", async () => {
		const t = setup();
		t.client.start();
		t.client.start();
		await flush();
		expect(t.sockets).toHaveLength(1);
	});

	test("asks for the address before every attempt", async () => {
		const clock = new FakeClock();
		const sockets: FakeSocket[] = [];
		let asked = 0;
		const client = createSocketClient({
			resolveUrl: async () => `ws://test/ws?token=${++asked}`,
			protocolVersion: 1,
			store: new FakeStore(),
			interfaceStore: createInterfaceStore(),
			createSocket: (url) => {
				sockets.push(new FakeSocket(url));
				return sockets[sockets.length - 1];
			},
			now: clock.now,
			timers: clock,
			random: () => 1,
			onWake: () => () => {},
			log: { info() {}, warn() {}, error() {} },
		});
		client.start();
		await flush();
		sockets[0].serverClose();
		await clock.advance(1_000);
		expect(sockets.map((socket) => socket.url)).toEqual([
			"ws://test/ws?token=1",
			"ws://test/ws?token=2",
		]);
	});

	test("an address that cannot be had is a failed attempt", async () => {
		const clock = new FakeClock();
		const sockets: FakeSocket[] = [];
		let fail = true;
		const interfaceStore = createInterfaceStore();
		const client = createSocketClient({
			resolveUrl: () => {
				if (fail) throw new Error("no token");
				return "ws://test/ws";
			},
			protocolVersion: 1,
			store: new FakeStore(),
			interfaceStore,
			createSocket: (url) => {
				sockets.push(new FakeSocket(url));
				return sockets[sockets.length - 1];
			},
			now: clock.now,
			timers: clock,
			random: () => 1,
			onWake: () => () => {},
			log: { info() {}, warn() {}, error() {} },
		});
		client.start();
		await flush();
		expect(sockets).toHaveLength(0);
		expect(clock.timeouts()).toEqual([1_000]);

		fail = false;
		await clock.advance(1_000);
		expect(sockets).toHaveLength(1);
	});
});

describe("viewport", () => {
	test("is sent after hello when the map has already reported one", async () => {
		const t = setup();
		t.state().setViewport(VIEWPORT);
		t.client.start();
		await flush();
		t.socket().open();
		expect(t.socket().sent).toEqual([
			{ type: "hello", protocol: 7 },
			{ type: "viewport", bbox: [-80, 30, -70, 40], zoom: 6 },
		]);
	});

	test("is not sent when there is none", async () => {
		const t = setup();
		await t.live();
		expect(t.socket().sent).toEqual([{ type: "hello", protocol: 7 }]);
	});

	test("is sent when it changes, and not when it is set to the same", async () => {
		const t = setup();
		await t.live();
		t.state().setViewport(VIEWPORT);
		t.state().setViewport({ ...VIEWPORT });
		t.state().setViewport({ bbox: [-75, 35, -74, 36], zoom: 9 });
		expect(t.socket().sent.slice(1)).toEqual([
			{ type: "viewport", bbox: [-80, 30, -70, 40], zoom: 6 },
			{ type: "viewport", bbox: [-75, 35, -74, 36], zoom: 9 },
		]);
	});

	test("a change before the socket opens waits for hello", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.state().setViewport(VIEWPORT);
		expect(t.socket().sent).toEqual([]);
		t.socket().open();
		expect(
			t.socket().sent.map((message) => (message as { type: string }).type),
		).toEqual(["hello", "viewport"]);
	});

	test("a new connection is sent the newest", async () => {
		const t = setup();
		await t.live();
		t.state().setViewport(VIEWPORT);
		t.socket().serverClose();
		t.state().setViewport({ bbox: [-75, 35, -74, 36], zoom: 9 });
		await t.clock.advance(1_000);
		t.socket().open();
		expect(t.socket().sent).toEqual([
			{ type: "hello", protocol: 7 },
			{ type: "viewport", bbox: [-75, 35, -74, 36], zoom: 9 },
		]);
	});

	test("is not sent after stop", async () => {
		const t = setup();
		await t.live();
		const socket = t.socket();
		t.client.stop();
		t.state().setViewport(VIEWPORT);
		expect(socket.sent).toHaveLength(1);
	});
});

describe("send", () => {
	test("writes once hello has gone, and says so", async () => {
		const t = setup();
		expect(t.client.send({ type: "select", id: 4 })).toBe(false);
		t.client.start();
		await flush();
		expect(t.client.send({ type: "select", id: 4 })).toBe(false);
		t.socket().open();
		expect(t.client.send({ type: "select", id: 4 })).toBe(true);
		expect(t.client.send({ type: "track", id: 4 })).toBe(true);
		expect(t.socket().sent.slice(1)).toEqual([
			{ type: "select", id: 4 },
			{ type: "track", id: 4 },
		]);
	});

	test("writes nothing while reconnecting", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		expect(t.client.send({ type: "select", id: null })).toBe(false);
	});
});

describe("frames", () => {
	test("go to ingest with the clock's time", async () => {
		const t = setup();
		await t.live();
		t.clock.nowMs = 2_345;
		t.socket().message(frame(METADATA, 1));
		t.socket().message(frame(POSITIONS, 1));
		expect(t.store.ingested).toEqual([
			{ kind: POSITIONS, seq: 0, receivedMs: 1_000 },
			{ kind: METADATA, seq: 1, receivedMs: 2_345 },
			{ kind: POSITIONS, seq: 1, receivedMs: 2_345 },
		]);
	});

	test("a frame the store cannot read is logged and changes nothing", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.socket().open();
		t.socket().message(frame(POSITIONS, 0, { bad: true }));
		expect(t.state().connectionStatus).toBe("connecting");
		expect(t.logged.map((entry) => entry.level)).toEqual(["warn"]);

		t.socket().message(frame(POSITIONS, 1));
		expect(t.state().connectionStatus).toBe("open");
	});

	test("the sim message is kept", async () => {
		const t = setup();
		await t.live();
		expect(t.state().sim).toBeNull();
		t.socket().message('{"type":"sim","multiplier":7,"windowSeconds":14400}');
		expect(t.state().sim).toEqual({ multiplier: 7, windowSeconds: 14400 });
	});

	test("an error message is logged, and unsupported only as information", async () => {
		const t = setup();
		await t.live();
		t.socket().message('{"type":"error","code":"unsupported","message":"x"}');
		t.socket().message('{"type":"error","code":"bad_message","message":"x"}');
		t.socket().message("not json");
		expect(t.logged.map((entry) => entry.level)).toEqual([
			"info",
			"warn",
			"warn",
		]);
		expect(t.state().connectionStatus).toBe("open");
	});
});

describe("skipped frames and bytes", () => {
	const skipped = (t: ReturnType<typeof setup>) =>
		t.state().performance.skippedFrames;

	test("a gap of n missing seqs counts n", async () => {
		const t = setup();
		await t.live();
		t.socket().message(frame(POSITIONS, 1));
		t.socket().message(frame(METADATA, 5));
		t.socket().message(frame(POSITIONS, 5));
		// A track frame repeats the last positions frame's seq.
		t.socket().message(frame(4, 5));
		t.socket().message(frame(POSITIONS, 6));
		t.socket().message(frame(POSITIONS, 8));
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(skipped(t)).toBe(4);
	});

	test("ticks missed before a connection's first frame count too", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.socket().open();
		t.socket().message(frame(POSITIONS, 2));
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(skipped(t)).toBe(2);
	});

	test("a new connection's seq starts again and the count carries on", async () => {
		const t = setup();
		await t.live();
		t.socket().message(frame(POSITIONS, 3));
		t.socket().serverClose();
		await t.clock.advance(1_000);
		t.socket().open();
		t.socket().message(frame(POSITIONS, 0));
		t.socket().message(frame(POSITIONS, 1));
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(skipped(t)).toBe(2);
	});

	const rate = (t: ReturnType<typeof setup>) =>
		t.state().performance.bytesPerSecond;

	/** One tick: `extra` bytes of other messages, then a 4-byte positions frame. */
	function tick(t: ReturnType<typeof setup>, seq: number, extra: number) {
		t.socket().message("x".repeat(extra));
		t.socket().message(frame(POSITIONS, seq));
	}

	test("bytes per second are measured from tick to tick", async () => {
		const t = setup();
		await t.live();
		// One positions frame marks a start and measures nothing.
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(0);

		tick(t, 1, 996);
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(1_000);

		// The mean of the ticks held: 1,000 and 500 bytes over two seconds.
		tick(t, 2, 496);
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(750);
	});

	test("the mean is over the newest ticks only", async () => {
		const t = setup();
		await t.live();
		tick(t, 1, 99_996);
		for (let seq = 2; seq < 2 + RATE_TICKS; seq += 1) {
			await t.clock.advance(REPORT_INTERVAL_MS);
			tick(t, seq, 96);
		}
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(100);
	});

	test("two ticks arriving together do not read as a burst", async () => {
		const t = setup();
		await t.live();
		await t.clock.advance(REPORT_INTERVAL_MS);
		tick(t, 1, 996);
		await t.clock.advance(REPORT_INTERVAL_MS);
		tick(t, 2, 996);
		tick(t, 3, 996);
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(1_500);
	});

	test("the reading falls to zero when frames stop, with no final flush", async () => {
		const t = setup();
		await t.live();
		await t.clock.advance(REPORT_INTERVAL_MS);
		tick(t, 1, 996);
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(1_000);
		await t.clock.advance(RATE_HOLD_MS + REPORT_INTERVAL_MS);
		expect(rate(t)).toBe(0);
	});
});

describe("reconnecting", () => {
	test("a dropped connection is retried on the backoff schedule", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		expect(t.state().connectionStatus).toBe("reconnecting");

		const waits: number[] = [];
		for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
			const [wait] = t.clock.timeouts();
			waits.push(wait);
			await t.clock.advance(wait);
			expect(t.sockets).toHaveLength(retry + 2);
			expect(t.state().connectionStatus).toBe("reconnecting");
			t.socket().serverClose();
		}
		expect(waits).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
		]);

		// The last retry failed too: it stops.
		expect(t.state().connectionStatus).toBe("closed");
		expect(t.state().connectionClosedReason).toBe("unreachable");
		expect(t.clock.timeouts()).toEqual([]);
		await t.clock.advance(120_000);
		expect(t.sockets).toHaveLength(MAX_RETRIES + 1);
	});

	test("the wait is jittered down to half", async () => {
		const t = setup({ random: 0 });
		await t.live();
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([500]);
	});

	test("the store is reset when the new connection opens, not before", async () => {
		const t = setup();
		await t.live();
		expect(t.store.resets).toBe(1);
		t.socket().serverClose();
		await t.clock.advance(1_000);
		// The last picture is still there while the socket connects.
		expect(t.store.resets).toBe(1);
		t.socket().open();
		expect(t.store.resets).toBe(2);
		expect(t.state().connectionStatus).toBe("reconnecting");

		t.socket().message(frame(POSITIONS, 0));
		expect(t.state().connectionStatus).toBe("open");
	});

	test("a frame starts the schedule again", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		await t.clock.advance(1_000);
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([2_000]);
		await t.clock.advance(2_000);
		t.socket().open();
		// Opening is not enough.
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([4_000]);
		await t.clock.advance(4_000);
		t.socket().open();
		t.socket().message(frame(POSITIONS, 0));
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([1_000]);
	});

	test("before any frame the status stays connecting through the retries", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.socket().serverClose();
		expect(t.state().connectionStatus).toBe("connecting");
		await t.clock.advance(1_000);
		expect(t.sockets).toHaveLength(2);
		expect(t.state().connectionStatus).toBe("connecting");
	});

	test("reconnectNow starts again after giving up", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
			await t.clock.advance(30_000);
			t.socket().serverClose();
		}
		expect(t.state().connectionStatus).toBe("closed");
		const before = t.sockets.length;

		t.client.reconnectNow();
		await flush();
		expect(t.sockets).toHaveLength(before + 1);
		expect(t.state().connectionStatus).toBe("reconnecting");
		expect(t.state().connectionClosedReason).toBeNull();
		// With a full run of retries.
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([1_000]);
	});

	test("reconnectNow does nothing while connected or stopped", async () => {
		const t = setup();
		t.client.reconnectNow();
		await flush();
		expect(t.sockets).toHaveLength(0);
		await t.live();
		t.client.reconnectNow();
		await flush();
		expect(t.sockets).toHaveLength(1);
	});

	test("a connection that goes silent is replaced", async () => {
		const t = setup();
		await t.live();
		const first = t.socket();
		await t.clock.advance(STALE_AFTER_MS);
		expect(first.closed).toBe(false);
		await t.clock.advance(REPORT_INTERVAL_MS);
		expect(first.closed).toBe(true);
		expect(t.state().connectionStatus).toBe("reconnecting");
		await t.clock.advance(1_000);
		expect(t.sockets).toHaveLength(2);

		// The old socket's late close is not taken for the new one's.
		first.serverClose();
		expect(t.clock.timeouts()).toEqual([]);
	});

	test("a socket that never opens is replaced too", async () => {
		const t = setup();
		t.client.start();
		await flush();
		await t.clock.advance(STALE_AFTER_MS + REPORT_INTERVAL_MS);
		expect(t.socket().closed).toBe(true);
		expect(t.clock.timeouts()).toHaveLength(1);
	});
});

describe("close codes", () => {
	test("4001, a protocol mismatch, is not retried", async () => {
		const t = setup();
		t.client.start();
		await flush();
		t.socket().open();
		t.socket().serverClose(4001, "protocol");
		expect(t.state().connectionStatus).toBe("closed");
		expect(t.state().connectionClosedReason).toBe("protocol-mismatch");
		expect(t.clock.timeouts()).toEqual([]);
		expect(t.logged.map((entry) => entry.level)).toEqual(["error"]);

		// Nor when the tab is shown again.
		t.wake();
		await flush();
		expect(t.sockets).toHaveLength(1);
	});

	test("4000, no hello in time, is retried with a warning", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose(4000);
		expect(t.state().connectionStatus).toBe("reconnecting");
		expect(t.clock.timeouts()).toEqual([1_000]);
		expect(t.logged.map((entry) => entry.level)).toEqual(["warn"]);
	});

	test("1001, the simulator stopping, is retried quietly", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose(1001);
		expect(t.state().connectionStatus).toBe("reconnecting");
		expect(t.clock.timeouts()).toEqual([1_000]);
		expect(t.logged.map((entry) => entry.level)).toEqual(["info"]);
	});

	test("any other close is retried, and its code logged as information", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose(1006);
		expect(t.state().connectionStatus).toBe("reconnecting");
		expect(t.clock.timeouts()).toEqual([1_000]);
		expect(t.logged).toEqual([
			{ level: "info", text: "[socket] the connection closed with code 1006" },
		]);
	});
});

describe("waking", () => {
	test("a waiting retry is made at once", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		await t.clock.advance(1_000);
		t.socket().serverClose();
		expect(t.clock.timeouts()).toEqual([2_000]);

		t.wake();
		await flush();
		expect(t.sockets).toHaveLength(3);
		expect(t.clock.timeouts()).toEqual([]);
	});

	test("a client that gave up starts again", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
			await t.clock.advance(30_000);
			t.socket().serverClose();
		}
		const before = t.sockets.length;
		t.wake();
		await flush();
		expect(t.sockets).toHaveLength(before + 1);
	});

	test("a live connection is left alone", async () => {
		const t = setup();
		await t.live();
		t.wake();
		await flush();
		expect(t.sockets).toHaveLength(1);
		expect(t.socket().closed).toBe(false);
	});

	test("a connection found silent is replaced without waiting for the timer", async () => {
		const t = setup();
		await t.live();
		// A hidden tab's timers have not run.
		t.clock.nowMs += STALE_AFTER_MS + 1;
		t.wake();
		expect(t.socket().closed).toBe(true);
		expect(t.state().connectionStatus).toBe("reconnecting");
	});
});

describe("the replay notice", () => {
	test("is raised by a new pass and lowered after its time", async () => {
		const t = setup();
		await t.live();
		expect(t.state().replayRestarted).toBe(false);

		t.socket().message(frame(POSITIONS, 1, { newPass: true }));
		expect(t.state().replayRestarted).toBe(true);
		await t.clock.advance(REPLAY_NOTICE_MS - 1);
		expect(t.state().replayRestarted).toBe(true);
		await t.clock.advance(1);
		expect(t.state().replayRestarted).toBe(false);
	});

	test("only a positions frame raises it", async () => {
		const t = setup();
		await t.live();
		t.socket().message(frame(METADATA, 1, { newPass: true }));
		expect(t.state().replayRestarted).toBe(false);
	});

	test("is lowered by stop", async () => {
		const t = setup();
		await t.live();
		t.socket().message(frame(POSITIONS, 1, { newPass: true }));
		t.client.stop();
		expect(t.state().replayRestarted).toBe(false);
	});
});

describe("stop", () => {
	test("closes the socket, cancels every timer and stops listening", async () => {
		const t = setup();
		await t.live();
		const socket = t.socket();
		expect(t.isListening()).toBe(true);
		t.client.stop();
		expect(socket.closed).toBe(true);
		expect(t.isListening()).toBe(false);

		// Nothing the old socket says is heard.
		socket.message(frame(POSITIONS, 1));
		socket.serverClose();
		expect(t.store.ingested).toHaveLength(1);
		await t.clock.advance(60_000);
		expect(t.sockets).toHaveLength(1);
	});

	test("cancels a waiting retry", async () => {
		const t = setup();
		await t.live();
		t.socket().serverClose();
		t.client.stop();
		await t.clock.advance(60_000);
		expect(t.sockets).toHaveLength(1);
	});
});
