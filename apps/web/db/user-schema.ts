// What each user keeps: their preferences here, and their saved views when
// those arrive. The web app writes and reads these; atc-server never does.

import {
	bigserial,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
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

/**
 * A user's named views of the map: where the camera was, and how the page
 * was set. What a view holds is one JSON value, read through a schema that
 * fills in what a row lacks (lib/api/views-shapes.ts), so milestone 6 can
 * add to it with no migration. A view is only ever read or changed by the
 * user it belongs to.
 */
export const savedViews = pgTable(
	"saved_views",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		data: jsonb("data").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	// A user's views, in the order they were made.
	(table) => [index("saved_views_user_idx").on(table.userId, table.id)],
);
