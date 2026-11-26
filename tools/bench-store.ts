// Times the aircraft store in the WASM build: `advance`, which the browser
// calls every animation frame, and `ingest` of a whole-picture positions
// frame, which it calls once a second. The design's target for `advance` is
// under 2 ms at 50,000 aircraft.
//
//   bun run wasm:build && bun tools/bench-store.ts
//   node tools/bench-store.ts      (the same, on V8, the engine Chrome uses)
//
// `cargo bench -p atc-core --bench store` times the native build.
//
// The aircraft are made up here: spread over the coverage area, each flying
// straight. It exits non-zero if the median `advance` passes the target.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AircraftStore, initSync } from "../packages/atc-wasm/atc_wasm.js";

/** The stress target, and the picture at multiplier 7. */
const SIZES = [50_000, 60_583];
/** Seconds played, at 60 frames each. The first few are left out. */
const SECONDS = 25;
const WARM_UP_S = 5;
const FRAME_MS = 1_000 / 60;
const TARGET_MS = 2;

const HEADER = 24;
const RECORD = 24;

const wasm = initSync({
	module: readFileSync(
		join(import.meta.dirname, "../packages/atc-wasm/atc_wasm_bg.wasm"),
	),
});

/** A generator of numbers from 0 up to 1, the same on every run. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let z = Math.imul(state ^ (state >>> 15), 1 | state);
		z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
		return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
	};
}

type Fleet = {
	lat: Float64Array;
	lon: Float64Array;
	north: Float64Array;
	east: Float64Array;
	track: Uint16Array;
	speed: Uint16Array;
	altitude: Int16Array;
};

function fleet(count: number): Fleet {
	const next = random(17);
	const made: Fleet = {
		lat: new Float64Array(count),
		lon: new Float64Array(count),
		north: new Float64Array(count),
		east: new Float64Array(count),
		track: new Uint16Array(count),
		speed: new Uint16Array(count),
		altitude: new Int16Array(count),
	};
	for (let i = 0; i < count; i++) {
		const lat = 25 + 24 * next();
		const track = 2 * Math.PI * next();
		const speed = Math.round(120 + 400 * next());
		// Degrees flown in a second.
		const step = speed / 3_600 / 60;
		made.lat[i] = lat;
		made.lon[i] = -124 + 57 * next();
		made.north[i] = step * Math.cos(track);
		made.east[i] = (step * Math.sin(track)) / Math.cos((lat * Math.PI) / 180);
		made.track[i] = Math.floor((track / (2 * Math.PI)) * 65_536);
		made.speed[i] = speed;
		made.altitude[i] = Math.round((1_000 + 40_000 * next()) / 25);
	}
	return made;
}

/** Flies every aircraft on a second and returns the positions frame. */
function tick(aircraft: Fleet, seq: number): Uint8Array {
	const count = aircraft.lat.length;
	const bytes = new Uint8Array(HEADER + count * RECORD);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, 2); // protocol version
	view.setUint8(1, 1); // positions
	view.setUint16(2, RECORD, true);
	view.setUint32(4, seq, true);
	view.setFloat64(8, seq * 1_000, true);
	view.setUint32(16, count, true);
	for (let i = 0; i < count; i++) {
		aircraft.lat[i] += aircraft.north[i];
		aircraft.lon[i] += aircraft.east[i];
		const at = HEADER + i * RECORD;
		view.setUint32(at, i, true);
		view.setInt32(at + 4, Math.round(aircraft.lat[i] * 1e7), true);
		view.setInt32(at + 8, Math.round(aircraft.lon[i] * 1e7), true);
		view.setInt16(at + 12, aircraft.altitude[i], true);
		view.setUint16(at + 14, aircraft.speed[i], true);
		view.setUint16(at + 16, aircraft.track[i], true);
		// The altimeter reads 200 ft low.
		view.setInt16(at + 20, aircraft.altitude[i] - 8, true);
	}
	return bytes;
}

/** The median, the 95th percentile and the longest, in milliseconds. */
function spread(times: number[]): string {
	times.sort((a, b) => a - b);
	const ms = (value: number) => value.toFixed(3).padStart(6);
	const median = ms(times[times.length >> 1]);
	const high = ms(times[Math.floor((times.length * 95) / 100)]);
	return `median ${median} ms   95th ${high} ms   longest ${ms(times[times.length - 1])} ms`;
}

function timed(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

/** Times one size and returns the median `advance`. */
function measure(count: number): number {
	const aircraft = fleet(count);
	const store = new AircraftStore();
	const ingests: number[] = [];
	const first: number[] = [];
	const interpolating: number[] = [];
	const reckoning: number[] = [];
	let generation = -1;
	let rebuilt = 0;
	let checksum = 0;
	let positions = new Float32Array();

	// What the render loop does after every `advance`: check the views, and
	// read through one of them.
	const look = () => {
		if (store.view_generation() !== generation) {
			generation = store.view_generation();
			rebuilt += 1;
			positions = new Float32Array(
				wasm.memory.buffer,
				store.positions_ptr(),
				store.capacity() * 3,
			);
		}
		checksum += positions[(store.len() - 1) * 3];
	};

	for (let second = 0; second < SECONDS; second++) {
		const frame = tick(aircraft, second);
		const now = second * 1_000;
		const took = timed(() => store.ingest(frame, now));
		if (second >= WARM_UP_S) ingests.push(took);
		for (let i = 0; i < 60; i++) {
			const took = timed(() => store.advance(now + i * FRAME_MS));
			look();
			if (second < WARM_UP_S) continue;
			// The first after a frame also takes up its rows and colours.
			(i === 0 ? first : interpolating).push(took);
		}
	}
	// The feed stops, and every frame from here is past the newest sample.
	for (let i = 0; i < 240; i++) {
		const now = SECONDS * 1_000 + i * FRAME_MS;
		reckoning.push(timed(() => store.advance(now)));
		look();
	}
	if (store.len() !== count || !Number.isFinite(checksum)) {
		throw new Error(`expected ${count} aircraft, drew ${store.len()}`);
	}
	store.free();

	console.log(`${count} aircraft (views built: ${rebuilt})`);
	console.log(`  advance, interpolating    ${spread(interpolating)}`);
	console.log(`  advance, dead reckoning   ${spread(reckoning)}`);
	console.log(`  advance, first after one  ${spread(first)}`);
	console.log(`  ingest a positions frame  ${spread(ingests)}`);
	return Math.max(
		interpolating[interpolating.length >> 1],
		reckoning[reckoning.length >> 1],
	);
}

const slowest = Math.max(...SIZES.map(measure));
if (slowest > TARGET_MS) {
	console.log(`the median advance passed the ${TARGET_MS} ms target`);
	process.exit(1);
}
console.log(`every median advance was under the ${TARGET_MS} ms target`);
