import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
	type Alert,
	createInterfaceStore,
	type InterfaceState,
	initialInterfaceState,
	interfaceStore,
	MAX_ALERTS,
	MAX_SCRUB_AHEAD_SECONDS,
	PERFORMANCE_PUBLISH_INTERVAL_MS,
	useInterfaceStore,
} from "./interface-store";

function alert(n: number): Alert {
	return {
		a: { id: n, longitude: -71, latitude: 42, altitudeFt: 35000 },
		b: {
			id: n + 1_000_000,
			longitude: -71.1,
			latitude: 42.1,
			altitudeFt: 35500,
		},
		secondsToClosestApproach: n,
		lateralNm: 3.2,
		verticalFt: 500,
		flags: 0,
	};
}

/** The state without the actions, to compare against the defaults. */
function data(state: InterfaceState): InterfaceState {
	return Object.fromEntries(
		Object.entries(state).filter(([, value]) => typeof value !== "function"),
	) as InterfaceState;
}

describe("defaults", () => {
	test("a new store starts live, in 2D, with nothing chosen", () => {
		const state = createInterfaceStore().getState();

		expect(data(state)).toEqual(initialInterfaceState());
		expect(state.selectedId).toBeNull();
		expect(state.hoveredId).toBeNull();
		expect(state.filters).toEqual({ callsign: "" });
		expect(state.sort).toEqual({ key: "callsign", descending: false });
		expect(state.viewMode).toBe("2d");
		expect(state.verticalExaggeration).toBe(1);
		expect(Object.values(state.layers)).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
		]);
		expect(state.scrubAheadSeconds).toBeNull();
		expect(state.connectionStatus).toBe("connecting");
		expect(state.camera).toBeNull();
		expect(state.viewport).toBeNull();
		expect(state.performance.fps).toBe(0);
		expect(state.performance.skippedFrames).toBe(0);
		expect(state.hudVisible).toBe(true);
		expect(state.alerts).toEqual([]);
	});

	test("two stores share nothing", () => {
		const one = createInterfaceStore();
		const two = createInterfaceStore();

		one.getState().select(7);
		one.getState().setLayerVisible("stems", false);
		one.getState().reportPerformance({ fps: 60 }, 0);

		expect(data(two.getState())).toEqual(initialInterfaceState());
	});
});

describe("selection", () => {
	test("selects and hovers by aircraft id", () => {
		const store = createInterfaceStore();

		store.getState().select(4_294_967_295);
		store.getState().hover(0);

		expect(store.getState().selectedId).toBe(4_294_967_295);
		// Id 0 is an aircraft, not "nothing".
		expect(store.getState().hoveredId).toBe(0);
	});

	test("clears with null, each on its own", () => {
		const store = createInterfaceStore();
		store.getState().select(12);
		store.getState().hover(34);

		store.getState().hover(null);
		expect(store.getState().selectedId).toBe(12);
		expect(store.getState().hoveredId).toBeNull();

		store.getState().select(null);
		expect(store.getState().selectedId).toBeNull();
	});

	test("hovering the same aircraft again tells nobody", () => {
		const store = createInterfaceStore();
		store.getState().hover(34);
		let calls = 0;
		store.subscribe(() => {
			calls += 1;
		});

		store.getState().hover(34);
		store.getState().select(null);

		expect(calls).toBe(0);
	});
});

describe("filters and sort order", () => {
	test("setFilters merges and setSort replaces", () => {
		const store = createInterfaceStore();

		store.getState().setFilters({ callsign: "UAL" });
		store.getState().setFilters({});
		store.getState().setSort({ key: "altitude", descending: true });

		expect(store.getState().filters).toEqual({ callsign: "UAL" });
		expect(store.getState().sort).toEqual({
			key: "altitude",
			descending: true,
		});
	});
});

