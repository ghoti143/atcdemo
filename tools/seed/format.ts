// The seed file format: the recorded flights the simulator replays.
//
// The file is one gzip stream. Inside it everything is little-endian:
//
//   header, 20 bytes
//     0  magic          4 bytes  "ATCS"
//     4  version        u8       1
//     5  spacing        u8       seconds between samples
//     6  reserved       u16      0
//     8  window start   u32      Unix time, seconds
//     12 window length  u32      seconds
//     16 flight count   u32
//
//   one flight record per flight, 32 bytes
//     0  ICAO24         u32
//     4  callsign       8 bytes  space-padded ASCII, as are the next three
//     12 type           4 bytes
//     16 origin         4 bytes
//     20 destination    4 bytes
//     24 first sample   u32      index on the window's grid
//     28 sample count   u32
//
//   eight columns, each a u32 byte length followed by that many bytes
//     lat            1e-5 degrees
//     lon            1e-5 degrees
//     altitude       25 ft above mean sea level
//     barometric     25 ft; barometric altitude less the altitude above
//     ground speed   knots
//     track          whole degrees, 0 to 359
//     vertical rate  64 ft/min
//     on ground      one bit per sample
//
// A column holds every flight's samples in turn, in flight order. The first
// seven are signed variable-length integers (zigzag, then LEB128). A flight's
// first value is stored whole and each later one as the difference from the
// one before; a track difference is taken the short way round, so it is
// between -180 and 179. For lat and lon the third value onwards is the
// difference between successive differences: an aircraft flying straight at
// a steady speed becomes a run of zeros. The on-ground column packs each
// flight's bits into bytes, lowest bit first, starting each flight on a new
// byte.
//
// Sample n of a flight was taken (first sample + n) × spacing seconds into
// the window, and no sample is later than the window's length.

import { gunzipSync, gzipSync } from "node:zlib";

export const MAGIC = "ATCS";
export const VERSION = 1;
const HEADER_SIZE = 20;
const FLIGHT_SIZE = 32;

// One flight, with its samples as parallel arrays in the file's units.
export interface SeedFlight {
	icao24: number;
	callsign: string;
	aircraftType: string;
	origin: string;
	destination: string;
	// Index on the window's grid of the first sample.
	firstSample: number;
	// 1e-5 degrees.
	lat: number[];
	// 1e-5 degrees.
	lon: number[];
	// 25 ft above mean sea level.
	altitude: number[];
	// 25 ft: barometric altitude, what the altimeter reads at standard
	// pressure. Aircraft are separated by this one.
	barometric: number[];
	// Knots.
	groundSpeed: number[];
	// Whole degrees, 0 to 359.
	track: number[];
	// 64 ft/min.
	verticalRate: number[];
	onGround: boolean[];
}

export interface Seed {
	// Unix time of the start of the window, in seconds.
	windowStart: number;
	// Length of the window in seconds.
	windowSeconds: number;
	// Seconds between samples.
	spacing: number;
	flights: SeedFlight[];
}

class Writer {
	private bytes = new Uint8Array(1 << 16);
	private length = 0;

	private reserve(extra: number) {
		if (this.length + extra <= this.bytes.length) return;
		const grown = new Uint8Array(
			Math.max(this.bytes.length * 2, this.length + extra),
		);
		grown.set(this.bytes.subarray(0, this.length));
		this.bytes = grown;
	}

	u8(value: number) {
		this.reserve(1);
		this.bytes[this.length++] = value;
	}

	u32(value: number) {
		this.reserve(4);
		new DataView(this.bytes.buffer).setUint32(this.length, value, true);
		this.length += 4;
	}

	// Space-padded ASCII in exactly `size` bytes.
	text(value: string, size: number) {
		for (let i = 0; i < size; i++) {
			const code = i < value.length ? value.charCodeAt(i) : 0x20;
			this.u8(code >= 0x20 && code < 0x7f ? code : 0x3f);
		}
	}

