// Interface state: what the user has chosen and what the page is doing, as
// opposed to the traffic itself. See docs/DESIGN.md section 8.
//
// Nothing here is per aircraft. Aircraft live in WASM memory and are named
// here by id only. The alerts list is the one collection, and the server caps
// it at 500 records.
//
// The store is a vanilla Zustand store, so the render loop and the socket
// client use it without React:
//
//   interfaceStore.getState().selectedId
//   interfaceStore.subscribe((s) => s.selectedId, (id) => sendSelect(id))
//
// Components use the hook with a selector and re-render only when the value
// they selected changes:
//
//   const status = useInterfaceStore((s) => s.connectionStatus)
//
// Two fields are written far more often than React should render, and each
// has its own rule:
//
// - `performance` is reported every animation frame. `reportPerformance`
//   keeps the newest readings outside the state and publishes them at most
//   every PERFORMANCE_PUBLISH_INTERVAL_MS, so the HUD renders a few times a
//   second and no subscriber runs at 60 Hz. There is no trailing publish:
//   a reading held back is published by the next report that is late
//   enough, and while the HUD is shown the frame meter (lib/frame-meter.ts)
//   reports every frame.
// - `camera` is written on every map move. Select it in a component only
//   where a render per frame of a pan is acceptable; otherwise read it with
//   `getState` when it is needed.
//
// `viewport` is the same movement paced for the socket client: the map
// writes it a few times a second at most (see lib/viewport.ts), and
// `setViewport` ignores a value equal to the one held.

import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type {
	ConnectionClosedReason,
	ConnectionStatus,
} from "@/lib/connection-status";
import { sameViewport, type Viewport } from "@/lib/viewport";

// The socket's state, written by the socket client. Defined beside the
// shell's labels for it, and exported from here too for the store's users.
export type { ConnectionClosedReason, ConnectionStatus, Viewport };

/** What the server's `sim` message says about the simulation (section 6). */
export type SimSettings = {
	/** The stress multiplier: 1 is the real picture. */
	multiplier: number;
	/** The length of one pass of the recording, in seconds. */
	windowSeconds: number;
};

export type ViewMode = "2d" | "3d";

/** The overlays a user can show and hide. The aircraft are always drawn. */
export const LAYER_IDS = [
	"trails",
	"predictionVectors",
	"conflictLinks",
	"stems",
	"classB",
	"artcc",
] as const;

export type LayerId = (typeof LAYER_IDS)[number];

/** The units each kind of value can be shown in. The first is the default. */
export const UNIT_CHOICES = {
	altitude: ["ft", "m"],
	speed: ["kt", "kmh", "mph"],
	verticalRate: ["fpm", "ms"],
} as const;

/** What the user has chosen to see values in. */
export type Units = {
	[Kind in keyof typeof UNIT_CHOICES]: (typeof UNIT_CHOICES)[Kind][number];
};

/** The most the vertical scale can be stretched. */
export const MAX_VERTICAL_EXAGGERATION = 20;

/**
 * What the flight list is narrowed to. The list arrives in milestone 5 and
 * will add to this; WASM does the filtering.
 */
export type Filters = {
	/** Matched against the callsign. Empty matches everything. */
	callsign: string;
};

export type SortKey = "callsign" | "altitude" | "groundSpeed";

export type SortOrder = {
	key: SortKey;
	descending: boolean;
};

/** The map's camera, as MapLibre reports it. */
export type Camera = {
	longitude: number;
	latitude: number;
	zoom: number;
	/** Degrees from straight down. */
	pitch: number;
	/** Degrees clockwise from north. */
	bearing: number;
};

/**
 * What the HUD shows. The times and the frame rate are NaN until something
 * has measured them, and the HUD shows a dash for those; the three counts
 * start at a true zero.
 */
export type PerformanceReadings = {
	fps: number;
	frameTimeP95Ms: number;
	frameTimeP99Ms: number;
	/** Main-thread time in the WASM `advance`, each frame. */
	wasmAdvanceMs: number;
	/** Main-thread time handing deck.gl its attributes, each frame. */
	attributeUpdateMs: number;
	/**
	 * Main-thread time MapLibre spends drawing a frame: the base map and the
	 * deck.gl layers drawn inside it, as draw calls issued. The GPU's own
	 * time is not in it. The render loop reports it
	 * (lib/aircraft-frame.ts).
	 */
	mapRenderMs: number;
	aircraftCount: number;
	bytesPerSecond: number;
	/** Gaps in the frames' `seq`, counted by the socket client. */
	skippedFrames: number;
};

/** One end of an alert: an aircraft and where it was when the alert was sent. */
export type AlertAircraft = {
	id: number;
	longitude: number;
	latitude: number;
	altitudeFt: number;
};

/** One record of an alerts frame, in display units. */
export type Alert = {
	a: AlertAircraft;
	b: AlertAircraft;
	secondsToClosestApproach: number;
	lateralNm: number;
	verticalFt: number;
	flags: number;
};

