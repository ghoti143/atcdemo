// One animation frame of the aircraft picture, and the loop that asks for
// frames. No import of the map, deck.gl or the DOM, so `bun test` runs it.
// See docs/DESIGN.md section 8.
//
// Each frame:
//
//   1. `store.advance(frameMs)` writes where every aircraft is into the
//      store's output buffers, inside WASM memory.
//   2. `store.view_generation()` is compared with the one the views were
//      made at. Only when it differs are the three typed-array views made
//      again: a buffer has moved, or WASM memory has grown and detached
//      them. A detached view reports length zero and raises nothing, so
//      this comparison is the only thing that catches it.
//   3. The views go to the target, which copies them to the GPU and draws
//      rows 0..count.
//   4. The two timings and the count are reported.
//
// Nothing is allocated in a frame unless the views are made again: the
// views, the readings object and the callbacks are all made once.

import type { PerformanceReadings } from "@/lib/interface-store";

/** What a frame calls on the aircraft store (`AircraftStore` in atc-wasm). */
export type FrameStore = {
	advance(renderMs: number): void;
	set_altitude_scale(scale: number): void;
	len(): number;
	capacity(): number;
	view_generation(): number;
	positions_ptr(): number;
	angles_ptr(): number;
	colors_ptr(): number;
};

/** The store and the WASM memory its buffers are in. */
export type FrameSource = {
	store: FrameStore;
	memory: { readonly buffer: ArrayBuffer };
};

/**
 * Views over the store's output buffers, each `capacity` rows long. Rows
 * `0..count` are in use; the count is passed beside them.
 */
export type AircraftViews = {
	/** f32 × 3 a row: lon, lat, altitude times the store's altitude scale. */
	positions: Float32Array;
	/** f32 a row: degrees counter-clockwise, the negative of track. */
	angles: Float32Array;
	/** u8 × 4 a row: red, green, blue, alpha, by altitude band. */
	colors: Uint8Array;
	/** Rows each view has room for. */
	capacity: number;
};

/** Where a frame's picture goes: the GPU, in the app. */
export type AircraftTarget = {
	/** Takes rows `0..count` of `views` and draws them. */
	draw(views: AircraftViews, count: number): void;
	/** Draws no aircraft. Called when there is no traffic to draw. */
	clear(): void;
};

export type AircraftFrameOptions = {
	/**
	 * The page's traffic, or null when nothing is running. Called every
	 * frame: `currentTraffic` in the app.
	 */
	source: () => FrameSource | null;
	target: AircraftTarget;
	/** `reportPerformance` of the interface store. */
	report: (readings: Partial<PerformanceReadings>, nowMs: number) => void;
	/**
	 * What the store multiplies altitude by in the positions it writes. 0,
	 * the default, lays the picture flat for 2D; 3D is milestone 6.
	 */
	altitudeScale?: number;
	/** The clock the timings are taken with. `performance.now` by default. */
	now?: () => number;
};

export type AircraftFrame = {
	/**
	 * Draws the picture as of `frameMs`, which is on the clock the socket
	 * client gives `ingest`: an animation frame's timestamp.
	 */
	frame(frameMs: number): void;
	/** The views in use, or null before the first frame with traffic. */
	views(): AircraftViews | null;
};

