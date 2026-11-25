import { expect, test } from "bun:test";
import { getSchema } from "better-auth/db";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// Better Auth's tables are written by hand in auth-schema.ts. This fails when
// a plugin is added or upgraded and expects a table or column that the
// Drizzle schema lacks, before it can fail at run time.
test("the Drizzle schema has every table and field Better Auth expects", async () => {
	process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret!";
	process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
	const { auth } = await import("@/lib/auth");
	const tables = schema as unknown as Record<string, PgTable | undefined>;

	const missing: string[] = [];
	for (const [model, definition] of Object.entries(getSchema(auth.options))) {
		const table = tables[model];
		if (!table) {
			missing.push(model);
			continue;
		}
		const columns = getTableColumns(table);
		for (const field of ["id", ...Object.keys(definition.fields)]) {
			if (!(field in columns)) {
				missing.push(`${model}.${field}`);
			}
		}
	}

	expect(missing).toEqual([]);
});
