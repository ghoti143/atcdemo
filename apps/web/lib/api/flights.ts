// The flights routes' queries. The routes read what atc-server has recorded
// (db/flight-schema.ts) and nothing else, so they can return nothing from
// the future. What they answer with is in flights-shapes.ts, which the
// browser shares.

import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { flights, flightTracks } from "@/db/schema";
import type { Flight, FlightDetail } from "@/lib/api/flights-shapes";
import { decodeTrackRow, emptyTrack } from "@/lib/track-codec";

/** Seconds between two samples of a recorded track. */
const SAMPLE_SPACING_S = 10;

type FlightRow = typeof flights.$inferSelect;

function toFlight(row: FlightRow): Flight {
	return {
		id: row.id,
		aircraftId: row.aircraftId,
		icao24: row.icao24.toString(16).padStart(6, "0"),
		callsign: row.callsign,
		aircraftType: row.aircraftType,
		origin: row.origin,
		destination: row.destination,
		pass: row.pass,
		firstSeenAt: row.firstSeenAt.toISOString(),
		lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
		firstSeenSimS: row.firstSeenSimS,
		lastSeenSimS: row.lastSeenSimS,
		flying: row.lastSeenAt === null,
	};
}

/** One flight and its recorded track, or null if there is none with that id. */
export async function findFlight(id: number): Promise<FlightDetail | null> {
	const [row] = await db.select().from(flights).where(eq(flights.id, id));
	if (!row) return null;
	const batches = await db
		.select()
		.from(flightTracks)
		.where(eq(flightTracks.flightId, id))
		.orderBy(asc(flightTracks.firstSampleSimS));

	const columns = emptyTrack();
	const timesS: number[] = [];
	for (const batch of batches) {
		decodeTrackRow(batch.samples, batch.sampleCount, columns);
		for (let n = 0; n < batch.sampleCount; n++) {
			timesS.push(batch.firstSampleSimS + n * SAMPLE_SPACING_S);
		}
	}
	return { flight: toFlight(row), track: { timesS, ...columns } };
}

/**
 * Flights whose callsign starts with `search`, whatever its case, among
 * those flying now and those last seen within 24 hours. Flying ones first,
 * then the most recently seen. Clones were never recorded, so none is here.
 */
export async function searchFlights(
	search: string,
	limit: number,
): Promise<Flight[]> {
	// `search` is letters and digits only, so it holds nothing LIKE reads
	// as a pattern.
	const prefix = `${search.toUpperCase()}%`;
	const rows = await db
		.select()
		.from(flights)
		.where(
			and(
				sql`upper(${flights.callsign}) like ${prefix}`,
				or(
					isNull(flights.lastSeenAt),
					gt(flights.lastSeenAt, sql`now() - interval '24 hours'`),
				),
			),
		)
		.orderBy(
			// Null, which is still flying, sorts first.
			sql`${flights.lastSeenAt} desc nulls first`,
			desc(flights.firstSeenAt),
			desc(flights.id),
		)
		.limit(limit);
	return rows.map(toFlight);
}
