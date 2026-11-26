import { describe, expect, test } from "bun:test";
import {
	type AircraftViews,
	createAircraftFrame,
	createFrameLoop,
	type FrameLoopEnvironment,
	type FrameSource,
	NO_ROW,
} from "@/lib/aircraft-frame";
import {
	createInterfaceStore,
	PERFORMANCE_PUBLISH_INTERVAL_MS,
} from "@/lib/interface-store";

/**
 * A stand-in for the WASM store: buffers at fixed offsets in a "memory"
 * that can be grown, which, like the real one, replaces its ArrayBuffer
 * and leaves the old one detached.
 */
function fakeTraffic(rows: number) {
	let buffer = new ArrayBuffer(1 << 16);
	let capacity = 1_024;
	let generation = 1;
	let count = rows;
	let scale = 1;
	// The aircraft id drawn in each row; a test moves them about.
	let rowIds: number[] = Array.from({ length: rows }, (_, row) => 100 + row);
	const advancedTo: number[] = [];
	const POSITIONS = 0;
	const ANGLES = 1 << 15;
	const COLORS = 3 << 14;

	const store = {
		advance(renderMs: number) {
			advancedTo.push(renderMs);
			// Every row's longitude is the frame time, so a test can tell which
			// frame a view shows.
			const positions = new Float32Array(buffer, POSITIONS, capacity * 3);
			// And its latitude is its aircraft's id, so a test can tell whose
			// position a row holds.
			for (let row = 0; row < count; row++) {
				positions[row * 3] = renderMs;
				positions[row * 3 + 1] = rowIds[row] ?? 0;
			}
		},
		row_of(id: number) {
			const row = rowIds.indexOf(id);
			return row === -1 ? undefined : row;
		},
		set_altitude_scale(value: number) {
			scale = value;
		},
		len: () => count,
		capacity: () => capacity,
		view_generation: () => generation,
		positions_ptr: () => POSITIONS,
		angles_ptr: () => ANGLES,
		colors_ptr: () => COLORS,
	};
	const traffic: FrameSource = {
		store,
		memory: {
			get buffer() {
				return buffer;
			},
		},
	};
	return {
		traffic,
		advancedTo,
		scale: () => scale,
		setCount(next: number) {
			count = next;
		},
		/** A positions frame arrives: these aircraft, in these rows. */
		setRows(ids: number[]) {
			rowIds = ids;
			count = ids.length;
		},
		/** WASM memory grows: every view over the old buffer is detached. */
		growMemory() {
			buffer = buffer.transfer(buffer.byteLength * 2);
			generation += 1;
		},
		/** The store's buffers grow, without the memory growing. */
		growCapacity() {
			capacity *= 2;
			generation += 1;
		},
	};
}

function recordingTarget() {
	const draws: { views: AircraftViews; count: number }[] = [];
	const marks: {
		selectedRow: number;
		hoveredRow: number;
		/** The latitude in the marked row, which the fake store sets to the id. */
		selectedLatitude: number | undefined;
	}[] = [];
	let clears = 0;
	let repaints = 0;
	return {
		draws,
		marks,
		clears: () => clears,
		repaints: () => repaints,
		target: {
			draw(views: AircraftViews, count: number) {
				draws.push({ views, count });
			},
			mark(views: AircraftViews, selectedRow: number, hoveredRow: number) {
				marks.push({
					selectedRow,
					hoveredRow,
					selectedLatitude:
						selectedRow === NO_ROW
							? undefined
							: views.positions[selectedRow * 3 + 1],
				});
			},
			repaint() {
				repaints += 1;
			},
			clear() {
				clears += 1;
			},
		},
	};
}

/** A clock that moves on by `stepMs` each time it is read. */
function steppingClock(stepMs: number) {
	let nowMs = 0;
	return () => {
		nowMs += stepMs;
		return nowMs;
	};
}

