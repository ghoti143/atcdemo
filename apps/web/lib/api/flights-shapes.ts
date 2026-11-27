// What the flights routes take and answer with, as Zod schemas: the route
// reads its input through them, the tests check its answers against them,
// and the browser checks what it receives. The types come from them. No
// import of the database, so the browser can load this file.

import { z } from "zod";

export const flightSchema = z.object({
	/** This API's id for the flight. */
	id: z.number().int(),
	/** The aircraft's id on the socket, for selecting it on the map. */
	aircraftId: z.number().int(),
	/** Six hex digits. */
	icao24: z.string(),
	callsign: z.string(),
	aircraftType: z.string(),
	origin: z.string().nullable(),
	destination: z.string().nullable(),
	pass: z.number().int(),
	firstSeenAt: z.iso.datetime(),
	/** Null while the flight is still in the air. */
	lastSeenAt: z.iso.datetime().nullable(),
	firstSeenSimS: z.number().int(),
	lastSeenSimS: z.number().int().nullable(),
	/** Whether the aircraft is in the picture now. */
	flying: z.boolean(),
});

export type Flight = z.infer<typeof flightSchema>;

export const trackSchema = z.object({
	/** Sim time of each sample, in seconds. Every array is this long. */
	timesS: z.array(z.number().int()),
	lat: z.array(z.number()),
	lon: z.array(z.number()),
	altitudeFt: z.array(z.number()),
	barometricFt: z.array(z.number()),
	groundSpeedKt: z.array(z.number()),
	trackDeg: z.array(z.number()),
	verticalRateFpm: z.array(z.number()),
	onGround: z.array(z.boolean()),
});

export type FlightTrack = z.infer<typeof trackSchema>;

export const flightDetailSchema = z.object({
	flight: flightSchema,
	/**
	 * The track as far as it has been recorded: all of a finished flight's,
	 * and a flying one's up to the last batch, at most five minutes old.
	 */
	track: trackSchema,
});

export type FlightDetail = z.infer<typeof flightDetailSchema>;

export const flightSearchSchema = z.object({ flights: z.array(flightSchema) });

export type FlightSearch = z.infer<typeof flightSearchSchema>;

/** `:id` in `/api/flights/:id`. */
export const flightParamsSchema = z.object({
	id: z
		.string()
		.regex(/^[1-9][0-9]{0,15}$/, "must be a flight id")
		.transform(Number),
});

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

/** The query of `GET /api/flights`. */
export const flightSearchQuerySchema = z.object({
	search: z
		.string({ error: "is required" })
		.trim()
		.min(1, "is required")
		.max(8, "is at most 8 characters, the length of a callsign")
		.regex(/^[A-Za-z0-9]+$/, "is letters and digits only"),
	limit: z.coerce
		.number({ error: "must be a number" })
		.int("must be a whole number")
		.min(1, "must be at least 1")
		.max(SEARCH_LIMIT_MAX, `must be at most ${SEARCH_LIMIT_MAX}`)
		.default(SEARCH_LIMIT_DEFAULT),
});
