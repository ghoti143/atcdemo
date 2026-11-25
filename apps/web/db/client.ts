import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function createPool(): Pool {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	return new Pool({ connectionString });
}

// `next dev` re-evaluates modules on every reload. Keeping the pool on
// globalThis stops each reload from opening a new set of connections.
const globalForDb = globalThis as typeof globalThis & { atcPool?: Pool };

export const pool = globalForDb.atcPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
	globalForDb.atcPool = pool;
}

export const db = drizzle(pool, { schema });
