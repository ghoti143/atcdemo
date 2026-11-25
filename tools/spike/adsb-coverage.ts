// Milestone 2 spike (issue #10): measures what one day of adsb.lol data
// holds for each candidate coverage area. It is a measuring tool, not the
// bake script; the bake script (issue #12) replaces it.
//
// The day's archive must already be joined and unpacked:
//
//   cat v2026.11.20-planes-readsb-prod-0.tar.a? | tar -x -C <dump dir>
//
// One process handles one shard of the 256 trace directories, so several
// can run side by side, and `merge` adds their results together:
//
//   bun tools/spike/adsb-coverage.ts measure <dump dir>/traces <out dir> <shard> <shards>
//   bun tools/spike/adsb-coverage.ts merge <out dir>
//
// For each candidate it counts flights and the peak number airborne for a
// 4, 5 and 6 hour window, and writes the 5 hour window as a real gzipped CSV
// in the proposed seed format, so the file size is measured, not estimated.

import {
	appendFileSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// 2026-11-20 17:00 UTC, which is noon on the US east coast.
const WINDOW_START = Date.UTC(2026, 10, 20, 17, 0, 0) / 1000;
const WINDOW_HOURS = [4, 5, 6];
const CSV_HOURS = 5;
const LONGEST = Math.max(...WINDOW_HOURS) * 3600;

const SPACING = 10;
// A trace with no point for this long is treated as two flights.
const GAP_SECONDS = 600;
// Flights are clipped to the coverage area plus this margin, in degrees.
const MARGIN = 0.5;
// A clipped flight shorter than this is dropped.
const MIN_SAMPLES = 6;

interface Candidate {
	name: string;
	// south, west, north, east; null is the whole sky.
	box: [number, number, number, number] | null;
}

const CANDIDATES: Candidate[] = [
	{ name: "northeast", box: [38, -78, 43.5, -69.5] },
	// A bounding box, so it takes in southern Canada and northern Mexico.
	{ name: "conus", box: [24.4, -125, 49.4, -66.9] },
	{ name: "world", box: null },
];

// One point of a readsb trace, as documented in README-json.md.
type TracePoint = [
	number, // seconds after the file's timestamp
	number, // lat
	number, // lon
	number | "ground" | null, // barometric altitude, ft
	number | null, // ground speed, knots
	number | null, // track, degrees
	number, // flags: 1 stale, 2 new leg, 4 geometric rate, 8 geometric altitude
	number | null, // vertical rate, ft/min
	{ flight?: string } | null,
	...unknown[],
];

interface TraceFile {
	icao: string;
	t?: string;
	timestamp: number;
	trace: TracePoint[];
}

interface Point {
	t: number; // seconds after the window start
	lat: number;
	lon: number;
	alt: number;
	ground: boolean;
	gs: number;
	track: number;
	rate: number;
	callsign: string;
}

interface WindowStats {
	flights: number;
	samples: number;
}

interface CandidateStats {
	windows: WindowStats[];
	// Aircraft airborne at each minute of the longest window.
	airborne: number[];
	groundOnly: number;
	tooShort: number;
	csvBytes: number;
	csvRawBytes: number;
	csvFlights: number;
}

interface Stats {
	files: number;
	compressedBytes: number;
	jsonBytes: number;
	points: number;
	pointsInWindow: number;
	// Seconds between one point and the next, capped at 120.
	intervals: number[];
	sources: Record<string, number>;
	candidates: Record<string, CandidateStats>;
}

function emptyStats(): Stats {
	const candidates: Record<string, CandidateStats> = {};
	for (const c of CANDIDATES) {
		candidates[c.name] = {
			windows: WINDOW_HOURS.map(() => ({ flights: 0, samples: 0 })),
			airborne: new Array(LONGEST / 60).fill(0),
			groundOnly: 0,
			tooShort: 0,
			csvBytes: 0,
			csvRawBytes: 0,
			csvFlights: 0,
		};
	}
	return {
		files: 0,
		compressedBytes: 0,
		jsonBytes: 0,
		points: 0,
		pointsInWindow: 0,
		intervals: new Array(121).fill(0),
		sources: {},
		candidates,
	};
}

function inside(c: Candidate, p: Point): boolean {
	if (!c.box) return true;
	const [south, west, north, east] = c.box;
	return (
		p.lat >= south - MARGIN &&
		p.lat <= north + MARGIN &&
		p.lon >= west - MARGIN &&
		p.lon <= east + MARGIN
	);
}

// Shortest way round from one track to another.
function lerpTrack(a: number, b: number, f: number): number {
	const turn = ((b - a + 540) % 360) - 180;
	return (a + turn * f + 360) % 360;
}

interface Resampled {
	first: number; // index on the 10 s grid of the first sample
	lat: string[];
	lon: string[];
	alt: number[];
	gs: number[];
	track: number[];
	rate: number[];
	ground: boolean[];
}

// Puts one clipped flight on the window's 10 s grid.
function resample(run: Point[]): Resampled | null {
	const first = Math.ceil(run[0].t / SPACING);
	const last = Math.floor(run[run.length - 1].t / SPACING);
	if (last < first) return null;
	const out: Resampled = {
		first,
		lat: [],
		lon: [],
		alt: [],
		gs: [],
		track: [],
		rate: [],
		ground: [],
	};
	let i = 0;
	for (let k = first; k <= last; k++) {
		const t = k * SPACING;
		while (i < run.length - 2 && run[i + 1].t < t) i++;
		const a = run[i];
		const b = run[Math.min(i + 1, run.length - 1)];
		const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
		out.lat.push((a.lat + (b.lat - a.lat) * f).toFixed(5));
		out.lon.push((a.lon + (b.lon - a.lon) * f).toFixed(5));
		out.alt.push(Math.round((a.alt + (b.alt - a.alt) * f) / 25) * 25);
		out.gs.push(Math.round(a.gs + (b.gs - a.gs) * f));
		out.track.push(Math.round(lerpTrack(a.track, b.track, f)) % 360);
		out.rate.push(Math.round(a.rate / 64) * 64);
		out.ground.push(f < 0.5 ? a.ground : b.ground);
	}
	return out;
}

class CsvWriter {
	private pending: string[] = [];
	private pendingBytes = 0;
	constructor(
		private path: string,
		private stats: CandidateStats,
	) {
		writeFileSync(path, "");
	}
	row(line: string) {
		this.pending.push(line);
		this.pendingBytes += line.length;
		this.stats.csvFlights++;
		if (this.pendingBytes > 16 << 20) this.flush();
	}
	// Each flush is its own gzip member; members joined end to end are one
	// valid gzip file.
	flush() {
		if (this.pending.length === 0) return;
		const text = this.pending.join("");
		const packed = gzipSync(text, { level: 9 });
		appendFileSync(this.path, packed);
		this.stats.csvRawBytes += text.length;
		this.stats.csvBytes += packed.length;
		this.pending = [];
		this.pendingBytes = 0;
	}
}

function measure(
	tracesDir: string,
	outDir: string,
	shard: number,
	shards: number,
) {
	const stats = emptyStats();
	const writers = CANDIDATES.map(
		(c) =>
			new CsvWriter(
				join(outDir, `flights-${c.name}-${shard}.csv.gz`),
				stats.candidates[c.name],
			),
	);
	const decoder = new TextDecoder();
	const csvLimit = (CSV_HOURS * 3600) / SPACING;

	const dirs = readdirSync(tracesDir)
		.sort()
		.filter((_, i) => i % shards === shard);
	for (const dir of dirs) {
		for (const name of readdirSync(join(tracesDir, dir))) {
			const packed = readFileSync(join(tracesDir, dir, name));
			const json = Bun.gunzipSync(packed);
			const file = JSON.parse(decoder.decode(json)) as TraceFile;
			stats.files++;
			stats.compressedBytes += packed.length;
			stats.jsonBytes += json.length;
			stats.points += file.trace.length;

			// Split the part of the trace inside the window into flights.
			const flights: Point[][] = [];
			let current: Point[] = [];
			let callsign = "";
			let previous = Number.NaN;
			let gs = 0;
			let track = 0;
			for (const p of file.trace) {
				const flight = p[8]?.flight?.trim();
				if (flight) callsign = flight;
				const t = file.timestamp + p[0] - WINDOW_START;
				const gap = t - previous;
				previous = t;
				if (gap >= 0) stats.intervals[Math.min(120, Math.round(gap))]++;
				if (t < 0 || t > LONGEST) continue;
				stats.pointsInWindow++;
				const source = typeof p[9] === "string" ? p[9] : "unknown";
				stats.sources[source] = (stats.sources[source] ?? 0) + 1;

				if (current.length > 0 && (p[6] & 2 || gap > GAP_SECONDS)) {
					flights.push(current);
					current = [];
				}
				// Speed and track are missing from some points; carry the last.
				if (p[4] !== null) gs = p[4];
				if (p[5] !== null) track = p[5];
				current.push({
					t,
					lat: p[1],
					lon: p[2],
					alt: typeof p[3] === "number" ? p[3] : 0,
					ground: p[3] === "ground",
					gs,
					track,
					rate: p[7] ?? 0,
					callsign,
				});
			}
			if (current.length > 0) flights.push(current);

			for (const flight of flights) {
				CANDIDATES.forEach((candidate, c) => {
					const cs = stats.candidates[candidate.name];
					// Each stretch inside the area is one clipped flight.
					let run: Point[] = [];
					const finish = () => {
						const points = run;
						run = [];
						if (points.length < 2) return;
						const r = resample(points);
						if (!r || r.lat.length < MIN_SAMPLES) {
							cs.tooShort++;
							return;
						}
						if (r.ground.every(Boolean)) {
							cs.groundOnly++;
							return;
						}
						WINDOW_HOURS.forEach((hours, w) => {
							const limit = (hours * 3600) / SPACING;
							if (r.first >= limit) return;
							cs.windows[w].flights++;
							cs.windows[w].samples += Math.min(limit - r.first, r.lat.length);
						});
						for (let n = 0; n < r.lat.length; n++) {
							const k = r.first + n;
							if (k % 6 === 0 && !r.ground[n] && k / 6 < cs.airborne.length) {
								cs.airborne[k / 6]++;
							}
						}
						const keep = Math.min(csvLimit - r.first, r.lat.length);
						if (keep < MIN_SAMPLES) return;
						const name = points.find((p) => p.callsign)?.callsign ?? callsign;
						writers[c].row(
							`${[
								file.icao,
								name,
								file.t ?? "",
								"",
								"",
								r.first * SPACING,
								r.lat.slice(0, keep).join(" "),
								r.lon.slice(0, keep).join(" "),
								r.alt.slice(0, keep).join(" "),
								r.gs.slice(0, keep).join(" "),
								r.track.slice(0, keep).join(" "),
								r.rate.slice(0, keep).join(" "),
								r.ground
									.slice(0, keep)
									.map((g) => (g ? 1 : 0))
									.join(""),
							].join(",")}\n`,
						);
					};
					for (const p of flight) {
						if (inside(candidate, p)) run.push(p);
						else finish();
					}
					finish();
				});
			}
		}
	}
	for (const w of writers) w.flush();
	writeFileSync(join(outDir, `stats-${shard}.json`), JSON.stringify(stats));
}

function merge(outDir: string) {
	const total = emptyStats();
	const add = (into: number[], from: number[]) => {
		from.forEach((v, i) => {
			into[i] += v;
		});
	};
	for (const name of readdirSync(outDir)) {
		if (!/^stats-\d+\.json$/.test(name)) continue;
		const s = JSON.parse(readFileSync(join(outDir, name), "utf8")) as Stats;
		total.files += s.files;
		total.compressedBytes += s.compressedBytes;
		total.jsonBytes += s.jsonBytes;
		total.points += s.points;
		total.pointsInWindow += s.pointsInWindow;
		add(total.intervals, s.intervals);
		for (const [k, v] of Object.entries(s.sources)) {
			total.sources[k] = (total.sources[k] ?? 0) + v;
		}
		for (const c of CANDIDATES) {
			const into = total.candidates[c.name];
			const from = s.candidates[c.name];
			from.windows.forEach((w, i) => {
				into.windows[i].flights += w.flights;
				into.windows[i].samples += w.samples;
			});
			add(into.airborne, from.airborne);
			into.groundOnly += from.groundOnly;
			into.tooShort += from.tooShort;
			into.csvBytes += from.csvBytes;
			into.csvRawBytes += from.csvRawBytes;
			into.csvFlights += from.csvFlights;
		}
	}

	const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
	const gaps = total.intervals.reduce((a, b) => a + b, 0);
	const percentile = (q: number) => {
		let seen = 0;
		return total.intervals.findIndex((n) => {
			seen += n;
			return seen >= gaps * q;
		});
	};
	console.log(`trace files      ${total.files}`);
	console.log(`compressed       ${mb(total.compressedBytes)}`);
	console.log(`as JSON          ${mb(total.jsonBytes)}`);
	console.log(`points, whole day ${total.points}`);
	console.log(
		`points in the ${Math.max(...WINDOW_HOURS)} h window ${total.pointsInWindow}`,
	);
	console.log(
		`seconds between points: median ${percentile(0.5)}, 90th percentile ${percentile(0.9)}`,
	);
	console.log("position sources in the window:");
	for (const [k, v] of Object.entries(total.sources).sort(
		(a, b) => b[1] - a[1],
	)) {
		console.log(
			`  ${k.padEnd(16)} ${((100 * v) / total.pointsInWindow).toFixed(1)}%`,
		);
	}
	for (const c of CANDIDATES) {
		const cs = total.candidates[c.name];
		console.log(`\n${c.name}`);
		WINDOW_HOURS.forEach((hours, w) => {
			const minutes = cs.airborne.slice(0, hours * 60);
			const peak = Math.max(...minutes);
			const mean = minutes.reduce((a, b) => a + b, 0) / minutes.length;
			const { flights, samples } = cs.windows[w];
			const measured = cs.windows[WINDOW_HOURS.indexOf(CSV_HOURS)].samples;
			const bytes = (cs.csvBytes / measured) * samples;
			console.log(
				`  ${hours} h: ${flights} flights, ${samples} samples, airborne peak ${peak} mean ${Math.round(mean)}, ` +
					`${hours === CSV_HOURS ? "measured" : "scaled"} ${mb(bytes)}`,
			);
		});
		console.log(
			`  ${CSV_HOURS} h file: ${cs.csvFlights} rows, ${mb(cs.csvBytes)} gzipped, ${mb(cs.csvRawBytes)} as text`,
		);
		console.log(
			`  dropped: ${cs.groundOnly} never left the ground, ${cs.tooShort} under ${MIN_SAMPLES * SPACING} s`,
		);
	}
	writeFileSync(join(outDir, "total.json"), JSON.stringify(total));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "measure" && args.length === 4) {
	if (!statSync(args[0]).isDirectory())
		throw new Error(`${args[0]} is not a directory`);
	measure(args[0], args[1], Number(args[2]), Number(args[3]));
} else if (mode === "merge" && args.length === 1) {
	merge(args[0]);
} else {
	console.error(
		"usage: adsb-coverage.ts measure <traces dir> <out dir> <shard> <shards>\n" +
			"       adsb-coverage.ts merge <out dir>",
	);
	process.exit(1);
}
