import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// The URL is validated once at startup, in instrumentation.ts. It is read
// here without a check because `next build` evaluates this module with no
// database configured, and creating a pool opens no connection.
function createPool(): Pool {
	return new Pool({ connectionString: process.env.DATABASE_URL });
}

// `next dev` re-evaluates modules on every reload. Keeping the pool on
// globalThis stops each reload from opening a new set of connections.
const globalForDb = globalThis as typeof globalThis & { atcPool?: Pool };

export const pool = globalForDb.atcPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
	globalForDb.atcPool = pool;
}

export const db = drizzle(pool, { schema });
