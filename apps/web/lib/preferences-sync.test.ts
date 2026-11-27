import { describe, expect, test } from "bun:test";
import {
	defaultPreferences,
	type Preferences,
} from "@/lib/api/preferences-shapes";
import { createInterfaceStore } from "./interface-store";
import {
	applyPreferences,
	createPreferencesSync,
	LOAD_ATTEMPTS,
	LOAD_RETRY_MS,
	preferencesOf,
	SAVE_DELAY_MS,
} from "./preferences-sync";

class FakeTimers {
	private nowMs = 0;
	private next = 1;
	private pending = new Map<number, { at: number; callback: () => void }>();
	setTimeout(callback: () => void, ms: number) {
		this.pending.set(this.next, { at: this.nowMs + ms, callback });
		return this.next++;
	}
	clearTimeout(handle: unknown) {
		this.pending.delete(handle as number);
	}
	waiting() {
		return [...this.pending.values()].map((timer) => timer.at - this.nowMs);
	}
	advance(ms: number) {
		this.nowMs += ms;
		for (const [handle, timer] of [...this.pending]) {
			if (timer.at <= this.nowMs) {
				this.pending.delete(handle);
				timer.callback();
			}
		}
	}
}

/** Lets a settled promise's callbacks run. */
const settle = async () => {
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const stored = (): Preferences => ({
	units: { altitude: "m", speed: "kmh", verticalRate: "ms" },
	layers: { ...defaultPreferences().layers, classB: false, trails: false },
	verticalExaggeration: 4,
});

function syncing(
	options: {
		loads?: (Preferences | Error)[];
		failSaves?: number;
		/** What a failing save rejects with. An `Error` by default. */
		saveFailure?: unknown;
	} = {},
) {
	const interfaceStore = createInterfaceStore();
	const timers = new FakeTimers();
	const loads = options.loads ?? [stored()];
	const saves: Preferences[] = [];
	const warnings: unknown[][] = [];
	let loadCalls = 0;
	let failSaves = options.failSaves ?? 0;
	let sessionsEnded = 0;
	const sync = createPreferencesSync({
		interfaceStore,
		load: async () => {
			const answer = loads[Math.min(loadCalls, loads.length - 1)];
			loadCalls += 1;
			if (answer instanceof Error) throw answer;
			return answer;
		},
		save: async (preferences) => {
			saves.push(preferences);
			if (failSaves > 0) {
				failSaves -= 1;
				throw options.saveFailure ?? new Error("save failed");
			}
		},
		onSessionEnded: () => {
			sessionsEnded += 1;
		},
		timers,
		log: { warn: (...args) => warnings.push(args) },
	});
	return {
		sync,
		timers,
		saves,
		warnings,
		loadCalls: () => loadCalls,
		sessionsEnded: () => sessionsEnded,
		state: () => interfaceStore.getState(),
		current: () => preferencesOf(interfaceStore),
	};
}

describe("loading", () => {
	test("a load answered 401 tells the page the session has ended and is not tried again", async () => {
		const t = syncing({
			loads: [Object.assign(new Error("unauthorized"), { status: 401 })],
		});
		t.sync.start();
		await settle();
		expect(t.sessionsEnded()).toBe(1);
		t.timers.advance(60_000);
		await settle();
		expect(t.loadCalls()).toBe(1);
		expect(t.warnings).toEqual([]);
	});

	test("puts the stored preferences into the store, and saves nothing", async () => {
		const t = syncing();
		t.sync.start();
		await settle();
		expect(t.current()).toEqual(stored());
		t.timers.advance(10 * SAVE_DELAY_MS);
		await settle();
		expect(t.saves).toEqual([]);
	});

	test("a change made before the load has finished is not saved over what is stored", async () => {
		const t = syncing();
		t.sync.start();
		t.state().setUnits({ altitude: "m" });
		t.timers.advance(10 * SAVE_DELAY_MS);
		expect(t.saves).toEqual([]);
		await settle();
		// The stored value has been applied; nothing was written.
		expect(t.current()).toEqual(stored());
		t.timers.advance(10 * SAVE_DELAY_MS);
		expect(t.saves).toEqual([]);
	});

	test("a load that fails is tried again, further apart each time", async () => {
		const down = new Error("down");
		const t = syncing({ loads: [down, down, stored()] });
		t.sync.start();
		await settle();
		expect(t.timers.waiting()).toEqual([LOAD_RETRY_MS]);
		t.timers.advance(LOAD_RETRY_MS);
		await settle();
		expect(t.timers.waiting()).toEqual([2 * LOAD_RETRY_MS]);
		t.timers.advance(2 * LOAD_RETRY_MS);
		await settle();
		expect(t.loadCalls()).toBe(3);
		expect(t.current()).toEqual(stored());
		expect(t.warnings).toEqual([]);
	});

	test("after the last try it gives up, says so, and never saves", async () => {
		const t = syncing({ loads: [new Error("down")] });
		t.sync.start();
		for (let attempt = 0; attempt < LOAD_ATTEMPTS + 2; attempt++) {
			await settle();
			t.timers.advance(LOAD_RETRY_MS * 2 ** attempt);
		}
		await settle();
		expect(t.loadCalls()).toBe(LOAD_ATTEMPTS);
		expect(t.warnings).toHaveLength(1);
		t.state().setLayerVisible("trails", false);
		t.timers.advance(10 * SAVE_DELAY_MS);
		expect(t.saves).toEqual([]);
	});

	test("an answer holding values the store does not know loads as defaults for those", async () => {
		const odd = {
			units: { altitude: "furlongs", speed: "kt", verticalRate: "fpm" },
			layers: { trails: "yes" },
			verticalExaggeration: -3,
		} as unknown as Preferences;
		const t = syncing({ loads: [odd] });
		t.sync.start();
		await settle();
		expect(t.current()).toEqual(defaultPreferences());
	});
});

describe("saving", () => {
	async function loaded(options?: Parameters<typeof syncing>[0]) {
		const t = syncing(options);
		t.sync.start();
		await settle();
		return t;
	}

	test("a change is saved a moment later, whole", async () => {
		const t = await loaded();
		t.state().setLayerVisible("artcc", false);
		t.timers.advance(SAVE_DELAY_MS - 1);
		expect(t.saves).toEqual([]);
		t.timers.advance(1);
		expect(t.saves).toEqual([
			{ ...stored(), layers: { ...stored().layers, artcc: false } },
		]);
	});

	test("changes in quick succession are saved once, as they ended", async () => {
		const t = await loaded();
		for (const value of [5, 6, 7, 8]) {
			t.state().setVerticalExaggeration(value);
			t.timers.advance(SAVE_DELAY_MS / 2);
		}
		t.state().setUnits({ speed: "mph" });
		t.timers.advance(SAVE_DELAY_MS);
		expect(t.saves).toHaveLength(1);
		expect(t.saves[0].verticalExaggeration).toBe(8);
		expect(t.saves[0].units.speed).toBe("mph");
	});

	test("a change that is undone before the save sends nothing", async () => {
		const t = await loaded();
		t.state().setLayerVisible("stems", false);
		t.state().setLayerVisible("stems", true);
		t.timers.advance(SAVE_DELAY_MS);
		expect(t.saves).toEqual([]);
	});

	test("each kind of preference is saved: units, layers and the vertical scale", async () => {
		const t = await loaded();
		t.state().setUnits({ verticalRate: "fpm" });
		t.timers.advance(SAVE_DELAY_MS);
		t.state().setLayerVisible("classB", true);
		t.timers.advance(SAVE_DELAY_MS);
		t.state().setVerticalExaggeration(2);
		t.timers.advance(SAVE_DELAY_MS);
		expect(t.saves.map((save) => save.units.verticalRate)).toEqual([
			"fpm",
			"fpm",
			"fpm",
		]);
		expect(t.saves.map((save) => save.layers.classB)).toEqual([
			false,
			true,
			true,
		]);
		expect(t.saves.map((save) => save.verticalExaggeration)).toEqual([4, 4, 2]);
	});

	test("something that is not a preference is not saved", async () => {
		const t = await loaded();
		t.state().select(7);
		t.state().setSort({ key: "altitude", descending: true });
		t.state().setHudVisible(false);
		t.timers.advance(10 * SAVE_DELAY_MS);
		expect(t.saves).toEqual([]);
	});

	test("a save answered 401 tells the page the session has ended, once, and saves no more", async () => {
		const t = await loaded({
			failSaves: 5,
			saveFailure: Object.assign(new Error("unauthorized"), { status: 401 }),
		});
		t.state().setLayerVisible("artcc", false);
		t.timers.advance(SAVE_DELAY_MS);
		await settle();
		expect(t.saves).toHaveLength(1);
		expect(t.sessionsEnded()).toBe(1);
		// It is not a warning: the page is on its way to sign-in.
		expect(t.warnings).toEqual([]);

		t.state().setLayerVisible("stems", false);
		t.timers.advance(10 * SAVE_DELAY_MS);
		await settle();
		expect(t.saves).toHaveLength(1);
		expect(t.sessionsEnded()).toBe(1);
		// Stopping afterwards, as the page does when it goes, sends nothing.
		t.sync.stop();
		await settle();
		expect(t.saves).toHaveLength(1);
	});

	test("a save that fails some other way does not", async () => {
		const t = await loaded({
			failSaves: 1,
			saveFailure: Object.assign(new Error("down"), { status: 503 }),
		});
		t.state().setLayerVisible("artcc", false);
		t.timers.advance(SAVE_DELAY_MS);
		await settle();
		expect(t.sessionsEnded()).toBe(0);
		expect(t.warnings).toHaveLength(1);
	});

	test("a save that fails is sent again with the next change", async () => {
		const t = await loaded({ failSaves: 1 });
		t.state().setLayerVisible("artcc", false);
		t.timers.advance(SAVE_DELAY_MS);
		await settle();
		expect(t.saves).toHaveLength(1);
		expect(t.warnings).toHaveLength(1);

		t.state().setLayerVisible("stems", false);
		t.timers.advance(SAVE_DELAY_MS);
		expect(t.saves).toHaveLength(2);
		expect(t.saves[1].layers).toMatchObject({ artcc: false, stems: false });
	});

	test("stopping saves at once what was waiting, and nothing after", async () => {
		const t = await loaded();
		t.state().setUnits({ altitude: "ft" });
		t.sync.stop();
		expect(t.saves).toHaveLength(1);
		expect(t.saves[0].units.altitude).toBe("ft");
		t.state().setUnits({ altitude: "m" });
		t.timers.advance(10 * SAVE_DELAY_MS);
		expect(t.saves).toHaveLength(1);
	});
});

test("applying preferences and reading them back gives the same", () => {
	const interfaceStore = createInterfaceStore();
	applyPreferences(interfaceStore, stored());
	expect(preferencesOf(interfaceStore)).toEqual(stored());
});
