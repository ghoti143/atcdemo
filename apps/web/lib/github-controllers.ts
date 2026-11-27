// Which GitHub users become controllers. Kept apart from lib/auth.ts so the
// configuration check can use it without building Better Auth.

/**
 * The GitHub usernames in a `CONTROLLER_GITHUB_USERS` value: comma-separated,
 * lower-cased, because GitHub compares usernames without regard to case.
 */
export function parseControllerGithubUsers(
	value: string | undefined,
): string[] {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean);
}

/** The role of a new account created by a GitHub user's first sign-in. */
export function roleForGithubUser(
	login: string,
	controllers: readonly string[],
): "viewer" | "controller" {
	return controllers.includes(login.toLowerCase()) ? "controller" : "viewer";
}
