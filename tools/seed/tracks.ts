// Turns one aircraft's adsb.lol trace into the flights that go in the seed
// file: split the day into flights, put each on the window's 10 s grid, and
// clip it to the coverage area.

import type { SeedFlight } from "./format";

// One point of a readsb trace file. The fields are documented in
// https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons
export type RawPoint = [
	number, // seconds after the file's timestamp
	number, // lat
	number, // lon
	number | "ground" | null, // barometric altitude, ft
	number | null, // ground speed, knots
	number | null, // track, degrees; true heading on the ground
	number, // flags: 1 stale, 2 new leg, 4 geometric rate, 8 geometric altitude
	number | null, // vertical rate, ft/min
	{ flight?: string } | null, // extra details, on some points
	...unknown[],
];

export interface TraceFile {
	icao: string;
	// Aircraft type, when adsb.lol's database knows the airframe.
	t?: string;
	// Unix time of the start of the day, in seconds.
	timestamp: number;
	trace: RawPoint[];
}

// A trace point with the gaps in it filled from the points before.
export interface Point {
	// Unix time, seconds.
	time: number;
	lat: number;
	lon: number;
	// Feet; 0 on the ground.
	altitude: number;
	onGround: boolean;
	// Knots.
	groundSpeed: number;
	// Degrees.
	track: number;
	// Feet per minute.
	verticalRate: number;
	// readsb's guess that a new flight starts here.
	newLeg: boolean;
	// The callsign in effect at this point, or "".
	callsign: string;
}

// A stretch of samples on the window's grid, in the seed file's units.
export type Track = Pick<
	SeedFlight,
	| "firstSample"
	| "lat"
	| "lon"
	| "altitude"
	| "groundSpeed"
	| "track"
	| "verticalRate"
	| "onGround"
>;

export interface Coverage {
	// Unix time of the start of the window, in seconds.
	windowStart: number;
	windowSeconds: number;
	// Seconds between samples.
	spacing: number;
	// Degrees.
	south: number;
	west: number;
	north: number;
	east: number;
	// Flights are kept this far outside the box, in degrees, so they do not
	// vanish exactly on its edge.
	margin: number;
	// A trace silent for longer than this, in seconds, is two flights.
	gapSeconds: number;
	// A clipped flight with fewer samples than this is dropped.
	minSamples: number;
	// No aircraft covers ground faster than this, in knots. A point that
	// would need more is a bad position.
	maxSpeed: number;
}

// The continental United States from 17:00 to 21:00 UTC on 2026-11-20,
// chosen by the milestone 2 spike (section 5 of the design).
export const COVERAGE: Coverage = {
	windowStart: Date.UTC(2026, 10, 20, 17, 0, 0) / 1000,
	windowSeconds: 4 * 3600,
	spacing: 10,
	south: 24.4,
	west: -125,
	north: 49.4,
	east: -66.9,
	margin: 0.5,
	gapSeconds: 600,
	minSamples: 6,
	maxSpeed: 900,
};

// Reported speeds and vertical rates beyond these are noise, and are
// treated as missing.
const MAX_REPORTED_SPEED = 1000;
const MAX_REPORTED_RATE = 20_000;
// How far a position may be off without counting as a jump, in nautical
// miles. Positions a second apart would otherwise turn jitter into speed.
const POSITION_SLACK = 0.5;
// How many points ahead to look for the trace to come back after a jump.
const OUTLIER_LOOKAHEAD = 3;

