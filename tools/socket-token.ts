// Prints a socket token for a demo account, for programs that are not a
// browser: `atc-cli`, or a WebSocket client of your own.
//
//   bun tools/socket-token.ts [viewer|controller]
//   cargo run -p atc-cli -- --token "$(bun tools/socket-token.ts)" --frames 5
//   ATC_TOKEN=$(bun tools/socket-token.ts controller) cargo run -p atc-cli
//
// It signs in to the web app the way the sign-in page does, then asks for a
// token the way the page does. So the web app must be running, and the
// setup service must have created the demo accounts. Run it from the repo
// root, where Bun reads `.env`: it uses BETTER_AUTH_URL and the demo
// account's password from there.
//
// The token is good for five minutes and is the only thing written to
// standard output.

const ROLES = {
	viewer: { email: "viewer@example.com", variable: "DEMO_VIEWER_PASSWORD" },
	controller: {
		email: "controller@example.com",
		variable: "DEMO_CONTROLLER_PASSWORD",
	},
} as const;

function fail(message: string): never {
	console.error(`socket-token: ${message}`);
	process.exit(1);
}

const role = process.argv[2] ?? "viewer";
if (role !== "viewer" && role !== "controller") {
	console.error("usage: bun tools/socket-token.ts [viewer|controller]");
	process.exit(2);
}
const { email, variable } = ROLES[role];
const password = process.env[variable];
if (!password) {
	fail(`${variable} is not set; run this from the repo root, where .env is`);
}
const origin = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(
	/\/$/,
	"",
);

let signIn: Response;
try {
	signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		// Better Auth checks the origin of a request that changes state.
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ email, password }),
	});
} catch (error) {
	fail(
		`could not reach the web app at ${origin}: ${error instanceof Error ? error.message : error}`,
	);
}
if (!signIn.ok) {
	fail(
		`signing in as ${email} was answered ${signIn.status}; has the setup service created the demo accounts, with this password?`,
	);
}
const cookie = signIn.headers
	.getSetCookie()
	.map((entry) => entry.split(";")[0])
	.join("; ");

const response = await fetch(`${origin}/api/auth/token`, {
	headers: { cookie },
});
if (!response.ok) {
	fail(`the token request was answered ${response.status}`);
}
const { token } = (await response.json()) as { token?: unknown };
if (typeof token !== "string" || token === "") {
	fail("the token request's answer held no token");
}
console.log(token);

// Makes this file a module, which top-level `await` needs.
export {};
