// What the map is showing, in the shape the `viewport` message carries it
// (docs/DESIGN.md section 6), and the pacing of how often it is reported.
//
// The map writes the viewport to the interface store. The socket client
// reads it from there, outside React:
//
//   interfaceStore.getState().viewport          // on connect; may be null
//   interfaceStore.subscribe((s) => s.viewport, (viewport) => send(viewport))
//
// It is already paced when it reaches the store: at most one change every
// VIEWPORT_REPORT_INTERVAL_MS while the map moves, and always the place it
// came to rest. The socket client needs no debounce of its own.

/** `[west, south, east, north]` in degrees, the order MapLibre and GeoJSON use. */
export type Bbox = readonly [
	west: number,
	south: number,
	east: number,
	north: number,
];

export type Viewport = {
	bbox: Bbox;
	zoom: number;
};

/** The coverage area: the continental United States (section 2). */
export const COVERAGE_BBOX: Bbox = [-125, 24.4, -66.9, 49.4];

/**
 * The store's viewport changes at most this often during a pan or a zoom.
 * The server adds a margin of a quarter of the viewport's longer side
 * (section 6), so four reports a second keep a moving map inside it.
 */
export const VIEWPORT_REPORT_INTERVAL_MS = 250;

// About 11 m of latitude. Finer than anything the server's filter resolves,
// and it keeps a resting map from reporting changes in the last float digit.
const DEGREE_DECIMALS = 4;
const ZOOM_DECIMALS = 2;

/**
 * The viewport for the bounds and zoom the map reports.
 *
 * Longitudes are passed on as they are, beyond ±180 too: a map dragged
 * round the world gives them, and the server brings them back into range.
 * Latitudes are held to ±90.
 */
export function viewportOf(
	bounds: { west: number; south: number; east: number; north: number },
	zoom: number,
): Viewport {
	return {
		bbox: [
			round(bounds.west, DEGREE_DECIMALS),
			round(clamp(bounds.south, -90, 90), DEGREE_DECIMALS),
			round(bounds.east, DEGREE_DECIMALS),
			round(clamp(bounds.north, -90, 90), DEGREE_DECIMALS),
		],
		zoom: round(zoom, ZOOM_DECIMALS),
	};
}

export function sameViewport(a: Viewport | null, b: Viewport | null): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.zoom === b.zoom &&
		a.bbox[0] === b.bbox[0] &&
		a.bbox[1] === b.bbox[1] &&
		a.bbox[2] === b.bbox[2] &&
		a.bbox[3] === b.bbox[3]
	);
}

/** The clock and timer `paced` uses; tests pass their own. */
export type Timers = {
	now: () => number;
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: never) => void;
};

const REAL_TIMERS: Timers = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export type Paced<T> = {
	/** Offers a value. The newest one offered is the one delivered. */
	(value: T): void;
	/** Drops a value that is waiting, and delivers nothing more. */
	cancel: () => void;
};

/**
 * Delivers values to `deliver` at most once every `intervalMs`: the first
 * at once, then the newest of whatever arrived during each interval, when
 * the interval ends. The last value offered is always delivered.
 *
 * A debounce would hold everything back until the map stops, and a long pan
 * would run off the edge of what the server is sending.
 */
export function paced<T>(
	deliver: (value: T) => void,
	intervalMs: number,
	timers: Timers = REAL_TIMERS,
): Paced<T> {
	let deliveredAt = Number.NEGATIVE_INFINITY;
	let waiting: { value: T } | null = null;
	let timer: unknown = null;

	function flush() {
		timer = null;
		if (waiting === null) return;
		const { value } = waiting;
		waiting = null;
		deliveredAt = timers.now();
		deliver(value);
	}

	const offer = (value: T) => {
		waiting = { value };
		if (timer !== null) return;
		const wait = deliveredAt + intervalMs - timers.now();
		if (wait <= 0) {
			flush();
		} else {
			timer = timers.setTimeout(flush, wait);
		}
	};
	offer.cancel = () => {
		if (timer !== null) timers.clearTimeout(timer as never);
		timer = null;
		waiting = null;
	};
	return offer;
}

function round(value: number, decimals: number): number {
	const scale = 10 ** decimals;
	// Adding zero turns -0 into 0, which would otherwise never equal 0 under
	// Object.is and reads oddly in JSON.
	return Math.round(value * scale) / scale + 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
