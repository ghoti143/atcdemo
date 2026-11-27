import { findFlight } from "@/lib/api/flights";
import { flightParamsSchema } from "@/lib/api/flights-shapes";
import { json, problem, readParams, requireUser } from "@/lib/api/respond";

/**
 * `GET /api/flights/:id`: one flight's details and its track as far as it
 * has been recorded.
 */
export async function GET(
	request: Request,
	context: { params: Promise<{ id: string }> },
) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const params = readParams(await context.params, flightParamsSchema);
	if (params instanceof Response) return params;

	const flight = await findFlight(params.id);
	if (flight === null) {
		return problem(404, "not_found", "There is no flight with that id.");
	}
	return json(flight);
}
