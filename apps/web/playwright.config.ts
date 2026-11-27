// The end-to-end smoke test (docs/DESIGN.md section 13): the whole stack on
// one machine, driven through a browser.
//
//   bun run build        # once, and after a change to the web app
//   bun run e2e
//
// Playwright starts atc-server and the web app itself, and stops them when
// it is done. It needs what `bun dev` needs: `.env` at the repo root and a
// Postgres to match its DATABASE_URL (`docker compose up -d postgres`).
//
// atc-server replays its built-in fixture, eleven aircraft, so it starts at
// once and the picture is always the same. It verifies tokens for real,
// against the keys of the web app the test also starts.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright loads this file as CommonJS, so `__dirname` and not
// `import.meta.dirname`.
const repoRoot = path.join(__dirname, "../..");

// The repo's `.env`, for the settings the test and the two servers share.
// What the environment already sets wins, as it does for the servers.
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split("\n")) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
		if (match && process.env[match[1]] === undefined) {
			process.env[match[1]] = match[2];
		}
	}
}

const webUrl = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(
	/\/$/,
	"",
);
const webPort = new URL(webUrl).port || "80";
// atc-server always listens on 8080; ATC_WS_URL is how the browser gets there.
const serverHealthUrl = "http://localhost:8080/healthz";
const inCi = Boolean(process.env.CI);

export default defineConfig({
	testDir: "./e2e",
	// Not `.test.ts` or `.spec.ts`, which `bun test` would pick up.
	testMatch: "**/*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: inCi,
	// No retries: a test that passes on the second go has not passed.
	retries: 0,
	timeout: 90_000,
	reporter: inCi ? [["list"], ["github"]] : "list",
	use: {
		baseURL: webUrl,
		screenshot: "only-on-failure",
		trace: "off",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				launchOptions: {
					// A Chromium already on the machine, where Playwright's own
					// download is not to be had.
					executablePath:
						process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
				},
			},
		},
	],
	webServer: [
		{
			name: "web",
			// What the compose setup service does, then the production server.
			// It is started first, and Playwright waits for it before it starts
			// the next: atc-server stops at startup if the tables it records
			// flights in are not there, and it is this step that makes them.
			command: `bun db/setup.ts && bun --bun next start -p ${webPort}`,
			cwd: __dirname,
			env: process.env as Record<string, string>,
			url: `${webUrl}/sign-in`,
			timeout: 2 * 60_000,
			reuseExistingServer: !inCi,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			name: "atc-server",
			command: "cargo run --locked -p atc-server",
			cwd: repoRoot,
			env: {
				...(process.env as Record<string, string>),
				ATC_SEED_FILE: "fixture",
				ATC_STRESS_MULTIPLIER: "1",
				ATC_START_SECONDS: "",
				// Verify tokens, with the keys of the web app started below. It
				// runs on this machine here, not beside a container.
				ATC_AUTH: "",
				ATC_JWKS_URL: `${webUrl}/api/auth/jwks`,
				ATC_ALLOWED_ORIGIN: webUrl,
				ATC_TOKEN_ISSUER: "",
			},
			url: serverHealthUrl,
			// The first run compiles the server.
			timeout: 10 * 60_000,
			reuseExistingServer: !inCi,
			stdout: "pipe",
			stderr: "pipe",
		},
	],
});
