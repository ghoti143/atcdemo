import {
	json,
	problem,
	readBody,
	readParams,
	requireUser,
} from "@/lib/api/respond";
import { deleteView, updateView } from "@/lib/api/views";
import { updateViewSchema, viewParamsSchema } from "@/lib/api/views-shapes";

type Context = { params: Promise<{ id: string }> };

// A view that belongs to someone else is answered exactly as one that does
// not exist, so nobody learns which ids are in use.
const missing = () =>
	problem(404, "not_found", "You have no saved view with that id.");

/** `PUT /api/views/:id`: renames one of the user's views, replaces what it holds, or both. */
export async function PUT(request: Request, context: Context) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const params = readParams(await context.params, viewParamsSchema);
	if (params instanceof Response) return params;
	const body = await readBody(request, updateViewSchema);
	if (body instanceof Response) return body;

	const view = await updateView(user.id, params.id, body);
	return view === null ? missing() : json({ view });
}

/** `DELETE /api/views/:id`: deletes one of the user's views. */
export async function DELETE(request: Request, context: Context) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const params = readParams(await context.params, viewParamsSchema);
	if (params instanceof Response) return params;

	return (await deleteView(user.id, params.id))
		? json({ deleted: true })
		: missing();
}
