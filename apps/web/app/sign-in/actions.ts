"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, githubSignInEnabled } from "@/lib/auth";
import { safeNextPath, signInPath } from "@/lib/next-path";

export type SignInState = { error: string | null; email: string };

/**
 * Signs in with an email and password. On success the session cookie is set
 * (by Better Auth's `nextCookies` plugin) and the browser is sent on.
 */
export async function signInWithPassword(
	_previous: SignInState,
	form: FormData,
): Promise<SignInState> {
	const email = String(form.get("email") ?? "").trim();
	const password = String(form.get("password") ?? "");
	const next = safeNextPath(String(form.get("next") ?? ""));
	if (!email || !password) {
		return { error: "Enter an email address and a password.", email };
	}

	try {
		await auth.api.signInEmail({
			body: { email, password },
			headers: await headers(),
		});
	} catch (error) {
		if (error instanceof APIError) {
			// One message for an unknown address and a wrong password, so the
			// form does not say which accounts exist.
			return { error: "That email address or password is not right.", email };
		}
		throw error;
	}
	redirect(next);
}

/** Starts a GitHub sign-in: sends the browser to GitHub. */
export async function signInWithGithub(form: FormData): Promise<void> {
	const next = safeNextPath(String(form.get("next") ?? ""));
	if (!githubSignInEnabled) {
		redirect(signInPath(next));
	}
	const errorParams = new URLSearchParams({ error: "github" });
	if (next !== "/") {
		errorParams.set("next", next);
	}
	const { url } = await auth.api.signInSocial({
		body: {
			provider: "github",
			callbackURL: next,
			errorCallbackURL: `/sign-in?${errorParams}`,
		},
		headers: await headers(),
	});
	if (!url) {
		redirect(`/sign-in?${errorParams}`);
	}
	redirect(url);
}

/** Ends the session and returns to the sign-in page. */
export async function signOut(): Promise<void> {
	await auth.api.signOut({ headers: await headers() }).catch(() => {
		// No session to end is the state being asked for.
	});
	redirect(signInPath("/", "signed-out"));
}
