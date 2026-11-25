import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bakeShare, seedOf } from "./bake-tracks";
import { decode } from "./seed/format";
import { COVERAGE } from "./seed/tracks";

const sample = join(import.meta.dir, "../data/sample");

// The committed sample seed is what the bake makes of the committed sample
// traces. If the bake's rules change, re-bake it:
//   bun run bake:tracks data/sample/adsb-2026-11-20 data/sample/flights.bin.gz
test("baking the sample traces gives the committed sample seed", () => {
	const traces = join(sample, "adsb-2026-11-20/traces");
	const baked = seedOf([
		...bakeShare(traces, 0, 2),
		...bakeShare(traces, 1, 2),
	]);
	const committed = decode(readFileSync(join(sample, "flights.bin.gz")));
	expect(baked).toEqual(committed);
});

test("the sample seed holds real flights inside the window", () => {
	const seed = decode(readFileSync(join(sample, "flights.bin.gz")));
	expect(seed.windowStart).toBe(Date.UTC(2026, 10, 20, 17) / 1000);
	expect(seed.windowSeconds).toBe(4 * 3600);
	expect(seed.spacing).toBe(10);
	expect(seed.flights).toHaveLength(39);

	const lastIndex = seed.windowSeconds / seed.spacing;
	for (const f of seed.flights) {
		expect(f.callsign).not.toBe("");
		expect(f.firstSample + f.lat.length - 1).toBeLessThanOrEqual(lastIndex);
		expect(f.lat.length).toBeGreaterThanOrEqual(COVERAGE.minSamples);
		expect(f.onGround).toContain(false);
		for (let n = 0; n < f.lat.length; n++) {
			const lat = f.lat[n] / 1e5;
			const lon = f.lon[n] / 1e5;
			expect(lat).toBeGreaterThanOrEqual(COVERAGE.south - COVERAGE.margin);
			expect(lat).toBeLessThanOrEqual(COVERAGE.north + COVERAGE.margin);
			expect(lon).toBeGreaterThanOrEqual(COVERAGE.west - COVERAGE.margin);
			expect(lon).toBeLessThanOrEqual(COVERAGE.east + COVERAGE.margin);
		}
	}
	// Flights are in the order that gives them their ids.
	const starts = seed.flights.map((f) => f.firstSample);
	expect(starts).toEqual([...starts].sort((a, b) => a - b));
});
