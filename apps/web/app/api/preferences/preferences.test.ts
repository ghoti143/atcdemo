import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
	defaultPreferences,
	type Preferences,
	preferencesAnswerSchema,
	readStoredPreferences,
} from "@/lib/api/preferences-shapes";

// The preferences routes against a migrated Postgres, called as Next.js
// calls them. Skipped without the database and the secret.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

const changed = (): Preferences => ({
	units: { altitude: "m", speed: "mph", verticalRate: "ms" },
	layers: { ...defaultPreferences().layers, artcc: false, stems: false },
	verticalExaggeration: 6.5,
});

describe.skipIf(!configured)("the preferences API", () => {
	const origin = process.env.BETTER_AUTH_URL as string;
	const password = "preferences-password";
	const emails = [
		"preferences-test-a@example.com",
		"preferences-test-b@example.com",
	];
	let auth: typeof import("@/lib/auth").auth;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");
	let route: typeof import("./route");
	const userIds: string[] = [];

	async function removeUsers() {
		await db.delete(schema.user).where(inArray(schema.user.email, emails));
	}

	/** Signs in and returns the cookie of a new session. */
	async function signIn(email: string): Promise<string> {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		return signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");
	}

	const get = (cookie?: string) =>
		route.GET(
			new Request(`${origin}/api/preferences`, {
				headers: cookie ? { cookie } : {},
			}),
		);
	const put = (body: unknown, cookie?: string) =>
		route.PUT(
			new Request(`${origin}/api/preferences`, {
				method: "PUT",
				headers: {
					"content-type": "application/json",
					...(cookie ? { cookie } : {}),
				},
				body: typeof body === "string" ? body : JSON.stringify(body),
			}),
		);
	const preferencesIn = async (response: Response) =>
		preferencesAnswerSchema.parse(await response.json()).preferences;

	beforeAll(async () => {
		({ auth } = await import("@/lib/auth"));
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		route = await import("./route");
		await removeUsers();
		for (const email of emails) {
			const created = await auth.api.createUser({
				body: { email, password, name: "Preferences Test", role: "viewer" },
			});
			userIds.push(created.user.id);
		}
	});

	afterAll(removeUsers);

	test("without a session both methods answer 401 and store nothing", async () => {
		expect((await get()).status).toBe(401);
		expect((await put(changed())).status).toBe(401);
		const rows = await db
			.select()
			.from(schema.preferences)
			.where(inArray(schema.preferences.userId, userIds));
		expect(rows).toEqual([]);
	});

	test("someone who has saved nothing gets the defaults", async () => {
		const response = await get(await signIn(emails[0]));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await preferencesIn(response)).toEqual(defaultPreferences());
	});

	test("what is put is what is got, after signing out and in again", async () => {
		const cookie = await signIn(emails[0]);
		const stored = await put(changed(), cookie);
		expect(stored.status).toBe(200);
		expect(await preferencesIn(stored)).toEqual(changed());
		expect(await preferencesIn(await get(cookie))).toEqual(changed());

		// The session ends; a new one, for the same user, sees the same.
		await auth.api.signOut({ headers: new Headers({ cookie }) });
		expect((await get(cookie)).status).toBe(401);
		const again = await signIn(emails[0]);
		expect(again).not.toBe(cookie);
		expect(await preferencesIn(await get(again))).toEqual(changed());
	});

	test("a second put replaces the first, in the one row", async () => {
		const cookie = await signIn(emails[0]);
		const next = { ...changed(), verticalExaggeration: 2 };
		await put(next, cookie);
		expect(await preferencesIn(await get(cookie))).toEqual(next);
		const rows = await db
			.select()
			.from(schema.preferences)
			.where(eq(schema.preferences.userId, userIds[0]));
		expect(rows).toHaveLength(1);
	});

	test("each user has their own", async () => {
		const first = await signIn(emails[0]);
		const second = await signIn(emails[1]);
		await put(changed(), first);
		// The other user still has the defaults, and changing theirs leaves
		// the first's alone.
		expect(await preferencesIn(await get(second))).toEqual(
			defaultPreferences(),
		);
		const theirs = { ...defaultPreferences(), verticalExaggeration: 9 };
		await put(theirs, second);
		expect(await preferencesIn(await get(first))).toEqual(changed());
		expect(await preferencesIn(await get(second))).toEqual(theirs);
	});

	test("a body naming another user changes nothing of theirs", async () => {
		const first = await signIn(emails[0]);
		const response = await put({ ...changed(), userId: userIds[1] }, first);
		// An unknown field is refused outright.
		expect(response.status).toBe(400);
	});

	test("a put that is not all of the preferences, or holds an unknown value, is 400", async () => {
		const cookie = await signIn(emails[0]);
		const before = await preferencesIn(await get(cookie));
		const bad: [unknown, string][] = [
			[
				{ ...changed(), units: { ...changed().units, altitude: "furlongs" } },
				"units.altitude",
			],
			[{ ...changed(), verticalExaggeration: 0 }, "verticalExaggeration"],
			[{ ...changed(), verticalExaggeration: 21 }, "verticalExaggeration"],
			[{ ...changed(), verticalExaggeration: "4" }, "verticalExaggeration"],
			[
				{ ...changed(), layers: { ...changed().layers, trails: "yes" } },
				"layers.trails",
			],
			[
				{ units: changed().units, layers: changed().layers },
				"verticalExaggeration",
			],
			[{ ...changed(), layers: { trails: true } }, "layers.predictionVectors"],
		];
		for (const [body, field] of bad) {
			const response = await put(body, cookie);
			expect(response.status).toBe(400);
			const answer = await response.json();
			expect(answer.error.code).toBe("invalid_request");
			expect(Object.keys(answer.error.fields)).toContain(field);
		}
		expect((await put("{not json", cookie)).status).toBe(400);
		expect((await put([], cookie)).status).toBe(400);
		// Nothing of it was stored.
		expect(await preferencesIn(await get(cookie))).toEqual(before);
	});

	test("a stored row from another version still loads", async () => {
		const cookie = await signIn(emails[1]);
		// Written straight to the table, as an older or newer version might
		// have left it.
		await db
			.insert(schema.preferences)
			.values({
				userId: userIds[1],
				data: {
					units: { altitude: "m", speed: "knots" },
					layers: { classB: false, wind: true },
					theme: "light",
				},
			})
			.onConflictDoUpdate({
				target: schema.preferences.userId,
				set: {
					data: {
						units: { altitude: "m", speed: "knots" },
						layers: { classB: false, wind: true },
						theme: "light",
					},
				},
			});
		expect(await preferencesIn(await get(cookie))).toEqual({
			units: { altitude: "m", speed: "kt", verticalRate: "fpm" },
			layers: { ...defaultPreferences().layers, classB: false },
			verticalExaggeration: 1,
		});
	});

	test("deleting the user deletes their preferences", async () => {
		await db.delete(schema.user).where(eq(schema.user.id, userIds[1]));
		const rows = await db
			.select()
			.from(schema.preferences)
			.where(eq(schema.preferences.userId, userIds[1]));
		expect(rows).toEqual([]);
	});
});

describe("readStoredPreferences", () => {
	test("anything that is not an object is the defaults", () => {
		for (const stored of [undefined, null, "x", 7, [], true]) {
			expect(readStoredPreferences(stored)).toEqual(defaultPreferences());
		}
	});

	test("a whole, valid value comes back as it is", () => {
		expect(readStoredPreferences(changed())).toEqual(changed());
	});
});