// Reads a trace file's points. Speed, track, vertical rate and altitude are
// missing from some points; each takes the last value seen. Points before
// the first known altitude are left out.
export function readPoints(file: TraceFile): Point[] {
	const points: Point[] = [];
	let altitude: number | null = null;
	let onGround = false;
	let groundSpeed = 0;
	let track = 0;
	let verticalRate = 0;
	let callsign = "";
	for (const raw of file.trace) {
		const flight = raw[8]?.flight?.trim();
		if (flight) callsign = flight;
		if (raw[3] === "ground") {
			altitude = 0;
			onGround = true;
			verticalRate = 0;
		} else if (raw[3] !== null) {
			altitude = raw[3];
			onGround = false;
		}
		if (raw[4] !== null && raw[4] <= MAX_REPORTED_SPEED) groundSpeed = raw[4];
		if (raw[5] !== null) track = raw[5];
		if (raw[7] !== null && !onGround && Math.abs(raw[7]) <= MAX_REPORTED_RATE) {
			verticalRate = raw[7];
		}
		if (altitude === null) continue;
		points.push({
			time: file.timestamp + raw[0],
			lat: raw[1],
			lon: raw[2],
			altitude,
			onGround,
			groundSpeed,
			track,
			verticalRate,
			newLeg: (raw[6] & 2) !== 0,
			callsign,
		});
	}
	return points;
}

// Distance between two points in nautical miles, near enough for points a
// few miles apart.
function distance(a: Point, b: Point): number {
	const north = (b.lat - a.lat) * 60;
	const east =
		(b.lon - a.lon) * 60 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
	return Math.hypot(north, east);
}

// Whether an aircraft could have got from one point to the other in the
// time between them.
function reachable(from: Point, to: Point, maxSpeed: number): boolean {
	const hours = (to.time - from.time) / 3600;
	return distance(from, to) <= maxSpeed * hours + POSITION_SLACK;
}

// Splits an aircraft's day into flights: at each point readsb marked as a
// new leg, and wherever the trace is silent for longer than the gap.
//
// Bad positions are dealt with here too. A point the aircraft could not
// have reached is left out if the trace comes back within the next few
// points. If it does not, the trace has moved for good, and a new flight
// starts there.
export function splitFlights(points: Point[], coverage: Coverage): Point[][] {
	const { gapSeconds, maxSpeed } = coverage;
	const flights: Point[][] = [];
	let current: Point[] = [];
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		const previous = current[current.length - 1];
		if (!previous) {
			current.push(point);
			continue;
		}
		let split = point.newLeg || point.time - previous.time > gapSeconds;
		if (!split && !reachable(previous, point, maxSpeed)) {
			const comesBack = points
				.slice(i + 1, i + 1 + OUTLIER_LOOKAHEAD)
				.some(
					(later) =>
						later.time - previous.time <= gapSeconds &&
						reachable(previous, later, maxSpeed),
				);
			if (comesBack) continue;
			split = true;
		}
		if (split) {
			flights.push(current);
			current = [];
		}
		current.push(point);
	}
	if (current.length > 0) flights.push(current);
	return flights;
}

// From one track to another the short way round, a fraction of the way.
function turnTowards(from: number, to: number, fraction: number): number {
	const turn = ((((to - from + 180) % 360) + 360) % 360) - 180;
	return (((from + turn * fraction) % 360) + 360) % 360;
}

// Rounds to the nearest integer. Adding 0 turns the -0 that Math.round gives
// for small negative numbers into 0.
function round(value: number): number {
	return Math.round(value) + 0;
}

// Puts one flight on the window's grid by interpolating between the points
// either side of each grid time. Returns null if the flight has no grid time
// inside the window.
export function resample(points: Point[], coverage: Coverage): Track | null {
	const { windowStart, windowSeconds, spacing } = coverage;
	const begin = points[0].time - windowStart;
	const end = points[points.length - 1].time - windowStart;
	const first = Math.max(0, Math.ceil(begin / spacing));
	const last = Math.min(
		Math.floor(windowSeconds / spacing),
		Math.floor(end / spacing),
	);
	if (last < first) return null;

	const out: Track = {
		firstSample: first,
		lat: [],
		lon: [],
		altitude: [],
		groundSpeed: [],
		track: [],
		verticalRate: [],
		onGround: [],
	};
	let i = 0;
	for (let index = first; index <= last; index++) {
		const time = windowStart + index * spacing;
		while (i < points.length - 2 && points[i + 1].time <= time) i++;
		const a = points[i];
		const b = points[Math.min(i + 1, points.length - 1)];
		const span = b.time - a.time;
		const f = span > 0 ? Math.min(1, Math.max(0, (time - a.time) / span)) : 0;
		// The nearer point decides what cannot be interpolated.
		const near = f < 0.5 ? a : b;
		out.lat.push(round((a.lat + (b.lat - a.lat) * f) * 1e5));
		out.lon.push(round((a.lon + (b.lon - a.lon) * f) * 1e5));
		out.altitude.push(round((a.altitude + (b.altitude - a.altitude) * f) / 25));
		out.groundSpeed.push(
			round(a.groundSpeed + (b.groundSpeed - a.groundSpeed) * f),
		);
		out.track.push(round(turnTowards(a.track, b.track, f)) % 360);
		out.verticalRate.push(round(near.verticalRate / 64));
		out.onGround.push(near.onGround);
	}
	return out;
}

