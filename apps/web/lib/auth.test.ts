import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";

// Needs a migrated Postgres, and the same BETTER_AUTH_SECRET as anything else
// that has used that database: the signing key in `jwks` is stored encrypted
// with the secret, and a different one cannot read it. `bun run test` takes
// both from .env. The auth module is imported inside the suite so that a run
// without them never builds it.
//
// The database tests share the app's one connection pool, and `bun test` runs
// every file in one process, so no file closes it: the first to finish would
// close it under the others.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

describe.skipIf(!configured)("Better Auth", () => {
	const email = "auth-test-controller@example.com";
	const password = "auth-test-password";
	let auth: typeof import("./auth").auth;
	let db: typeof import("@/db/client").db;
	let user: typeof import("@/db/schema").user;

	async function removeUser() {
		await db.delete(user).where(eq(user.email, email));
	}

	beforeAll(async () => {
		({ auth } = await import("./auth"));
		({ db } = await import("@/db/client"));
		({ user } = await import("@/db/schema"));
		await removeUser();
	});

	afterAll(async () => {
		await removeUser();
	});

	test("a seeded controller signs in and gets a token carrying the role", async () => {
		const created = await auth.api.createUser({
			body: { email, password, name: "Test Controller", role: "controller" },
		});
		expect(created.user.role).toBe("controller");

		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		const cookie = signIn.headers.get("set-cookie");
		expect(cookie).toContain("better-auth.session_token");

		const headers = new Headers({ cookie: cookie as string });
		const { token } = await auth.api.getToken({ headers });

		// Verify the way atc-server will: with the public keys only.
		const jwks = createLocalJWKSet(await auth.api.getJwks());
		const { payload, protectedHeader } = await jwtVerify(token, jwks, {
			issuer: process.env.BETTER_AUTH_URL,
			audience: process.env.BETTER_AUTH_URL,
		});

		expect(protectedHeader.alg).toBe("EdDSA");
		expect(payload.sub).toBe(created.user.id);
		expect(payload.role).toBe("controller");
		const lifetime = (payload.exp as number) - (payload.iat as number);
		expect(lifetime).toBe(5 * 60);
	});

	test("a user with no role or an unknown one gets a viewer's token", async () => {
		for (const role of [null, "admin"]) {
			await db.update(user).set({ role }).where(eq(user.email, email));
			const signIn = await auth.api.signInEmail({
				body: { email, password },
				returnHeaders: true,
			});
			const headers = new Headers({
				cookie: signIn.headers.get("set-cookie") as string,
			});
			const { token } = await auth.api.getToken({ headers });
			const claims = JSON.parse(
				Buffer.from(token.split(".")[1], "base64url").toString(),
			);
			expect(claims.role).toBe("viewer");
		}
		await db
			.update(user)
			.set({ role: "controller" })
			.where(eq(user.email, email));
	});

	test("two tokens for one session are different tokens", async () => {
		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		const headers = new Headers({
			cookie: signIn.headers.get("set-cookie") as string,
		});
		const first = await auth.api.getToken({ headers });
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const second = await auth.api.getToken({ headers });
		expect(second.token).not.toBe(first.token);
	});

	test("nobody can register by email", async () => {
		await expect(
			auth.api.signUpEmail({
				body: { email: "stranger@example.com", password, name: "Stranger" },
			}),
		).rejects.toThrow();
	});

	test("a token is refused without a session", async () => {
		await expect(
			auth.api.getToken({ headers: new Headers() }),
		).rejects.toThrow();
	});

	test("a wrong password is refused", async () => {
		await expect(
			auth.api.signInEmail({ body: { email, password: "wrong-password" } }),
		).rejects.toThrow();
	});

	test("a controller cannot use the admin plugin's endpoints", async () => {
		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		const headers = new Headers({
			cookie: signIn.headers.get("set-cookie") as string,
		});

		await expect(
			auth.api.setRole({
				body: { userId: signIn.response.user.id, role: "viewer" },
				headers,
			}),
		).rejects.toThrow();
		await expect(auth.api.listUsers({ query: {}, headers })).rejects.toThrow();
	});

	test("over HTTP, a signed-in user can change neither their password nor their name", async () => {
		const origin = process.env.BETTER_AUTH_URL as string;
		const post = (path: string, body: unknown, cookie?: string) =>
			auth.handler(
				new Request(`${origin}/api/auth${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin,
						...(cookie ? { cookie } : {}),
					},
					body: JSON.stringify(body),
				}),
			);
		const signedIn = await post("/sign-in/email", { email, password });
		expect(signedIn.status).toBe(200);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((entry) => entry.split(";")[0])
			.join("; ");

		const changed = await post(
			"/change-password",
			{
				currentPassword: password,
				newPassword: "taken-over-123",
				revokeOtherSessions: true,
			},
			cookie,
		);
		expect(changed.status).toBe(404);
		expect((await post("/update-user", { name: "Taken" }, cookie)).status).toBe(
			404,
		);

		// The account is as it was: the old password still works, the name
		// is the same, and the session was not revoked.
		expect((await post("/sign-in/email", { email, password })).status).toBe(
			200,
		);
		const [row] = await db.select().from(user).where(eq(user.email, email));
		expect(row.name).not.toBe("Taken");
		const session = await auth.api.getSession({
			headers: new Headers({ cookie }),
		});
		expect(session?.user.email).toBe(email);
	});

	test("a tampered token fails verification", async () => {
		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		});
		const headers = new Headers({
			cookie: signIn.headers.get("set-cookie") as string,
		});
		const { token } = await auth.api.getToken({ headers });
		const [head, body, signature] = token.split(".");
		const claims = JSON.parse(Buffer.from(body, "base64url").toString());
		const forgedBody = Buffer.from(
			JSON.stringify({ ...claims, role: "controller", sub: "someone-else" }),
		).toString("base64url");
		const jwks = createLocalJWKSet(await auth.api.getJwks());

		await expect(
			jwtVerify(`${head}.${forgedBody}.${signature}`, jwks),
		).rejects.toThrow();
	});
});
