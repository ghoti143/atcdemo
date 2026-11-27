import { describe, expect, test } from "bun:test";
import { createInterfaceStore } from "@/lib/interface-store";
import { createMapHover } from "@/lib/map-hover";

describe("the map's hover", () => {
	test("a pick hovers an aircraft and a pick of nothing clears it", () => {
		const store = createInterfaceStore();
		const pick = createMapHover(store);
		pick(7);
		expect(store.getState().hoveredId).toBe(7);
		pick(9);
		expect(store.getState().hoveredId).toBe(9);
		pick(null);
		expect(store.getState().hoveredId).toBeNull();
	});

	test("the late pick of nothing does not clear a hover a row has set", () => {
		const store = createInterfaceStore();
		const pick = createMapHover(store);
		// The pointer was over the empty map, then entered a row; the map's
		// pick for its having left comes a frame later.
		pick(null);
		store.getState().hover(42);
		pick(null);
		expect(store.getState().hoveredId).toBe(42);
	});

	test("nor when the pointer came to the row from an aircraft on the map", () => {
		const store = createInterfaceStore();
		const pick = createMapHover(store);
		pick(7);
		store.getState().hover(42);
		pick(null);
		expect(store.getState().hoveredId).toBe(42);
	});

	test("nor when the row is the aircraft the map hovered a while ago", () => {
		const store = createInterfaceStore();
		const pick = createMapHover(store);
		pick(7);
		pick(null);
		store.getState().hover(7);
		pick(null);
		expect(store.getState().hoveredId).toBe(7);
	});

	test("back on the map, a pick takes the hover from the row", () => {
		const store = createInterfaceStore();
		const pick = createMapHover(store);
		store.getState().hover(42);
		pick(7);
		expect(store.getState().hoveredId).toBe(7);
		pick(null);
		expect(store.getState().hoveredId).toBeNull();
	});
});
