// The flight list's data: which aircraft are in it, in what order, and what
// a row says. No import of React or the DOM, so `bun test` runs it. See
// docs/DESIGN.md sections 8 and 10.
//
// WASM does the work. Once a second, and whenever the sort or the filter
// changes, `list_refresh` sorts and filters every aircraft in the picture
// and leaves their ids in a buffer; this module copies the ids out, which
// is all it holds. Nothing is known about an aircraft here until a row is
// asked for, and the table asks only for the rows on screen: `row(index)`
// reads that one aircraft's fields through the store, which is where its
// strings are made. So 60,000 aircraft cost one sort in WASM and one copy
// of 240 kB a second, and thirty rows of strings.
//
// It is a store for React's `useSyncExternalStore`: `subscribe` and
// `getSnapshot`. The snapshot is a new object after every refresh and the
// same one between them. The timer runs only while someone is subscribed.

import type { InterfaceStoreLike } from "@/lib/socket-client";
import type { SortKey, SortOrder } from "./interface-store";

/** How often the list is worked out again while it is shown. */
export const LIST_REFRESH_MS = 1_000;

/** The number `list_refresh` takes for each sort key. */
export const SORT_CODES: Record<SortKey, number> = {
	callsign: 0,
	aircraftType: 1,
	altitude: 2,
	groundSpeed: 3,
	verticalRate: 4,
	origin: 5,
	destination: 6,
};

/** The part of the WASM `AircraftStore` the list uses. */
export type ListStore = {
	list_refresh(sort: number, descending: boolean, filter: string): number;
	list_ids_ptr(): number;
	callsign(id: number): string | undefined;
	aircraft_type(id: number): string | undefined;
	origin(id: number): string | undefined;
	destination(id: number): string | undefined;
	altitude_ft(id: number): number | undefined;
	ground_speed_kt(id: number): number | undefined;
	vertical_rate_fpm(id: number): number | undefined;
	on_ground(id: number): boolean | undefined;
	synthetic(id: number): boolean | undefined;
};

export type ListSource = {
	store: ListStore;
	memory: { readonly buffer: ArrayBuffer };
};

/** What one row of the table says. A number is null when it is not known. */
export type FlightRow = {
	id: number;
	callsign: string;
	aircraftType: string;
	origin: string;
	destination: string;
	altitudeFt: number | null;
	groundSpeedKt: number | null;
	verticalRateFpm: number | null;
	onGround: boolean;
	/** A stress-mode clone. */
	synthetic: boolean;
};

/** What `useSyncExternalStore` is given: it changes when the list has. */
export type ListSnapshot = {
	/** Aircraft in the list. */
	count: number;
	/** Counts the refreshes, so two lists of one length differ. */
	version: number;
	/** How long the last `list_refresh` and copy took, in milliseconds. */
	refreshMs: number;
};

export type FlightList = {
	subscribe(listener: () => void): () => void;
	getSnapshot(): ListSnapshot;
	/** The aircraft at `index` of the list, or null past its end. */
	row(index: number): FlightRow | null;
	/** The aircraft id at `index`, or null past the end. Makes no strings. */
	idAt(index: number): number | null;
	/** Where an aircraft is in the list, or -1. */
	indexOf(id: number): number;
	/** Works the list out now. The timer and a changed sort or filter call it. */
	refresh(): void;
};

