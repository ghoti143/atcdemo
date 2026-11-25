# Database

One Postgres database with one schema. Drizzle, in this app, owns every table and every migration, including the tables that `atc-server` reads and writes.

| File | Purpose |
|---|---|
| `schema.ts` | Every table, declared with Drizzle |
| `migrations/` | Generated SQL and Drizzle's journal. Committed; do not edit a migration that has been merged |
| `client.ts` | The `db` client and its `pg` pool, for route handlers and server code |
| `migrate.ts` | Applies pending migrations. Run by `bun run db:migrate` |

All commands below run from `apps/web` and read `DATABASE_URL` from the environment.

## A local Postgres

Until the compose file lands, start a throwaway Postgres with Docker:

```bash
docker run -d --name atcdemo-pg \
  -e POSTGRES_USER=atc -e POSTGRES_PASSWORD=atc -e POSTGRES_DB=atc \
  -p 5432:5432 postgres:19-alpine

export DATABASE_URL=postgres://atc:atc@localhost:5432/atc
```

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

Remove the container and start it again, then migrate:

```bash
docker rm -f atcdemo-pg
# run the `docker run` command above again
bun run db:migrate
```

To reset without restarting Postgres, drop both schemas. `drizzle` holds the record of applied migrations, so it must go too:

```bash
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;'
bun run db:migrate
```

## Tests

`bun test` runs the database tests when `DATABASE_URL` is set and skips them when it is not. They apply the migrations to that database, so point it at a development database.
