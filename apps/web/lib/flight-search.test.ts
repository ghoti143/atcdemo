import { describe, expect, test } from "bun:test";
import type {
	Flight,
	FlightDetail,
	FlightTrack,
} from "@/lib/api/flights-shapes";
import {
	cleanSearch,
	formatRoute,
	formatSeen,
	selectFlying,
	showFlight,
	trackBounds,
	trackPositions,
} from "@/lib/flight-search";
import { createInterfaceStore } from "@/lib/interface-store";

const flight = (over: Partial<Flight> = {}): Flight => ({
	id: 12,
	aircraftId: 700,
	icao24: "a1b2c3",
	callsign: "UAL123",
	aircraftType: "B738",
	origin: "KORD",
	destination: "KDEN",
	pass: 0,
	firstSeenAt: "2026-11-27T01:00:00.000Z",
	lastSeenAt: "2026-11-27T03:00:00.000Z",
	firstSeenSimS: 100,
	lastSeenSimS: 7_300,
	flying: false,
	...over,
});

const track = (points: [number, number, number][]): FlightTrack => ({
	timesS: points.map((_, i) => 100 + i * 5),
	lon: points.map(([lon]) => lon),
	lat: points.map(([, lat]) => lat),
	altitudeFt: points.map(([, , feet]) => feet),
	barometricFt: points.map(([, , feet]) => feet),
	groundSpeedKt: points.map(() => 400),
	trackDeg: points.map(() => 270),
	verticalRateFpm: points.map(() => 0),
	onGround: points.map(() => false),
});

const flown = track([
	[-87.9, 41.9, 700],
	[-95.5, 41.25, 36_000],
	[-104.7, 39.8, 5_400],
]);

describe("what is typed", () => {
	test("is cleaned to what a callsign can hold", () => {
		expect(cleanSearch(" ual 12 ")).toBe("UAL12");
		expect(cleanSearch("n123-ab!")).toBe("N123AB");
		expect(cleanSearch("%_';--")).toBe("");
		expect(cleanSearch("ABCDEFGHIJ")).toBe("ABCDEFGH");
	});
});

describe("what a result says", () => {
	test("the route, with a dash for an end that is not known", () => {
		expect(formatRoute(flight())).toBe("KORD → KDEN");
		expect(formatRoute(flight({ origin: null }))).toBe("— → KDEN");
	});

	test("flying, or how long ago it ended", () => {
		const ended = Date.parse("2026-11-27T03:00:00.000Z");
		expect(formatSeen(flight({ flying: true, lastSeenAt: null }), ended)).toBe(
			"Flying",
		);
		expect(formatSeen(flight(), ended + 20_000)).toBe("Ended just now");
		expect(formatSeen(flight(), ended + 12 * 60_000)).toBe("Ended 12 min ago");
		expect(formatSeen(flight(), ended + 135 * 60_000)).toBe(
			"Ended 2 h 15 min ago",
		);
		// A clock behind the server's does not show a time to come.
		expect(formatSeen(flight(), ended - 60_000)).toBe("Ended just now");
	});
});

describe("a recorded track for the map", () => {
	test("is lon, lat and feet for each point, oldest first", () => {
		const positions = trackPositions(flown);
		expect(positions).toHaveLength(9);
		expect(positions[0]).toBeCloseTo(-87.9, 4);
		expect(positions[4]).toBeCloseTo(41.25, 4);
		expect(positions[8]).toBe(5_400);
	});

	test("lies in a box, and a track of nothing lies in none", () => {
		expect(trackBounds(flown)).toEqual([-104.7, 39.8, -87.9, 41.9]);
		expect(trackBounds(track([]))).toBeNull();
	});
});

describe("choosing a flight", () => {
	const detail = (over: Partial<Flight>, points = flown): FlightDetail => ({
		flight: flight(over),
		track: points,
	});

	test("one that has finished: its track is drawn, shown whole, and nothing is selected", () => {
		const store = createInterfaceStore();
		store.getState().select(55);
		showFlight(store, detail({}));
		const state = store.getState();
		expect(state.selectedId).toBeNull();
		expect(state.recordedFlight?.id).toBe(12);
		expect(state.recordedFlight?.callsign).toBe("UAL123");
		expect(state.recordedFlight?.points).toBe(3);
		expect(state.boundsTarget?.bounds).toEqual([-104.7, 39.8, -87.9, 41.9]);
	});

	test("one still flying: selected by its aircraft id, at once", () => {
		const store = createInterfaceStore();
		selectFlying(store, flight({ flying: true, lastSeenAt: null }));
		expect(store.getState().selectedId).toBe(700);
		expect(store.getState().recordedFlight).toBeNull();
	});

	test("one still flying, once its detail is here: the map goes to where it was last recorded", () => {
		const store = createInterfaceStore();
		showFlight(store, detail({ flying: true, lastSeenAt: null }));
		const state = store.getState();
		expect(state.selectedId).toBe(700);
		expect(state.recordedFlight).toBeNull();
		expect(state.boundsTarget?.bounds).toEqual([-104.7, 39.8, -104.7, 39.8]);
	});

	test("one still flying with nothing recorded yet: selected, and the map stays", () => {
		const store = createInterfaceStore();
		showFlight(store, detail({ flying: true, lastSeenAt: null }, track([])));
		expect(store.getState().selectedId).toBe(700);
		expect(store.getState().boundsTarget).toBeNull();
	});

	test("a flying flight chosen after a finished one puts the track away", () => {
		const store = createInterfaceStore();
		showFlight(store, detail({}));
		selectFlying(store, flight({ flying: true, lastSeenAt: null }));
		expect(store.getState().recordedFlight).toBeNull();
	});

	test("the same box asked for twice is two requests", () => {
		const store = createInterfaceStore();
		showFlight(store, detail({}));
		const first = store.getState().boundsTarget?.request;
		showFlight(store, detail({}));
		expect(store.getState().boundsTarget?.request).not.toBe(first);
	});
});
