import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, ilike } from "drizzle-orm";
import {
	flightDetailSchema,
	flightSearchSchema,
} from "@/lib/api/flights-shapes";

// The two flights routes against a migrated Postgres, called as Next.js
// calls them: a Request in, a Response out. `bun run test` takes the
// database and the secret from .env; without them the suite is skipped.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

// The row checked in lib/track-codec.test.ts: three samples.
const ROW = Buffer.from(
	"d8d9dd03860104e1c2b407d90b23ae010208170000f0060000aa0401ac0105000004",
	"hex",
);
// Callsigns no recorded flight has, so the suite can run beside real rows.
const PREFIX = "ZQ9";

describe.skipIf(!configured)("the flights API", () => {
	const origin = process.env.BETTER_AUTH_URL as string;
	const email = "flights-api-test@example.com";
	const password = "flights-api-password";
	let auth: typeof import("@/lib/auth").auth;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");
	let search: typeof import("./route").GET;
	let detail: typeof import("./[id]/route").GET;
	let cookie = "";
	const ids: Record<string, number> = {};

	const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

	async function insertFlight(
		name: string,
		values: {
			callsign: string;
			firstSeenAt: Date;
			lastSeenAt: Date | null;
			aircraftId?: number;
			origin?: string | null;
		},
	) {
		const [row] = await db
			.insert(schema.flights)
			.values({
				aircraftId: values.aircraftId ?? 4_000_000_000,
				icao24: 0x00a1b2,
				callsign: values.callsign,
				aircraftType: "B738",
				origin: values.origin ?? null,
				destination: "KJFK",
				pass: 2,
				firstSeenSimS: 100,
				firstSeenAt: values.firstSeenAt,
				lastSeenSimS: values.lastSeenAt ? 420 : null,
				lastSeenAt: values.lastSeenAt,
			})
			.returning({ id: schema.flights.id });
		ids[name] = row.id;
	}

	async function removeRows() {
		// Whatever the case: one of the flights is in lower case.
		await db
			.delete(schema.flights)
			.where(ilike(schema.flights.callsign, `${PREFIX}%`));
		await db.delete(schema.user).where(eq(schema.user.email, email));
	}

	const get = (path: string, signedIn = true) =>
		new Request(`${origin}${path}`, {
			headers: signedIn ? { cookie } : {},
		});
	const getFlight = (id: string | number, signedIn = true) =>
		detail(get(`/api/flights/${id}`, signedIn), {
			params: Promise.resolve({ id: String(id) }),
		});

	beforeAll(async () => {
		({ auth } = await import("@/lib/auth"));
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		({ GET: search } = await import("./route"));
		({ GET: detail } = await import("./[id]/route"));
		await removeRows();

		await auth.api.createUser({
			body: { email, password, name: "Flights Test", role: "viewer" },
		});
		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		cookie = signIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");

		await insertFlight("finished", {
			callsign: `${PREFIX}100`,
			firstSeenAt: hoursAgo(3),
			lastSeenAt: hoursAgo(2),
			origin: "KORD",
		});
		await insertFlight("flying", {
			callsign: `${PREFIX}200`,
			firstSeenAt: hoursAgo(1),
			lastSeenAt: null,
			aircraftId: 777,
		});
		await insertFlight("bare", {
			callsign: `${PREFIX}300`,
			firstSeenAt: hoursAgo(0.1),
			lastSeenAt: null,
		});
		await insertFlight("yesterday", {
			callsign: `${PREFIX}100`,
			firstSeenAt: hoursAgo(30),
			lastSeenAt: hoursAgo(26),
		});
		await insertFlight("lowercase", {
			callsign: `${PREFIX.toLowerCase()}abc`,
			firstSeenAt: hoursAgo(5),
			lastSeenAt: hoursAgo(4),
		});
		// Two batches for the finished flight, written out of order, and one
		// for the flying one.
		await db.insert(schema.flightTracks).values([
			{
				flightId: ids.finished,
				firstSampleSimS: 400,
				sampleCount: 3,
				samples: ROW,
			},
			{
				flightId: ids.finished,
				firstSampleSimS: 100,
				sampleCount: 3,
				samples: ROW,
			},
			{
				flightId: ids.flying,
				firstSampleSimS: 3_700,
				sampleCount: 3,
				samples: ROW,
			},
		]);
	});

	afterAll(removeRows);

	describe("without a session", () => {
		test("both routes answer 401, in the API's error shape", async () => {
			for (const response of [
				await search(get(`/api/flights?search=${PREFIX}`, false)),
				await getFlight(ids.finished, false),
				// A cookie that is not a session.
				await search(
					new Request(`${origin}/api/flights?search=${PREFIX}`, {
						headers: { cookie: "better-auth.session_token=forged.forged" },
					}),
				),
			]) {
				expect(response.status).toBe(401);
				expect(await response.json()).toEqual({
					error: { code: "unauthorized", message: "Sign in to use this." },
				});
			}
		});

		test("the session is checked before the input is read", async () => {
			const response = await getFlight("not-an-id", false);
			expect(response.status).toBe(401);
		});
	});

	describe("GET /api/flights/:id", () => {
		test("an unknown flight is 404", async () => {
			const response = await getFlight(999_999_999_999);
			expect(response.status).toBe(404);
			expect((await response.json()).error.code).toBe("not_found");
		});

		test("an id that is not one is 400", async () => {
			for (const id of [
				"abc",
				"0",
				"-5",
				"1.5",
				"12345678901234567",
				"1 or 1=1",
			]) {
				const response = await getFlight(id);
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({
					error: {
						code: "invalid_request",
						fields: { id: "must be a flight id" },
					},
				});
			}
		});

		test("a finished flight has its details and its whole track as arrays", async () => {
			const response = await getFlight(ids.finished);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const body = flightDetailSchema.parse(await response.json());

			expect(body.flight).toMatchObject({
				id: ids.finished,
				aircraftId: 4_000_000_000,
				icao24: "00a1b2",
				callsign: `${PREFIX}100`,
				aircraftType: "B738",
				origin: "KORD",
				destination: "KJFK",
				pass: 2,
				firstSeenSimS: 100,
				lastSeenSimS: 420,
				flying: false,
			});
			expect(body.flight.lastSeenAt).not.toBeNull();

			// Both batches, in order of time, each sample ten seconds on.
			expect(body.track.timesS).toEqual([100, 110, 120, 400, 410, 420]);
			expect(body.track.lat).toEqual([
				39.13324, 39.13391, 39.1346, 39.13324, 39.13391, 39.1346,
			]);
			expect(body.track.lon.slice(0, 3)).toEqual([
				-77.70289, -77.71038, -77.71805,
			]);
			expect(body.track.altitudeFt.slice(0, 3)).toEqual([2_175, 2_200, 2_300]);
			expect(body.track.barometricFt.slice(3)).toEqual([1_875, 1_900, 2_000]);
			expect(body.track.groundSpeedKt).toEqual(new Array(6).fill(440));
			expect(body.track.trackDeg.slice(0, 3)).toEqual([277, 276, 2]);
			expect(body.track.verticalRateFpm).toEqual(new Array(6).fill(-192));
			expect(body.track.onGround).toEqual([
				false,
				false,
				true,
				false,
				false,
				true,
			]);
		});

		test("a flight still in the air says so, with its aircraft id and its track so far", async () => {
			const body = flightDetailSchema.parse(
				await (await getFlight(ids.flying)).json(),
			);
			expect(body.flight).toMatchObject({
				aircraftId: 777,
				flying: true,
				lastSeenAt: null,
				lastSeenSimS: null,
			});
			expect(body.track.timesS).toEqual([3_700, 3_710, 3_720]);
		});

		test("a flight with nothing recorded yet has an empty track", async () => {
			const body = flightDetailSchema.parse(
				await (await getFlight(ids.bare)).json(),
			);
			expect(body.track.timesS).toEqual([]);
			expect(body.track.lat).toEqual([]);
			expect(body.track.onGround).toEqual([]);
		});
	});

	describe("GET /api/flights?search=", () => {
		const found = async (query: string) => {
			const response = await search(get(`/api/flights?${query}`));
			expect(response.status).toBe(200);
			return flightSearchSchema.parse(await response.json()).flights;
		};

		test("finds flights whose callsign starts with the text, flying first", async () => {
			const flights = await found(`search=${PREFIX}`);
			expect(flights.map((flight) => flight.id)).toEqual([
				// Flying, the one that started last first.
				ids.bare,
				ids.flying,
				// Then finished, the most recently seen first.
				ids.finished,
				ids.lowercase,
			]);
			expect(flights[1]).toMatchObject({ flying: true, aircraftId: 777 });
		});

		test("matches whatever the case of either", async () => {
			expect(
				(await found(`search=${PREFIX.toLowerCase()}1`)).map((f) => f.id),
			).toEqual([ids.finished]);
			expect((await found(`search=${PREFIX}AB`)).map((f) => f.id)).toEqual([
				ids.lowercase,
			]);
		});

		test("leaves out a flight last seen more than a day ago", async () => {
			const flights = await found(`search=${PREFIX}100`);
			expect(flights.map((flight) => flight.id)).toEqual([ids.finished]);
		});

		test("matches the start of a callsign, not its middle", async () => {
			expect(await found("search=Q91")).toEqual([]);
			expect(await found(`search=${PREFIX}999`)).toEqual([]);
		});

		test("returns no more than the limit", async () => {
			expect(await found(`search=${PREFIX}&limit=2`)).toHaveLength(2);
			expect(await found(`search=${PREFIX}&limit=1`)).toHaveLength(1);
		});

		test("a search that is missing or not a callsign is 400, naming the field", async () => {
			const cases: [string, string][] = [
				["", "search"],
				["search=", "search"],
				["search=%20%20", "search"],
				["search=UAL%25", "search"],
				["search=A_B", "search"],
				["search=ABCDEFGHI", "search"],
				[`search=${PREFIX}&limit=0`, "limit"],
				[`search=${PREFIX}&limit=51`, "limit"],
				[`search=${PREFIX}&limit=two`, "limit"],
				[`search=${PREFIX}&limit=1.5`, "limit"],
			];
			for (const [query, field] of cases) {
				const response = await search(get(`/api/flights?${query}`));
				expect(response.status).toBe(400);
				const body = await response.json();
				expect(body.error.code).toBe("invalid_request");
				expect(Object.keys(body.error.fields)).toEqual([field]);
			}
		});
	});
});
