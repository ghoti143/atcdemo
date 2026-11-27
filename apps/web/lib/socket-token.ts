// The short-lived token the browser presents to `atc-server` (DESIGN.md
// section 11). A browser cannot set headers on a WebSocket and the server
// cannot see the session cookie, so the web app signs a token that says who
// is connecting and in what role, and it goes in the query string.

import { SessionEndedError } from "@/lib/socket-client";

/** Better Auth's JWT plugin: a token for the session in the cookie. */
export const SOCKET_TOKEN_PATH = "/api/auth/token";

/**
 * Fetches a fresh token. Rejects with `SessionEndedError` when the web app
 * answers 401, which is its answer to no session, and with a plain error for
 * anything else, which may pass.
 */
export async function fetchSocketToken(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const response = await fetchImpl(SOCKET_TOKEN_PATH, {
		credentials: "same-origin",
		// A token is good for five minutes and must never be reused from a
		// cache: every connection attempt gets its own.
		cache: "no-store",
	});
	if (response.status === 401) {
		throw new SessionEndedError();
	}
	if (!response.ok) {
		throw new Error(`the token request was answered ${response.status}`);
	}
	const body: unknown = await response.json();
	const token =
		typeof body === "object" && body !== null
			? (body as { token?: unknown }).token
			: undefined;
	if (typeof token !== "string" || token === "") {
		throw new Error("the token request's answer held no token");
	}
	return token;
}

/** The socket's address with the token in its query string. */
export function socketUrlWithToken(socketUrl: string, token: string): string {
	const url = new URL(socketUrl);
	url.searchParams.set("token", token);
	return url.toString();
}

/**
 * What the socket client asks before every connection attempt: the address,
 * with a token fetched just now.
 */
export function tokenUrlResolver(
	socketUrl: string,
	fetchImpl?: typeof fetch,
): () => Promise<string> {
	return async () =>
		socketUrlWithToken(socketUrl, await fetchSocketToken(fetchImpl));
}
