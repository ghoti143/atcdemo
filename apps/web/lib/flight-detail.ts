// What the detail panel says about the selected aircraft. No import of
// React or the DOM, so `bun test` runs it. See docs/DESIGN.md section 10.
//
// Everything comes from the WASM store: who the aircraft is from its
// metadata, where it is from its newest sample, and its altitude profile
// from the track the store holds for whatever is selected. The store got
// that track from the socket and extends it every ten seconds, so the
// profile covers what the aircraft has flown and ends at now. It is the
// same for a stress-mode clone, which the web API knows nothing of.
//
// It is a store for React's `useSyncExternalStore`. The snapshot is worked
// out again once a second and when the selection changes, and only while
// someone is subscribed.

import type { InterfaceStoreLike } from "@/lib/socket-client";

/** How often the panel is brought up to date. */
export const DETAIL_REFRESH_MS = 1_000;

/** The wire's altitude step, in feet. */
const ALTITUDE_STEP_FT = 25;

/** The part of the WASM `AircraftStore` the panel reads. */
export type DetailStore = {
	row_of(id: number): number | undefined;
	callsign(id: number): string | undefined;
	aircraft_type(id: number): string | undefined;
	origin(id: number): string | undefined;
	destination(id: number): string | undefined;
	icao24(id: number): number | undefined;
	altitude_ft(id: number): number | undefined;
	ground_speed_kt(id: number): number | undefined;
	track_deg(id: number): number | undefined;
	vertical_rate_fpm(id: number): number | undefined;
	on_ground(id: number): boolean | undefined;
	synthetic(id: number): boolean | undefined;
	track_len(id: number): number;
	track_times_ptr(id: number): number;
	track_altitudes_ptr(id: number): number;
};

export type DetailSource = {
	store: DetailStore;
	memory: { readonly buffer: ArrayBuffer };
};

/** Altitude against time, one entry a sample, oldest first. */
export type AltitudeProfile = {
	/** Sim time of each sample, in seconds. */
	timesS: number[];
	/** Feet above mean sea level. */
	altitudesFt: number[];
};

export type FlightDetail = {
	id: number;
	/** Whether the aircraft is in the picture now. */
	present: boolean;
	callsign: string;
	aircraftType: string;
	/** Empty where the recording does not know. */
	origin: string;
	destination: string;
	/** Six hex digits, or empty before the aircraft's metadata has come. */
	icao24: string;
	/** A stress-mode clone. */
	synthetic: boolean;
	// The newest sample. Null when the aircraft has left the picture.
	altitudeFt: number | null;
	groundSpeedKt: number | null;
	trackDeg: number | null;
	verticalRateFpm: number | null;
	onGround: boolean;
	/** Empty until the track frame has come. */
	profile: AltitudeProfile;
};

export type FlightDetailStore = {
	subscribe(listener: () => void): () => void;
	/** The selected aircraft, or null when nothing is selected. */
	getSnapshot(): FlightDetail | null;
	refresh(): void;
};

export type FlightDetailOptions = {
	/** The page's traffic, or null when there is none: `currentTraffic`. */
	source: () => DetailSource | null;
	interfaceStore: InterfaceStoreLike;
	intervalMs?: number;
	timers?: {
		setInterval(callback: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
};

function read(traffic: DetailSource, id: number): FlightDetail {
	const { store, memory } = traffic;
	const points = store.track_len(id);
	const profile: AltitudeProfile = { timesS: [], altitudesFt: [] };
	if (points > 0) {
		// Copied out: the views are over WASM memory, which the next frame
		// may move.
		const times = new Uint32Array(
			memory.buffer,
			store.track_times_ptr(id),
			points,
		);
		const altitudes = new Int16Array(
			memory.buffer,
			store.track_altitudes_ptr(id),
			points,
		);
		for (let point = 0; point < points; point++) {
			profile.timesS.push(times[point]);
			profile.altitudesFt.push(altitudes[point] * ALTITUDE_STEP_FT);
		}
	}
	const icao24 = store.icao24(id);
	return {
		id,
		present: store.row_of(id) !== undefined,
		callsign: store.callsign(id) ?? "",
		aircraftType: store.aircraft_type(id) ?? "",
		origin: store.origin(id) ?? "",
		destination: store.destination(id) ?? "",
		icao24: icao24 === undefined ? "" : icao24.toString(16).padStart(6, "0"),
		synthetic: store.synthetic(id) ?? false,
		altitudeFt: store.altitude_ft(id) ?? null,
		groundSpeedKt: store.ground_speed_kt(id) ?? null,
		trackDeg: store.track_deg(id) ?? null,
		verticalRateFpm: store.vertical_rate_fpm(id) ?? null,
		onGround: store.on_ground(id) ?? false,
		profile,
	};
}

export function createFlightDetail({
	source,
	interfaceStore,
	intervalMs = DETAIL_REFRESH_MS,
	timers = {
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: (handle) =>
			clearInterval(handle as ReturnType<typeof setInterval>),
	},
}: FlightDetailOptions): FlightDetailStore {
	const listeners = new Set<() => void>();
	let snapshot: FlightDetail | null = null;
	let timer: unknown = null;
	let stopListening: (() => void) | null = null;

	function refresh() {
		const id = interfaceStore.getState().selectedId;
		const traffic = source();
		const next = id === null || traffic === null ? null : read(traffic, id);
		// Nothing selected stays one snapshot, so nobody renders for it.
		if (next === null && snapshot === null) return;
		snapshot = next;
		for (const listener of listeners) listener();
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			if (listeners.size === 1) {
				timer = timers.setInterval(refresh, intervalMs);
				stopListening = interfaceStore.subscribe(
					(state) => state.selectedId,
					refresh,
				);
				refresh();
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					timers.clearInterval(timer);
					timer = null;
					stopListening?.();
					stopListening = null;
				}
			};
		},
		getSnapshot: () => snapshot,
		refresh,
	};
}

/** The route as the panel shows it, or null when neither end is known. */
export function formatRoute(
	detail: Pick<FlightDetail, "origin" | "destination">,
): string | null {
	if (!detail.origin && !detail.destination) return null;
	return `${detail.origin || "?"} → ${detail.destination || "?"}`;
}

/** A track in whole degrees, three digits, as a heading is written. */
export function formatTrack(degrees: number | null): string {
	if (degrees === null) return "—";
	const whole = ((Math.round(degrees) % 360) + 360) % 360;
	return `${String(whole).padStart(3, "0")}°`;
}

/** How long ago, for a point of the profile: "now", "45 s ago", "12 min ago". */
export function formatAgo(seconds: number): string {
	if (seconds < 5) return "now";
	if (seconds < 90) return `${Math.round(seconds)} s ago`;
	return `${Math.round(seconds / 60)} min ago`;
}

/** How far up its axis the highest point of a profile may reach. */
const PROFILE_HEADROOM = 0.75;

/**
 * The top of the profile's altitude axis: a round number of thousands of
 * feet that leaves the highest point no more than three quarters of the way
 * up. The room above is where the axis's label sits, clear of the line.
 */
export function profileCeilingFt(altitudesFt: readonly number[]): number {
	const highest = altitudesFt.reduce((max, value) => Math.max(max, value), 0);
	const needed = highest / PROFILE_HEADROOM;
	for (const ceiling of [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 40_000]) {
		if (needed <= ceiling) return ceiling;
	}
	return Math.ceil(needed / 10_000) * 10_000;
}
