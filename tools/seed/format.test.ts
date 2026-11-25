import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	decode,
	decodeRaw,
	encode,
	encodeRaw,
	type Seed,
	type SeedFlight,
} from "./format";

function flight(overrides: Partial<SeedFlight> = {}): SeedFlight {
	return {
		icao24: 0xa1b2c3,
		callsign: "JBU123",
		aircraftType: "A320",
		origin: "",
		destination: "",
		firstSample: 2,
		lat: [4064130, 4064340, 4064551, 4064761],
		lon: [-7377810, -7377600, -7377391, -7377181],
		altitude: [1400, 1400, 1401, 1399],
		groundSpeed: [450, 451, 451, 449],
		track: [358, 359, 1, 357],
		verticalRate: [0, 1, -3, 0],
		onGround: [false, false, false, false],
		...overrides,
	};
}

function seed(flights: SeedFlight[]): Seed {
	return {
		windowStart: 1795194000,
		windowSeconds: 14400,
		spacing: 10,
		flights,
	};
}

test("a seed survives encoding and decoding", () => {
	const original = seed([
		flight(),
		flight({
			icao24: 0x000001,
			callsign: "N1",
			aircraftType: "",
			firstSample: 0,
			lat: [-3385000, -3385010],
			lon: [15120000, 15120300],
			altitude: [-4, 0],
			groundSpeed: [12, 0],
			track: [0, 180],
			verticalRate: [-127, 127],
			onGround: [true, false],
		}),
		// More than eight samples, so the on-ground bits span bytes.
		flight({
			firstSample: 1430,
			lat: Array.from({ length: 11 }, (_, n) => 2500000 + n * n),
			lon: Array.from({ length: 11 }, (_, n) => -12499999 - 7 * n),
			altitude: Array.from({ length: 11 }, (_, n) => 100 - n),
			groundSpeed: Array.from({ length: 11 }, () => 140),
			track: Array.from({ length: 11 }, (_, n) => (350 + 3 * n) % 360),
			verticalRate: Array.from({ length: 11 }, () => -10),
			onGround: Array.from({ length: 11 }, (_, n) => n % 3 === 0),
		}),
	]);
	expect(decode(encode(original))).toEqual(original);
});

test("an empty seed survives too", () => {
	expect(decodeRaw(encodeRaw(seed([])))).toEqual(seed([]));
});

test("the largest values the units allow fit", () => {
	const extreme = flight({
		lat: [9000000, -9000000, 9000000],
		lon: [18000000, -18000000, 18000000],
		altitude: [32767, -32768, 0],
		groundSpeed: [0, 65535, 0],
		track: [0, 359, 180],
		verticalRate: [127, -127, 0],
		onGround: [false, true, false],
	});
	expect(decodeRaw(encodeRaw(seed([extreme]))).flights[0]).toEqual(extreme);
});

// The layout in the comment at the top of format.ts, byte for byte, for one
// flight of three samples.
test("the bytes match the documented layout", () => {
	const bytes = encodeRaw(
		seed([
			flight({
				firstSample: 2,
				lat: [100, 110, 121],
				lon: [-100, -90, -80],
				altitude: [40, 40, 42],
				groundSpeed: [250, 249, 249],
				track: [359, 1, 0],
				verticalRate: [0, 2, -1],
				onGround: [true, false, true],
			}),
		]),
	);
	const u32 = (n: number) => [
		n & 255,
		(n >> 8) & 255,
		(n >> 16) & 255,
		n >>> 24,
	];
	const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
	expect([...bytes]).toEqual([
		...text("ATCS"),
		1, // version
		10, // spacing
		0,
		0,
		...u32(1795194000),
		...u32(14400),
		...u32(1),
		// The flight record.
		...u32(0xa1b2c3),
		...text("JBU123  "),
		...text("A320"),
		...text("    "),
		...text("    "),
		...u32(2),
		...u32(3),
		// lat: 100, then +10, then the step grows by 1. Zigzag doubles.
		...u32(4),
		200 - 128 + 128,
		1,
		20,
		2,
		// lon: -100, then +10, then no change in the step.
		...u32(4),
		199 - 128 + 128,
		1,
		20,
		0,
		// altitude: 40, +0, +2.
		...u32(3),
		80,
		0,
		4,
		// ground speed: 250, -1, +0.
		...u32(4),
		500 - 384 + 128,
		3,
		1,
		0,
		// track: 359, then +2 through north, then -1.
		...u32(4),
		718 - 640 + 128,
		5,
		4,
		1,
		// vertical rate: 0, +2, -3.
		...u32(3),
		0,
		4,
		5,
		// on ground: bits 0 and 2.
		...u32(1),
		0b101,
	]);
});

test("a file of another version is refused", () => {
	const bytes = encodeRaw(seed([flight()]));
	bytes[4] = 2;
	expect(() => decodeRaw(bytes)).toThrow(
		"seed file is format version 2; this code reads version 1",
	);
});

test("a file that is not a seed is refused", () => {
	expect(() =>
		decodeRaw(new TextEncoder().encode("icao24,callsign\n")),
	).toThrow("not a seed file");
	expect(() => decode(gzipSync("hello"))).toThrow("not a seed file");
});

test("a cut-off file is refused", () => {
	const bytes = encodeRaw(seed([flight(), flight()]));
	for (const length of [19, 40, 84, bytes.length - 1]) {
		expect(() => decodeRaw(bytes.slice(0, length))).toThrow(
			"seed file is truncated",
		);
	}
});

test("a flight with samples past the window is refused", () => {
	const late = flight({ firstSample: 1438 });
	expect(() => encodeRaw(seed([late]))).toThrow("outside the window");
	// The last sample may sit exactly at the end of the window.
	const atEnd = flight({ firstSample: 1437 });
	expect(decodeRaw(encodeRaw(seed([atEnd]))).flights[0]).toEqual(atEnd);
});

test("columns of different lengths are refused", () => {
	const uneven = flight({ altitude: [1400] });
	expect(() => encodeRaw(seed([uneven]))).toThrow("columns differ in length");
});

test("encoding gives the same bytes every time", () => {
	const one = encode(seed([flight()]));
	const two = encode(seed([flight()]));
	expect(Buffer.compare(one, two)).toBe(0);
});