describe("a frame", () => {
	test("advances the store to the frame's time and draws the rows in use", () => {
		const fake = fakeTraffic(3);
		const { target, draws } = recordingTarget();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target,
			report: () => {},
		});

		frame.frame(1_000);

		expect(fake.advancedTo).toEqual([1_000]);
		expect(draws).toHaveLength(1);
		expect(draws[0].count).toBe(3);
		expect(draws[0].views.capacity).toBe(1_024);
		expect(draws[0].views.positions).toHaveLength(1_024 * 3);
		expect(draws[0].views.angles).toHaveLength(1_024);
		expect(draws[0].views.colors).toHaveLength(1_024 * 4);
		// The view is over the store's memory, not a copy of it.
		expect(draws[0].views.positions.buffer).toBe(fake.traffic.memory.buffer);
		expect(draws[0].views.positions[0]).toBe(1_000);
	});

	test("lays the picture flat before the first advance", () => {
		const fake = fakeTraffic(1);
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target: recordingTarget().target,
			report: () => {},
		});
		expect(fake.scale()).toBe(1);
		frame.frame(0);
		expect(fake.scale()).toBe(0);
	});

	test("keeps the same views while the generation holds, whatever the count", () => {
		const fake = fakeTraffic(3);
		const { target, draws } = recordingTarget();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target,
			report: () => {},
		});

		frame.frame(0);
		fake.setCount(900);
		frame.frame(16);
		frame.frame(32);

		expect(draws.map((draw) => draw.count)).toEqual([3, 900, 900]);
		expect(draws[1].views).toBe(draws[0].views);
		expect(draws[2].views).toBe(draws[0].views);
		expect(draws[2].views.positions[899 * 3]).toBe(32);
	});

	test("makes the views again when WASM memory grows", () => {
		const fake = fakeTraffic(3);
		const { target, draws } = recordingTarget();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target,
			report: () => {},
		});

		frame.frame(0);
		const before = draws[0].views;
		fake.growMemory();
		// What the generation is for: the old view is detached, reads as
		// empty, and says nothing about it.
		expect(before.positions).toHaveLength(0);

		frame.frame(16);

		const after = draws[1].views;
		expect(after).not.toBe(before);
		expect(after.positions).toHaveLength(1_024 * 3);
		expect(after.positions.buffer).toBe(fake.traffic.memory.buffer);
		expect(after.positions[0]).toBe(16);
		expect(frame.views()).toBe(after);
	});

	test("makes the views again, longer, when the store's buffers grow", () => {
		const fake = fakeTraffic(3);
		const { target, draws } = recordingTarget();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target,
			report: () => {},
		});

		frame.frame(0);
		fake.growCapacity();
		fake.setCount(2_000);
		frame.frame(16);

		expect(draws[1].views).not.toBe(draws[0].views);
		expect(draws[1].views.capacity).toBe(2_048);
		expect(draws[1].views.colors).toHaveLength(2_048 * 4);
		expect(draws[1].count).toBe(2_000);
	});

	test("reports the three timings through one reused object, and not the count", () => {
		const fake = fakeTraffic(7);
		const reported: object[] = [];
		const store = createInterfaceStore();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target: recordingTarget().target,
			report: (readings, nowMs) => {
				reported.push(readings);
				store.getState().reportPerformance(readings, nowMs);
			},
			// Read four times a frame: before the advance, after it, after
			// the upload and after the repaint.
			now: steppingClock(0.5),
		});

		frame.frame(0);
		expect(store.getState().performance).toMatchObject({
			wasmAdvanceMs: 0.5,
			attributeUpdateMs: 0.5,
			mapRenderMs: 0.5,
		});

		frame.frame(PERFORMANCE_PUBLISH_INTERVAL_MS);
		expect(reported[1]).toBe(reported[0]);
		expect(Object.keys(reported[0]).sort()).toEqual([
			"attributeUpdateMs",
			"mapRenderMs",
			"wasmAdvanceMs",
		]);
		// The readings the frame does not take are left as they were: the
		// count is the socket client's.
		expect(store.getState().performance.aircraftCount).toBe(0);
		expect(store.getState().performance.fps).toBeNaN();
	});

	test("repaints the map on every frame with aircraft, and once more when the last has gone", () => {
		const fake = fakeTraffic(3);
		const { target, repaints } = recordingTarget();
		const store = createInterfaceStore();
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target,
			report: store.getState().reportPerformance,
			now: steppingClock(0.5),
		});

		frame.frame(0);
		frame.frame(16);
		expect(repaints()).toBe(2);

		fake.setCount(0);
		frame.frame(PERFORMANCE_PUBLISH_INTERVAL_MS);
		expect(repaints()).toBe(3);
		expect(store.getState().performance.mapRenderMs).toBe(0.5);

		frame.frame(2 * PERFORMANCE_PUBLISH_INTERVAL_MS);
		frame.frame(3 * PERFORMANCE_PUBLISH_INTERVAL_MS);
		expect(repaints()).toBe(3);
		// Not timed while the map is left to itself.
		expect(store.getState().performance.mapRenderMs).toBeNaN();
		expect(store.getState().performance.wasmAdvanceMs).toBe(0.5);
	});

	test("with no traffic, as under a preview that pins the connection, draws nothing", () => {
		const { target, draws, clears, repaints } = recordingTarget();
		const store = createInterfaceStore();
		const frame = createAircraftFrame({
			source: () => null,
			target,
			report: store.getState().reportPerformance,
		});

		frame.frame(0);
		frame.frame(16);

		expect(draws).toHaveLength(0);
		expect(clears()).toBe(0);
		expect(repaints()).toBe(0);
		expect(frame.views()).toBeNull();
		expect(store.getState().performance.wasmAdvanceMs).toBeNaN();
		expect(store.getState().performance.mapRenderMs).toBeNaN();
	});

	test("clears the picture once when the traffic stops", () => {
		const fake = fakeTraffic(3);
		let running: FrameSource | null = fake.traffic;
		const { target, draws, clears } = recordingTarget();
		const store = createInterfaceStore();
		const frame = createAircraftFrame({
			source: () => running,
			target,
			report: store.getState().reportPerformance,
		});

		frame.frame(0);
		running = null;
		frame.frame(PERFORMANCE_PUBLISH_INTERVAL_MS);
		frame.frame(2 * PERFORMANCE_PUBLISH_INTERVAL_MS);

		expect(draws).toHaveLength(1);
		expect(clears()).toBe(1);
		expect(fake.advancedTo).toEqual([0]);
		// The timings go back to "not measured".
		expect(store.getState().performance.wasmAdvanceMs).toBeNaN();

		running = fake.traffic;
		frame.frame(3 * PERFORMANCE_PUBLISH_INTERVAL_MS);
		expect(draws).toHaveLength(2);
	});
});