/** The scrubber reaches 20 minutes ahead (section 10). */
export const MAX_SCRUB_AHEAD_SECONDS = 20 * 60;

/** An alerts frame holds at most this many records (section 6). */
export const MAX_ALERTS = 500;

/** `performance` changes at most this often, however often it is reported. */
export const PERFORMANCE_PUBLISH_INTERVAL_MS = 250;

export type InterfaceState = {
	/** Aircraft id, or null when nothing is selected. */
	selectedId: number | null;
	/** Aircraft id, or null when the pointer is over no aircraft. */
	hoveredId: number | null;
	filters: Filters;
	sort: SortOrder;
	viewMode: ViewMode;
	/** One value for terrain, aircraft height and airspace (section 9). */
	verticalExaggeration: number;
	layers: Record<LayerId, boolean>;
	units: Units;
	/**
	 * How far ahead of now the scrubber shows, in seconds. Null is the live
	 * picture.
	 */
	scrubAheadSeconds: number | null;
	connectionStatus: ConnectionStatus;
	/** Why the client stopped trying. Null unless the status is `closed`. */
	connectionClosedReason: ConnectionClosedReason | null;
	/** The newest `sim` message. Null until the server has sent one. */
	sim: SimSettings | null;
	/**
	 * True while the "replay restarted" notice should show. The socket client
	 * raises it at the first frame of a new pass and lowers it a few seconds
	 * later.
	 */
	replayRestarted: boolean;
	/** Null until the map has reported where it is. */
	camera: Camera | null;
	/**
	 * The bounds and zoom the socket client sends as `viewport` (section 6).
	 * Null until the map has reported where it is.
	 */
	viewport: Viewport | null;
	performance: PerformanceReadings;
	hudVisible: boolean;
	/** The newest alerts frame, soonest closest approach first. */
	alerts: readonly Alert[];
};

export type InterfaceActions = {
	select: (id: number | null) => void;
	hover: (id: number | null) => void;
	setFilters: (filters: Partial<Filters>) => void;
	setSort: (sort: SortOrder) => void;
	setViewMode: (mode: ViewMode) => void;
	/** Ignores a value that is not a positive, finite number. */
	setVerticalExaggeration: (value: number) => void;
	setLayerVisible: (layer: LayerId, visible: boolean) => void;
	setUnits: (units: Partial<Units>) => void;
	/**
	 * Moves the scrubber, held between now and MAX_SCRUB_AHEAD_SECONDS. Ignores
	 * a value that is not a number.
	 */
	scrubTo: (aheadSeconds: number) => void;
	returnToLive: () => void;
	/** `closedReason` is kept only with `closed`; any other status clears it. */
	setConnectionStatus: (
		status: ConnectionStatus,
		closedReason?: ConnectionClosedReason,
	) => void;
	setSim: (sim: SimSettings) => void;
	setReplayRestarted: (visible: boolean) => void;
	setCamera: (camera: Camera) => void;
	/** Ignores a viewport equal to the one held, so subscribers hear changes only. */
	setViewport: (viewport: Viewport) => void;
	/**
	 * Takes the readings the caller has, and leaves the rest as they were; a
	 * reading given as `undefined` is left too. Cheap enough to call every
	 * frame: the readings are copied out of `readings`, so the caller may
	 * reuse one object, and the state changes only when
	 * PERFORMANCE_PUBLISH_INTERVAL_MS has passed since it last did.
	 * `nowMs` is the animation frame's timestamp or `performance.now()`. If
	 * it is earlier than the last publish the clock is taken to have changed,
	 * and the interval is counted from `nowMs`.
	 */
	reportPerformance: (
		readings: Partial<PerformanceReadings>,
		nowMs: number,
	) => void;
	setHudVisible: (visible: boolean) => void;
	/** Replaces the list, keeping the first MAX_ALERTS. */
	setAlerts: (alerts: readonly Alert[]) => void;
};

export type InterfaceStore = InterfaceState & InterfaceActions;

export function initialInterfaceState(): InterfaceState {
	return {
		selectedId: null,
		hoveredId: null,
		filters: { callsign: "" },
		sort: { key: "callsign", descending: false },
		viewMode: "2d",
		verticalExaggeration: 1,
		layers: {
			trails: true,
			predictionVectors: true,
			conflictLinks: true,
			stems: true,
			classB: true,
			artcc: true,
		},
		units: { altitude: "ft", speed: "kt", verticalRate: "fpm" },
		scrubAheadSeconds: null,
		connectionStatus: "connecting",
		connectionClosedReason: null,
		sim: null,
		replayRestarted: false,
		camera: null,
		viewport: null,
		performance: {
			fps: Number.NaN,
			frameTimeP95Ms: Number.NaN,
			frameTimeP99Ms: Number.NaN,
			wasmAdvanceMs: Number.NaN,
			attributeUpdateMs: Number.NaN,
			mapRenderMs: Number.NaN,
			aircraftCount: 0,
			bytesPerSecond: 0,
			skippedFrames: 0,
		},
		hudVisible: true,
		alerts: [],
	};
}

