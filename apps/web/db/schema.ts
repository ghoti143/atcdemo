// Every table in the one Postgres schema is declared here or re-exported
// from here, and Drizzle owns every migration. The remaining tables arrive
// with the features that need them: `saved_views`, `preferences` and
// `alerts`.
//
// After changing a table, run `bun run db:generate` and commit the new files
// under db/migrations.

export * from "./auth-schema";
export * from "./flight-schema";
