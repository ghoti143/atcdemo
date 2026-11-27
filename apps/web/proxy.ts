import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { routeDecision } from "@/lib/next-path";

// Route protection: a visit to any page without a session goes to the
// sign-in page, and a visit to the sign-in page with one goes on to the app.
// Proxy runs on the Node.js runtime, so the session is checked against the
// database here and not merely by the presence of a cookie.
//
// This is the first check, not the only one: pages and route handlers read
// the session themselves, because a matcher is easy to get wrong.
export async function proxy(request: NextRequest) {
	const session = await auth.api.getSession({ headers: request.headers });
	const decision = routeDecision({
		pathname: request.nextUrl.pathname,
		search: request.nextUrl.search,
		signedIn: session !== null,
	});
	if (!decision) {
		return NextResponse.next();
	}
	return NextResponse.redirect(new URL(decision.redirect, request.url));
}

export const config = {
	// Every page. Not the API, whose routes answer 401 themselves and must
	// not redirect; not Next.js's own files; not the two files in public/.
	matcher: [
		"/((?!api/|_next/static|_next/image|favicon\\.ico$|aircraft\\.svg$).*)",
	],
};
