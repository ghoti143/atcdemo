import { expect, test } from "bun:test";
import {
	bakeAircraft,
	type Coverage,
	clip,
	keep,
	type Point,
	type RawPoint,
	readPoints,
	resample,
	splitFlights,
	type TraceFile,
} from "./tracks";

// A small box and a 10 minute window starting at time 1000.
const coverage: Coverage = {
	windowStart: 1000,
	windowSeconds: 600,
	spacing: 10,
	south: 40,
	west: -75,
	north: 41,
	east: -74,
	margin: 0.5,
	gapSeconds: 600,
	minSamples: 6,
	maxSpeed: 900,
};

function point(time: number, overrides: Partial<Point> = {}): Point {
	return {
		time,
		lat: 40.5,
		lon: -74.5,
		altitude: 10000,
		onGround: false,
		groundSpeed: 300,
		track: 90,
		verticalRate: 0,
		newLeg: false,
		callsign: "TEST1",
		...overrides,
	};
}

// Points every `step` seconds flying east at 360 knots: 0.1 nm a second.
function eastbound(from: number, to: number, step: number, lon = -74.9) {
	const points: Point[] = [];
	const degreesPerSecond = 0.1 / (60 * Math.cos((40.5 * Math.PI) / 180));
	for (let time = from; time <= to; time += step) {
		points.push(
			point(time, {
				lon: lon + (time - from) * degreesPerSecond,
				groundSpeed: 360,
			}),
		);
	}
	return points;
}

test("readPoints fills missing values from the points before", () => {
	const raw: RawPoint[] = [
		[5, 40.1, -74.1, null, 100, 10, 0, 64, null],
		[10, 40.2, -74.2, 3000, 200, 20, 0, 640, { flight: "ABC12   " }],
		[20, 40.3, -74.3, null, null, null, 2, null, null],
		[30, 40.4, -74.4, "ground", 15, 30, 0, 9999, null],
		[40, 40.5, -74.5, 100, 5000, 40, 0, -99999, { flight: "" }],
	];
	const points = readPoints({ icao: "a00001", timestamp: 1000, trace: raw });
	// The first point has no altitude to go on and is left out.
	expect(points.map((p) => p.time)).toEqual([1010, 1020, 1030, 1040]);
	expect(points[0]).toEqual({
		time: 1010,
		lat: 40.2,
		lon: -74.2,
		altitude: 3000,
		onGround: false,
		groundSpeed: 200,
		track: 20,
		verticalRate: 640,
		newLeg: false,
		callsign: "ABC12",
	});
	// Nothing reported: everything carries over, and the leg flag is read.
	expect(points[1]).toMatchObject({
		altitude: 3000,
		groundSpeed: 200,
		track: 20,
		verticalRate: 640,
		newLeg: true,
	});
	// On the ground the altitude is 0 and the vertical rate is ignored.
	expect(points[2]).toMatchObject({
		altitude: 0,
		onGround: true,
		groundSpeed: 15,
		verticalRate: 0,
	});
	// A speed and a rate no aircraft has are treated as missing.
	expect(points[3]).toMatchObject({
		altitude: 100,
		onGround: false,
		groundSpeed: 15,
		verticalRate: 0,
		callsign: "ABC12",
	});
});

test("a trace splits at a new leg and at a long gap", () => {
	const points = [
		point(0),
		point(10),
		point(20, { newLeg: true }),
		point(30),
		point(630),
		point(631 + 600),
		point(1300),
	];
	const flights = splitFlights(points, coverage);
	expect(flights.map((f) => f.map((p) => p.time))).toEqual([
		[0, 10],
		[20, 30, 630],
		[1231, 1300],
	]);
});

test("a single bad position is left out", () => {
	const points = eastbound(0, 60, 10);
	// 60 nm north for one point: 21,600 knots there and back.
	points[3] = { ...points[3], lat: 41.5 };
	const flights = splitFlights(points, coverage);
	expect(flights).toHaveLength(1);
	expect(flights[0].map((p) => p.time)).toEqual([0, 10, 20, 40, 50, 60]);
});

test("a trace that jumps for good starts a new flight", () => {
	const before = eastbound(0, 30, 10);
	const after = eastbound(40, 90, 10).map((p) => ({ ...p, lat: 45 }));
	const flights = splitFlights([...before, ...after], coverage);
	expect(flights.map((f) => f.length)).toEqual([4, 6]);
	expect(flights[1][0].time).toBe(40);
});

test("positions a second apart may jitter without counting as a jump", () => {
	const points = [
		point(0),
		// 0.3 nm in one second is 1,080 knots, but well inside the slack.
		point(1, { lat: 40.505 }),
		point(2),
	];
	expect(splitFlights(points, coverage)).toHaveLength(1);
});

test("resampling interpolates onto the window's grid", () => {
	const track = resample(
		[
			point(1004, { lat: 40, lon: -74, altitude: 1000, groundSpeed: 200 }),
			point(1024, {
				lat: 40.2,
				lon: -74.4,
				altitude: 3000,
				groundSpeed: 240,
				verticalRate: 640,
				onGround: true,
			}),
		],
		coverage,
	);
	// Grid times 1010 and 1020 fall between the points, 0.3 and 0.8 of the way.
	expect(track).toEqual({
		firstSample: 1,
		lat: [4006000, 4016000],
		lon: [-7412000, -7432000],
		altitude: [64, 104],
		groundSpeed: [212, 232],
		track: [90, 90],
		// The nearer point's rate and ground state.
		verticalRate: [0, 10],
		onGround: [false, true],
	});
});

