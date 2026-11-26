// The parity test: the aircraft store built natively and built as WASM are
// given the same frames and the same render times, and must read back the
// same bytes.
//
// `crates/atc-wasm/examples/parity.rs` is the native half. It writes the
// script of calls and what it read back while making them. `replay` below
// makes the same calls on the WASM package; it mirrors that file's `run`, so
// change them together.
//
// It needs `bun run wasm:build` first, and cargo.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AircraftStore, initSync } from "../packages/atc-wasm/atc_wasm.js";

const root = join(import.meta.dir, "..");
const wasm = initSync({
	module: readFileSync(join(root, "packages/atc-wasm/atc_wasm_bg.wasm")),
});

const INGEST = 0;
const ADVANCE = 1;
const SET_SELECTED = 2;
const SET_HOVERED = 3;
const SET_ALTITUDE_SCALE = 4;
const READ_AIRCRAFT = 5;
const READ_TRACK = 6;
const READ_ALERTS = 7;
const RESET = 8;

/** What was read back, as bytes. */
class Read {
	#bytes = new Uint8Array(1 << 16);
	#view = new DataView(this.#bytes.buffer);
	#length = 0;

	#room(bytes: number): number {
		if (this.#length + bytes > this.#bytes.length) {
			const grown = new Uint8Array((this.#length + bytes) * 2);
			grown.set(this.#bytes);
			this.#bytes = grown;
			this.#view = new DataView(grown.buffer);
		}
		const at = this.#length;
		this.#length += bytes;
		return at;
	}

	u8(value: number) {
		this.#view.setUint8(this.#room(1), value);
	}

	u32(value: number) {
		this.#view.setUint32(this.#room(4), value, true);
	}

	f64(value: number) {
		this.#view.setFloat64(this.#room(8), value, true);
	}

	/** The bytes under a typed array, which is little-endian wherever WASM runs. */
	raw(values: Uint8Array | Uint32Array | Float32Array) {
		const bytes = new Uint8Array(
			values.buffer,
			values.byteOffset,
			values.byteLength,
		);
		const at = this.#room(bytes.length);
		this.#bytes.set(bytes, at);
	}

	number(value: number | undefined) {
		this.u8(value === undefined ? 0 : 1);
		this.f64(value ?? 0);
	}

	flag(value: boolean | undefined) {
		this.number(value === undefined ? undefined : Number(value));
	}

	text(value: string | undefined) {
		this.u8(value === undefined ? 0 : 1);
		const bytes = new TextEncoder().encode(value ?? "");
		this.u32(bytes.length);
		this.raw(bytes);
	}

	bytes(): Uint8Array {
		return this.#bytes.subarray(0, this.#length);
	}
}

/** Views over the store's output buffers, built again when they go stale. */
class Views {
	#generation = -1;
	ids = new Uint32Array();
	positions = new Float32Array();
	angles = new Float32Array();
	colors = new Uint8Array();
	rebuilt = 0;

	refresh(store: AircraftStore) {
		const generation = store.view_generation();
		if (generation === this.#generation) return;
		this.#generation = generation;
		this.rebuilt += 1;
		const { buffer } = wasm.memory;
		const capacity = store.capacity();
		this.ids = new Uint32Array(buffer, store.ids_ptr(), capacity);
		this.positions = new Float32Array(
			buffer,
			store.positions_ptr(),
			capacity * 3,
		);
		this.angles = new Float32Array(buffer, store.angles_ptr(), capacity);
		this.colors = new Uint8Array(buffer, store.colors_ptr(), capacity * 4);
	}
}

const optionalId = (value: number) => (value === -1 ? undefined : value);

/** Makes every call in an encoded script and returns what it read. */
function replay(script: Uint8Array): { read: Uint8Array; views: Views } {
	const store = new AircraftStore();
	const views = new Views();
	const read = new Read();
	const calls = new DataView(
		script.buffer,
		script.byteOffset,
		script.byteLength,
	);
	let at = 0;
	while (at < script.length) {
		const name = calls.getUint8(at);
		const value = calls.getFloat64(at + 1, true);
		const length = calls.getUint32(at + 9, true);
		const bytes = script.subarray(at + 13, at + 13 + length);
		at += 13 + length;

		switch (name) {
			case INGEST:
				read.u8(store.ingest(bytes, value));
				read.u32(store.frame_seq());
				read.f64(store.frame_sim_time_ms());
				read.u8(Number(store.frame_new_pass()));
				read.u32(store.frame_count());
				break;
			case ADVANCE: {
				store.advance(value);
				views.refresh(store);
				const rows = store.len();
				// A detached view has length zero and reads as nothing.
				expect(views.positions.length).toBe(store.capacity() * 3);
				read.u32(rows);
				read.u32(store.rows_version());
				read.raw(views.ids.subarray(0, rows));
				read.raw(views.positions.subarray(0, rows * 3));
				read.raw(views.angles.subarray(0, rows));
				read.raw(views.colors.subarray(0, rows * 4));
				break;
			}
			case SET_SELECTED:
				store.set_selected(optionalId(value));
				break;
			case SET_HOVERED:
				store.set_hovered(optionalId(value));
				break;
			case SET_ALTITUDE_SCALE:
				store.set_altitude_scale(value);
				break;
			case READ_AIRCRAFT: {
				const row = store.row_of(value);
				read.number(row);
				read.number(row === undefined ? undefined : store.id_at(row));
				read.text(store.callsign(value));
				read.text(store.aircraft_type(value));
				read.text(store.origin(value));
				read.text(store.destination(value));
				read.number(store.flight_id(value));
				read.number(store.icao24(value));
				read.number(store.latitude(value));
				read.number(store.longitude(value));
				read.number(store.altitude_ft(value));
				read.number(store.ground_speed_kt(value));
				read.number(store.track_deg(value));
				read.number(store.vertical_rate_fpm(value));
				read.flag(store.on_ground(value));
				read.flag(store.synthetic(value));
				break;
			}
			case READ_TRACK: {
				const samples = store.track_len(value);
				const { buffer } = wasm.memory;
				read.u32(samples);
				read.raw(
					new Uint32Array(buffer, store.track_times_ptr(value), samples),
				);
				read.raw(
					new Float32Array(
						buffer,
						store.track_positions_ptr(value),
						samples * 3,
					),
				);
				break;
			}
			case READ_ALERTS: {
				const alerts = store.alert_count();
				const { buffer } = wasm.memory;
				read.u32(alerts);
				read.raw(new Uint32Array(buffer, store.alert_ids_ptr(), alerts * 2));
				read.raw(
					new Float32Array(buffer, store.alert_positions_ptr(), alerts * 6),
				);
				read.raw(
					new Float32Array(buffer, store.alert_details_ptr(), alerts * 3),
				);
				break;
			}
			case RESET:
				store.reset();
				break;
			default:
				throw new Error(`the script has no call ${name}`);
		}
	}
	store.free();
	return { read: read.bytes(), views };
}

/** The first byte at which two arrays differ, or -1. */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
	const shorter = Math.min(a.length, b.length);
	for (let i = 0; i < shorter; i++) {
		if (a[i] !== b[i]) return i;
	}
	return a.length === b.length ? -1 : shorter;
}

test(
	"the store reads back the same bytes natively and in WASM",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "atc-parity-"));
		try {
			const native = Bun.spawnSync(
				[
					"cargo",
					"run",
					"--quiet",
					"--locked",
					"--package",
					"atc-wasm",
					"--example",
					"parity",
					"--",
					directory,
				],
				{ cwd: root, stdout: "pipe", stderr: "pipe" },
			);
			if (native.exitCode !== 0) {
				throw new Error(`the native half failed:\n${native.stderr}`);
			}
			const script = readFileSync(join(directory, "script.bin"));
			const expected = readFileSync(join(directory, "expected.bin"));

			const { read, views } = replay(script);

			// Enough was read for the comparison to mean something.
			expect(expected.length).toBeGreaterThan(100_000);
			expect(views.rebuilt).toBeGreaterThan(0);
			expect(read.length).toBe(expected.length);
			expect(firstDifference(read, expected)).toBe(-1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	{ timeout: 300_000 },
);

test("a frame that cannot be decoded throws and changes nothing", () => {
	const store = new AircraftStore();
	expect(() => store.ingest(new Uint8Array(10), 0)).toThrow(/truncated/);
	const wrongVersion = new Uint8Array(24);
	wrongVersion[0] = 99;
	expect(() => store.ingest(wrongVersion, 0)).toThrow(/protocol version 99/);
	store.advance(16);
	expect(store.len()).toBe(0);
	expect(store.frame_seq()).toBe(0);
	store.free();
});

test("the view generation changes when WASM memory grows", () => {
	const store = new AircraftStore();
	const before = store.view_generation();
	const pages = wasm.memory.buffer.byteLength;
	// Nothing to do with the store: any growth detaches every view.
	wasm.memory.grow(1);
	expect(wasm.memory.buffer.byteLength).toBeGreaterThan(pages);
	expect(store.view_generation()).not.toBe(before);
	store.free();
});
