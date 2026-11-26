import { describe, expect, test } from "bun:test";
import {
	COVERAGE_BBOX,
	paced,
	sameViewport,
	type Timers,
	VIEWPORT_REPORT_INTERVAL_MS,
	viewportOf,
} from "./viewport";

describe("viewportOf", () => {
	test("orders the box west, south, east, north", () => {
		expect(
			viewportOf({ west: -125, south: 24.4, east: -66.9, north: 49.4 }, 4),
		).toEqual({ bbox: [...COVERAGE_BBOX], zoom: 4 });
	});

	test("rounds away float noise", () => {
		const viewport = viewportOf(
			{
				west: -104.99000000000001,
				south: 39.123449,
				east: -104.03,
				north: 39.99995,
			},
			7.600000000000001,
		);

		expect(viewport).toEqual({
			bbox: [-104.99, 39.1234, -104.03, 40],
			zoom: 7.6,
		});
	});

	test("passes on longitudes beyond 180 and holds latitudes to 90", () => {
		const viewport = viewportOf(
			{ west: -250, south: -95, east: 200, north: 91 },
			1,
		);

		expect(viewport.bbox).toEqual([-250, -90, 200, 90]);
	});

	test("never gives a negative zero", () => {
		const viewport = viewportOf(
			{ west: -0.00001, south: -0.00001, east: 1, north: 1 },
			0,
		);

		expect(Object.is(viewport.bbox[0], 0)).toBe(true);
		expect(JSON.stringify(viewport.bbox)).toBe("[0,0,1,1]");
	});
});

describe("sameViewport", () => {
	const a = { bbox: [-125, 24.4, -66.9, 49.4] as const, zoom: 4 };

	test("compares by value", () => {
		expect(sameViewport(a, { bbox: [...a.bbox], zoom: 4 })).toBe(true);
		expect(sameViewport(a, { ...a, zoom: 4.01 })).toBe(false);
		expect(sameViewport(a, { bbox: [-125, 24.4, -66.9, 49.5], zoom: 4 })).toBe(
			false,
		);
	});

	test("null equals only null", () => {
		expect(sameViewport(null, null)).toBe(true);
		expect(sameViewport(a, null)).toBe(false);
		expect(sameViewport(null, a)).toBe(false);
	});
});

/** A clock that moves only when told to, and runs the timers it passes. */
function fakeTimers() {
	let now = 0;
	let nextHandle = 1;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const timers: Timers = {
		now: () => now,
		setTimeout: (callback, ms) => {
			pending.set(nextHandle, { at: now + ms, callback });
			return nextHandle++;
		},
		clearTimeout: (handle) => {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		pending,
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...pending.entries()]
					.filter(([, timer]) => timer.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				pending.delete(due[0]);
				now = due[1].at;
				due[1].callback();
			}
			now = end;
		},
	};
}

describe("paced", () => {
	const interval = VIEWPORT_REPORT_INTERVAL_MS;

	test("delivers the first value at once", () => {
		const clock = fakeTimers();
		const seen: number[] = [];
		const offer = paced((n: number) => seen.push(n), interval, clock.timers);

		offer(1);

		expect(seen).toEqual([1]);
		expect(clock.pending.size).toBe(0);
	});

	test("delivers the newest value of each interval, when it ends", () => {
		const clock = fakeTimers();
		const seen: [number, number][] = [];
		const offer = paced(
			(n: number) => seen.push([n, clock.timers.now()]),
			interval,
			clock.timers,
		);

		// A value every 16 ms for a second, as a pan gives.
		for (let n = 0; n < 60; n++) {
			offer(n);
			clock.advance(16);
		}
		clock.advance(interval);

		expect(seen.map(([, at]) => at)).toEqual([0, 250, 500, 750, 1000]);
		// The place the map came to rest is the last thing delivered.
		expect(seen.at(-1)?.[0]).toBe(59);
		expect(clock.pending.size).toBe(0);
	});

	test("a value after a quiet spell is delivered at once", () => {
		const clock = fakeTimers();
		const seen: number[] = [];
		const offer = paced((n: number) => seen.push(n), interval, clock.timers);

		offer(1);
		clock.advance(interval * 4);
		offer(2);

		expect(seen).toEqual([1, 2]);
	});

	test("cancel drops the value that is waiting", () => {
		const clock = fakeTimers();
		const seen: number[] = [];
		const offer = paced((n: number) => seen.push(n), interval, clock.timers);

		offer(1);
		offer(2);
		offer.cancel();
		clock.advance(interval * 2);

		expect(seen).toEqual([1]);
		expect(clock.pending.size).toBe(0);
	});
});
