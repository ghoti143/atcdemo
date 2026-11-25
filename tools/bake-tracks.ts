// Bakes one day of adsb.lol data into the seed file, and prints seed files
// as text.
//
//   bun run bake:tracks <dump dir> [out file]
//   bun run bake:tracks dump <seed file> [flight id]
//
// <dump dir> is the day's archive, joined and unpacked:
//
//   cat v2026.11.20-planes-readsb-prod-0.tar.a? | tar -x -C <dump dir>
//
// The day, window and coverage area are fixed in tools/seed/tracks.ts, so
// the same dump always gives the same file. The work is split across one
// process per core; each reads a share of the 256 trace directories.

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode, type Seed, type SeedFlight } from "./seed/format";
import {
	bakeAircraft,
	COVERAGE,
	compareFlights,
	type TraceFile,
} from "./seed/tracks";

const DEFAULT_OUT = join(import.meta.dir, "../data/seed/flights.bin.gz");
// The most the seed file may be and still be committed.
const SIZE_LIMIT = 50_000_000;

export function seedOf(flights: SeedFlight[]): Seed {
	return {
		windowStart: COVERAGE.windowStart,
		windowSeconds: COVERAGE.windowSeconds,
		spacing: COVERAGE.spacing,
		flights: flights.sort(compareFlights),
	};
}

// Bakes the trace directories whose position in the sorted list is `share`
// modulo `shares`.
export function bakeShare(
	tracesDir: string,
	share: number,
	shares: number,
): SeedFlight[] {
	const decoder = new TextDecoder();
	const flights: SeedFlight[] = [];
	const dirs = readdirSync(tracesDir)
		.sort()
		.filter((_, i) => i % shares === share);
	for (const dir of dirs) {
		for (const name of readdirSync(join(tracesDir, dir)).sort()) {
			// The files are gzip-compressed, whatever their name says.
			const packed = readFileSync(join(tracesDir, dir, name));
			const file = JSON.parse(
				decoder.decode(Bun.gunzipSync(packed)),
			) as TraceFile;
			flights.push(...bakeAircraft(file, COVERAGE));
		}
	}
	return flights;
}

async function bake(dumpDir: string, out: string) {
	const tracesDir = join(dumpDir, "traces");
	const shares = availableParallelism();
	const parts = Array.from({ length: shares }, (_, i) =>
		join(tmpdir(), `bake-tracks-${process.pid}-${i}.bin.gz`),
	);
	console.log(`reading ${tracesDir} in ${shares} processes`);
	const children = parts.map((part, i) =>
		Bun.spawn(
			["bun", import.meta.path, "share", tracesDir, `${i}`, `${shares}`, part],
			{ stdout: "inherit", stderr: "inherit" },
		),
	);
	const codes = await Promise.all(children.map((child) => child.exited));
	if (codes.some((code) => code !== 0)) {
		throw new Error("a share of the bake failed");
	}

	const flights: SeedFlight[] = [];
	for (const part of parts) {
		flights.push(...decode(readFileSync(part)).flights);
		rmSync(part);
	}
	if (flights.length === 0) throw new Error(`no flights found in ${tracesDir}`);
	const seed = seedOf(flights);
	const file = encode(seed);
	const samples = seed.flights.reduce((sum, f) => sum + f.lat.length, 0);
	console.log(
		`${seed.flights.length} flights, ${samples} samples, ${(file.length / 1e6).toFixed(1)} MB`,
	);
	if (file.length > SIZE_LIMIT) {
		throw new Error(
			`the seed file would be ${file.length} bytes, over the ${SIZE_LIMIT} byte limit`,
		);
	}
	writeFileSync(out, file);
	console.log(`wrote ${out}`);
}

function dump(path: string, flightId?: number) {
	const seed = decode(readFileSync(path));
	const start = new Date(seed.windowStart * 1000).toISOString();
	if (flightId === undefined) {
		console.log(
			`window ${start}, ${seed.windowSeconds} s, ${seed.spacing} s spacing, ${seed.flights.length} flights`,
		);
		console.log("id,icao24,callsign,type,origin,destination,start_s,samples");
		seed.flights.forEach((f, id) => {
			console.log(
				[
					id,
					f.icao24.toString(16).padStart(6, "0"),
					f.callsign,
					f.aircraftType,
					f.origin,
					f.destination,
					f.firstSample * seed.spacing,
					f.lat.length,
				].join(","),
			);
		});
		return;
	}
	const f = seed.flights[flightId];
	if (!f) throw new Error(`no flight ${flightId} in ${path}`);
	console.log(
		`flight ${flightId}: ${f.icao24.toString(16).padStart(6, "0")} ${f.callsign} ${f.aircraftType}`,
	);
	console.log(
		"time_s,lat,lon,altitude_ft,ground_speed_kt,track_deg,vertical_rate_fpm,on_ground",
	);
	f.lat.forEach((_, n) => {
		console.log(
			[
				(f.firstSample + n) * seed.spacing,
				(f.lat[n] / 1e5).toFixed(5),
				(f.lon[n] / 1e5).toFixed(5),
				f.altitude[n] * 25,
				f.groundSpeed[n],
				f.track[n],
				f.verticalRate[n] * 64,
				f.onGround[n] ? 1 : 0,
			].join(","),
		);
	});
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "dump" && (args.length === 2 || args.length === 3)) {
		dump(args[1], args[2] === undefined ? undefined : Number(args[2]));
	} else if (args[0] === "share" && args.length === 5) {
		// One process of a bake; see `bake`.
		const flights = bakeShare(args[1], Number(args[2]), Number(args[3]));
		writeFileSync(args[4], encode(seedOf(flights)));
	} else if (args.length >= 1 && args.length <= 2 && args[0] !== "dump") {
		await bake(args[0], args[1] ?? DEFAULT_OUT);
	} else {
		console.error(
			"usage: bun run bake:tracks <dump dir> [out file]\n" +
				"       bun run bake:tracks dump <seed file> [flight id]",
		);
		process.exit(1);
	}
}
