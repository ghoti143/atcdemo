// Notices a session that ends while the page is open: it expired, or the
// user signed out in another tab. The page is one long-lived view with no
// navigation, so nothing else would send them to the sign-in page.

/** How often the session is checked while the page is visible. */
export const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export type SessionCheck = "active" | "ended" | "unknown";

/**
 * Asks the server whether the session still stands. Only a clear answer that
 * there is none counts as ended: a failed request or a server error is
 * `unknown`, so a network blip never signs anyone out.
 */
export async function checkSession(
	fetchImpl: typeof fetch = fetch,
): Promise<SessionCheck> {
	let response: Response;
	try {
		response = await fetchImpl("/api/auth/get-session", {
			credentials: "same-origin",
			cache: "no-store",
		});
	} catch {
		return "unknown";
	}
	if (response.status === 401) {
		return "ended";
	}
	if (!response.ok) {
		return "unknown";
	}
	try {
		// Better Auth answers 200 with `null` when there is no session.
		const body: unknown = await response.json();
		return body === null ? "ended" : "active";
	} catch {
		return "unknown";
	}
}

/**
 * Checks the session on a timer and whenever the page becomes visible again,
 * and calls `onEnded` once when it has gone. Returns a function that stops
 * it. The browser's pieces are parameters so the logic runs in a test.
 */
export function startSessionWatch(options: {
	onEnded: () => void;
	check?: () => Promise<SessionCheck>;
	intervalMs?: number;
	target?: Pick<Document, "addEventListener" | "removeEventListener"> & {
		visibilityState: DocumentVisibilityState;
	};
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}): () => void {
	const {
		onEnded,
		check = () => checkSession(),
		intervalMs = SESSION_CHECK_INTERVAL_MS,
		target = document,
		setTimer = (callback, ms) => setInterval(callback, ms),
		clearTimer = (timer) => clearInterval(timer as number),
	} = options;
	let stopped = false;
	let checking = false;

	const run = async () => {
		// A hidden page is not checked; it is checked when it is shown.
		if (stopped || checking || target.visibilityState !== "visible") {
			return;
		}
		checking = true;
		const result = await check();
		checking = false;
		if (result === "ended" && !stopped) {
			stop();
			onEnded();
		}
	};
	const onVisibility = () => {
		void run();
	};
	const timer = setTimer(() => {
		void run();
	}, intervalMs);
	target.addEventListener("visibilitychange", onVisibility);

	function stop() {
		if (stopped) return;
		stopped = true;
		clearTimer(timer);
		target.removeEventListener("visibilitychange", onVisibility);
	}
	return stop;
}
