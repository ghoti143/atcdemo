// The history of what has flown. atc-server writes both tables as the
// simulator runs, and the web API reads them (DESIGN.md sections 5 and 12).
// Drizzle owns the tables all the same, so the Rust side checks at startup
// that the columns it writes exist: change a name here and
// crates/atc-server/src/recorder/store.rs must change with it.

import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	customType,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
	dataType: () => "bytea",
});

/**
 * One row for each real flight on each pass through the recording, inserted
 * when the aircraft appears. Stress-mode clones have none.
 */
export const flights = pgTable(
	"flights",
	{
		// The web API's id for the flight. An aircraft id is new on every
		// pass and is only the socket's name for it.
		id: bigserial("id", { mode: "number" }).primaryKey(),
		// The id the aircraft has on the socket, a u32.
		aircraftId: bigint("aircraft_id", { mode: "number" }).notNull(),
		icao24: integer("icao24").notNull(),
		callsign: text("callsign").notNull(),
		aircraftType: text("aircraft_type").notNull(),
		// Null where the recording does not know.
		origin: text("origin"),
		destination: text("destination"),
		// Which trip through the recording, from 0.
		pass: integer("pass").notNull(),
		// Sim time in seconds, a u32, and the wall clock, when the aircraft
		// was first in the picture.
		firstSeenSimS: bigint("first_seen_sim_s", { mode: "number" }).notNull(),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
		// Both null while the flight is still in the air.
		lastSeenSimS: bigint("last_seen_sim_s", { mode: "number" }),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
	},
	(table) => [
		// Search by the start of a callsign, whatever its case.
		index("flights_callsign_idx").on(
			sql`upper(${table.callsign}) text_pattern_ops`,
		),
		// The flight an aircraft on the socket is.
		index("flights_aircraft_id_idx").on(table.aircraftId),
		// Retention deletes by age.
		index("flights_first_seen_at_idx").on(table.firstSeenAt),
		// The flights still flying: few, and asked for often.
		index("flights_open_idx")
			.on(table.id)
			.where(sql`${table.lastSeenAt} is null`),
	],
);

/**
 * A flight's track, appended in batches of up to five minutes. A row decodes
 * by itself: it starts with whole values.
 */
export const flightTracks = pgTable(
	"flight_tracks",
	{
		flightId: bigint("flight_id", { mode: "number" })
			.notNull()
			.references(() => flights.id, { onDelete: "cascade" }),
		// Sim time of the first sample; each one after is 10 s later.
		firstSampleSimS: bigint("first_sample_sim_s", { mode: "number" }).notNull(),
		sampleCount: integer("sample_count").notNull(),
		// The samples in the seed file's difference encoding, as
		// crates/atc-server/src/recorder/codec.rs describes it. The database
		// never looks inside.
		samples: bytea("samples").notNull(),
	},
	(table) => [
		// A flight's rows in order of time, which is the only way they are
		// read. There is no id of their own: at 2.6 million rows a day a
		// second index is a fifth of the table again.
		primaryKey({ columns: [table.flightId, table.firstSampleSimS] }),
	],
);
