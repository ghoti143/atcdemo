import { afterAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "./migrate";
import journal from "./migrations/meta/_journal.json";

const connectionString = process.env.DATABASE_URL;

// Needs a real Postgres. Without DATABASE_URL the suite is skipped, so
// `bun test` still passes on a machine with no database; CI always sets it.
describe.skipIf(!connectionString)("runMigrations", () => {
	const pool = new Pool({ connectionString, max: 1 });

	afterAll(async () => {
		await pool.end();
	});

	async function appliedCount(): Promise<number> {
		const result = await pool.query(
			"SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
		);
		return result.rows[0].count;
	}

	test("applies every migration in the journal", async () => {
		await runMigrations(connectionString as string);

		expect(await appliedCount()).toBe(journal.entries.length);
	});

	test("applies nothing on a second run", async () => {
		await runMigrations(connectionString as string);
		await runMigrations(connectionString as string);

		expect(await appliedCount()).toBe(journal.entries.length);
	});
});