describe("view", () => {
	test("switches between 2D and 3D", () => {
		const store = createInterfaceStore();

		store.getState().setViewMode("3d");
		expect(store.getState().viewMode).toBe("3d");

		store.getState().setViewMode("2d");
		expect(store.getState().viewMode).toBe("2d");
	});

	test("sets the vertical exaggeration", () => {
		const store = createInterfaceStore();

		store.getState().setVerticalExaggeration(4.5);

		expect(store.getState().verticalExaggeration).toBe(4.5);
	});

	test("ignores an exaggeration that is not a positive number", () => {
		const store = createInterfaceStore();
		store.getState().setVerticalExaggeration(3);

		for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
			store.getState().setVerticalExaggeration(bad);
		}

		expect(store.getState().verticalExaggeration).toBe(3);
	});

	test("hides and shows one layer and leaves the others", () => {
		const store = createInterfaceStore();
		const before = store.getState().layers;

		store.getState().setLayerVisible("classB", false);

		expect(store.getState().layers).toEqual({ ...before, classB: false });
		// The old object is untouched, so a selector sees the change.
		expect(before.classB).toBe(true);

		store.getState().setLayerVisible("classB", true);
		expect(store.getState().layers).toEqual(before);
	});

	test("setting a layer to what it already is keeps the same object", () => {
		const store = createInterfaceStore();
		const before = store.getState().layers;

		store.getState().setLayerVisible("artcc", true);

		expect(store.getState().layers).toBe(before);
	});

	test("stores the camera the map reports", () => {
		const store = createInterfaceStore();
		const camera = {
			longitude: -98.5,
			latitude: 39.8,
			zoom: 4,
			pitch: 0,
			bearing: 0,
		};

		store.getState().setCamera(camera);

		expect(store.getState().camera).toEqual(camera);
	});

	test("tells a viewport subscriber about changes only", () => {
		const store = createInterfaceStore();
		const seen: unknown[] = [];
		store.subscribe(
			(state) => state.viewport,
			(viewport) => seen.push(viewport),
		);

		store.getState().setViewport({ bbox: [-125, 24.4, -66.9, 49.4], zoom: 4 });
		store.getState().setViewport({ bbox: [-125, 24.4, -66.9, 49.4], zoom: 4 });
		store.getState().setViewport({ bbox: [-120, 24.4, -66.9, 49.4], zoom: 4 });

		expect(seen).toEqual([
			{ bbox: [-125, 24.4, -66.9, 49.4], zoom: 4 },
			{ bbox: [-120, 24.4, -66.9, 49.4], zoom: 4 },
		]);
	});

	test("shows and hides the HUD", () => {
		const store = createInterfaceStore();

		store.getState().setHudVisible(false);
		expect(store.getState().hudVisible).toBe(false);

		store.getState().setHudVisible(true);
		expect(store.getState().hudVisible).toBe(true);
	});
});

describe("scrubber", () => {
	test("moves ahead of now and returns to live", () => {
		const store = createInterfaceStore();

		store.getState().scrubTo(90);
		expect(store.getState().scrubAheadSeconds).toBe(90);

		store.getState().returnToLive();
		expect(store.getState().scrubAheadSeconds).toBeNull();
	});

	test("scrubbed to zero is still scrubbing, not live", () => {
		const store = createInterfaceStore();

		store.getState().scrubTo(0);

		expect(store.getState().scrubAheadSeconds).toBe(0);
	});

	test("is held between now and 20 minutes ahead", () => {
		const store = createInterfaceStore();

		store.getState().scrubTo(MAX_SCRUB_AHEAD_SECONDS + 1);
		expect(store.getState().scrubAheadSeconds).toBe(1200);

		store.getState().scrubTo(Number.POSITIVE_INFINITY);
		expect(store.getState().scrubAheadSeconds).toBe(1200);

		store.getState().scrubTo(-5);
		expect(store.getState().scrubAheadSeconds).toBe(0);
	});

	test("ignores a position that is not a number", () => {
		const store = createInterfaceStore();

		store.getState().scrubTo(Number.NaN);
		expect(store.getState().scrubAheadSeconds).toBeNull();

		store.getState().scrubTo(300);
		store.getState().scrubTo(Number.NaN);
		expect(store.getState().scrubAheadSeconds).toBe(300);
	});
});

describe("connection status", () => {
	test("takes each status", () => {
		const store = createInterfaceStore();

		for (const status of [
			"open",
			"reconnecting",
			"closed",
			"connecting",
		] as const) {
			store.getState().setConnectionStatus(status);
			expect(store.getState().connectionStatus).toBe(status);
		}
	});
});

