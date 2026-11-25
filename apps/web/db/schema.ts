// Every table in the one Postgres schema is declared here, and Drizzle owns
// every migration. The tables arrive with the features that need them:
// `flights` with the loader, Better Auth's tables with sign-in, then
// `saved_views`, `preferences` and `alerts`.
//
// After changing this file, run `bun run db:generate` and commit the new
// files under db/migrations.

export {};
