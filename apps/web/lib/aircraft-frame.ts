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
//   3. The views go to the target, which copies them to the GPU.
//   4. The selected and the hovered aircraft are looked up by id,
//      `store.row_of(id)`, and the target is told which rows to mark. Rows
//      are reused from one positions frame to the next, so the row is asked
//      for again every frame and never kept.
//   5. The target repaints the map, which draws rows 0..count.
//   6. The three timings are reported: the advance, the attribute update
//      and the map's render.
//
// Nothing is allocated in a frame unless the views are made again: the
// views, the readings object and the callbacks are all made once. (The
// four numbers `performance.now()` returns are the exception.)
//
// The aircraft count is not reported from here. The socket client reports
// the count as of the newest frame, once a second; `store.len()` is the
// rows the last `advance` wrote, and two writers with two meanings would
// take turns on the HUD.

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
	/**
	 * The row of an aircraft, if it is in the newest positions frame. It is
	 * a row of the output buffers only once `advance` has run after that
	 * frame arrived, so ask straight after `advance`, as a frame does.
	 */
	row_of(id: number): number | undefined;
	/** Points in the trail of an aircraft whose track is held; 0 for none. */
	trail_len(id: number): number;
	/** f32 × 3 a point. Rewritten by `advance`, and may move on `ingest`. */
	trail_positions_ptr(id: number): number;
};

/** The store and the WASM memory its buffers are in. */
export type FrameSource = {
	store: FrameStore;
	memory: { readonly buffer: ArrayBuffer };
	/**
	 * Called after every `advance`: where the selection is cleared once its
	 * aircraft has left the picture (lib/selection.ts).
	 */
	selection?: { afterAdvance(): void };
};

/** The aircraft to mark on the map: the interface store's state, in the app. */
export type MarkedAircraft = {
	selectedId: number | null;
	hoveredId: number | null;
	/**
	 * A finished flight's track to draw (`RECORDED_TRAIL`): lon, lat and
	 * altitude in feet for each point. Left out or null for none.
	 */
	recordedFlight?: { positions: Float32Array; points: number } | null;
	/**
	 * Which layers are shown. With `trails` false the selected and the
	 * hovered aircraft have no trail; a finished flight's track, which was
	 * asked for by name, is still drawn. Left out, everything is shown.
	 */
	layers?: { trails: boolean };
};

/** A row to mark that is not there: nothing selected, or not in the picture. */
export const NO_ROW = -1;

/** Which trail `AircraftTarget.trail` is given. */
export const SELECTED_TRAIL = 0;
export const HOVERED_TRAIL = 1;
/** A finished flight's recorded track, which ends at no icon. */
export const RECORDED_TRAIL = 2;

const NO_TRAIL = new Float32Array(0);

/**
 * A view over one trail in WASM memory, kept until the trail moves, grows
 * or the memory is replaced, so that a frame with nothing new makes no
 * object.
 */
type TrailView = {
	buffer: ArrayBuffer | null;
	pointer: number;
	points: number;
	view: Float32Array;
};

