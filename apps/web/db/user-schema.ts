// What each user keeps: their preferences here, and their saved views when
// those arrive. The web app writes and reads these; atc-server never does.

import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * One row a user, made the first time they change something. The settings
 * are one JSON value, read through a schema that fills in whatever a row
 * lacks (lib/api/preferences-shapes.ts), so a setting added later needs no
 * migration and an old row still loads.
 */
export const preferences = pgTable("preferences", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	data: jsonb("data").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
