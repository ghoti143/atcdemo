import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";

// Needs a migrated Postgres, and the same BETTER_AUTH_SECRET as anything else
// that has used that database: the signing key in `jwks` is stored encrypted
// with the secret, and a different one cannot read it. `bun run test` takes
// both from .env. The auth module is imported inside the suite so that a run
// without them never builds it.
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
	let pool: typeof import("@/db/client").pool;
	let user: typeof import("@/db/schema").user;

	async function removeUser() {
		await db.delete(user).where(eq(user.email, email));
	}

	beforeAll(async () => {
		({ auth } = await import("./auth"));
		({ db, pool } = await import("@/db/client"));
		({ user } = await import("@/db/schema"));
		await removeUser();
	});

	afterAll(async () => {
		await removeUser();
		await pool.end();
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