const PERFORMANCE_KEYS = Object.keys(
	initialInterfaceState().performance,
) as readonly (keyof PerformanceReadings)[];

/** A store of its own. The app uses `interfaceStore`; tests make their own. */
export function createInterfaceStore() {
	return createStore<InterfaceStore>()(
		subscribeWithSelector((set, get) => {
			const initial = initialInterfaceState();

			// The newest readings, held outside the state between publishes.
			const pending = { ...initial.performance };
			let publishedAtMs = Number.NEGATIVE_INFINITY;

			// Zustand tells every subscriber about every `set`, even one that
			// changes nothing, and hover is written on every pointer move.
			function setIfChanged<K extends keyof InterfaceState>(
				key: K,
				value: InterfaceState[K],
			) {
				if (!Object.is(get()[key], value)) {
					set({ [key]: value } as Pick<InterfaceState, K>);
				}
			}

			return {
				...initial,

				select: (id) => setIfChanged("selectedId", id),
				hover: (id) => setIfChanged("hoveredId", id),

				setFilters: (filters) =>
					set((state) => ({ filters: { ...state.filters, ...filters } })),
				setSort: (sort) => set({ sort }),

				setViewMode: (mode) => setIfChanged("viewMode", mode),
				setVerticalExaggeration: (value) => {
					if (Number.isFinite(value) && value > 0) {
						setIfChanged(
							"verticalExaggeration",
							Math.min(value, MAX_VERTICAL_EXAGGERATION),
						);
					}
				},
				setLayerVisible: (layer, visible) => {
					if (get().layers[layer] !== visible) {
						set((state) => ({
							layers: { ...state.layers, [layer]: visible },
						}));
					}
				},

				setUnits: (units) => {
					const current = get().units;
					const next = { ...current, ...units };
					if (
						next.altitude !== current.altitude ||
						next.speed !== current.speed ||
						next.verticalRate !== current.verticalRate
					) {
						set({ units: next });
					}
				},

				scrubTo: (aheadSeconds) => {
					if (!Number.isNaN(aheadSeconds)) {
						setIfChanged(
							"scrubAheadSeconds",
							Math.min(Math.max(aheadSeconds, 0), MAX_SCRUB_AHEAD_SECONDS),
						);
					}
				},
				returnToLive: () => setIfChanged("scrubAheadSeconds", null),

				setConnectionStatus: (status, closedReason) => {
					const reason = status === "closed" ? (closedReason ?? null) : null;
					const state = get();
					if (
						state.connectionStatus !== status ||
						state.connectionClosedReason !== reason
					) {
						set({ connectionStatus: status, connectionClosedReason: reason });
					}
				},
				setSim: (sim) => {
					const held = get().sim;
					if (
						held?.multiplier !== sim.multiplier ||
						held.windowSeconds !== sim.windowSeconds
					) {
						set({ sim });
					}
				},
				setReplayRestarted: (visible) =>
					setIfChanged("replayRestarted", visible),
				setCamera: (camera) => set({ camera }),
				setViewport: (viewport) => {
					if (!sameViewport(get().viewport, viewport)) set({ viewport });
				},

				reportPerformance: (readings, nowMs) => {
					// Key by key, not `Object.assign`: `Partial` lets a caller
					// pass `{ fps: undefined }`, which must not be stored.
					// An indexed loop, which makes no iterator: this runs every
					// frame.
					for (let i = 0; i < PERFORMANCE_KEYS.length; i += 1) {
						const key = PERFORMANCE_KEYS[i];
						const value = readings[key];
						if (value !== undefined) pending[key] = value;
					}
					// A time before the last publish would otherwise hold every
					// later report back until that clock caught up, which for
					// `Date.now()` followed by frame timestamps is never.
					if (nowMs < publishedAtMs) publishedAtMs = nowMs;
					if (nowMs - publishedAtMs >= PERFORMANCE_PUBLISH_INTERVAL_MS) {
						publishedAtMs = nowMs;
						set({ performance: { ...pending } });
					}
				},
				setHudVisible: (visible) => setIfChanged("hudVisible", visible),

				setAlerts: (alerts) =>
					set({
						alerts:
							alerts.length > MAX_ALERTS ? alerts.slice(0, MAX_ALERTS) : alerts,
					}),
			};
		}),
	);
}

/** The page's one interface store. */
export const interfaceStore = createInterfaceStore();

/** Reads the store in a component, which re-renders when `selector`'s value changes. */
export function useInterfaceStore<T>(
	selector: (state: InterfaceStore) => T,
): T {
	return useStore(interfaceStore, selector);
}
