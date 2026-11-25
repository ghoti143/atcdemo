# Database

One Postgres database with one schema. Drizzle, in this app, owns every table and every migration, including the tables that `atc-server` reads and writes.

| File | Purpose |
|---|---|
| `schema.ts` | Every table, declared with Drizzle or re-exported from a file beside it |
| `auth-schema.ts` | Better Auth's tables. Written by hand; `auth-schema.test.ts` checks it against what the configured plugins expect |
| `migrations/` | Generated SQL and Drizzle's journal. Committed; do not edit a migration that has been merged |
| `client.ts` | The `db` client and its `pg` pool, for route handlers and server code |
| `migrate.ts` | Applies pending migrations. Run by `bun run db:migrate` |
| `setup.ts` | What the compose `setup` service runs before `atc-server` starts: migrations now, the flights loader and demo accounts later |

All commands below run from `apps/web`. They read `DATABASE_URL` from `.env` at the repo root, or from the environment, which wins.

## A local Postgres

`docker compose up postgres` at the repo root starts Postgres on port 5432, matching the `DATABASE_URL` in `.env.example`. A plain `docker compose up` also runs the `setup` service, which applies the migrations by running `db/setup.ts`.

## Applying migrations

```bash
bun run db:migrate
```

This applies every migration the database has not yet recorded. Drizzle keeps its record in the `drizzle.__drizzle_migrations` table, so running it again does nothing.

## Adding a migration

1. Change `db/schema.ts`.
2. Run `bun run db:generate -- --name=short_description`. Drizzle compares the schema with the latest snapshot in `migrations/meta` and writes a new numbered SQL file. This step does not need a database.
3. Read the generated SQL. Drizzle asks when it cannot tell a rename from a drop and an add; check that it guessed as you meant.
4. Run `bun run db:migrate` and check the result.
5. Commit `schema.ts` and everything new under `migrations/` together.

For a change Drizzle cannot express in the schema, such as a data fix, run `bun run db:generate -- --custom --name=short_description` and write the SQL by hand in the empty file it creates.

Do not use `drizzle-kit push`. It changes the database without writing a migration, so no other environment can reproduce the change.

## Resetting the database

```bash
docker compose down -v
docker compose up
```

`down -v` deletes the database volume, and the `setup` service migrates the new, empty database.

To reset without restarting Postgres, drop both schemas. `drizzle` holds the record of applied migrations, so it must go too:

```bash
docker compose exec postgres psql -U atc -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;'
bun run db:migrate
```

## Tests

`bun run test` runs the database tests when `DATABASE_URL` is set, which it is once `.env` exists, so Postgres must be running. They apply the migrations to that database, so point it at a development database. Without `DATABASE_URL` they are skipped.