	// A signed integer: zigzag, then seven bits to a byte, low bits first.
	varint(value: number) {
		// Arithmetic, not shifts: a second difference of longitude does not
		// fit in the 31 bits a shift would leave after the zigzag.
		let rest = value < 0 ? -2 * value - 1 : 2 * value;
		this.reserve(8);
		while (rest >= 0x80) {
			this.bytes[this.length++] = (rest % 0x80) | 0x80;
			rest = Math.floor(rest / 0x80);
		}
		this.bytes[this.length++] = rest;
	}

	append(other: Writer) {
		const bytes = other.done();
		this.reserve(bytes.length);
		this.bytes.set(bytes, this.length);
		this.length += bytes.length;
	}

	done(): Uint8Array {
		return this.bytes.subarray(0, this.length);
	}
}

class Reader {
	private view: DataView;
	offset = 0;

	constructor(private bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
	}

	private need(count: number) {
		if (this.offset + count > this.bytes.length) {
			throw new Error("seed file is truncated");
		}
	}

	u8(): number {
		this.need(1);
		return this.bytes[this.offset++];
	}

	u32(): number {
		this.need(4);
		const value = this.view.getUint32(this.offset, true);
		this.offset += 4;
		return value;
	}

	text(size: number): string {
		this.need(size);
		const raw = this.bytes.subarray(this.offset, this.offset + size);
		this.offset += size;
		return String.fromCharCode(...raw).trimEnd();
	}

	varint(): number {
		let rest = 0;
		let scale = 1;
		for (;;) {
			const byte = this.u8();
			rest += (byte & 0x7f) * scale;
			if (byte < 0x80) break;
			scale *= 0x80;
		}
		return rest % 2 === 1 ? -(rest + 1) / 2 : rest / 2;
	}

	// A reader over the next length-prefixed column.
	column(): Reader {
		const length = this.u32();
		this.need(length);
		const column = new Reader(
			this.bytes.subarray(this.offset, this.offset + length),
		);
		this.offset += length;
		return column;
	}

	atEnd(): boolean {
		return this.offset === this.bytes.length;
	}
}

