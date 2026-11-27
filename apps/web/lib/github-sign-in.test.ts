import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

// GitHub sign-in from end to end, against a migrated Postgres, with GitHub
// itself played by a stub of `fetch`: the token exchange and the two profile
// calls. Everything between is Better Auth's own code and this app's
// configuration of it.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

type GithubUser = { id: number; login: string; email: string };

describe.skipIf(!configured)("GitHub sign-in", () => {
	const origin = process.env.BETTER_AUTH_URL as string;
	const listed: GithubUser = {
		id: 9_000_001,
		login: "Atc-Test-Listed",
		email: "github-test-listed@example.com",
	};
	const unlisted: GithubUser = {
		id: 9_000_002,
		login: "atc-test-unlisted",
		email: "github-test-unlisted@example.com",
	};
	const demoLookalike: GithubUser = {
		id: 9_000_003,
		login: "atc-test-lookalike",
		email: "github-test-existing@example.com",
	};
	const emails = [listed.email, unlisted.email, demoLookalike.email];

	let authModule: typeof import("./auth");
	let auth: ReturnType<typeof import("./auth").createAuth>;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");
	const realFetch = globalThis.fetch;
	const controllersBefore = process.env.CONTROLLER_GITHUB_USERS;
	// The GitHub user whose browser is "at GitHub" for the next callback.
	let githubUser: GithubUser = listed;

	async function removeUsers() {
		await db.delete(schema.user).where(inArray(schema.user.email, emails));
	}

	beforeAll(async () => {
		authModule = await import("./auth");
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		auth = authModule.createAuth({
			github: { clientId: "test-client-id", clientSecret: "test-secret" },
		});
		await removeUsers();

		const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://github.com/login/oauth/access_token") {
				return Response.json({
					access_token: "gho_test",
					token_type: "bearer",
					scope: "read:user,user:email",
				});
			}
			if (url === "https://api.github.com/user") {
				return Response.json({
					id: githubUser.id,
					login: githubUser.login,
					name: null,
					email: null,
					avatar_url: "https://example.com/avatar.png",
				});
			}
			if (url === "https://api.github.com/user/emails") {
				return Response.json([
					{ email: githubUser.email, primary: true, verified: true },
				]);
			}
			return realFetch(input, init);
		};
		globalThis.fetch = Object.assign(stub, realFetch);
	});

	afterAll(async () => {
		globalThis.fetch = realFetch;
		if (controllersBefore === undefined) {
			delete process.env.CONTROLLER_GITHUB_USERS;
		} else {
			process.env.CONTROLLER_GITHUB_USERS = controllersBefore;
		}
		await removeUsers();
	});

	/** The `name=value` pairs of a response's cookies, for the next request. */
	function cookiesOf(response: Response): string {
		return response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(";")[0])
			.join("; ");
	}

	/** Signs in as `who`, as a browser would, and returns the last response. */
	async function signInWithGithub(
		who: GithubUser,
		handle: (request: Request) => Promise<Response>,
	): Promise<Response> {
		githubUser = who;
		const start = await handle(
			new Request(`${origin}/api/auth/sign-in/social`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ provider: "github", callbackURL: "/" }),
			}),
		);
		expect(start.status).toBe(200);
		const { url } = (await start.json()) as { url: string };
		const authorize = new URL(url);
		expect(authorize.origin + authorize.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
		expect(authorize.searchParams.get("redirect_uri")).toBe(
			`${origin}/api/auth/callback/github`,
		);
		const state = authorize.searchParams.get("state") as string;

		return handle(
			new Request(
				`${origin}/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`,
				{ headers: { cookie: cookiesOf(start) } },
			),
		);
	}

	async function roleOf(email: string): Promise<string | null | undefined> {
		const rows = await db
			.select({ role: schema.user.role })
			.from(schema.user)
			.where(eq(schema.user.email, email));
		return rows[0]?.role;
	}

	const viaRoute = (request: Request) =>
		authModule.handleAuthRequest(request, auth);

	test("a listed GitHub user is created as a controller, whatever the case", async () => {
		process.env.CONTROLLER_GITHUB_USERS = "someone-else, atc-test-listed";
		const response = await signInWithGithub(listed, viaRoute);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/");
		expect(cookiesOf(response)).toContain("better-auth.session_token");
		expect(await roleOf(listed.email)).toBe("controller");

		// And the socket token says so.
		const { token } = await auth.api.getToken({
			headers: new Headers({ cookie: cookiesOf(response) }),
		});
		const claims = JSON.parse(
			Buffer.from(token.split(".")[1], "base64url").toString(),
		);
		expect(claims.role).toBe("controller");
	});

	test("any other GitHub user is created as a viewer", async () => {
		process.env.CONTROLLER_GITHUB_USERS = "atc-test-listed";
		const response = await signInWithGithub(unlisted, viaRoute);

		expect(response.status).toBe(302);
		expect(cookiesOf(response)).toContain("better-auth.session_token");
		expect(await roleOf(unlisted.email)).toBe("viewer");
	});

	test("the list is applied at creation only", async () => {
		// Listed now, but the account already exists as a viewer.
		process.env.CONTROLLER_GITHUB_USERS = "atc-test-unlisted";
		const again = await signInWithGithub(unlisted, viaRoute);
		expect(again.status).toBe(302);
		expect(await roleOf(unlisted.email)).toBe("viewer");

		// No longer listed, and still a controller.
		process.env.CONTROLLER_GITHUB_USERS = "";
		const listedAgain = await signInWithGithub(listed, viaRoute);
		expect(listedAgain.status).toBe(302);
		expect(await roleOf(listed.email)).toBe("controller");
	});

	test("a GitHub sign-in does not join an existing account with the same email", async () => {
		await auth.api.createUser({
			body: {
				email: demoLookalike.email,
				password: "an-existing-password",
				name: "Existing",
				role: "controller",
			},
		});
		process.env.CONTROLLER_GITHUB_USERS = "";
		const response = await signInWithGithub(demoLookalike, viaRoute);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("error=");
		expect(cookiesOf(response)).not.toContain("better-auth.session_token");
		const accounts = await db
			.select({ providerId: schema.account.providerId })
			.from(schema.account)
			.innerJoin(schema.user, eq(schema.account.userId, schema.user.id))
			.where(eq(schema.user.email, demoLookalike.email));
		expect(accounts).toEqual([{ providerId: "credential" }]);
	});

	test("without the id and secret there is no GitHub sign-in", async () => {
		const plain = authModule.createAuth();
		const response = await authModule.handleAuthRequest(
			new Request(`${origin}/api/auth/sign-in/social`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ provider: "github", callbackURL: "/" }),
			}),
			plain,
		);
		expect(response.status).toBe(404);
	});
});
