import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DemoAccount } from "./demo-accounts";

// Needs a migrated Postgres. The accounts here are not the real demo
// accounts, so a run leaves a developer's own untouched.
const configured = Boolean(
	process.env.DATABASE_URL &&
		process.env.BETTER_AUTH_SECRET &&
		process.env.BETTER_AUTH_URL,
);

test("there is one demo account for each role, each with its own password variable", async () => {
	const { DEMO_ACCOUNTS } = await import("./demo-accounts");
	expect(DEMO_ACCOUNTS.map((account) => account.role).sort()).toEqual([
		"controller",
		"viewer",
	]);
	expect(new Set(DEMO_ACCOUNTS.map((a) => a.email)).size).toBe(2);
	expect(new Set(DEMO_ACCOUNTS.map((a) => a.passwordVariable)).size).toBe(2);
});

describe.skipIf(!configured)("ensureDemoAccount", () => {
	const account: DemoAccount = {
		role: "controller",
		email: "demo-test-controller@example.com",
		name: "Demo Test Controller",
		passwordVariable: "DEMO_CONTROLLER_PASSWORD",
	};
	let auth: typeof import("./auth").auth;
	let ensureDemoAccount: typeof import("./demo-accounts").ensureDemoAccount;
	let db: typeof import("@/db/client").db;
	let schema: typeof import("@/db/schema");

	async function removeUser() {
		await db.delete(schema.user).where(eq(schema.user.email, account.email));
	}

	async function signsIn(password: string): Promise<boolean> {
		try {
			await auth.api.signInEmail({ body: { email: account.email, password } });
			return true;
		} catch {
			return false;
		}
	}

	async function stored() {
		const [row] = await db
			.select()
			.from(schema.user)
			.where(eq(schema.user.email, account.email));
		return row;
	}

	beforeAll(async () => {
		({ auth } = await import("./auth"));
		({ ensureDemoAccount } = await import("./demo-accounts"));
		({ db } = await import("@/db/client"));
		schema = await import("@/db/schema");
		await removeUser();
	});

	afterAll(async () => {
		await removeUser();
	});

	test("creates the account with its role, and it signs in", async () => {
		expect(await ensureDemoAccount(auth, account, "first-password")).toBe(
			"created",
		);
		expect((await stored()).role).toBe("controller");
		expect(await signsIn("first-password")).toBe(true);
		expect(await signsIn("wrong-password")).toBe(false);
	});

	test("a second run changes nothing", async () => {
		const before = await stored();
		expect(await ensureDemoAccount(auth, account, "first-password")).toBe(
			"unchanged",
		);
		const after = await stored();
		expect(after.id).toBe(before.id);
		expect(after.updatedAt).toEqual(before.updatedAt);
		const users = await db
			.select({ id: schema.user.id })
			.from(schema.user)
			.where(eq(schema.user.email, account.email));
		expect(users).toHaveLength(1);
	});

	test("a changed password takes effect and the old one stops working", async () => {
		expect(await ensureDemoAccount(auth, account, "second-password")).toBe(
			"updated",
		);
		expect(await signsIn("second-password")).toBe(true);
		expect(await signsIn("first-password")).toBe(false);
	});

	test("a role that has drifted is put back", async () => {
		await db
			.update(schema.user)
			.set({ role: "viewer" })
			.where(eq(schema.user.email, account.email));
		expect(await ensureDemoAccount(auth, account, "second-password")).toBe(
			"updated",
		);
		expect((await stored()).role).toBe("controller");
	});

	test("an account that lost its password gets one", async () => {
		const { id } = await stored();
		await db.delete(schema.account).where(eq(schema.account.userId, id));
		expect(await signsIn("second-password")).toBe(false);
		expect(await ensureDemoAccount(auth, account, "second-password")).toBe(
			"updated",
		);
		expect(await signsIn("second-password")).toBe(true);
	});
});
