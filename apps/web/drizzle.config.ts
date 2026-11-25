import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./db/schema.ts",
	out: "./db/migrations",
	// Only the commands that talk to the database need the URL; `generate`
	// works without it.
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
