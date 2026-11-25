// The one-shot setup step that `docker compose up` runs before atc-server
// starts. Every step is safe to repeat, so it runs on every start.
//
// Steps so far: apply the migrations. Loading the flights and creating the
// demo accounts are added by later issues.

import { runMigrations } from "./migrate";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("setup: DATABASE_URL is not set");
	process.exit(1);
}

try {
	await runMigrations(connectionString);
	console.log("setup: migrations applied");
} catch (error) {
	console.error("setup: failed to apply migrations");
	console.error(error);
	process.exit(1);
}

console.log("setup: done");