function slice(track: Track, from: number, to: number): Track {
	return {
		firstSample: track.firstSample + from,
		lat: track.lat.slice(from, to),
		lon: track.lon.slice(from, to),
		altitude: track.altitude.slice(from, to),
		groundSpeed: track.groundSpeed.slice(from, to),
		track: track.track.slice(from, to),
		verticalRate: track.verticalRate.slice(from, to),
		onGround: track.onGround.slice(from, to),
	};
}

// Clips a flight to the coverage area. Each unbroken stretch inside the box
// plus its margin becomes a flight of its own, so one that leaves and comes
// back is two. A stretch that only ever touches the margin is dropped.
export function clip(track: Track, coverage: Coverage): Track[] {
	const { south, west, north, east, margin } = coverage;
	const within = (n: number, extra: number) => {
		const lat = track.lat[n] / 1e5;
		const lon = track.lon[n] / 1e5;
		return (
			lat >= south - extra &&
			lat <= north + extra &&
			lon >= west - extra &&
			lon <= east + extra
		);
	};
	const runs: Track[] = [];
	let start = -1;
	let inBox = false;
	for (let n = 0; n <= track.lat.length; n++) {
		if (n < track.lat.length && within(n, margin)) {
			if (start < 0) start = n;
			inBox ||= within(n, 0);
			continue;
		}
		if (start >= 0 && inBox) runs.push(slice(track, start, n));
		start = -1;
		inBox = false;
	}
	return runs;
}

// Whether a clipped flight is worth keeping: long enough, and airborne at
// some point. Aircraft that only taxi, and ground vehicles, are left out.
export function keep(track: Track, coverage: Coverage): boolean {
	return (
		track.lat.length >= coverage.minSamples && track.onGround.includes(false)
	);
}

// Everything above, for one trace file: the flights it adds to the seed.
// An aircraft with no ICAO24 address (adsb.lol writes those with a leading
// `~`) adds none.
export function bakeAircraft(
	file: TraceFile,
	coverage: Coverage,
): SeedFlight[] {
	if (!/^[0-9a-f]{6}$/.test(file.icao)) return [];
	const flights: SeedFlight[] = [];
	for (const points of splitFlights(readPoints(file), coverage)) {
		const whole = resample(points, coverage);
		if (!whole) continue;
		// The last callsign the flight used; some start before the first
		// message that carries one.
		const callsign = points[points.length - 1].callsign;
		for (const track of clip(whole, coverage)) {
			if (!keep(track, coverage)) continue;
			flights.push({
				icao24: Number.parseInt(file.icao, 16),
				callsign: callsign.slice(0, 8),
				aircraftType: (file.t ?? "").slice(0, 4),
				origin: "",
				destination: "",
				...track,
			});
		}
	}
	return flights;
}

// The order flights take in the seed file, which is also their flight id:
// by first sample, then address, then where they start.
export function compareFlights(a: SeedFlight, b: SeedFlight): number {
	return (
		a.firstSample - b.firstSample ||
		a.icao24 - b.icao24 ||
		a.lat[0] - b.lat[0] ||
		a.lon[0] - b.lon[0]
	);
}
