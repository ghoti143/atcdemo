import { json, problem, readBody, requireUser } from "@/lib/api/respond";
import { createView, listViews } from "@/lib/api/views";
import { createViewSchema, MAX_VIEWS } from "@/lib/api/views-shapes";

/** `GET /api/views`: the signed-in user's saved views, oldest first. */
export async function GET(request: Request) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	return json({ views: await listViews(user.id) });
}

/** `POST /api/views`: saves a view for the signed-in user. */
export async function POST(request: Request) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const body = await readBody(request, createViewSchema);
	if (body instanceof Response) return body;

	const view = await createView(user.id, body.name, body.view);
	if (view === null) {
		return problem(
			400,
			"invalid_request",
			`You have ${MAX_VIEWS} saved views, which is the most. Delete one first.`,
		);
	}
	return json({ view }, 201);
}