// The difference between two tracks, the short way round: -180 to 179.
function turn(from: number, to: number): number {
	return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

// Encodes a seed as the file's bytes, before compression.
export function encodeRaw(seed: Seed): Uint8Array {
	const out = new Writer();
	out.text(MAGIC, 4);
	out.u8(VERSION);
	out.u8(seed.spacing);
	out.u8(0);
	out.u8(0);
	out.u32(seed.windowStart);
	out.u32(seed.windowSeconds);
	out.u32(seed.flights.length);

	const lastIndex = Math.floor(seed.windowSeconds / seed.spacing);
	for (const f of seed.flights) {
		const count = f.lat.length;
		const columns = [
			f.lon,
			f.altitude,
			f.barometric,
			f.groundSpeed,
			f.track,
			f.verticalRate,
			f.onGround,
		];
		if (columns.some((c) => c.length !== count)) {
			throw new Error(`flight ${f.callsign}: columns differ in length`);
		}
		if (count === 0 || f.firstSample + count - 1 > lastIndex) {
			throw new Error(`flight ${f.callsign}: samples fall outside the window`);
		}
		out.u32(f.icao24);
		out.text(f.callsign, 8);
		out.text(f.aircraftType, 4);
		out.text(f.origin, 4);
		out.text(f.destination, 4);
		out.u32(f.firstSample);
		out.u32(count);
	}

	const second = (values: (f: SeedFlight) => number[]) => {
		const column = new Writer();
		for (const f of seed.flights) {
			let previous = 0;
			let step = 0;
			values(f).forEach((value, n) => {
				const difference = value - previous;
				column.varint(n === 0 ? value : difference - step);
				step = n === 0 ? 0 : difference;
				previous = value;
			});
		}
		return column;
	};
	const first = (values: (f: SeedFlight) => number[], wraps = false) => {
		const column = new Writer();
		for (const f of seed.flights) {
			let previous = 0;
			values(f).forEach((value, n) => {
				if (n === 0) column.varint(value);
				else column.varint(wraps ? turn(previous, value) : value - previous);
				previous = value;
			});
		}
		return column;
	};
	const bits = new Writer();
	for (const f of seed.flights) {
		for (let n = 0; n < f.onGround.length; n += 8) {
			let byte = 0;
			for (let bit = 0; bit < 8 && n + bit < f.onGround.length; bit++) {
				if (f.onGround[n + bit]) byte |= 1 << bit;
			}
			bits.u8(byte);
		}
	}

	for (const column of [
		second((f) => f.lat),
		second((f) => f.lon),
		first((f) => f.altitude),
		// Stored against the altitude above sea level, which it follows.
		first((f) => f.barometric.map((value, n) => value - f.altitude[n])),
		first((f) => f.groundSpeed),
		first((f) => f.track, true),
		first((f) => f.verticalRate),
		bits,
	]) {
		out.u32(column.done().length);
		out.append(column);
	}
	return out.done();
}

// Decodes the file's bytes, after decompression.
export function decodeRaw(bytes: Uint8Array): Seed {
	const input = new Reader(bytes);
	if (bytes.length < MAGIC.length || input.text(4) !== MAGIC) {
		throw new Error("not a seed file");
	}
	const version = input.u8();
	if (version !== VERSION) {
		throw new Error(
			`seed file is format version ${version}; this code reads version ${VERSION}`,
		);
	}
	const spacing = input.u8();
	input.u8();
	input.u8();
	const windowStart = input.u32();
	const windowSeconds = input.u32();
	const flightCount = input.u32();
	if (bytes.length < HEADER_SIZE + flightCount * FLIGHT_SIZE) {
		throw new Error("seed file is truncated");
	}

	const flights: SeedFlight[] = [];
	const counts: number[] = [];
	for (let i = 0; i < flightCount; i++) {
		flights.push({
			icao24: input.u32(),
			callsign: input.text(8),
			aircraftType: input.text(4),
			origin: input.text(4),
			destination: input.text(4),
			firstSample: input.u32(),
			lat: [],
			lon: [],
			altitude: [],
			barometric: [],
			groundSpeed: [],
			track: [],
			verticalRate: [],
			onGround: [],
		});
		counts.push(input.u32());
	}

	const second = (values: (f: SeedFlight) => number[]) => {
		const column = input.column();
		flights.forEach((f, i) => {
			const into = values(f);
			let previous = 0;
			let step = 0;
			for (let n = 0; n < counts[i]; n++) {
				const stored = column.varint();
				if (n === 0) previous = stored;
				else {
					step += stored;
					previous += step;
				}
				into.push(previous);
			}
		});
		if (!column.atEnd()) throw new Error("seed file has a column too long");
	};
	const first = (values: (f: SeedFlight) => number[], wraps = false) => {
		const column = input.column();
		flights.forEach((f, i) => {
			const into = values(f);
			let previous = 0;
			for (let n = 0; n < counts[i]; n++) {
				const stored = column.varint();
				previous = n === 0 ? stored : previous + stored;
				if (wraps) previous = ((previous % 360) + 360) % 360;
				into.push(previous);
			}
		});
		if (!column.atEnd()) throw new Error("seed file has a column too long");
	};
	second((f) => f.lat);
	second((f) => f.lon);
	first((f) => f.altitude);
	first((f) => f.barometric);
	for (const f of flights) {
		f.barometric = f.barometric.map((value, n) => value + f.altitude[n]);
	}
	first((f) => f.groundSpeed);
	first((f) => f.track, true);
	first((f) => f.verticalRate);
	const bits = input.column();
	flights.forEach((f, i) => {
		for (let n = 0; n < counts[i]; n += 8) {
			const byte = bits.u8();
			for (let bit = 0; bit < 8 && n + bit < counts[i]; bit++) {
				f.onGround.push((byte & (1 << bit)) !== 0);
			}
		}
	});
	if (!bits.atEnd()) throw new Error("seed file has a column too long");

	return { windowStart, windowSeconds, spacing, flights };
}

// Encodes and compresses a seed: the bytes of the file.
export function encode(seed: Seed): Uint8Array {
	return gzipSync(encodeRaw(seed), { level: 9 });
}

// Decompresses and decodes a seed file.
export function decode(file: Uint8Array): Seed {
	return decodeRaw(gunzipSync(file));
}
