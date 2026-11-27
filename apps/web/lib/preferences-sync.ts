// Keeps the interface store's preferences and the server's copy the same:
// loads them when the page starts and saves them when they change. No
// import of React or the DOM, so `bun test` runs it.
//
// - Nothing is saved until the load has succeeded. Otherwise a page that
//   could not load would write its defaults over what the user had stored.
//   A load that fails is tried again a few times, further apart each time.
// - A change is saved a moment after it is made, and changes in quick
//   succession, as from dragging a slider, are saved once.
// - What is sent is all of the preferences, so the last save wins whole.
// - Applying what was loaded is not a change to save.

import {
	type Preferences,
	readStoredPreferences,
} from "@/lib/api/preferences-shapes";
import { LAYER_IDS } from "@/lib/interface-store";
import type { InterfaceStoreLike } from "@/lib/socket-client";

/** How long after the last change the save is made. */
export const SAVE_DELAY_MS = 600;
/** How long after a failed load the first retry is made; each doubles. */
export const LOAD_RETRY_MS = 2_000;
/** Loads tried in all before giving up for this page load. */
export const LOAD_ATTEMPTS = 4;

export type PreferencesSyncOptions = {
	interfaceStore: InterfaceStoreLike;
	/** `GET /api/preferences`. */
	load: () => Promise<Preferences>;
	/** `PUT /api/preferences`. */
	save: (preferences: Preferences) => Promise<unknown>;
	/**
	 * Called when a load or a save is answered 401: the session has ended
	 * under the open page. Sending the browser to sign-in, in the app.
	 * After it nothing more is loaded or saved.
	 */
	onSessionEnded?: () => void;
	timers?: {
		setTimeout(callback: () => void, ms: number): unknown;
		clearTimeout(handle: unknown): void;
	};
	log?: Pick<Console, "warn">;
};

export type PreferencesSync = {
	start(): void;
	/** Stops, saving at once anything that was waiting to be. */
	stop(): void;
};

/** The preferences as the interface store holds them now. */
export function preferencesOf(store: InterfaceStoreLike): Preferences {
	const { units, layers, verticalExaggeration } = store.getState();
	return { units: { ...units }, layers: { ...layers }, verticalExaggeration };
}

/** Puts `preferences` into the interface store. */
export function applyPreferences(
	store: InterfaceStoreLike,
	preferences: Preferences,
): void {
	const state = store.getState();
	state.setUnits(preferences.units);
	for (const layer of LAYER_IDS) {
		state.setLayerVisible(layer, preferences.layers[layer]);
	}
	state.setVerticalExaggeration(preferences.verticalExaggeration);
}

export function createPreferencesSync({
	interfaceStore,
	load,
	save,
	onSessionEnded,
	timers = {
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	},
	log = console,
}: PreferencesSyncOptions): PreferencesSync {
	let running = false;
	let loaded = false;
	// What the server is known to hold, as text, to tell a change from none.
	let saved = "";
	let saveTimer: unknown = null;
	let retryTimer: unknown = null;
	let stopListening: (() => void)[] = [];

	/**
	 * Whether `cause` is a route's 401. If it is, the sync stops and the
	 * page is told: no retry will be answered differently, and until now
	 * a save refused this way left the user's changes unkept with nothing
	 * saying so.
	 */
	function sessionEnded(cause: unknown): boolean {
		const status = (cause as { status?: unknown } | null)?.status;
		if (status !== 401) return false;
		if (running) {
			running = false;
			for (const stop of stopListening) stop();
			stopListening = [];
			if (saveTimer !== null) timers.clearTimeout(saveTimer);
			if (retryTimer !== null) timers.clearTimeout(retryTimer);
			saveTimer = null;
			retryTimer = null;
			onSessionEnded?.();
		}
		return true;
	}

	function saveNow() {
		saveTimer = null;
		const next = preferencesOf(interfaceStore);
		const text = JSON.stringify(next);
		if (text === saved) return;
		const before = saved;
		saved = text;
		save(next).catch((cause: unknown) => {
			// Left as unsaved, so the next change sends it again, with that
			// change. Nothing is retried on a timer: the user is told nothing
			// was lost by the page still showing what they chose.
			if (saved === text) saved = before;
			if (sessionEnded(cause)) return;
			log.warn("[preferences] could not be saved", cause);
		});
	}

	function changed() {
		if (!loaded) return;
		if (saveTimer !== null) timers.clearTimeout(saveTimer);
		saveTimer = timers.setTimeout(saveNow, SAVE_DELAY_MS);
	}

	function tryLoad(attempt: number) {
		retryTimer = null;
		load().then(
			(stored) => {
				if (!running) return;
				// Read again here, so an answer of an unexpected shape cannot
				// put a value into the store that it does not know.
				const preferences = readStoredPreferences(stored);
				saved = JSON.stringify(preferences);
				loaded = true;
				applyPreferences(interfaceStore, preferences);
				// The store may have refused a value; what it now holds is
				// what there is to compare the next change with.
				saved = JSON.stringify(preferencesOf(interfaceStore));
			},
			(cause: unknown) => {
				if (!running) return;
				if (sessionEnded(cause)) return;
				if (attempt >= LOAD_ATTEMPTS) {
					log.warn(
						"[preferences] could not be loaded; changes on this page are not saved",
						cause,
					);
					return;
				}
				retryTimer = timers.setTimeout(
					() => tryLoad(attempt + 1),
					LOAD_RETRY_MS * 2 ** (attempt - 1),
				);
			},
		);
	}

	return {
		start() {
			if (running) return;
			running = true;
			stopListening = [
				interfaceStore.subscribe((state) => state.units, changed),
				interfaceStore.subscribe((state) => state.layers, changed),
				interfaceStore.subscribe(
					(state) => state.verticalExaggeration,
					changed,
				),
			];
			tryLoad(1);
		},

		stop() {
			if (!running) return;
			running = false;
			for (const stopOne of stopListening) stopOne();
			stopListening = [];
			if (retryTimer !== null) timers.clearTimeout(retryTimer);
			retryTimer = null;
			if (saveTimer !== null) {
				timers.clearTimeout(saveTimer);
				saveNow();
			}
			loaded = false;
		},
	};
}
