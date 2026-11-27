import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import {
	MAX_VIEWS,
	type ViewData,
	viewAnswerSchema,
	viewsAnswerSchema,
} from "@/lib/api/views-shapes";

// The saved views routes against a migrated Postgres, called as Next.js
// calls them. Skipped without the database and the secret.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

const view = (zoom = 9): ViewData => ({
	camera: { longitude: -73.8, latitude: 40.6, zoom, pitch: 50, bearing: 30 },
	viewMode: "3d",
	filters: { text: "UAL" },
});

describe.skipIf(!configured)("the saved views API", () => {
	const origin = process.env.BETTER_AUTH_URL as string;
	const password = "saved-views-password";
	const emails = ["views-test-a@example.com", "views-test-b@example.com"];
	let auth: typeof import("@/lib/auth").auth;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");
	let list: typeof import("./route");
	let one: typeof import("./[id]/route");
	const userIds: string[] = [];

	async function removeUsers() {
		await db.delete(schema.user).where(inArray(schema.user.email, emails));
	}

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

	const request = (
		path: string,
		method: string,
		cookie?: string,
		body?: unknown,
	) =>
		new Request(`${origin}${path}`, {
			method,
			headers: {
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(cookie ? { cookie } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	const get = (cookie?: string) =>
		list.GET(request("/api/views", "GET", cookie));
	const post = (body: unknown, cookie?: string) =>
		list.POST(request("/api/views", "POST", cookie, body));
	const put = (id: number | string, body: unknown, cookie?: string) =>
		one.PUT(request(`/api/views/${id}`, "PUT", cookie, body), {
			params: Promise.resolve({ id: String(id) }),
		});
	const remove = (id: number | string, cookie?: string) =>
		one.DELETE(request(`/api/views/${id}`, "DELETE", cookie), {
			params: Promise.resolve({ id: String(id) }),
		});
	const viewsIn = async (response: Response) =>
		viewsAnswerSchema.parse(await response.json()).views;
	const viewIn = async (response: Response) =>
		viewAnswerSchema.parse(await response.json()).view;

	beforeAll(async () => {
		({ auth } = await import("@/lib/auth"));
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		list = await import("./route");
		one = await import("./[id]/route");
		await removeUsers();
		for (const email of emails) {
			const created = await auth.api.createUser({
				body: { email, password, name: "Views Test", role: "viewer" },
			});
			userIds.push(created.user.id);
		}
	});

	afterAll(removeUsers);

	test("without a session every method answers 401 and stores nothing", async () => {
		expect((await get()).status).toBe(401);
		expect((await post({ name: "a", view: view() })).status).toBe(401);
		expect((await put(1, { name: "b" })).status).toBe(401);
		expect((await remove(1)).status).toBe(401);
		const rows = await db
			.select()
			.from(schema.savedViews)
			.where(inArray(schema.savedViews.userId, userIds));
		expect(rows).toEqual([]);
	});

	test("a view is saved, listed, renamed, replaced and deleted", async () => {
		const cookie = await signIn(emails[0]);
		expect(await viewsIn(await get(cookie))).toEqual([]);

		const created = await post({ name: " New York ", view: view() }, cookie);
		expect(created.status).toBe(201);
		expect(created.headers.get("cache-control")).toBe("no-store");
		const saved = await viewIn(created);
		expect(saved.name).toBe("New York");
		expect(saved.view).toEqual(view());
		expect(await viewsIn(await get(cookie))).toEqual([saved]);

		const renamed = await viewIn(await put(saved.id, { name: "JFK" }, cookie));
		expect(renamed.name).toBe("JFK");
		expect(renamed.view).toEqual(view());
		const replaced = await viewIn(
			await put(saved.id, { view: view(11) }, cookie),
		);
		expect(replaced.name).toBe("JFK");
		expect(replaced.view.camera.zoom).toBe(11);

		const deleted = await remove(saved.id, cookie);
		expect(deleted.status).toBe(200);
		expect(await viewsIn(await get(cookie))).toEqual([]);
		expect((await remove(saved.id, cookie)).status).toBe(404);
	});

	test("a view is still there after signing out and in again", async () => {
		const cookie = await signIn(emails[0]);
		const saved = await viewIn(
			await post({ name: "kept", view: view() }, cookie),
		);
		await auth.api.signOut({ headers: new Headers({ cookie }) });
		expect((await get(cookie)).status).toBe(401);
		const again = await signIn(emails[0]);
		expect(await viewsIn(await get(again))).toEqual([saved]);
		await remove(saved.id, again);
	});

	test("one user cannot read, change or delete another's view", async () => {
		const mine = await signIn(emails[0]);
		const theirs = await signIn(emails[1]);
		const saved = await viewIn(
			await post({ name: "mine", view: view() }, mine),
		);

		expect(await viewsIn(await get(theirs))).toEqual([]);
		const renamed = await put(saved.id, { name: "taken" }, theirs);
		expect(renamed.status).toBe(404);
		expect((await put(saved.id, { view: view(3) }, theirs)).status).toBe(404);
		expect((await remove(saved.id, theirs)).status).toBe(404);
		// The answer is the one an id nobody has gets.
		const nobody = await put(saved.id + 1_000_000, { name: "taken" }, theirs);
		expect(await renamed.json()).toEqual(await nobody.json());

		expect(await viewsIn(await get(mine))).toEqual([saved]);
		await remove(saved.id, mine);
	});

	test("a body that is not a view is refused and stores nothing", async () => {
		const cookie = await signIn(emails[0]);
		const bad: unknown[] = [
			{ view: view() },
			{ name: "", view: view() },
			{ name: "a" },
			{ name: "a", view: { ...view(), userId: userIds[1] } },
			{ name: "a", view: view(), userId: userIds[1] },
			{ name: "a", view: { ...view(), viewMode: "4d" } },
		];
		for (const body of bad) {
			expect((await post(body, cookie)).status).toBe(400);
		}
		expect((await put("abc", { name: "a" }, cookie)).status).toBe(400);
		expect((await put(1, {}, cookie)).status).toBe(400);
		expect(await viewsIn(await get(cookie))).toEqual([]);
	});

	test(`a user keeps at most ${MAX_VIEWS} views`, async () => {
		const cookie = await signIn(emails[1]);
		await db.insert(schema.savedViews).values(
			Array.from({ length: MAX_VIEWS }, (_, i) => ({
				userId: userIds[1],
				name: `view ${i}`,
				data: view(),
			})),
		);
		const refused = await post({ name: "one more", view: view() }, cookie);
		expect(refused.status).toBe(400);
		expect((await viewsIn(await get(cookie))).length).toBe(MAX_VIEWS);
		await db
			.delete(schema.savedViews)
			.where(eq(schema.savedViews.userId, userIds[1]));
	});

	test("deleting a user deletes their views", async () => {
		const cookie = await signIn(emails[1]);
		await post({ name: "goes too", view: view() }, cookie);
		await db.delete(schema.user).where(eq(schema.user.id, userIds[1]));
		const rows = await db
			.select()
			.from(schema.savedViews)
			.where(eq(schema.savedViews.userId, userIds[1]));
		expect(rows).toEqual([]);
	});
});
