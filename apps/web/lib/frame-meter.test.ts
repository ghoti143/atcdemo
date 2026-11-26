import { describe, expect, test } from "bun:test";
import {
	createFrameMeter,
	FPS_WINDOW_MS,
	FRAME_WINDOW,
	type FrameMeterHost,
	type FrameReadings,
	startFrameMeter,
} from "./frame-meter";
import {
	createInterfaceStore,
	PERFORMANCE_PUBLISH_INTERVAL_MS,
} from "./interface-store";

/** Feeds frames `intervals` apart, starting at `fromMs`; returns the last time. */
function run(
	meter: { frame: (timestampMs: number) => void },
	intervals: readonly number[],
	fromMs = 0,
): number {
	let now = fromMs;
	meter.frame(now);
	for (const interval of intervals) {
		now += interval;
		meter.frame(now);
	}
	return now;
}

const repeat = (value: number, times: number) =>
	Array.from({ length: times }, () => value);

describe("createFrameMeter", () => {
	test("has nothing to say before two frames", () => {
		const meter = createFrameMeter();
		expect(meter.readings.fps).toBeNaN();

		meter.frame(1000);

		expect(meter.sampleCount).toBe(0);
		expect(meter.readings.fps).toBeNaN();
		expect(meter.readings.frameTimeP95Ms).toBeNaN();
		expect(meter.readings.frameTimeP99Ms).toBeNaN();
	});

	test("steady frames read as their rate and their interval", () => {
		const meter = createFrameMeter();

		// Two seconds at 50 Hz, whose times are whole numbers.
		run(meter, repeat(20, 100));

		expect(meter.readings.fps).toBe(50);
		expect(meter.readings.frameTimeP95Ms).toBe(20);
		expect(meter.readings.frameTimeP99Ms).toBe(20);
	});

	test("percentiles are the nearest rank of the window", () => {
		// Worked out on every frame, to read them at an exact count.
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		// 100 intervals: 1, 2, … 100 ms, shuffled by a fixed stride.
		const intervals = Array.from(
			{ length: 100 },
			(_, i) => ((i * 37) % 100) + 1,
		);
		run(meter, intervals);

		expect(meter.sampleCount).toBe(100);
		expect(meter.readings.frameTimeP95Ms).toBe(95);
		expect(meter.readings.frameTimeP99Ms).toBe(99);
	});

	test("a few slow frames move the 99th percentile before the 95th", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		// 200 frames, 4 of them slow: 2% of the window.
		const intervals = repeat(10, 200);
		for (const at of [20, 70, 120, 170]) intervals[at] = 50;
		run(meter, intervals);

		expect(meter.readings.frameTimeP95Ms).toBe(10);
		expect(meter.readings.frameTimeP99Ms).toBe(50);
	});

	test("frames per second is over the last second only", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		// A slow second, then exactly a second at 100 Hz.
		const now = run(meter, repeat(100, 10));
		run(meter, repeat(10, FPS_WINDOW_MS / 10), now);

		expect(meter.readings.fps).toBe(100);
		// The percentiles still see the slow frames.
		expect(meter.readings.frameTimeP99Ms).toBe(100);
	});

	test("the figures change once a publish interval, not once a frame", () => {
		let reports = 0;
		let changes = 0;
		let lastFps = Number.NaN;
		const meter = createFrameMeter({
			report: (readings) => {
				reports += 1;
				if (!Object.is(readings.fps, lastFps)) {
					changes += 1;
					lastFps = readings.fps;
				}
			},
		});

		// A second of frames, each a little longer than the last so that
		// every compute gives a new figure.
		const intervals = Array.from({ length: 50 }, (_, i) => 19.5 + i * 0.02);
		const elapsed = run(meter, intervals);

		expect(reports).toBe(51);
		// Once at the first interval, then once each publish interval.
		expect(changes).toBe(
			1 + Math.floor(elapsed / PERFORMANCE_PUBLISH_INTERVAL_MS),
		);
	});

	test("the gap across a pause is not a frame", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		const hiddenAt = run(meter, repeat(16, 60));
		meter.pause();
		// The tab was hidden for half a minute.
		run(meter, repeat(16, 60), hiddenAt + 30_000);

		expect(meter.sampleCount).toBe(120);
		expect(meter.readings.frameTimeP99Ms).toBe(16);
		expect(meter.readings.fps).toBe(62.5);
	});

	test("the same gap without a pause is a stall, and is counted", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		const stalledAt = run(meter, repeat(16, 60));
		meter.frame(stalledAt + 3000);

		expect(meter.sampleCount).toBe(61);
		expect(meter.readings.frameTimeP99Ms).toBe(3000);
	});

	test("the window holds the newest frames once it has wrapped", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		// Slow frames fill the window and then some, and are pushed out one
		// by one by fast ones.
		let now = run(meter, repeat(40, FRAME_WINDOW + 50));
		expect(meter.sampleCount).toBe(FRAME_WINDOW);
		expect(meter.readings.frameTimeP95Ms).toBe(40);

		now = run(meter, repeat(10, FRAME_WINDOW - 1), now);
		// One frame of the gap between the two runs is the frame at `now`
		// given twice, which adds nothing; one slow frame is left.
		expect(meter.sampleCount).toBe(FRAME_WINDOW);
		expect(meter.readings.frameTimeP99Ms).toBe(10);
		expect(meter.readings.fps).toBe(100);

		run(meter, [10, 10], now);
		expect(meter.readings.frameTimeP99Ms).toBe(10);
	});

	test("a window of another size wraps the same way", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0, capacity: 4 });

		run(meter, [100, 100, 100, 100, 1, 2, 3]);
		expect(meter.sampleCount).toBe(4);
		// Holds 100, 1, 2, 3.
		expect(meter.readings.frameTimeP99Ms).toBe(100);

		meter.frame(410);
		// Holds 1, 2, 3, 4.
		expect(meter.readings.frameTimeP99Ms).toBe(4);
		expect(meter.readings.fps).toBe(400);
	});

	test("the same timestamp twice is one frame", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		for (let now = 0; now <= 200; now += 20) {
			meter.frame(now);
			meter.frame(now);
		}

		expect(meter.sampleCount).toBe(10);
		expect(meter.readings.fps).toBe(50);
	});

	test("a timestamp earlier than the last starts a new run", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });

		run(meter, repeat(20, 10), 50_000);
		run(meter, repeat(20, 10), 100);

		expect(meter.sampleCount).toBe(20);
		expect(meter.readings.frameTimeP99Ms).toBe(20);
	});

	test("reports one object, every frame, and keeps its buffers", () => {
		const seen = new Set<FrameReadings>();
		const times: number[] = [];
		const meter = createFrameMeter({
			report: (readings, nowMs) => {
				seen.add(readings);
				times.push(nowMs);
			},
		});

		// Typed arrays made while the meter runs would show here; the two it
		// made at the start are all it may use.
		const made: number[] = [];
		const RealFloat64Array = globalThis.Float64Array;
		globalThis.Float64Array = new Proxy(RealFloat64Array, {
			construct(target, args) {
				made.push(1);
				return Reflect.construct(target, args);
			},
		});
		try {
			run(meter, repeat(16, FRAME_WINDOW * 3));
		} finally {
			globalThis.Float64Array = RealFloat64Array;
		}

		expect(made).toEqual([]);
		expect(seen.size).toBe(1);
		expect(seen.has(meter.readings)).toBe(true);
		expect(times).toHaveLength(FRAME_WINDOW * 3 + 1);
		expect(times[1]).toBe(16);
	});

	test("reset forgets every frame", () => {
		const meter = createFrameMeter({ computeIntervalMs: 0 });
		run(meter, repeat(16, 30));

		meter.reset();

		expect(meter.sampleCount).toBe(0);
		expect(meter.readings.fps).toBeNaN();
		meter.frame(10_000);
		expect(meter.sampleCount).toBe(0);
	});
});