export type FlightListOptions = {
	/** The page's traffic, or null when there is none: `currentTraffic`. */
	source: () => ListSource | null;
	interfaceStore: InterfaceStoreLike;
	intervalMs?: number;
	timers?: {
		setInterval(callback: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
	now?: () => number;
};

const EMPTY: ListSnapshot = { count: 0, version: 0, refreshMs: 0 };

export function createFlightList({
	source,
	interfaceStore,
	intervalMs = LIST_REFRESH_MS,
	timers = {
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: (handle) =>
			clearInterval(handle as ReturnType<typeof setInterval>),
	},
	now = () => performance.now(),
}: FlightListOptions): FlightList {
	const listeners = new Set<() => void>();
	let snapshot = EMPTY;
	// The ids as of the last refresh, copied out of WASM memory: a view over
	// it would be detached the next time the memory grew.
	let ids = new Uint32Array(1_024);
	let timer: unknown = null;
	let stopListening: (() => void)[] = [];

	function refresh() {
		const traffic = source();
		if (traffic === null) {
			if (snapshot.count !== 0) {
				snapshot = { count: 0, version: snapshot.version + 1, refreshMs: 0 };
				for (const listener of listeners) listener();
			}
			return;
		}
		const { sort, filters } = interfaceStore.getState();
		const startMs = now();
		const count = traffic.store.list_refresh(
			SORT_CODES[sort.key] ?? 0,
			sort.descending,
			filters.text,
		);
		if (ids.length < count) {
			let capacity = ids.length;
			while (capacity < count) capacity *= 2;
			ids = new Uint32Array(capacity);
		}
		if (count > 0) {
			ids.set(
				new Uint32Array(
					traffic.memory.buffer,
					traffic.store.list_ids_ptr(),
					count,
				),
			);
		}
		snapshot = {
			count,
			version: snapshot.version + 1,
			refreshMs: now() - startMs,
		};
		for (const listener of listeners) listener();
	}

	function start() {
		timer = timers.setInterval(refresh, intervalMs);
		stopListening = [
			interfaceStore.subscribe<SortOrder>((state) => state.sort, refresh),
			interfaceStore.subscribe((state) => state.filters.text, refresh),
		];
		refresh();
	}

	function stop() {
		timers.clearInterval(timer);
		timer = null;
		for (const stopOne of stopListening) stopOne();
		stopListening = [];
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			if (listeners.size === 1) start();
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) stop();
			};
		},
		getSnapshot: () => snapshot,
		refresh,

		idAt(index) {
			return Number.isInteger(index) && index >= 0 && index < snapshot.count
				? ids[index]
				: null;
		},

		indexOf(id) {
			for (let index = 0; index < snapshot.count; index++) {
				if (ids[index] === id) return index;
			}
			return -1;
		},

		row(index) {
			const traffic = source();
			if (
				traffic === null ||
				!Number.isInteger(index) ||
				index < 0 ||
				index >= snapshot.count
			) {
				return null;
			}
			const id = ids[index];
			const { store } = traffic;
			// An aircraft that has left since the refresh still has its
			// metadata; its numbers are gone until the next one drops the row.
			return {
				id,
				callsign: store.callsign(id) ?? "",
				aircraftType: store.aircraft_type(id) ?? "",
				origin: store.origin(id) ?? "",
				destination: store.destination(id) ?? "",
				altitudeFt: store.altitude_ft(id) ?? null,
				groundSpeedKt: store.ground_speed_kt(id) ?? null,
				verticalRateFpm: store.vertical_rate_fpm(id) ?? null,
				onGround: store.on_ground(id) ?? false,
				synthetic: store.synthetic(id) ?? false,
			};
		},
	};
}

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Feet above mean sea level, to the 25 ft the wire carries: "35,000". */
export function formatAltitude(
	row: Pick<FlightRow, "altitudeFt" | "onGround">,
) {
	if (row.onGround) return "GND";
	return row.altitudeFt === null ? "—" : WHOLE.format(row.altitudeFt);
}

/** Knots. */
export function formatSpeed(knots: number | null): string {
	return knots === null ? "—" : WHOLE.format(knots);
}

/**
 * Feet a minute with its sign, and a true minus: "+1,920", "−640", "0".
 * The wire carries it in steps of 64.
 */
export function formatVerticalRate(feetPerMinute: number | null): string {
	if (feetPerMinute === null) return "—";
	if (feetPerMinute === 0) return "0";
	const sign = feetPerMinute > 0 ? "+" : "−";
	return `${sign}${WHOLE.format(Math.abs(feetPerMinute))}`;
}
