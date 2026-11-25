import { expect, test } from "bun:test";
import { geoidHeightFeet } from "./geoid";

// EGM96 values from the full model, in metres, turned into feet.
test("the geoid is where EGM96 puts it", () => {
	const places: [string, number, number, number][] = [
		["Teterboro", 40.85, -74.06, -32.66],
		["Boston", 42.36, -71.01, -28.49],
		["Denver", 39.86, -104.67, -18.34],
		["Salt Lake City", 40.79, -111.98, -17.07],
		["Miami", 25.79, -80.29, -27.31],
		["Seattle", 47.45, -122.31, -22.18],
	];
	for (const [name, lat, lon, metres] of places) {
		const feet = geoidHeightFeet(lat, lon);
		// Within 1.1 m, the grid's stated accuracy.
		expect(Math.abs(feet - metres / 0.3048), name).toBeLessThan(3.7);
	}
});

test("a grid point is returned exactly, and outside the grid the edge is used", () => {
	// 23°N 127°W is the grid's first point.
	const corner = geoidHeightFeet(23, -127);
	expect(geoidHeightFeet(10, -140)).toBe(corner);
	expect(geoidHeightFeet(23, -150)).toBe(corner);
	expect(Number.isFinite(geoidHeightFeet(60, -60))).toBe(true);
	expect(geoidHeightFeet(60, -60)).toBe(geoidHeightFeet(51, -65));
});