/** A browser with a frame queue the test runs by hand. */
function fakeBrowser() {
	let nextHandle = 1;
	let hidden = false;
	const waiting = new Map<number, (frameMs: number) => void>();
	const listeners = new Set<() => void>();
	const environment: FrameLoopEnvironment = {
		requestFrame(callback) {
			const handle = nextHandle++;
			waiting.set(handle, callback);
			return handle;
		},
		cancelFrame(handle) {
			waiting.delete(handle);
		},
		hidden: () => hidden,
		onVisibilityChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		environment,
		waiting: () => waiting.size,
		listeners: () => listeners.size,
		/** Runs the frames that are waiting, as one animation frame does. */
		runFrame(frameMs: number) {
			const callbacks = [...waiting.values()];
			waiting.clear();
			for (const callback of callbacks) callback(frameMs);
		},
		setHidden(value: boolean) {
			hidden = value;
			for (const listener of listeners) listener();
		},
	};
}

describe("the marks", () => {
	function marking(rows: number) {
		const fake = fakeTraffic(rows);
		const recorded = recordingTarget();
		const marked = {
			selectedId: null as number | null,
			hoveredId: null as number | null,
		};
		const frame = createAircraftFrame({
			source: () => fake.traffic,
			target: recorded.target,
			report: () => {},
			marked: () => marked,
		});
		return { fake, marks: recorded.marks, marked, frame };
	}

	test("with nothing selected or hovered, no row is marked", () => {
		const { marks, frame } = marking(3);
		frame.frame(1_000);
		expect(marks).toEqual([
			{ selectedRow: NO_ROW, hoveredRow: NO_ROW, selectedLatitude: undefined },
		]);
	});

	test("marks the rows the selected and the hovered aircraft are in", () => {
		const { marks, marked, frame } = marking(4);
		marked.selectedId = 102;
		marked.hoveredId = 100;
		frame.frame(1_000);
		expect(marks[0]).toMatchObject({ selectedRow: 2, hoveredRow: 0 });
	});

	test("the mark follows its aircraft when the rows are reordered", () => {
		const { fake, marks, marked, frame } = marking(4);
		marked.selectedId = 102;
		frame.frame(1_000);
		expect(marks[0]).toMatchObject({ selectedRow: 2, selectedLatitude: 102 });

		// Aircraft 100 leaves and the last row takes its place, as the store
		// does; then two more arrive ahead of it.
		fake.setRows([103, 101, 102]);
		frame.frame(2_000);
		expect(marks[1]).toMatchObject({ selectedRow: 2, selectedLatitude: 102 });

		fake.setRows([103, 102, 104, 105, 101]);
		frame.frame(3_000);
		expect(marks[2]).toMatchObject({ selectedRow: 1, selectedLatitude: 102 });

		// Row 2, where it was first found, is now somebody else's.
		fake.setRows([102, 103, 104]);
		frame.frame(4_000);
		expect(marks[3]).toMatchObject({ selectedRow: 0, selectedLatitude: 102 });
	});

	test("an aircraft that has left the picture is not marked, and is again when it returns", () => {
		const { fake, marks, marked, frame } = marking(3);
		marked.selectedId = 101;
		marked.hoveredId = 102;
		fake.setRows([100, 102]);
		frame.frame(1_000);
		expect(marks[0]).toMatchObject({ selectedRow: NO_ROW, hoveredRow: 1 });

		fake.setRows([100, 102, 101]);
		frame.frame(2_000);
		expect(marks[1]).toMatchObject({ selectedRow: 2, hoveredRow: 1 });
	});

	test("a row past the rows drawn is not marked", () => {
		const { fake, marks, marked, frame } = marking(3);
		marked.selectedId = 102;
		// The store names row 2 and has drawn only two rows.
		fake.setCount(2);
		frame.frame(1_000);
		expect(marks[0]).toMatchObject({ selectedRow: NO_ROW });
	});

	test("hovering the selected aircraft marks it once, as selected", () => {
		const { marks, marked, frame } = marking(3);
		marked.selectedId = 101;
		marked.hoveredId = 101;
		frame.frame(1_000);
		expect(marks[0]).toMatchObject({ selectedRow: 1, hoveredRow: NO_ROW });
	});

	test("the selection is checked after the advance and before the marks are looked up", () => {
		const fake = fakeTraffic(3);
		const recorded = recordingTarget();
		const marked = { selectedId: 101 as number | null, hoveredId: null };
		const calls: number[] = [];
		const frame = createAircraftFrame({
			source: () => ({
				...fake.traffic,
				selection: {
					afterAdvance() {
						calls.push(fake.advancedTo.length);
						// What the selection does when the aircraft has gone.
						marked.selectedId = null;
					},
				},
			}),
			target: recorded.target,
			report: () => {},
			marked: () => marked,
		});

		frame.frame(1_000);

		expect(calls).toEqual([1]);
		expect(recorded.marks[0]).toMatchObject({ selectedRow: NO_ROW });
	});
});