export function createAircraftFrame({
	source,
	target,
	report,
	altitudeScale = 0,
	now = () => performance.now(),
}: AircraftFrameOptions): AircraftFrame {
	// The store the altitude scale was last set on.
	let scaledStore: FrameStore | null = null;
	let views: AircraftViews | null = null;
	let viewsStore: FrameStore | null = null;
	let viewsGeneration = 0;
	// True while the target is drawing nothing, so `clear` is called once.
	let cleared = true;

	// One object for the life of the loop: `report` copies the readings out.
	const readings = { wasmAdvanceMs: 0, attributeUpdateMs: 0, aircraftCount: 0 };

	return {
		frame(frameMs) {
			const traffic = source();
			if (traffic === null) {
				// No socket: before the shell has started one, or under a preview
				// that pins the connection. Nothing is advanced or drawn.
				if (!cleared) {
					target.clear();
					cleared = true;
				}
				readings.wasmAdvanceMs = 0;
				readings.attributeUpdateMs = 0;
				readings.aircraftCount = 0;
				report(readings, frameMs);
				return;
			}
			const { store, memory } = traffic;
			if (scaledStore !== store) {
				store.set_altitude_scale(altitudeScale);
				scaledStore = store;
			}

			const startMs = now();
			store.advance(frameMs);
			const advancedMs = now();

			// After `advance`, before the views are used: see the notes above.
			const generation = store.view_generation();
			if (
				views === null ||
				viewsStore !== store ||
				viewsGeneration !== generation
			) {
				const buffer = memory.buffer;
				const capacity = store.capacity();
				views = {
					positions: new Float32Array(
						buffer,
						store.positions_ptr(),
						capacity * 3,
					),
					angles: new Float32Array(buffer, store.angles_ptr(), capacity),
					colors: new Uint8Array(buffer, store.colors_ptr(), capacity * 4),
					capacity,
				};
				viewsStore = store;
				viewsGeneration = generation;
			}

			const count = store.len();
			target.draw(views, count);
			cleared = false;
			const drawnMs = now();

			readings.wasmAdvanceMs = advancedMs - startMs;
			readings.attributeUpdateMs = drawnMs - advancedMs;
			readings.aircraftCount = count;
			report(readings, frameMs);
		},
		views: () => views,
	};
}

/** What the loop needs of the browser. Tests give their own. */
export type FrameLoopEnvironment = {
	requestFrame(callback: (frameMs: number) => void): number;
	cancelFrame(handle: number): void;
	/** Whether the tab is hidden now. */
	hidden(): boolean;
	/** Calls `listener` when the tab is hidden or shown. Returns the way to stop. */
	onVisibilityChange(listener: () => void): () => void;
};

export function browserFrameLoopEnvironment(): FrameLoopEnvironment {
	return {
		requestFrame: (callback) => requestAnimationFrame(callback),
		cancelFrame: (handle) => cancelAnimationFrame(handle),
		hidden: () => document.hidden,
		onVisibilityChange: (listener) => {
			document.addEventListener("visibilitychange", listener);
			return () => document.removeEventListener("visibilitychange", listener);
		},
	};
}

export type FrameLoop = {
	/** Starts asking for frames. Does nothing if it is already running. */
	start(): void;
	/** Stops for good, and cancels the frame that is waiting. */
	stop(): void;
	/** Whether a frame is waiting. False while the tab is hidden. */
	running(): boolean;
};

/**
 * Calls `onFrame` once per animation frame while the tab is shown.
 *
 * A hidden tab gets no frames from the browser anyway; the loop also
 * cancels the one it has asked for, so nothing of it is left waiting, and
 * asks again when the tab is shown. The store needs no catching up then
 * (section 8): the socket client has kept its clock.
 *
 * At most one frame is ever waiting, however often `start` is called, and
 * `stop` leaves none, so React's development double mount cannot leave two
 * loops running.
 *
 * If `onFrame` throws, the loop stops and says so once: the same error 60
 * times a second helps nobody.
 */
export function createFrameLoop(
	onFrame: (frameMs: number) => void,
	environment: FrameLoopEnvironment = browserFrameLoopEnvironment(),
): FrameLoop {
	let handle: number | null = null;
	let started = false;
	let stopListening: (() => void) | null = null;

	const tick = (frameMs: number) => {
		// Asked for before the work is done, so this loop's next frame is in
		// the browser's queue ahead of anything the work itself asks for. The
		// map's repaint is one such: it then draws, in the same animation
		// frame, what this loop has just written.
		handle = environment.requestFrame(tick);
		try {
			onFrame(frameMs);
		} catch (cause) {
			stop();
			console.error("The render loop stopped:", cause);
		}
	};

	const wait = () => {
		if (handle === null && !environment.hidden()) {
			handle = environment.requestFrame(tick);
		}
	};
	const cancel = () => {
		if (handle !== null) {
			environment.cancelFrame(handle);
			handle = null;
		}
	};

	function stop() {
		started = false;
		cancel();
		stopListening?.();
		stopListening = null;
	}

	return {
		start() {
			if (started) return;
			started = true;
			stopListening = environment.onVisibilityChange(() => {
				if (environment.hidden()) cancel();
				else wait();
			});
			wait();
		},
		stop,
		running: () => handle !== null,
	};
}
