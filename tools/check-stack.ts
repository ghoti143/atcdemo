// Checks that a running stack works end to end, as a browser would use it:
// the sign-in page, a demo sign-in, the map page, the airspace files, a
// socket token, and live traffic on the socket. For CI after
// `docker compose --profile full up`, and for anyone checking a demo
// before showing it.
//
//   bun tools/check-stack.ts
//
// Run it from the repo root, where Bun reads `.env`: it uses
// BETTER_AUTH_URL, ATC_WS_URL and DEMO_VIEWER_PASSWORD from there. It
// prints one line a step and exits non-zero at the first that fails.

const TIMEOUT_MS = 30_000;
/** The socket protocol this checks against, as `hello` sends it. */
const PROTOCOL = 2;

const origin = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(
	/\/$/,
	"",
);
const socketUrl = process.env.ATC_WS_URL ?? "ws://localhost:8080/ws";
const password = process.env.DEMO_VIEWER_PASSWORD;

function fail(message: string): never {
	console.error(`check-stack: ${message}`);
	process.exit(1);
}

function pass(message: string) {
	console.log(`ok  ${message}`);
}

async function get(path: string, cookie?: string): Promise<Response> {
	try {
		return await fetch(`${origin}${path}`, {
			headers: cookie ? { cookie } : {},
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		fail(
			`could not reach ${origin}${path}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

if (!password) {
	fail(
		"DEMO_VIEWER_PASSWORD is not set; run this from the repo root, where .env is",
	);
}

const signInPage = await get("/sign-in");
if (signInPage.status !== 200) fail(`/sign-in answered ${signInPage.status}`);
pass(`${origin}/sign-in answers 200`);

const signedIn = await fetch(`${origin}/api/auth/sign-in/email`, {
	method: "POST",
	// Better Auth checks the origin of a request that changes state.
	headers: { "content-type": "application/json", origin },
	body: JSON.stringify({ email: "viewer@example.com", password }),
	signal: AbortSignal.timeout(TIMEOUT_MS),
});
if (!signedIn.ok) {
	fail(
		`signing in as the demo viewer was answered ${signedIn.status}; has the setup service run, with this password?`,
	);
}
const cookie = signedIn.headers
	.getSetCookie()
	.map((entry) => entry.split(";")[0])
	.join("; ");
pass("the demo viewer signs in");

const page = await get("/", cookie);
if (page.status !== 200)
	fail(`the map page answered ${page.status} when signed in`);
pass("the map page answers 200");

const airspace = await get("/api/airspace/class-b", cookie);
if (airspace.status !== 200)
	fail(`/api/airspace/class-b answered ${airspace.status}`);
const shelves = ((await airspace.json()) as { features?: unknown[] }).features;
if (!Array.isArray(shelves) || shelves.length === 0) {
	fail("/api/airspace/class-b held no shelves");
}
pass(`the airspace route serves ${shelves.length} Class B shelves`);

const tokenAnswer = await get("/api/auth/token", cookie);
if (!tokenAnswer.ok)
	fail(`the token request was answered ${tokenAnswer.status}`);
const { token } = (await tokenAnswer.json()) as { token?: unknown };
if (typeof token !== "string" || token === "")
	fail("the token answer held no token");
pass("a socket token is issued");

// The server checks the token against the web app's signing keys, so a
// frame back means the server reached the web app for them too.
const frames = await new Promise<number>((resolve, reject) => {
	const separator = socketUrl.includes("?") ? "&" : "?";
	const socket = new WebSocket(`${socketUrl}${separator}token=${token}`);
	socket.binaryType = "arraybuffer";
	let received = 0;
	const timer = setTimeout(() => {
		socket.close();
		reject(
			new Error(`no traffic on ${socketUrl} within ${TIMEOUT_MS / 1000} s`),
		);
	}, TIMEOUT_MS);
	socket.onopen = () =>
		socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL }));
	socket.onmessage = (event) => {
		if (typeof event.data === "string") return;
		received += 1;
		// Two frames: the first may be the snapshot, the second shows it moves.
		if (received === 2) {
			clearTimeout(timer);
			socket.close();
			resolve(received);
		}
	};
	socket.onclose = (event) => {
		if (received < 2) {
			clearTimeout(timer);
			reject(
				new Error(
					`${socketUrl} closed with ${[event.code, event.reason].filter(Boolean).join(" ")} before any traffic`,
				),
			);
		}
	};
	socket.onerror = () => {};
}).catch((error: Error) => fail(error.message));
pass(`the socket at ${socketUrl} streams traffic (${frames} frames)`);

// Makes this file a module, which top-level `await` needs.
export {};
