import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Baked,
	bakeArtcc,
	bakeClassB,
	type CentreProperties,
	COVERAGE_BOX,
	countVertices,
	type RawCollection,
	type RawFeature,
	type ShelfProperties,
	serialize,
	THIN_TOLERANCE_DEG,
	thinLine,
	thinRing,
} from "./airspace/bake";

const root = join(import.meta.dir, "..");
const json = <T>(path: string) =>
	JSON.parse(readFileSync(join(root, path), "utf8")) as T;

const sampleClassB = () =>
	json<RawCollection>("data/sample/airspace/class-b.geojson");
const sampleArtcc = () =>
	json<RawCollection>("data/sample/airspace/artcc.geojson");

describe("thinning", () => {
	test("a straight line keeps its ends only", () => {
		const line: [number, number][] = [
			[0, 0],
			[1, 0.00001],
			[2, 0],
			[3, -0.00001],
			[4, 0],
		];
		expect(thinLine(line, THIN_TOLERANCE_DEG)).toEqual([
			[0, 0],
			[4, 0],
		]);
	});

	test("a corner farther off than the tolerance is kept", () => {
		const line: [number, number][] = [
			[0, 0],
			[1, 0.001],
			[2, 0],
		];
		expect(thinLine(line, THIN_TOLERANCE_DEG)).toEqual(line);
	});

	test("a circle of 3,600 points keeps its shape to the tolerance", () => {
		const ring: [number, number][] = [];
		for (let i = 0; i < 3_600; i++) {
			const angle = (i / 3_600) * 2 * Math.PI;
			ring.push([-71 + 0.3 * Math.cos(angle), 42 + 0.3 * Math.sin(angle)]);
		}
		ring.push(ring[0]);
		const thinned = thinRing(ring);
		expect(thinned.length).toBeLessThan(200);
		expect(thinned.length).toBeGreaterThan(30);
		expect(thinned[thinned.length - 1]).toEqual(thinned[0]);
		// Every kept point is still on the circle, to the rounding.
		for (const [x, y] of thinned) {
			expect(Math.hypot(x + 71, y - 42)).toBeCloseTo(0.3, 4);
		}
		// And no chord between kept points cuts in by more than the tolerance.
		for (let i = 1; i < thinned.length; i++) {
			const middle = [
				(thinned[i][0] + thinned[i - 1][0]) / 2,
				(thinned[i][1] + thinned[i - 1][1]) / 2,
			];
			const inside = 0.3 - Math.hypot(middle[0] + 71, middle[1] - 42);
			expect(inside).toBeLessThan(THIN_TOLERANCE_DEG + 0.00002);
		}
	});

	test("a ring is never left with fewer than four positions", () => {
		const sliver: [number, number][] = [
			[0, 0],
			[0.00001, 0],
			[0.00001, 0.00001],
			[0, 0],
		];
		expect(thinRing(sliver)).toHaveLength(4);
	});
});

describe("baking the sample", () => {
	test("each Class B row becomes a shelf with its floor and ceiling", () => {
		const baked = bakeClassB(sampleClassB());
		expect(baked.features).toHaveLength(47);
		const surface = baked.features.find(
			(f) => f.properties.ident === "BOS" && f.properties.sector === "AREA A",
		);
		expect(surface?.properties).toMatchObject({
			name: "BOSTON CLASS B",
			floorFt: 0,
			floorRef: "SFC",
			ceilingFt: 7_000,
			exclusion: false,
		});
		for (const { properties } of baked.features) {
			expect(properties.floorFt).toBeLessThan(properties.ceilingFt);
		}
		expect(countVertices(baked)).toBeLessThan(
			countVertices(sampleClassB()) / 4,
		);
	});

	test("each ARTCC row is marked high or low", () => {
		const baked = bakeArtcc(sampleArtcc());
		expect(baked.features).toHaveLength(9);
		const ny = baked.features.filter((f) => f.properties.ident === "ZNY");
		expect(ny.map((f) => f.properties.level).sort()).toEqual([
			"high",
			"high",
			"low",
		]);
	});

	test("the same input gives the same bytes, whatever order the rows come in", () => {
		const once = serialize(bakeClassB(sampleClassB()));
		const turned = sampleClassB();
		turned.features.reverse();
		expect(serialize(bakeClassB(turned))).toBe(once);
	});
});

