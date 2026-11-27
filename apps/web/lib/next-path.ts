// Where to send someone after they sign in. The value travels in the URL,
// so it is checked before it is used: only a path inside this app.

const SIGN_IN_PATH = "/sign-in";

/**
 * The path to return to after sign-in, from an untrusted `next` value. A
 * value that is not a plain path on this origin gives "/": an absolute URL,
 * a protocol-relative one, a backslash trick, the sign-in page itself, or an
 * API route.
 */
export function safeNextPath(next: string | string[] | undefined): string {
	if (typeof next !== "string" || !next.startsWith("/")) {
		return "/";
	}
	// Browsers read "//host" and "/\\host" as another origin, and strip tabs
	// and newlines before they do. No path here needs any of them.
	if (next.startsWith("//") || next.includes("\\")) {
		return "/";
	}
	for (let index = 0; index < next.length; index++) {
		if (next.charCodeAt(index) < 0x20) {
			return "/";
		}
	}
	let url: URL;
	try {
		url = new URL(next, "http://app.invalid");
	} catch {
		return "/";
	}
	if (url.origin !== "http://app.invalid") {
		return "/";
	}
	const { pathname } = url;
	if (
		pathname === SIGN_IN_PATH ||
		pathname.startsWith(`${SIGN_IN_PATH}/`) ||
		pathname === "/api" ||
		pathname.startsWith("/api/")
	) {
		return "/";
	}
	return `${pathname}${url.search}`;
}

/** Why the sign-in page is being shown, when it is not a first visit. */
export type SignInReason = "expired" | "signed-out";

/**
 * The sign-in page's address, carrying where to return to. The front page is
 * the default and is left out.
 */
export function signInPath(next: string, reason?: SignInReason): string {
	const params = new URLSearchParams();
	const target = safeNextPath(next);
	if (target !== "/") {
		params.set("next", target);
	}
	if (reason) {
		params.set("reason", reason);
	}
	const query = params.toString();
	return query ? `${SIGN_IN_PATH}?${query}` : SIGN_IN_PATH;
}

/**
 * What route protection does with a request for a page: let it through, or
 * send it somewhere else. Kept apart from proxy.ts so it can be tested
 * without a server.
 */
export function routeDecision(request: {
	pathname: string;
	search: string;
	signedIn: boolean;
}): { redirect: string } | null {
	const onSignIn = request.pathname === SIGN_IN_PATH;
	if (!request.signedIn) {
		return onSignIn
			? null
			: { redirect: signInPath(`${request.pathname}${request.search}`) };
	}
	if (onSignIn) {
		// Already signed in: go where the page would have sent them.
		const next = new URLSearchParams(request.search).get("next");
		return { redirect: safeNextPath(next ?? undefined) };
	}
	return null;
}