describe("the frame loop", () => {
	test("calls back once per animation frame with the frame's time", () => {
		const browser = fakeBrowser();
		const frames: number[] = [];
		const loop = createFrameLoop(
			(frameMs) => frames.push(frameMs),
			browser.environment,
		);

		expect(browser.waiting()).toBe(0);
		loop.start();
		browser.runFrame(10);
		browser.runFrame(26);

		expect(frames).toEqual([10, 26]);
		expect(browser.waiting()).toBe(1);
		expect(loop.running()).toBe(true);
	});

	test("starting twice does not run two loops", () => {
		const browser = fakeBrowser();
		const frames: number[] = [];
		const loop = createFrameLoop(
			(frameMs) => frames.push(frameMs),
			browser.environment,
		);

		loop.start();
		loop.start();
		browser.runFrame(10);

		expect(frames).toEqual([10]);
		expect(browser.waiting()).toBe(1);
		expect(browser.listeners()).toBe(1);
	});

	test("stopping cancels the waiting frame and stops listening", () => {
		const browser = fakeBrowser();
		const frames: number[] = [];
		const loop = createFrameLoop(
			(frameMs) => frames.push(frameMs),
			browser.environment,
		);

		loop.start();
		browser.runFrame(10);
		loop.stop();
		browser.runFrame(26);

		expect(frames).toEqual([10]);
		expect(browser.waiting()).toBe(0);
		expect(browser.listeners()).toBe(0);
		expect(loop.running()).toBe(false);
	});

	test("a mount, an unmount and a mount again, as React does in development, leaves one loop", () => {
		const browser = fakeBrowser();
		const frames: string[] = [];
		const first = createFrameLoop(() => frames.push("a"), browser.environment);
		first.start();
		first.stop();
		const second = createFrameLoop(() => frames.push("b"), browser.environment);
		second.start();

		browser.runFrame(10);
		browser.runFrame(26);

		expect(frames).toEqual(["b", "b"]);
		expect(browser.waiting()).toBe(1);
	});

	test("stops while the tab is hidden and starts again when it is shown", () => {
		const browser = fakeBrowser();
		const frames: number[] = [];
		const loop = createFrameLoop(
			(frameMs) => frames.push(frameMs),
			browser.environment,
		);

		loop.start();
		browser.runFrame(10);
		browser.setHidden(true);
		expect(browser.waiting()).toBe(0);
		expect(loop.running()).toBe(false);

		browser.setHidden(false);
		browser.setHidden(false);
		expect(browser.waiting()).toBe(1);
		browser.runFrame(5_000);

		expect(frames).toEqual([10, 5_000]);
	});

	test("started in a hidden tab, waits until it is shown", () => {
		const browser = fakeBrowser();
		const frames: number[] = [];
		const loop = createFrameLoop(
			(frameMs) => frames.push(frameMs),
			browser.environment,
		);

		browser.setHidden(true);
		loop.start();
		expect(browser.waiting()).toBe(0);
		browser.setHidden(false);
		browser.runFrame(10);

		expect(frames).toEqual([10]);
	});

	test("asks for its next frame before doing the frame's work", () => {
		const browser = fakeBrowser();
		const waitingDuringWork: number[] = [];
		const loop = createFrameLoop(
			() => waitingDuringWork.push(browser.waiting()),
			browser.environment,
		);

		loop.start();
		browser.runFrame(10);

		expect(waitingDuringWork).toEqual([1]);
	});

	test("stops, and says so once, if a frame throws", () => {
		const browser = fakeBrowser();
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const loop = createFrameLoop(() => {
				throw new Error("lost context");
			}, browser.environment);
			loop.start();
			browser.runFrame(10);
			browser.runFrame(26);

			expect(errors).toHaveLength(1);
			expect(browser.waiting()).toBe(0);
			expect(loop.running()).toBe(false);
		} finally {
			console.error = original;
		}
	});
});
