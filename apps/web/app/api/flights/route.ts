import { searchFlights } from "@/lib/api/flights";
import { flightSearchQuerySchema } from "@/lib/api/flights-shapes";
import { json, readQuery, requireUser } from "@/lib/api/respond";

/**
 * `GET /api/flights?search=UAL&limit=20`: flights whose callsign starts
 * with the text, among those flying now and those seen in the last day.
 */
export async function GET(request: Request) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const query = readQuery(request, flightSearchQuerySchema);
	if (query instanceof Response) return query;

	return json({ flights: await searchFlights(query.search, query.limit) });
}
