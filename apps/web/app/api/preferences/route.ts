import { loadPreferences, savePreferences } from "@/lib/api/preferences";
import { preferencesSchema } from "@/lib/api/preferences-shapes";
import { json, readBody, requireUser } from "@/lib/api/respond";

/** `GET /api/preferences`: the signed-in user's, or the defaults. */
export async function GET(request: Request) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	return json({ preferences: await loadPreferences(user.id) });
}

/**
 * `PUT /api/preferences`: replaces the signed-in user's with the body,
 * which is all of them, and answers with what is now stored.
 */
export async function PUT(request: Request) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const next = await readBody(request, preferencesSchema);
	if (next instanceof Response) return next;

	await savePreferences(user.id, next);
	return json({ preferences: next });
}
