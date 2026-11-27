import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AIRSPACE_FILES,
	type ShelfCollection,
	shelfVolumes,
} from "@/lib/airspace";
import { altitudeScaleFor } from "@/lib/view-mode";

const shelf = (
	floorFt: number,
	ceilingFt: number,
	coordinates: number[][][],
): ShelfCollection["features"][number] => ({
	type: "Feature",
	properties: {
		id: `shelf-${floorFt}`,
		ident: "BOS",
		name: "BOSTON CLASS B",
		sector: "AREA A",
		floorFt,
		floorRef: floorFt === 0 ? "SFC" : "MSL",
		ceilingFt,
		exclusion: false,
	},
	geometry: { type: "Polygon", coordinates },
});
const square = [
	[
		[-71, 42],
		[-70, 42],
		[-70, 43],
		[-71, 43],
		[-71, 42],
	],
];
const sample = (): ShelfCollection => ({
	type: "FeatureCollection",
	features: [shelf(0, 7_000, square), shelf(3_000, 7_000, square)],
});

describe("the shelves as volumes", () => {
	test("in 2D every shelf lies flat", () => {
		for (const volume of shelfVolumes(sample(), altitudeScaleFor("2d", 5))) {
			expect(volume.thickness).toBe(0);
			for (const [, , z] of volume.polygon[0]) expect(z).toBe(0);
		}
	});

	test("in 3D a floor and a ceiling are where an aircraft at that height is drawn", () => {
		const scale = altitudeScaleFor("3d", 1);
		const [surface, raised] = shelfVolumes(sample(), scale);
		expect(surface.polygon[0][0]).toEqual([-71, 42, 0]);
		expect(surface.thickness).toBeCloseTo(7_000 * 0.3048, 6);
		// 3,000 ft is 914.4 m; the store writes an aircraft's height as feet
		// times the same scale.
		expect(raised.polygon[0][2][2]).toBeCloseTo(3_000 * scale, 6);
		expect(raised.polygon[0][2][2]).toBeCloseTo(914.4, 6);
		expect(raised.polygon[0][0][2] + raised.thickness).toBeCloseTo(
			7_000 * scale,
			6,
		);
	});

	test("the exaggeration stretches floors and ceilings by the same factor", () => {
		const [, once] = shelfVolumes(sample(), altitudeScaleFor("3d", 1));
		const [, tenfold] = shelfVolumes(sample(), altitudeScaleFor("3d", 10));
		expect(tenfold.polygon[0][0][2]).toBeCloseTo(once.polygon[0][0][2] * 10, 6);
		expect(tenfold.thickness).toBeCloseTo(once.thickness * 10, 6);
	});

	test("a shelf in several pieces is a volume a piece, with ids of their own", () => {
		const collection = sample();
		collection.features[0].geometry = {
			type: "MultiPolygon",
			coordinates: [square, square],
		};
		const volumes = shelfVolumes(collection, 1);
		expect(volumes.map((volume) => volume.id)).toEqual([
			"shelf-0-0",
			"shelf-0-1",
			"shelf-3000",
		]);
	});
});

describe("the baked Class B file, as the map will draw it", () => {
	const baked = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"../../../data/airspace",
				AIRSPACE_FILES["class-b"],
			),
			"utf8",
		),
	) as ShelfCollection;

	test("every one of the 359 shelves is a volume with its ceiling above its floor", () => {
		const volumes = shelfVolumes(baked, altitudeScaleFor("3d", 1));
		expect(volumes).toHaveLength(359);
		for (const volume of volumes) {
			expect(volume.thickness).toBeGreaterThan(0);
			expect(volume.polygon[0].length).toBeGreaterThanOrEqual(4);
		}
		expect(new Set(volumes.map((volume) => volume.id)).size).toBe(359);
	});

	test("all 29 areas are there", () => {
		expect(
			new Set(baked.features.map((feature) => feature.properties.ident)).size,
		).toBe(29);
	});
});