describe("rows the bake refuses", () => {
	const row = (change: Record<string, unknown>): RawCollection => {
		const feature: RawFeature = structuredClone(sampleClassB().features[0]);
		Object.assign(feature.properties, change);
		return { type: "FeatureCollection", features: [feature] };
	};

	test("a height that is not given", () => {
		expect(() => bakeClassB(row({ UPPER_VAL: -9998 }))).toThrow("not given");
		expect(() => bakeClassB(row({ LOWER_VAL: null }))).toThrow("not given");
	});

	test("a unit other than feet, and a reference it does not know", () => {
		expect(() => bakeClassB(row({ UPPER_UOM: "FL" }))).toThrow("not FT");
		expect(() => bakeClassB(row({ UPPER_CODE: "STD" }))).toThrow("not handled");
		// Height above ground: a value above 0 measured from the surface.
		expect(() =>
			bakeClassB(row({ LOWER_VAL: 700, LOWER_CODE: "SFC" })),
		).toThrow("not handled");
	});

	test("a floor that is not below its ceiling", () => {
		expect(() =>
			bakeClassB(row({ LOWER_VAL: 7_000, LOWER_CODE: "MSL" })),
		).toThrow("not below");
	});

	test("a row that is not Class B, or not an ARTCC boundary", () => {
		expect(() => bakeClassB(row({ LOCAL_TYPE: "CLASS_C" }))).toThrow(
			"not a Class B row",
		);
		expect(() => bakeArtcc(sampleClassB())).toThrow("not an ARTCC boundary");
	});
});

describe("the committed files", () => {
	const classB = json<Baked<ShelfProperties>>("data/airspace/class-b.geojson");
	const artcc = json<Baked<CentreProperties>>("data/airspace/artcc.geojson");

	test("every shelf has a floor below its ceiling, in feet we can draw", () => {
		expect(classB.features).toHaveLength(359);
		for (const { properties } of classB.features) {
			expect(properties.floorFt).toBeLessThan(properties.ceilingFt);
			expect(properties.floorFt).toBeGreaterThanOrEqual(0);
			expect(properties.ceilingFt).toBeLessThanOrEqual(12_500);
			expect(properties.floorRef === "SFC").toBe(properties.floorFt === 0);
		}
	});

	test("the 29 Class B areas of the coverage area are there, and Honolulu is not", () => {
		const areas = new Set(classB.features.map((f) => f.properties.ident));
		expect(areas.size).toBe(29);
		expect(areas.has("HNL")).toBe(false);
		for (const ident of ["BOS", "JFK", "ORD", "LAX", "SAN", "SEA", "MIA"]) {
			expect(areas.has(ident)).toBe(true);
		}
	});

	test("the only exclusion rows are San Diego's four", () => {
		const cut = classB.features.filter((f) => f.properties.exclusion);
		expect(cut).toHaveLength(4);
		for (const { properties } of cut) {
			expect(properties.ident).toBe("SAN");
			expect(properties.sector).toBe("VFR CORRIDOR EXCLUSION");
		}
	});

	test("20 centres, each with a high and a low boundary", () => {
		expect(artcc.features).toHaveLength(41);
		const centres = new Set(artcc.features.map((f) => f.properties.ident));
		expect(centres.size).toBe(20);
		expect(centres.has("ZAN")).toBe(false);
		for (const ident of centres) {
			const levels = artcc.features
				.filter((f) => f.properties.ident === ident)
				.map((f) => f.properties.level);
			expect(levels).toContain("high");
			expect(levels).toContain("low");
		}
	});

	test("every ring is closed, has four positions or more, and every shelf touches the coverage box", () => {
		const [west, south, east, north] = COVERAGE_BOX;
		for (const collection of [classB, artcc]) {
			for (const { geometry } of collection.features) {
				const polygons =
					geometry.type === "Polygon"
						? [geometry.coordinates]
						: geometry.coordinates;
				for (const ring of polygons.flat()) {
					expect(ring.length).toBeGreaterThanOrEqual(4);
					expect(ring[ring.length - 1]).toEqual(ring[0]);
				}
			}
		}
		for (const { geometry } of classB.features) {
			const ring =
				geometry.type === "Polygon"
					? geometry.coordinates[0]
					: geometry.coordinates[0][0];
			const inside = ring.some(
				([x, y]) => x >= west && x <= east && y >= south && y <= north,
			);
			expect(inside).toBe(true);
		}
	});

	test("are small enough for a browser to load", () => {
		const size = (file: string) =>
			readFileSync(join(root, "data/airspace", file)).length;
		expect(size("class-b.geojson")).toBeLessThan(600_000);
		expect(size("artcc.geojson")).toBeLessThan(100_000);
	});

	test("are written as the bake writes them", () => {
		expect(
			readFileSync(join(root, "data/airspace/class-b.geojson"), "utf8"),
		).toBe(serialize(classB));
	});
});
