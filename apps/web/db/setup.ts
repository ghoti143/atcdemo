// The one-shot setup step that `docker compose up` runs before atc-server
// starts. Every step is safe to repeat, so it runs on every start.
//
// Steps so far: apply the migrations, then create the demo accounts. Loading
// the flights is added by a later issue.

import { DEMO_ACCOUNTS, MIN_PASSWORD_LENGTH } from "../lib/demo-accounts";
import { runMigrations } from "./migrate";

// Everything setup needs is checked before anything is changed, and every
// problem is named at once.
const problems: string[] = [];
for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
	if (!process.env[name]) {
		problems.push(`${name} is not set`);
	}
}
for (const { passwordVariable } of DEMO_ACCOUNTS) {
	const password = process.env[passwordVariable];
	if (!password) {
		problems.push(`${passwordVariable} is not set`);
	} else if (password.length < MIN_PASSWORD_LENGTH) {
		problems.push(
			`${passwordVariable} must be at least ${MIN_PASSWORD_LENGTH} characters`,
		);
	}
}
if (problems.length > 0) {
	for (const problem of problems) {
		console.error(`setup: ${problem}`);
	}
	process.exit(1);
}

try {
	await runMigrations(process.env.DATABASE_URL as string);
	console.log("setup: migrations applied");
} catch (error) {
	console.error("setup: failed to apply migrations");
	console.error(error);
	process.exit(1);
}

// Better Auth is loaded only now: it needs the tables the migrations made.
const { auth } = await import("../lib/auth");
const { ensureDemoAccount } = await import("../lib/demo-accounts");
const { pool } = await import("./client");
try {
	for (const account of DEMO_ACCOUNTS) {
		const result = await ensureDemoAccount(
			auth,
			account,
			process.env[account.passwordVariable] as string,
		);
		console.log(`setup: demo ${account.role} ${account.email} ${result}`);
	}
} catch (error) {
	console.error("setup: failed to create the demo accounts");
	console.error(error);
	process.exit(1);
} finally {
	await pool.end();
}

console.log("setup: done");
