// The flight search's logic: what may be typed, what a result says, and
// what choosing one does to the page. No import of React or the DOM, so
// `bun test` runs it.

import type {
	Flight,
	FlightDetail,
	FlightTrack,
} from "@/lib/api/flights-shapes";
import type { Bounds, RecordedFlight } from "@/lib/interface-store";
import type { InterfaceStoreLike } from "@/lib/socket-client";

/** A callsign is at most this long, and the API takes no more. */
export const MAX_SEARCH_LENGTH = 8;
/** How long typing must pause before the API is asked. */
export const SEARCH_DELAY_MS = 250;

/**
 * What the API is asked for what was typed: its letters and digits, in
 * capitals, as far as a callsign goes. Empty asks for nothing.
 */
export function cleanSearch(typed: string): string {
	return typed
		.replace(/[^A-Za-z0-9]/g, "")
		.toUpperCase()
		.slice(0, MAX_SEARCH_LENGTH);
}

/** "KJFK → KLAX", with a dash for an end that is not known. */
export function formatRoute(
	flight: Pick<Flight, "origin" | "destination">,
): string {
	return `${flight.origin ?? "—"} → ${flight.destination ?? "—"}`;
}

/** "Flying", or how long ago the flight was last seen. */
export function formatSeen(
	flight: Pick<Flight, "flying" | "lastSeenAt">,
	nowMs: number,
): string {
	if (flight.flying || flight.lastSeenAt === null) return "Flying";
	const minutes = Math.max(
		0,
		Math.round((nowMs - Date.parse(flight.lastSeenAt)) / 60_000),
	);
	if (minutes < 1) return "Ended just now";
	if (minutes < 60) return `Ended ${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	return `Ended ${hours} h ${minutes % 60} min ago`;
}

/** A recorded track as the map draws it: lon, lat and feet for each point. */
export function trackPositions(track: FlightTrack): Float32Array {
	const points = track.timesS.length;
	const positions = new Float32Array(points * 3);
	for (let i = 0; i < points; i++) {
		positions[i * 3] = track.lon[i];
		positions[i * 3 + 1] = track.lat[i];
		positions[i * 3 + 2] = track.altitudeFt[i];
	}
	return positions;
}

/** The box a track lies in, or null for a track with no samples. */
export function trackBounds(track: FlightTrack): Bounds | null {
	const points = track.timesS.length;
	if (points === 0) return null;
	let west = Number.POSITIVE_INFINITY;
	let south = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < points; i++) {
		west = Math.min(west, track.lon[i]);
		east = Math.max(east, track.lon[i]);
		south = Math.min(south, track.lat[i]);
		north = Math.max(north, track.lat[i]);
	}
	return [west, south, east, north];
}

/**
 * What choosing a flying flight does at once, before anything is fetched:
 * selects its aircraft, which the server then streams wherever the map is.
 */
export function selectFlying(store: InterfaceStoreLike, flight: Flight): void {
	store.getState().select(flight.aircraftId);
}

/**
 * What choosing a flight does once its detail has arrived.
 *
 * Still flying: the aircraft is selected, and the map goes to where it was
 * last recorded, which is at most a few minutes behind it. Finished: its
 * recorded track is drawn and the map shows all of it, and nothing stays
 * selected, since the aircraft is no longer in the picture.
 */
export function showFlight(
	store: InterfaceStoreLike,
	detail: FlightDetail,
): void {
	const state = store.getState();
	const { flight, track } = detail;
	const points = track.timesS.length;
	if (flight.flying) {
		state.select(flight.aircraftId);
		if (points > 0) {
			const lon = track.lon[points - 1];
			const lat = track.lat[points - 1];
			state.fitMapTo([lon, lat, lon, lat]);
		}
		return;
	}
	state.select(null);
	const recorded: RecordedFlight = {
		id: flight.id,
		callsign: flight.callsign,
		positions: trackPositions(track),
		points,
	};
	state.showRecordedFlight(recorded);
	const bounds = trackBounds(track);
	if (bounds !== null) state.fitMapTo(bounds);
}
