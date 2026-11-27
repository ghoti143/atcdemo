// The preferences routes' queries. A user has at most one row, and only
// ever sees or changes their own: every query here takes the user's id
// from the session, never from the request.

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { preferences } from "@/db/schema";
import {
	type Preferences,
	readStoredPreferences,
} from "@/lib/api/preferences-shapes";

/** The user's preferences, or the defaults if they have saved none. */
export async function loadPreferences(userId: string): Promise<Preferences> {
	const [row] = await db
		.select({ data: preferences.data })
		.from(preferences)
		.where(eq(preferences.userId, userId));
	return readStoredPreferences(row?.data);
}

/** Replaces the user's preferences with `next`. */
export async function savePreferences(
	userId: string,
	next: Preferences,
): Promise<void> {
	await db
		.insert(preferences)
		.values({ userId, data: next })
		.onConflictDoUpdate({
			target: preferences.userId,
			set: { data: next, updatedAt: new Date() },
		});
}
