import { describe, expect, test } from "bun:test";
import {
	createFlightDetail,
	type DetailStore,
	formatAgo,
	formatRoute,
	formatTrack,
	profileCeilingFt,
} from "./flight-detail";
import { createInterfaceStore } from "./interface-store";

type Aircraft = {
	callsign: string;
	type: string;
	origin: string;
	destination: string;
	altitude: number;
	speed: number;
	rate: number;
	track: number;
	clone?: boolean;
	/** Sim time and altitude in 25 ft steps of each track sample. */
	flown?: [number, number][];
};

function fakeTraffic(aircraft: Record<number, Aircraft>) {
	let buffer = new ArrayBuffer(8_192);
	const TIMES = 1_024;
	const ALTITUDES = 4_096;
	const present = new Set(Object.keys(aircraft).map(Number));
	const newest =
		<K extends keyof Aircraft>(key: K) =>
		(id: number) =>
			present.has(id) ? aircraft[id]?.[key] : undefined;
	const store: DetailStore = {
		row_of: (id) => (present.has(id) ? 0 : undefined),
		callsign: (id) => aircraft[id]?.callsign,
		aircraft_type: (id) => aircraft[id]?.type,
		origin: (id) => aircraft[id]?.origin,
		destination: (id) => aircraft[id]?.destination,
		icao24: (id) => (aircraft[id] ? 0xa1b2c : undefined),
		altitude_ft: newest("altitude"),
		ground_speed_kt: newest("speed"),
		track_deg: newest("track"),
		vertical_rate_fpm: newest("rate"),
		on_ground: (id) => (present.has(id) ? false : undefined),
		synthetic: (id) => aircraft[id]?.clone,
		track_len: (id) => aircraft[id]?.flown?.length ?? 0,
		track_times_ptr(id) {
			const flown = aircraft[id]?.flown ?? [];
			new Uint32Array(buffer, TIMES, flown.length).set(
				flown.map(([time]) => time),
			);
			return TIMES;
		},
		track_altitudes_ptr(id) {
			const flown = aircraft[id]?.flown ?? [];
			new Int16Array(buffer, ALTITUDES, flown.length).set(
				flown.map(([, altitude]) => altitude),
			);
			return ALTITUDES;
		},
	};
	return {
		aircraft,
		source: {
			store,
			memory: {
				get buffer() {
					return buffer;
				},
			},
		},
		leave: (id: number) => present.delete(id),
		growMemory() {
			buffer = buffer.transfer(buffer.byteLength * 2);
		},
	};
}

class FakeTimers {
	private intervals = new Map<number, () => void>();
	private next = 1;
	setInterval(callback: () => void) {
		this.intervals.set(this.next, callback);
		return this.next++;
	}
	clearInterval(handle: unknown) {
		this.intervals.delete(handle as number);
	}
	running() {
		return this.intervals.size;
	}
	tick() {
		for (const callback of [...this.intervals.values()]) callback();
	}
}

const PICTURE = (): Record<number, Aircraft> => ({
	7: {
		callsign: "UAL12",
		type: "B738",
		origin: "KORD",
		destination: "KJFK",
		altitude: 35_000,
		speed: 450,
		rate: -640,
		track: 92.4,
		flown: [
			[100, 400],
			[110, 800],
			[120, 1_400],
		],
	},
	8: {
		callsign: "N14MS",
		type: "C337",
		origin: "",
		destination: "",
		altitude: 2_500,
		speed: 120,
		rate: 0,
		track: 359.7,
		clone: true,
	},
});

function detailing() {
	const fake = fakeTraffic(PICTURE());
	const interfaceStore = createInterfaceStore();
	const timers = new FakeTimers();
	let running = true;
	const detail = createFlightDetail({
		source: () => (running ? fake.source : null),
		interfaceStore,
		timers,
	});
	let notified = 0;
	const unsubscribe = detail.subscribe(() => {
		notified += 1;
	});
	return {
		fake,
		detail,
		timers,
		state: () => interfaceStore.getState(),
		notified: () => notified,
		unsubscribe,
		stopTraffic() {
			running = false;
		},
	};
}

