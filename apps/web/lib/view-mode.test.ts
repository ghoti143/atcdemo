import { describe, expect, test } from "bun:test";
import { createInterfaceStore } from "@/lib/interface-store";
import { applyView } from "@/lib/saved-views";
import {
	altitudeScaleFor,
	hillshadeBefore,
	MAX_PITCH,
	MODELS_MIN_ZOOM,
	modelsShownAt,
	PITCH_3D,
	TERRAIN_SOURCE,
} from "@/lib/view-mode";

describe("the altitude scale", () => {
	test("in 2D the picture lies flat, whatever the exaggeration", () => {
		expect(altitudeScaleFor("2d", 1)).toBe(0);
		expect(altitudeScaleFor("2d", 12)).toBe(0);
	});

	test("in 3D it is metres a foot, times the exaggeration", () => {
		expect(altitudeScaleFor("3d", 1)).toBeCloseTo(0.3048, 10);
		expect(altitudeScaleFor("3d", 10)).toBeCloseTo(3.048, 10);
		// 35,000 ft at ×5 is drawn 53.34 km up.
		expect(35_000 * altitudeScaleFor("3d", 5)).toBeCloseTo(53_340, 6);
	});
});

describe("the terrain source", () => {
	test("is Mapterhorn's tiles as its TileJSON describes them, with its credit", () => {
		expect(TERRAIN_SOURCE.type).toBe("raster-dem");
		expect(TERRAIN_SOURCE.encoding).toBe("terrarium");
		expect(TERRAIN_SOURCE.tileSize).toBe(512);
		expect(TERRAIN_SOURCE.tiles[0]).toBe(
			"https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
		);
		expect(TERRAIN_SOURCE.attribution).toContain("Mapterhorn");
		expect(TERRAIN_SOURCE.attribution).toContain(
			"https://mapterhorn.com/attribution",
		);
	});
});

describe("a saved view in 3D", () => {
	test("sets the mode before it asks for the camera, so the view's pitch is where the map ends", () => {
		const store = createInterfaceStore();
		const order: string[] = [];
		store.subscribe((state, before) => {
			if (state.viewMode !== before.viewMode) order.push("mode");
			if (state.cameraTarget !== before.cameraTarget) order.push("camera");
		});
		applyView(store, {
			camera: {
				longitude: -105,
				latitude: 39.7,
				zoom: 8,
				pitch: 62,
				bearing: 20,
			},
			viewMode: "3d",
			filters: { text: "" },
		});
		expect(order).toEqual(["mode", "camera"]);
		expect(store.getState().cameraTarget?.camera.pitch).toBe(62);
	});
});

describe("the hillshade", () => {
	test("goes under the style's first line layer, or on top when there is none", () => {
		expect(
			hillshadeBefore([
				{ id: "background", type: "background" },
				{ id: "water", type: "fill" },
				{ id: "boundary", type: "line" },
				{ id: "road", type: "line" },
			]),
		).toBe("boundary");
		expect(hillshadeBefore([{ id: "water", type: "fill" }])).toBeUndefined();
	});
});

describe("the camera's pitch", () => {
	test("may go past where 3D puts it, far enough to see the sky, and no farther than MapLibre allows", () => {
		expect(MAX_PITCH).toBeGreaterThan(PITCH_3D);
		expect(MAX_PITCH).toBeGreaterThan(60);
		expect(MAX_PITCH).toBeLessThanOrEqual(85);
	});
});

describe("icons or models", () => {
	test("models in 3D from the threshold in, icons otherwise", () => {
		expect(modelsShownAt("3d", MODELS_MIN_ZOOM)).toBe(true);
		expect(modelsShownAt("3d", 14)).toBe(true);
		expect(modelsShownAt("3d", MODELS_MIN_ZOOM - 0.01)).toBe(false);
		expect(modelsShownAt("2d", 14)).toBe(false);
	});
});
