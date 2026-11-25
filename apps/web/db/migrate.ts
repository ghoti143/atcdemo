import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export const migrationsFolder = path.join(import.meta.dir, "migrations");

/** Applies every migration that the database has not yet recorded. */
export async function runMigrations(connectionString: string): Promise<void> {
	const pool = new Pool({ connectionString, max: 1 });
	try {
		await migrate(drizzle(pool), { migrationsFolder });
	} finally {
		await pool.end();
	}
}

if (import.meta.main) {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error("DATABASE_URL is not set");
		process.exit(1);
	}
	await runMigrations(connectionString);
	console.log("Migrations applied");
}
