// The saved views routes' queries. Every one takes the user's id from the
// session and puts it in the WHERE clause, so a view that belongs to
// someone else is, to these queries, a view that does not exist.

import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { savedViews, user } from "@/db/schema";
import {
	MAX_VIEWS,
	readStoredView,
	type SavedView,
	type ViewData,
} from "@/lib/api/views-shapes";

type Row = typeof savedViews.$inferSelect;

function toView(row: Row): SavedView {
	return {
		id: row.id,
		name: row.name,
		view: readStoredView(row.data),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The user's views, oldest first. */
export async function listViews(userId: string): Promise<SavedView[]> {
	const rows = await db
		.select()
		.from(savedViews)
		.where(eq(savedViews.userId, userId))
		.orderBy(asc(savedViews.id));
	return rows.map(toView);
}

/** Saves a view, or returns null if the user already has `MAX_VIEWS`. */
export async function createView(
	userId: string,
	name: string,
	view: ViewData,
): Promise<SavedView | null> {
	// The count and the insert are one transaction that first locks the
	// user's row, so the user's saves take turns: without the lock, saves
	// made at once would each count before any had inserted, and all get
	// through. Nothing else in the app locks that row.
	const row = await db.transaction(async (tx) => {
		await tx
			.select({ id: user.id })
			.from(user)
			.where(eq(user.id, userId))
			.for("update");
		const [{ held }] = await tx
			.select({ held: count() })
			.from(savedViews)
			.where(eq(savedViews.userId, userId));
		if (held >= MAX_VIEWS) return null;
		const [inserted] = await tx
			.insert(savedViews)
			.values({ userId, name, data: view })
			.returning();
		return inserted;
	});
	return row === null ? null : toView(row);
}

/**
 * Changes the name of one of the user's views, what it holds, or both.
 * Returns null if the user has no view with that id.
 */
export async function updateView(
	userId: string,
	id: number,
	changes: { name?: string; view?: ViewData },
): Promise<SavedView | null> {
	const [row] = await db
		.update(savedViews)
		.set({
			...(changes.name !== undefined ? { name: changes.name } : {}),
			...(changes.view !== undefined ? { data: changes.view } : {}),
			updatedAt: new Date(),
		})
		.where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
		.returning();
	return row ? toView(row) : null;
}

/** Deletes one of the user's views. False if they have none with that id. */
export async function deleteView(userId: string, id: number): Promise<boolean> {
	const deleted = await db
		.delete(savedViews)
		.where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
		.returning({ id: savedViews.id });
	return deleted.length > 0;
}