describe("the detail panel's data", () => {
	test("with nothing selected there is nothing, and nobody is told", () => {
		const { detail, timers, notified } = detailing();
		expect(detail.getSnapshot()).toBeNull();
		timers.tick();
		timers.tick();
		expect(notified()).toBe(0);
	});

	test("a selected aircraft is read at once: who it is, where, and what it has flown", () => {
		const { detail, state } = detailing();
		state().select(7);
		expect(detail.getSnapshot()).toEqual({
			id: 7,
			present: true,
			callsign: "UAL12",
			aircraftType: "B738",
			origin: "KORD",
			destination: "KJFK",
			icao24: "0a1b2c",
			synthetic: false,
			altitudeFt: 35_000,
			groundSpeedKt: 450,
			trackDeg: 92.4,
			verticalRateFpm: -640,
			onGround: false,
			// Steps of 25 ft become feet.
			profile: {
				timesS: [100, 110, 120],
				altitudesFt: [10_000, 20_000, 35_000],
			},
		});
	});

	test("it is read again every second, so the numbers follow the picture", () => {
		const { fake, detail, state, timers, notified } = detailing();
		state().select(7);
		const first = detail.getSnapshot();
		fake.aircraft[7].altitude = 34_750;
		fake.aircraft[7].flown?.push([130, 1_390]);
		timers.tick();
		const second = detail.getSnapshot();
		expect(second).not.toBe(first);
		expect(second?.altitudeFt).toBe(34_750);
		expect(second?.profile.timesS).toEqual([100, 110, 120, 130]);
		expect(notified()).toBe(2);
	});

	test("a clone is read the same way, and says it is one", () => {
		const { detail, state } = detailing();
		state().select(8);
		expect(detail.getSnapshot()).toMatchObject({
			callsign: "N14MS",
			synthetic: true,
			present: true,
			altitudeFt: 2_500,
			origin: "",
			profile: { timesS: [], altitudesFt: [] },
		});
	});

	test("an aircraft that has left keeps its name and its profile, and loses its numbers", () => {
		const { fake, detail, state, timers } = detailing();
		state().select(7);
		fake.leave(7);
		timers.tick();
		expect(detail.getSnapshot()).toMatchObject({
			present: false,
			callsign: "UAL12",
			altitudeFt: null,
			groundSpeedKt: null,
			trackDeg: null,
			verticalRateFpm: null,
			profile: { altitudesFt: [10_000, 20_000, 35_000] },
		});
	});

	test("the profile is a copy, so growing WASM memory does not empty it", () => {
		const { fake, detail, state } = detailing();
		state().select(7);
		const snapshot = detail.getSnapshot();
		fake.growMemory();
		expect(snapshot?.profile.altitudesFt).toEqual([10_000, 20_000, 35_000]);
	});

	test("deselecting, or the traffic stopping, clears it once", () => {
		const { detail, state, timers, notified, stopTraffic } = detailing();
		state().select(7);
		state().select(null);
		expect(detail.getSnapshot()).toBeNull();
		const told = notified();
		timers.tick();
		expect(notified()).toBe(told);

		state().select(8);
		stopTraffic();
		timers.tick();
		expect(detail.getSnapshot()).toBeNull();
	});

	test("works only while someone is subscribed", () => {
		const { detail, state, timers, unsubscribe } = detailing();
		expect(timers.running()).toBe(1);
		unsubscribe();
		expect(timers.running()).toBe(0);
		state().select(7);
		expect(detail.getSnapshot()).toBeNull();
	});
});

describe("what the panel says", () => {
	test("the route, or nothing when neither end is known", () => {
		expect(formatRoute({ origin: "KORD", destination: "KJFK" })).toBe(
			"KORD → KJFK",
		);
		expect(formatRoute({ origin: "", destination: "KJFK" })).toBe("? → KJFK");
		expect(formatRoute({ origin: "KORD", destination: "" })).toBe("KORD → ?");
		expect(formatRoute({ origin: "", destination: "" })).toBeNull();
	});

	test("the track as three digits", () => {
		expect(formatTrack(92.4)).toBe("092°");
		expect(formatTrack(0)).toBe("000°");
		expect(formatTrack(359.7)).toBe("000°");
		expect(formatTrack(277)).toBe("277°");
		expect(formatTrack(null)).toBe("—");
	});

	test("how long ago", () => {
		expect(formatAgo(0)).toBe("now");
		expect(formatAgo(4)).toBe("now");
		expect(formatAgo(45)).toBe("45 s ago");
		expect(formatAgo(90)).toBe("2 min ago");
		expect(formatAgo(2_520)).toBe("42 min ago");
	});

	test("the profile's ceiling is a round number that leaves a quarter of the axis clear", () => {
		expect(profileCeilingFt([0, 600])).toBe(1_000);
		expect(profileCeilingFt([2_500])).toBe(5_000);
		expect(profileCeilingFt([30_000])).toBe(40_000);
		expect(profileCeilingFt([35_000])).toBe(50_000);
		expect(profileCeilingFt([41_000])).toBe(60_000);
		expect(profileCeilingFt([51_000])).toBe(70_000);
		expect(profileCeilingFt([])).toBe(1_000);
		expect(profileCeilingFt([-200])).toBe(1_000);
		// Never more than three quarters of the way up.
		for (const highest of [100, 999, 7_600, 14_999, 29_000, 45_000, 60_000]) {
			expect(highest / profileCeilingFt([highest])).toBeLessThanOrEqual(0.75);
		}
	});
});
