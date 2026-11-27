import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AIRSPACE_FILES, type AirspaceName } from "@/lib/airspace";
import { problem, requireUser } from "@/lib/api/respond";

type Context = { params: Promise<{ name: string }> };

// The baked files are in the repository's data/airspace/, two levels up
// from the web app, which is where every script starts it. They are read
// once and kept: they change only when the bake is run again.
const DIRECTORY = join(process.cwd(), "../../data/airspace");
const held = new Map<AirspaceName, Promise<string>>();

/**
 * `GET /api/airspace/:name`: one of the baked airspace files, `class-b` or
 * `artcc`, as GeoJSON, to a signed-in user.
 */
export async function GET(request: Request, context: Context) {
	const user = await requireUser(request);
	if (user instanceof Response) return user;
	const { name } = await context.params;
	if (!Object.hasOwn(AIRSPACE_FILES, name)) {
		return problem(404, "not_found", "There is no airspace file of that name.");
	}
	const known = name as AirspaceName;
	let file = held.get(known);
	if (file === undefined) {
		file = readFile(join(DIRECTORY, AIRSPACE_FILES[known]), "utf8");
		held.set(known, file);
		// A failed read is not kept, so the next request tries again.
		file.catch(() => held.delete(known));
	}
	// A file that cannot be read throws, and Next.js answers 500: the files
	// are committed, so that is a broken install and not a bad request.
	return new Response(await file, {
		headers: {
			"content-type": "application/geo+json; charset=utf-8",
			// The same for everyone, but only for the signed-in: the browser
			// may keep it for an hour, a shared cache may not.
			"cache-control": "private, max-age=3600",
		},
	});
}
