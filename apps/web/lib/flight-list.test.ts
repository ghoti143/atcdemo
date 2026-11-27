import { describe, expect, test } from "bun:test";
import {
	createFlightList,
	formatAltitude,
	formatSpeed,
	formatVerticalRate,
	type ListStore,
	SORT_CODES,
} from "./flight-list";
import { createInterfaceStore, SORT_KEYS } from "./interface-store";

type Aircraft = {
	callsign: string;
	type: string;
	altitude: number;
	speed: number;
	rate: number;
	ground?: boolean;
	clone?: boolean;
};

/**
 * A stand-in for the WASM store: it sorts by callsign or altitude and
 * filters on the callsign, and counts what is asked of it.
 */
function fakeTraffic(aircraft: Record<number, Aircraft>, bytes = 4_096) {
	let buffer = new ArrayBuffer(bytes);
	const LIST = 1_024;
	const refreshes: { sort: number; descending: boolean; filter: string }[] = [];
	const asked: string[] = [];
	const field =
		<K extends keyof Aircraft>(name: string, key: K) =>
		(id: number) => {
			asked.push(`${name} ${id}`);
			return aircraft[id]?.[key];
		};
	const store: ListStore = {
		list_refresh(sort, descending, filter) {
			refreshes.push({ sort, descending, filter });
			const ids = Object.keys(aircraft)
				.map(Number)
				.filter((id) =>
					aircraft[id].callsign.includes(filter.trim().toUpperCase()),
				)
				.sort((a, b) =>
					sort === SORT_CODES.altitude
						? aircraft[a].altitude - aircraft[b].altitude
						: aircraft[a].callsign.localeCompare(aircraft[b].callsign),
				);
			if (descending) ids.reverse();
			new Uint32Array(buffer, LIST, ids.length).set(ids);
			return ids.length;
		},
		list_ids_ptr: () => LIST,
		callsign: field("callsign", "callsign"),
		aircraft_type: field("type", "type"),
		origin: () => undefined,
		destination: () => "KJFK",
		altitude_ft: field("altitude", "altitude"),
		ground_speed_kt: field("speed", "speed"),
		vertical_rate_fpm: field("rate", "rate"),
		on_ground: (id) => aircraft[id]?.ground ?? undefined,
		synthetic: (id) => aircraft[id]?.clone ?? undefined,
	};
	return {
		aircraft,
		refreshes,
		asked,
		source: {
			store,
			memory: {
				get buffer() {
					return buffer;
				},
			},
		},
		/** WASM memory grows: a view over the old buffer is detached. */
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

const PICTURE: Record<number, Aircraft> = {
	7: { callsign: "UAL12", type: "B738", altitude: 35_000, speed: 450, rate: 0 },
	8: {
		callsign: "DAL7",
		type: "A320",
		altitude: 12_000,
		speed: 300,
		rate: 1_920,
	},
	9: {
		callsign: "UAL900",
		type: "B77W",
		altitude: 38_000,
		speed: 480,
		rate: -640,
	},
};

function listing(aircraft: Record<number, Aircraft> = { ...PICTURE }) {
	const fake = fakeTraffic(aircraft);
	const interfaceStore = createInterfaceStore();
	const timers = new FakeTimers();
	let running = true;
	let clock = 0;
	const list = createFlightList({
		source: () => (running ? fake.source : null),
		interfaceStore,
		timers,
		now: () => {
			clock += 2;
			return clock;
		},
	});
	let notified = 0;
	const unsubscribe = list.subscribe(() => {
		notified += 1;
	});
	return {
		fake,
		list,
		timers,
		state: () => interfaceStore.getState(),
		notified: () => notified,
		unsubscribe,
		stopTraffic() {
			running = false;
		},
	};
}

describe("the flight list", () => {
	test("is worked out when it is first shown, sorted by callsign", () => {
		const { fake, list } = listing();
		expect(list.getSnapshot().count).toBe(3);
		expect([0, 1, 2].map((index) => list.idAt(index))).toEqual([8, 7, 9]);
		expect(fake.refreshes).toEqual([
			{ sort: SORT_CODES.callsign, descending: false, filter: "" },
		]);
	});

	test("makes strings only for the rows that are asked for", () => {
		const { fake, list } = listing();
		expect(fake.asked).toEqual([]);
		expect(list.row(1)).toEqual({
			id: 7,
			callsign: "UAL12",
			aircraftType: "B738",
			origin: "",
			destination: "KJFK",
			altitudeFt: 35_000,
			groundSpeedKt: 450,
			verticalRateFpm: 0,
			onGround: false,
			synthetic: false,
		});
		// One aircraft's fields, and nobody else's.
		expect(new Set(fake.asked.map((entry) => entry.split(" ")[1]))).toEqual(
			new Set(["7"]),
		);
	});

	test("a row past the end, or not a whole number, is null", () => {
		const { list } = listing();
		for (const index of [3, -1, 1.5, Number.NaN]) {
			expect(list.row(index)).toBeNull();
			expect(list.idAt(index)).toBeNull();
		}
	});

	test("is worked out again every second, and the snapshot changes with it", () => {
		const { fake, list, timers, notified } = listing();
		const first = list.getSnapshot();
		expect(list.getSnapshot()).toBe(first);

		fake.aircraft[10] = {
			callsign: "AAL1",
			type: "B789",
			altitude: 41_000,
			speed: 500,
			rate: 0,
		};
		timers.tick();
		const second = list.getSnapshot();
		expect(second).not.toBe(first);
		expect(second.count).toBe(4);
		expect(second.version).toBe(first.version + 1);
		expect(list.idAt(0)).toBe(10);
		expect(notified()).toBe(2);

		// Nothing new: the list is the same and the snapshot is still new,
		// because the rows' numbers have moved on.
		timers.tick();
		expect(list.getSnapshot().count).toBe(4);
		expect(list.getSnapshot()).not.toBe(second);
	});

	test("a changed sort or filter works it out at once", () => {
		const { fake, list, state } = listing();
		state().setSort({ key: "altitude", descending: true });
		expect(fake.refreshes.at(-1)).toEqual({
			sort: SORT_CODES.altitude,
			descending: true,
			filter: "",
		});
		expect([0, 1, 2].map((index) => list.idAt(index))).toEqual([9, 7, 8]);

		state().setFilters({ text: "ual" });
		expect(fake.refreshes.at(-1)?.filter).toBe("ual");
		expect(list.getSnapshot().count).toBe(2);
		expect([0, 1].map((index) => list.idAt(index))).toEqual([9, 7]);
		expect(list.idAt(2)).toBeNull();
		expect(fake.refreshes).toHaveLength(3);
	});

	test("finds where an aircraft is, for scrolling to a selection", () => {
		const { list, state } = listing();
		expect(list.indexOf(9)).toBe(2);
		expect(list.indexOf(8)).toBe(0);
		expect(list.indexOf(404)).toBe(-1);
		// Filtered out is not in the list.
		state().setFilters({ text: "DAL" });
		expect(list.indexOf(9)).toBe(-1);
	});

	test("keeps its own copy of the ids, so growing WASM memory does not lose them", () => {
		const { fake, list } = listing();
		fake.growMemory();
		expect([0, 1, 2].map((index) => list.idAt(index))).toEqual([8, 7, 9]);
		expect(list.row(0)?.callsign).toBe("DAL7");
	});

	test("an aircraft that left since the refresh keeps its place and loses its numbers", () => {
		const { fake, list } = listing();
		delete fake.aircraft[7];
		expect(list.row(1)).toMatchObject({
			id: 7,
			callsign: "",
			altitudeFt: null,
			groundSpeedKt: null,
			verticalRateFpm: null,
		});
	});

	test("with no traffic the list is empty, and says so once", () => {
		const { list, timers, notified, stopTraffic } = listing();
		stopTraffic();
		timers.tick();
		expect(list.getSnapshot().count).toBe(0);
		expect(list.row(0)).toBeNull();
		const told = notified();
		timers.tick();
		expect(notified()).toBe(told);
	});

	test("holds more aircraft than it started with room for", () => {
		// The list's own buffer starts with room for 1,024 ids.
		const many: Record<number, Aircraft> = {};
		for (let id = 1; id <= 1_500; id++) {
			many[id] = {
				callsign: `T${String(id).padStart(4, "0")}`,
				type: "B738",
				altitude: id,
				speed: 1,
				rate: 0,
			};
		}
		const fake = fakeTraffic(many, 1 << 16);
		const list = createFlightList({
			source: () => fake.source,
			interfaceStore: createInterfaceStore(),
			timers: new FakeTimers(),
		});
		list.subscribe(() => {});
		expect(list.getSnapshot().count).toBe(1_500);
		expect(list.idAt(0)).toBe(1);
		expect(list.idAt(1_499)).toBe(1_500);
	});

	test("works only while someone is subscribed", () => {
		const { fake, list, timers, unsubscribe, state } = listing();
		expect(timers.running()).toBe(1);
		unsubscribe();
		expect(timers.running()).toBe(0);
		const before = fake.refreshes.length;
		state().setSort({ key: "altitude", descending: false });
		state().setFilters({ text: "x" });
		expect(fake.refreshes).toHaveLength(before);

		// And starts again, with the sort that now stands.
		const again = list.subscribe(() => {});
		expect(timers.running()).toBe(1);
		expect(fake.refreshes.at(-1)).toEqual({
			sort: SORT_CODES.altitude,
			descending: false,
			filter: "x",
		});
		again();
	});

	test("reports how long the refresh took", () => {
		const { list } = listing();
		// The fake clock moves 2 ms each time it is read.
		expect(list.getSnapshot().refreshMs).toBe(2);
	});
});

test("every sort key has a code, in the order WASM numbers them", () => {
	expect(SORT_KEYS.map((key) => SORT_CODES[key])).toEqual([
		0, 1, 2, 3, 4, 5, 6,
	]);
});

describe("what a row says", () => {
	test("altitude in feet, or GND", () => {
		expect(formatAltitude({ altitudeFt: 35_000, onGround: false })).toBe(
			"35,000",
		);
		expect(formatAltitude({ altitudeFt: 2_175, onGround: false })).toBe(
			"2,175",
		);
		expect(formatAltitude({ altitudeFt: 600, onGround: true })).toBe("GND");
		expect(formatAltitude({ altitudeFt: null, onGround: false })).toBe("—");
		expect(formatAltitude({ altitudeFt: -25, onGround: false })).toBe("-25");
	});

	test("speed in knots", () => {
		expect(formatSpeed(450)).toBe("450");
		expect(formatSpeed(1_200)).toBe("1,200");
		expect(formatSpeed(null)).toBe("—");
	});

	test("vertical rate with its sign", () => {
		expect(formatVerticalRate(1_920)).toBe("+1,920");
		expect(formatVerticalRate(-640)).toBe("−640");
		expect(formatVerticalRate(0)).toBe("0");
		expect(formatVerticalRate(null)).toBe("—");
	});
});
