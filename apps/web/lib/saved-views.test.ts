import { describe, expect, test } from "bun:test";
import {
	createViewSchema,
	DEFAULT_CAMERA,
	readStoredView,
	updateViewSchema,
	type ViewData,
	viewParamsSchema,
} from "@/lib/api/views-shapes";
import { createInterfaceStore } from "@/lib/interface-store";
import { applyView, captureView } from "@/lib/saved-views";

const view = (): ViewData => ({
	camera: { longitude: -73.8, latitude: 40.6, zoom: 9, pitch: 50, bearing: 30 },
	viewMode: "3d",
	filters: { text: "UAL" },
});

describe("capturing and applying a view", () => {
	test("there is nothing to capture before the map reports its camera", () => {
		expect(captureView(createInterfaceStore())).toBeNull();
	});

	test("a captured view holds the camera, the mode and the filter", () => {
		const store = createInterfaceStore();
		store.getState().setCamera(view().camera);
		store.getState().setViewMode("3d");
		store.getState().setFilters({ text: "UAL" });
		expect(captureView(store)).toEqual(view());
	});

	test("applying a view asks the map to move and sets the rest", () => {
		const store = createInterfaceStore();
		applyView(store, view());
		const state = store.getState();
		expect(state.cameraTarget?.camera).toEqual(view().camera);
		expect(state.viewMode).toBe("3d");
		expect(state.filters.text).toBe("UAL");
	});

	test("applying the same view twice is two requests to move", () => {
		const store = createInterfaceStore();
		applyView(store, view());
		const first = store.getState().cameraTarget?.request;
		applyView(store, view());
		expect(store.getState().cameraTarget?.request).not.toBe(first);
	});
});

describe("the shapes of a saved view", () => {
	test("a name is trimmed, and must not be empty or too long", () => {
		expect(createViewSchema.parse({ name: "  JFK  ", view: view() }).name).toBe(
			"JFK",
		);
		expect(
			createViewSchema.safeParse({ name: "   ", view: view() }).success,
		).toBe(false);
		expect(
			createViewSchema.safeParse({ name: "x".repeat(61), view: view() })
				.success,
		).toBe(false);
	});

	test("a view with an unknown part or a camera out of range is refused", () => {
		const extra = { ...view(), owner: "someone" };
		expect(createViewSchema.safeParse({ name: "a", view: extra }).success).toBe(
			false,
		);
		const far = { ...view(), camera: { ...view().camera, latitude: 91 } };
		expect(createViewSchema.safeParse({ name: "a", view: far }).success).toBe(
			false,
		);
	});

	test("an update needs a name or a view", () => {
		expect(updateViewSchema.safeParse({}).success).toBe(false);
		expect(updateViewSchema.safeParse({ name: "b" }).success).toBe(true);
		expect(updateViewSchema.safeParse({ view: view() }).success).toBe(true);
	});

	test("an id is digits only", () => {
		expect(viewParamsSchema.parse({ id: "12" }).id).toBe(12);
		for (const id of ["0", "-1", "1.5", "abc", "1 OR 1=1", ""]) {
			expect(viewParamsSchema.safeParse({ id }).success).toBe(false);
		}
	});

	test("what is stored is read whatever it is", () => {
		expect(readStoredView(view())).toEqual(view());
		expect(readStoredView(null)).toEqual({
			camera: DEFAULT_CAMERA,
			viewMode: "2d",
			filters: { text: "" },
		});
		const odd = readStoredView({
			camera: { longitude: -80, latitude: 500, zoom: "9" },
			viewMode: "4d",
			filters: { text: 7 },
			later: true,
		});
		expect(odd.camera.longitude).toBe(-80);
		expect(odd.camera.latitude).toBe(DEFAULT_CAMERA.latitude);
		expect(odd.camera.zoom).toBe(DEFAULT_CAMERA.zoom);
		expect(odd.viewMode).toBe("2d");
		expect(odd.filters.text).toBe("");
		expect("later" in odd).toBe(false);
	});
});
