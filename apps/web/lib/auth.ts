import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, jwt } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { db } from "@/db/client";
import * as schema from "@/db/schema";

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

// Better Auth reads BETTER_AUTH_SECRET and BETTER_AUTH_URL from the
// environment itself. Both are validated at startup, in instrumentation.ts.
export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg", schema }),
	// Accounts are created on the server only: the demo accounts by the setup
	// service, through `auth.api.createUser`. Nobody can register by email.
	emailAndPassword: { enabled: true, disableSignUp: true },
	plugins: [
		admin({ ac, roles, defaultRole: "viewer", adminRoles: [] }),
		jwt({
			jwt: {
				// Short-lived: the browser fetches a fresh token just before
				// each socket connection.
				expirationTime: "5m",
				definePayload: ({ user }) => ({ role: user.role }),
			},
		}),
		// Must be last: lets server actions set the session cookie.
		nextCookies(),
	],
});
