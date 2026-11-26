// The frame meter: frames per second and frame-time percentiles for the
// performance HUD, measured from the times of animation frames. See
// docs/DESIGN.md sections 8 and 15.
//
// It has two halves. `createFrameMeter` is the arithmetic: it is handed each
// frame's timestamp and knows nothing of the browser. `startFrameMeter` runs
// one on its own `requestAnimationFrame` loop and reports to the interface
// store; the HUD starts it when shown and stops it when hidden.
//
// What is measured is the time from one animation frame to the next, which
// is what the user sees as smoothness whatever the main thread spent it on.
//
// - Percentiles are over the last FRAME_WINDOW frames, a little over four
//   seconds at 60 Hz. They are the nearest rank: with a full window the 99th
//   percentile is the third slowest frame and the 95th the thirteenth.
// - Frames per second is over the newest frames that add up to
//   FPS_WINDOW_MS.
//
// Nothing is allocated per frame. The intervals go into a ring in one typed
// array; the percentiles are found by sorting a second typed array of the
// same size, and that happens once a publish interval, not once a frame. A
// report is made every frame, with the meter's one readings object when the
// figures have just been worked out and one shared empty object otherwise:
// reading three numbers out of an object sixty times a second is itself an
// allocation in code the engine has not yet optimised.
//
// A tab that is hidden gets no animation frames, so the first frame after it
// is shown again arrives seconds after the last. That is not a frame anyone
// watched: `startFrameMeter` calls `pause` when the page's visibility
// changes, and the frame after a pause starts a new run without adding an
// interval. A long gap with the page visible is a real stall and is counted.

import {
	interfaceStore,
	PERFORMANCE_PUBLISH_INTERVAL_MS,
	type PerformanceReadings,
} from "@/lib/interface-store";

/** How many frames the percentiles are taken over. */
export const FRAME_WINDOW = 256;

/** How much time the frames-per-second figure is taken over. */
export const FPS_WINDOW_MS = 1000;

export type FrameReadings = Pick<
	PerformanceReadings,
	"fps" | "frameTimeP95Ms" | "frameTimeP99Ms"
>;

export type FrameMeterOptions = {
	/**
	 * Called on every frame: with the meter's one readings object on a frame
	 * that worked the figures out again, which is every `computeIntervalMs`,
	 * and with NOTHING_NEW on the rest. The interface store's
	 * `reportPerformance` fits, and the call on every frame is what
	 * publishes readings others reported there and had held back.
	 */
	report?: (readings: Partial<FrameReadings>, nowMs: number) => void;
	/** How often the figures are worked out again. */
	computeIntervalMs?: number;
	/** The size of the ring, in frames. */
	capacity?: number;
};

/** What a frame reports when the figures have not changed. Always empty. */
export const NOTHING_NEW: Partial<FrameReadings> = Object.freeze({});

export type FrameMeter = {
	/**
	 * One animation frame, with the timestamp `requestAnimationFrame` gave.
	 * A timestamp equal to the last one adds nothing, so two loops in the
	 * same frame may both call this.
	 */
	frame: (timestampMs: number) => void;
	/** The next frame starts a new run: the gap before it is not a frame. */
	pause: () => void;
	/** Forgets every frame. */
	reset: () => void;
	/** Always the same object. NaN until there is an interval to measure. */
	readonly readings: FrameReadings;
	/** How many intervals the window holds, up to its capacity. */
	readonly sampleCount: number;
};

export function createFrameMeter({
	report,
	computeIntervalMs = PERFORMANCE_PUBLISH_INTERVAL_MS,
	capacity = FRAME_WINDOW,
}: FrameMeterOptions = {}): FrameMeter {
	// Frame intervals in milliseconds, newest at `head - 1`.
	const ring = new Float64Array(capacity);
	// Sorted afresh at each compute. Never handed out.
	const sorted = new Float64Array(capacity);
	const readings: FrameReadings = {
		fps: Number.NaN,
		frameTimeP95Ms: Number.NaN,
		frameTimeP99Ms: Number.NaN,
	};

	let head = 0;
	let count = 0;
	// NaN when the next frame has no frame before it to be timed from.
	let lastMs = Number.NaN;
	let computedAtMs = Number.NEGATIVE_INFINITY;

	function compute() {
		// The unused end is filled with infinities, which sort last, so the
		// whole array is sorted and no view of part of it is made.
		sorted.set(ring);
		if (count < capacity) sorted.fill(Number.POSITIVE_INFINITY, count);
		sorted.sort();
		readings.frameTimeP95Ms = sorted[Math.ceil(count * 0.95) - 1];
		readings.frameTimeP99Ms = sorted[Math.ceil(count * 0.99) - 1];

		let frames = 0;
		let elapsedMs = 0;
		let index = head;
		while (frames < count && elapsedMs < FPS_WINDOW_MS) {
			index = index === 0 ? capacity - 1 : index - 1;
			elapsedMs += ring[index];
			frames += 1;
		}
		readings.fps = (frames * 1000) / elapsedMs;
	}

	return {
		frame(timestampMs) {
			if (timestampMs > lastMs) {
				ring[head] = timestampMs - lastMs;
				head = head + 1 === capacity ? 0 : head + 1;
				if (count < capacity) count += 1;
			}
			// Also when it is earlier than the last, or the last is NaN: the
			// run starts again from here.
			lastMs = timestampMs;

			if (timestampMs < computedAtMs) computedAtMs = timestampMs;
			if (count > 0 && timestampMs - computedAtMs >= computeIntervalMs) {
				computedAtMs = timestampMs;
				compute();
				report?.(readings, timestampMs);
			} else {
				report?.(NOTHING_NEW, timestampMs);
			}
		},
		pause() {
			lastMs = Number.NaN;
		},
		reset() {
			head = 0;
			count = 0;
			lastMs = Number.NaN;
			computedAtMs = Number.NEGATIVE_INFINITY;
			readings.fps = Number.NaN;
			readings.frameTimeP95Ms = Number.NaN;
			readings.frameTimeP99Ms = Number.NaN;
		},
		readings,
		get sampleCount() {
			return count;
		},
	};
}

/** The parts of the browser the loop uses, so a test can stand in for them. */
export type FrameMeterHost = {
	requestFrame: (callback: (timestampMs: number) => void) => number;
	cancelFrame: (handle: number) => void;
	/** Calls `listener` when the page is hidden or shown; returns the undo. */
	onVisibilityChange: (listener: () => void) => () => void;
};

const browserHost: FrameMeterHost = {
	requestFrame: (callback) => requestAnimationFrame(callback),
	cancelFrame: (handle) => cancelAnimationFrame(handle),
	onVisibilityChange: (listener) => {
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
};

/**
 * Runs a frame meter on its own animation-frame loop until the function
 * returned is called. By default it reports to the interface store on every
 * frame, which also publishes whatever else was reported there and held
 * back. Browser only, unless a `host` is given.
 */
export function startFrameMeter({
	host = browserHost,
	...options
}: FrameMeterOptions & { host?: FrameMeterHost } = {}): () => void {
	const meter = createFrameMeter({
		report: interfaceStore.getState().reportPerformance,
		...options,
	});

	// One function for the whole run, so asking for the next frame allocates
	// nothing.
	let handle = host.requestFrame(function tick(timestampMs) {
		meter.frame(timestampMs);
		handle = host.requestFrame(tick);
	});
	const stopListening = host.onVisibilityChange(meter.pause);

	return () => {
		host.cancelFrame(handle);
		stopListening();
	};
}
