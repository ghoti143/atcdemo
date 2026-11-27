import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

// The airspace route, called as Next.js calls it. It needs the database
// only for the session. Skipped without the database and the secret.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

describe.skipIf(!configured)("the airspace API", () => {
	const origin = process.env.BETTER_AUTH_URL as string;
	const email = "airspace-test@example.com";
	const password = "airspace-password";
	let auth: typeof import("@/lib/auth").auth;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");
	let route: typeof import("./[name]/route");
	let cookie = "";

	const removeUser = () =>
		db.delete(schema.user).where(eq(schema.user.email, email));
	const get = (name: string, withCookie = true) =>
		route.GET(
			new Request(`${origin}/api/airspace/${name}`, {
				headers: withCookie ? { cookie } : {},
			}),
			{ params: Promise.resolve({ name }) },
		);

	beforeAll(async () => {
		({ auth } = await import("@/lib/auth"));
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		route = await import("./[name]/route");
		await removeUser();
		await auth.api.createUser({
			body: { email, password, name: "Airspace Test", role: "viewer" },
		});
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		cookie = signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");
	});

	afterAll(removeUser);

	test("without a session it answers 401", async () => {
		expect((await get("class-b", false)).status).toBe(401);
	});

	test("serves both files as GeoJSON the browser may keep and a shared cache may not", async () => {
		const classB = await get("class-b");
		expect(classB.status).toBe(200);
		expect(classB.headers.get("content-type")).toContain(
			"application/geo+json",
		);
		expect(classB.headers.get("cache-control")).toBe("private, max-age=3600");
		expect((await classB.json()).features).toHaveLength(359);
		const artcc = await get("artcc");
		expect((await artcc.json()).features).toHaveLength(41);
	});

	test("any other name is 404, and no path gets out of the directory", async () => {
		for (const name of [
			"class-c",
			"../README.md",
			"class-b.geojson",
			"constructor",
			"",
		]) {
			expect((await get(name)).status).toBe(404);
		}
	});
});
