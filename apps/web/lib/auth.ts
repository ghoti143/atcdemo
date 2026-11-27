import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, jwt } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { db } from "@/db/client";
import * as schema from "@/db/schema";
import {
	parseControllerGithubUsers,
	roleForGithubUser,
} from "./github-controllers";

// The two roles. `controller` may change simulator settings; `viewer` may
// only watch. atc-server enforces this from the role claim in the socket
// token, so the statements here document the roles more than they gate
// anything in the web app.
const ac = createAccessControl({ simulator: ["set-multiplier"] } as const);

export const roles = {
	viewer: ac.newRole({ simulator: [] }),
	controller: ac.newRole({ simulator: ["set-multiplier"] }),
};

export type Role = keyof typeof roles;

/** GitHub's OAuth app credentials. */
export type GithubCredentials = { clientId: string; clientSecret: string };

// What one request to Better Auth has learned from GitHub. Better Auth drops
// `role` from what a provider's profile may set, and the hook that runs when
// a user is created is not shown the profile. So the profile mapper notes the
// username here and the hook reads it, both inside the one request that
// `handleAuthRequest` wraps. Outside a request there is no note, and a new
// user is a viewer.
const githubSignUp = new AsyncLocalStorage<{ login?: string }>();

/**
 * Builds the Better Auth instance. The app has one, `auth` below; tests build
 * their own to try GitHub sign-in without configuring it for the process.
 *
 * Better Auth reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the
 * environment itself. Both are validated at startup, in instrumentation.ts.
 */
export function createAuth(options: { github?: GithubCredentials } = {}) {
	return betterAuth({
		database: drizzleAdapter(db, { provider: "pg", schema }),
		// Accounts are created on the server only: the demo accounts by the
		// setup service, through `auth.api.createUser`. Nobody can register
		// by email.
		emailAndPassword: { enabled: true, disableSignUp: true },
		// Anyone with a GitHub account may sign in, and a first sign-in
		// creates the account. Offered only when the id and secret are
		// configured.
		socialProviders: options.github
			? {
					github: {
						...options.github,
						mapProfileToUser: (profile) => {
							const signUp = githubSignUp.getStore();
							if (signUp) {
								signUp.login = profile.login;
							}
							return {};
						},
					},
				}
			: {},
		// A GitHub sign-in never joins an account that already exists under
		// the same email address, so GitHub is no way into a demo account.
		account: { accountLinking: { enabled: false } },
		databaseHooks: {
			user: {
				create: {
					// `CONTROLLER_GITHUB_USERS` is applied here, once, when
					// the account is created. Listing a user later does not
					// promote an account that already exists. The variable is
					// read at each sign-up, not when the module loads.
					before: async (user) => {
						const login = githubSignUp.getStore()?.login;
						if (login === undefined) {
							return;
						}
						const role = roleForGithubUser(
							login,
							parseControllerGithubUsers(process.env.CONTROLLER_GITHUB_USERS),
						);
						return { data: { ...user, role } };
					},
				},
			},
		},
		plugins: [
			admin({ ac, roles, defaultRole: "viewer", adminRoles: [] }),
			jwt({
				jwt: {
					// Short-lived: the browser fetches a fresh token just
					// before each socket connection.
					expirationTime: "5m",
					definePayload: ({ user }) => ({ role: user.role }),
				},
			}),
			// Must be last: lets server actions set the session cookie.
			nextCookies(),
		],
	});
}

// The GitHub settings are read here without a check, as the database URL is
// in db/client.ts: `next build` evaluates this module with nothing
// configured. instrumentation.ts validates them at startup, including that
// the two are set together.
const githubClientId = process.env.GITHUB_CLIENT_ID || undefined;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET || undefined;

/** Whether GitHub sign-in is offered: only when its id and secret are set. */
export const githubSignInEnabled = Boolean(
	githubClientId && githubClientSecret,
);

export const auth = createAuth({
	github:
		githubClientId && githubClientSecret
			? { clientId: githubClientId, clientSecret: githubClientSecret }
			: undefined,
});

/**
 * Better Auth's request handler, which is what the route serves. Use this and
 * not `auth.handler`: a GitHub sign-up handled outside it cannot be made a
 * controller.
 */
export function handleAuthRequest(
	request: Request,
	instance: { handler: (request: Request) => Promise<Response> } = auth,
): Promise<Response> {
	return githubSignUp.run({}, () => instance.handler(request));
}