test("resampling turns the short way through north", () => {
	const track = resample(
		[point(1000, { track: 350 }), point(1020, { track: 10 })],
		coverage,
	);
	expect(track?.track).toEqual([350, 0, 10]);
	const back = resample(
		[point(1000, { track: 10 }), point(1040, { track: 350 })],
		coverage,
	);
	expect(back?.track).toEqual([10, 5, 0, 355, 350]);
});

test("resampling keeps to the window", () => {
	// Starts before the window and ends after it.
	const track = resample(eastbound(900, 1700, 5), coverage);
	expect(track?.firstSample).toBe(0);
	// One sample at each grid time from the start to the end, inclusive.
	expect(track?.lat).toHaveLength(61);

	expect(resample(eastbound(100, 900, 5), coverage)).toBeNull();
	expect(resample(eastbound(1601, 1700, 5), coverage)).toBeNull();
	// Too short to reach a grid time.
	expect(resample([point(1001), point(1009)], coverage)).toBeNull();
});

test("clipping keeps what is inside the box and its margin", () => {
	// West to east along 40.5°N, from well outside to well outside.
	const lons = [-76, -75.6, -75.4, -75, -74.5, -74, -73.6, -73.4, -73];
	const whole = resample(
		lons.map((lon, n) => point(1000 + n * 10, { lon })),
		coverage,
	);
	if (!whole) throw new Error("expected a track");
	const [clipped, ...rest] = clip(whole, coverage);
	expect(rest).toEqual([]);
	// -75.4 to -73.6: the box and half a degree either side.
	expect(clipped.firstSample).toBe(2);
	expect(clipped.lon).toEqual([
		-7540000, -7500000, -7450000, -7400000, -7360000,
	]);
	expect(clipped.lat).toHaveLength(5);
	expect(clipped.onGround).toHaveLength(5);
});

test("a flight that leaves and comes back is two", () => {
	const lons = [-74.5, -74, -73.6, -73, -73.6, -74, -74.5];
	const whole = resample(
		lons.map((lon, n) => point(1000 + n * 10, { lon })),
		coverage,
	);
	if (!whole) throw new Error("expected a track");
	const runs = clip(whole, coverage);
	expect(runs.map((r) => [r.firstSample, r.lat.length])).toEqual([
		[0, 3],
		[4, 3],
	]);
});

test("a flight that only touches the margin is dropped", () => {
	const whole = resample(
		[point(1000, { lon: -75.4 }), point(1100, { lon: -75.2 })],
		coverage,
	);
	if (!whole) throw new Error("expected a track");
	expect(clip(whole, coverage)).toEqual([]);
});

test("short flights and flights that never leave the ground are not kept", () => {
	const airborne = resample(eastbound(1000, 1050, 10), coverage);
	const short = resample(eastbound(1000, 1040, 10), coverage);
	const taxi = resample(
		eastbound(1000, 1100, 10).map((p) => ({ ...p, onGround: true })),
		coverage,
	);
	const departure = resample(
		eastbound(1000, 1100, 10).map((p, n) => ({ ...p, onGround: n < 5 })),
		coverage,
	);
	if (!airborne || !short || !taxi || !departure) {
		throw new Error("expected tracks");
	}
	expect(keep(airborne, coverage)).toBe(true);
	expect(keep(short, coverage)).toBe(false);
	expect(keep(taxi, coverage)).toBe(false);
	expect(keep(departure, coverage)).toBe(true);
});

function traceFile(icao: string, points: Point[]): TraceFile {
	return {
		icao,
		t: "B738",
		timestamp: 0,
		trace: points.map((p, n) => [
			p.time,
			p.lat,
			p.lon,
			p.altitude,
			p.groundSpeed,
			p.track,
			p.newLeg ? 2 : 0,
			p.verticalRate,
			n === 2 ? { flight: `${p.callsign}   ` } : null,
		]),
	};
}

test("a trace file becomes flights with its identity", () => {
	const flights = bakeAircraft(
		traceFile("a1b2c3", eastbound(990, 1200, 5)),
		coverage,
	);
	expect(flights).toHaveLength(1);
	expect(flights[0]).toMatchObject({
		icao24: 0xa1b2c3,
		callsign: "TEST1",
		aircraftType: "B738",
		origin: "",
		destination: "",
		firstSample: 0,
	});
	expect(flights[0].lat).toHaveLength(21);
	expect(flights[0].groundSpeed.every((speed) => speed === 360)).toBe(true);
	// 0.1 nm a second east for 10 s, in 1e-5 degrees of longitude.
	const step = flights[0].lon[1] - flights[0].lon[0];
	expect(step).toBeGreaterThan(2180);
	expect(step).toBeLessThan(2200);
});

test("an aircraft with no ICAO24 address adds nothing", () => {
	const file = traceFile("~1f4fa0", eastbound(990, 1200, 5));
	expect(bakeAircraft(file, coverage)).toEqual([]);
});