describe("performance readings", () => {
	test("the first report is published at once", () => {
		const store = createInterfaceStore();

		store.getState().reportPerformance({ fps: 60, aircraftCount: 7000 }, 1000);

		expect(store.getState().performance).toEqual({
			...initialInterfaceState().performance,
			fps: 60,
			aircraftCount: 7000,
		});
	});

	test("a report every frame changes the state a few times a second", () => {
		const store = createInterfaceStore();
		let changes = 0;
		store.subscribe(
			(state) => state.performance,
			() => {
				changes += 1;
			},
		);
		let notified = 0;
		store.subscribe(() => {
			notified += 1;
		});

		// One second of frames at 60 Hz.
		const readings = { fps: 0 };
		for (let frame = 0; frame < 60; frame += 1) {
			readings.fps = frame;
			store.getState().reportPerformance(readings, frame * (1000 / 60));
		}

		expect(changes).toBe(1000 / PERFORMANCE_PUBLISH_INTERVAL_MS);
		// Nothing at all is told about the frames in between.
		expect(notified).toBe(changes);
	});

	test("what is published is the newest of every reading", () => {
		const store = createInterfaceStore();
		const { reportPerformance } = store.getState();

		reportPerformance({ fps: 60 }, 0);
		// Held back: too soon after the last publish.
		reportPerformance({ bytesPerSecond: 140_000, skippedFrames: 2 }, 10);
		reportPerformance({ fps: 58 }, 20);
		expect(store.getState().performance.fps).toBe(60);
		expect(store.getState().performance.skippedFrames).toBe(0);

		reportPerformance({ wasmAdvanceMs: 0.4 }, PERFORMANCE_PUBLISH_INTERVAL_MS);

		expect(store.getState().performance).toEqual({
			...initialInterfaceState().performance,
			fps: 58,
			wasmAdvanceMs: 0.4,
			bytesPerSecond: 140_000,
			skippedFrames: 2,
		});
	});

	test("the caller may reuse the object it reports with", () => {
		const store = createInterfaceStore();
		const readings = { fps: 60 };

		store.getState().reportPerformance(readings, 0);
		readings.fps = 12;

		expect(store.getState().performance.fps).toBe(60);
	});
});

describe("alerts", () => {
	test("each frame replaces the list", () => {
		const store = createInterfaceStore();

		store.getState().setAlerts([alert(1), alert(2)]);
		store.getState().setAlerts([alert(3)]);
		expect(store.getState().alerts).toEqual([alert(3)]);

		store.getState().setAlerts([]);
		expect(store.getState().alerts).toEqual([]);
	});

	test("keeps the first 500, which are the soonest", () => {
		const store = createInterfaceStore();
		const many = Array.from({ length: MAX_ALERTS + 25 }, (_, n) => alert(n));

		store.getState().setAlerts(many);

		const { alerts } = store.getState();
		expect(alerts).toHaveLength(500);
		expect(alerts[0]).toEqual(alert(0));
		expect(alerts[499]).toEqual(alert(499));
		expect(many).toHaveLength(MAX_ALERTS + 25);
	});
});

describe("outside React", () => {
	test("a subscriber to one field hears that field only", () => {
		const store = createInterfaceStore();
		const seen: Array<[number | null, number | null]> = [];
		store.subscribe(
			(state) => state.selectedId,
			(id, previous) => {
				seen.push([id, previous]);
			},
		);

		store.getState().hover(5);
		store.getState().setConnectionStatus("open");
		store.getState().select(9);
		store.getState().select(9);
		store.getState().select(null);

		expect(seen).toEqual([
			[9, null],
			[null, 9],
		]);
	});

	test("a plain subscriber gets the new state and the one before", () => {
		const store = createInterfaceStore();
		const seen: string[] = [];
		store.subscribe((state, previous) => {
			seen.push(`${previous.connectionStatus} -> ${state.connectionStatus}`);
		});

		store.getState().setConnectionStatus("open");
		store.getState().setConnectionStatus("reconnecting");

		expect(seen).toEqual(["connecting -> open", "open -> reconnecting"]);
	});

	test("unsubscribing stops the calls", () => {
		const store = createInterfaceStore();
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});

		store.getState().select(1);
		unsubscribe();
		store.getState().select(2);

		expect(calls).toBe(1);
		expect(store.getState().selectedId).toBe(2);
	});
});

describe("useInterfaceStore", () => {
	test("renders the value its selector picks from the page's store", () => {
		function Status() {
			return useInterfaceStore((state) => state.connectionStatus);
		}

		expect(interfaceStore.getState().connectionStatus).toBe("connecting");
		expect(renderToString(createElement(Status))).toBe("connecting");
	});
});