function emptyTrailView(): TrailView {
	return { buffer: null, pointer: 0, points: 0, view: NO_TRAIL };
}

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
	/** Takes rows `0..count` of `views`, to be drawn at the next repaint. */
	draw(views: AircraftViews, count: number): void;
	/**
	 * Says which rows of `views` to mark as selected and as hovered, each
	 * NO_ROW for none. Called after `draw` on every frame, so a mark follows
	 * its aircraft as it moves and as its row changes. The hovered row is
	 * NO_ROW when the hovered aircraft is the selected one.
	 */
	mark(views: AircraftViews, selectedRow: number, hoveredRow: number): void;
	/**
	 * Draws the trail of the selected aircraft (`SELECTED_TRAIL`) or the
	 * hovered one (`HOVERED_TRAIL`): `points` of lon, lat and altitude,
	 * oldest first, ending at the aircraft's icon. `RECORDED_TRAIL` is a
	 * finished flight's track, given when it changes and not every frame. Fewer than two points is
	 * no trail. The view is over WASM memory and is good for this call only.
	 */
	trail(which: number, positions: Float32Array, points: number): void;
	/**
	 * Draws the map now, aircraft and all, and returns when it has. Called
	 * after `draw` on every frame with aircraft in it, and once more when
	 * the last has gone.
	 */
	repaint(): void;
	/** Draws no aircraft and no marks. Called when there is no traffic to draw. */
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
	 * The selected and the hovered aircraft, asked for every frame:
	 * `interfaceStore.getState` in the app. Left out, nothing is marked.
	 */
	marked?: () => MarkedAircraft;
	/**
	 * What the store multiplies altitude by in the positions it writes. 0,
	 * the default, lays the picture flat for 2D; 3D is milestone 6.
	 */
	altitudeScale?: number | (() => number);
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
	marked,
	altitudeScale = 0,
	now = () => performance.now(),
}: AircraftFrameOptions): AircraftFrame {
	// The store the altitude scale was last set on, and the scale.
	let scaledStore: FrameStore | null = null;
	let appliedScale = typeof altitudeScale === "function" ? 0 : altitudeScale;
	let views: AircraftViews | null = null;
	let viewsStore: FrameStore | null = null;
	let viewsGeneration = 0;
	// True while the target is drawing nothing, so `clear` is called once.
	let cleared = true;

	// Rows the target was last given, so an emptied picture is painted once.
	let drawnCount = 0;

	// One object for the life of the loop: `report` copies the readings out.
	// NaN is "not measured", which the HUD shows as a dash.
	const trailViews = [emptyTrailView(), emptyTrailView()];
	// The recorded track the target holds; null for none, as at the start
	// and after `clear`.
	let drawnRecorded: MarkedAircraft["recordedFlight"] = null;

	/**
	 * Gives the target a finished flight's track when it changes, and not
	 * every frame: unlike a trail it does not move.
	 */
	function drawRecorded(recorded: MarkedAircraft["recordedFlight"] = null) {
		if (recorded === drawnRecorded) return;
		drawnRecorded = recorded;
		if (recorded === null || recorded.points < 2) {
			target.trail(RECORDED_TRAIL, NO_TRAIL, 0);
			return;
		}
		// Altitude as the store writes it for aircraft: feet times the scale.
		const scaled = recorded.positions.slice(0, recorded.points * 3);
		for (let i = 2; i < scaled.length; i += 3) scaled[i] *= appliedScale;
		target.trail(RECORDED_TRAIL, scaled, recorded.points);
	}

	function drawTrail(
		which: number,
		store: FrameStore,
		memory: { readonly buffer: ArrayBuffer },
		id: number | null,
	) {
		const points = id === null ? 0 : store.trail_len(id);
		if (id === null || points < 2) {
			target.trail(which, NO_TRAIL, 0);
			return;
		}
		const held = trailViews[which];
		const pointer = store.trail_positions_ptr(id);
		// WASM memory is a new ArrayBuffer whenever it grows.
		if (
			held.buffer !== memory.buffer ||
			held.pointer !== pointer ||
			held.points !== points
		) {
			held.buffer = memory.buffer;
			held.pointer = pointer;
			held.points = points;
			held.view = new Float32Array(memory.buffer, pointer, points * 3);
		}
		target.trail(which, held.view, points);
	}

	const readings = {
		wasmAdvanceMs: Number.NaN,
		attributeUpdateMs: Number.NaN,
		mapRenderMs: Number.NaN,
	};

	return {
		frame(frameMs) {
			const traffic = source();
			if (traffic === null) {
				// No socket: before the shell has started one, or under a preview
				// that pins the connection. Nothing is advanced or drawn.
				if (!cleared) {
					target.clear();
					cleared = true;
					drawnRecorded = null;
					drawnCount = 0;
				}
				readings.wasmAdvanceMs = Number.NaN;
				readings.attributeUpdateMs = Number.NaN;
				readings.mapRenderMs = Number.NaN;
				report(readings, frameMs);
				return;
			}
			const { store, memory } = traffic;
			// Asked for every frame when it is a function: the scale changes
			// with 2D and 3D and with the vertical exaggeration.
			const scale =
				typeof altitudeScale === "function" ? altitudeScale() : altitudeScale;
			if (scaledStore !== store || appliedScale !== scale) {
				store.set_altitude_scale(scale);
				scaledStore = store;
				if (appliedScale !== scale) {
					appliedScale = scale;
					// A recorded track's heights were written at the old scale.
					drawnRecorded = null;
				}
			}

			const startMs = now();
			store.advance(frameMs);
			const advancedMs = now();
			// Before the marks are looked up: this may clear the selection.
			traffic.selection?.afterAdvance();

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
			if (marked) {
				// By id, every frame: the row an aircraft is in changes whenever
				// a positions frame adds or drops another.
				const { selectedId, hoveredId, recordedFlight, layers } = marked();
				const trails = layers?.trails ?? true;
				drawRecorded(recordedFlight);
				const selectedRow = rowOf(store, selectedId, count);
				const hoveredRow =
					hoveredId === selectedId ? NO_ROW : rowOf(store, hoveredId, count);
				target.mark(views, selectedRow, hoveredRow);
				// The trails `advance` has just written. The hovered aircraft
				// has none of its own while it is also the selected one.
				drawTrail(SELECTED_TRAIL, store, memory, trails ? selectedId : null);
				drawTrail(
					HOVERED_TRAIL,
					store,
					memory,
					!trails || hoveredId === selectedId ? null : hoveredId,
				);
			}
			cleared = false;
			const drawnMs = now();

			readings.wasmAdvanceMs = advancedMs - startMs;
			readings.attributeUpdateMs = drawnMs - advancedMs;
			if (count > 0 || drawnCount > 0) {
				target.repaint();
				readings.mapRenderMs = now() - drawnMs;
			} else {
				// An empty picture that was empty before: the map is left to
				// repaint when it has its own reasons to, and is not timed.
				readings.mapRenderMs = Number.NaN;
			}
			drawnCount = count;
			report(readings, frameMs);
		},
		views: () => views,
	};
}

/** The row `id` is drawn in, or NO_ROW if there is no such aircraft among the `count` drawn. */
function rowOf(store: FrameStore, id: number | null, count: number): number {
	if (id === null) return NO_ROW;
	const row = store.row_of(id);
	return row === undefined || row >= count ? NO_ROW : row;
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
		// the browser's queue ahead of anything the work itself asks for,
		// such as a repaint the map schedules for itself.
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