/** A stand-in for the browser, which hands out frames when told to. */
function fakeHost() {
	let callback: ((timestampMs: number) => void) | null = null;
	let nextHandle = 1;
	const callbacks = new Set<unknown>();
	const listeners = new Set<() => void>();
	const host: FrameMeterHost = {
		requestFrame: (next) => {
			callback = next;
			callbacks.add(next);
			nextHandle += 1;
			return nextHandle;
		},
		cancelFrame: (handle) => {
			if (handle === nextHandle) callback = null;
		},
		onVisibilityChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		host,
		callbacks,
		listeners,
		/** Runs the frame that was asked for; false when none was. */
		frame(timestampMs: number) {
			const run = callback;
			callback = null;
			run?.(timestampMs);
			return run !== null;
		},
		changeVisibility() {
			for (const listener of listeners) listener();
		},
	};
}

describe("startFrameMeter", () => {
	test("measures frames until stopped", () => {
		const browser = fakeHost();
		const reported: FrameReadings[] = [];
		const stop = startFrameMeter({
			host: browser.host,
			report: (readings) => reported.push({ ...readings }),
		});

		for (let now = 0; now <= 1000; now += 20) {
			expect(browser.frame(now)).toBe(true);
		}
		expect(reported).toHaveLength(51);
		expect(reported.at(-1)?.fps).toBe(50);
		// One callback served every frame.
		expect(browser.callbacks.size).toBe(1);

		stop();
		expect(browser.frame(1020)).toBe(false);
		expect(browser.listeners.size).toBe(0);
		expect(reported).toHaveLength(51);
	});

	test("a hidden tab's gap is not counted", () => {
		const browser = fakeHost();
		let last: FrameReadings | undefined;
		const stop = startFrameMeter({
			host: browser.host,
			computeIntervalMs: 0,
			report: (readings) => {
				last = readings;
			},
		});

		for (let now = 0; now <= 400; now += 20) browser.frame(now);
		browser.changeVisibility(); // hidden: no frames
		browser.changeVisibility(); // shown again, a minute later
		for (let now = 60_000; now <= 60_400; now += 20) browser.frame(now);

		expect(last?.frameTimeP99Ms).toBe(20);
		expect(last?.fps).toBe(50);
		stop();
	});

	test("its reports reach a store's HUD readings a few times a second", () => {
		const browser = fakeHost();
		const store = createInterfaceStore();
		let changes = 0;
		store.subscribe(
			(state) => state.performance,
			() => {
				changes += 1;
			},
		);
		const stop = startFrameMeter({
			host: browser.host,
			report: store.getState().reportPerformance,
		});

		// Something else reports once and goes quiet.
		store.getState().reportPerformance({ skippedFrames: 4 }, 1);
		expect(changes).toBe(1);
		store.getState().reportPerformance({ skippedFrames: 5 }, 2);

		for (let now = 0; now <= 2000; now += 20) browser.frame(now);
		stop();

		const { performance } = store.getState();
		expect(performance.fps).toBe(50);
		expect(performance.frameTimeP95Ms).toBe(20);
		// The held reading went out with the meter's.
		expect(performance.skippedFrames).toBe(5);
		// Frames 20 ms apart first pass 250 ms on every thirteenth: seven
		// times in two seconds, after the one publish above.
		expect(changes).toBe(1 + 7);
	});
});
