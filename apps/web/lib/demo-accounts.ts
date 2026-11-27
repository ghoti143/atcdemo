// The two demo accounts, one per role, that make the app usable with no
// GitHub configuration. The setup service creates them; the sign-in page
// names them.

import type { auth as authInstance, Role } from "./auth";

export type DemoAccount = {
	role: Role;
	email: string;
	name: string;
	/** The variable that holds this account's password. */
	passwordVariable: "DEMO_VIEWER_PASSWORD" | "DEMO_CONTROLLER_PASSWORD";
};

// example.com is reserved for documentation, so nobody receives mail for
// these and no GitHub account can have verified either address.
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
	{
		role: "viewer",
		email: "viewer@example.com",
		name: "Demo Viewer",
		passwordVariable: "DEMO_VIEWER_PASSWORD",
	},
	{
		role: "controller",
		email: "controller@example.com",
		name: "Demo Controller",
		passwordVariable: "DEMO_CONTROLLER_PASSWORD",
	},
];

/** Better Auth's own minimum, which its sign-in form would enforce too. */
export const MIN_PASSWORD_LENGTH = 8;

export type DemoAccountResult = "created" | "updated" | "unchanged";

/**
 * Makes one demo account exist with the given password and its role. Safe to
 * repeat: an account that is already right is left alone, and one whose
 * password or role differs is brought back into line, so changing a password
 * in `.env` and running setup again takes effect.
 */
export async function ensureDemoAccount(
	auth: typeof authInstance,
	account: DemoAccount,
	password: string,
): Promise<DemoAccountResult> {
	const context = await auth.$context;
	const existing = await context.internalAdapter.findUserByEmail(
		account.email,
		{ includeAccounts: true },
	);

	if (!existing) {
		// With no session and no request, Better Auth treats this as a call
		// from the server itself and asks for no permission.
		await auth.api.createUser({
			body: {
				email: account.email,
				password,
				name: account.name,
				role: account.role,
			},
		});
		return "created";
	}

	let result: DemoAccountResult = "unchanged";
	const { accounts } = existing;
	// The admin plugin's columns, which the adapter returns and its type for
	// a user does not name.
	const user = existing.user as typeof existing.user & {
		role?: string | null;
		banned?: boolean | null;
	};
	if (user.role !== account.role || user.banned) {
		await context.internalAdapter.updateUser(user.id, {
			role: account.role,
			banned: false,
			banReason: null,
			banExpires: null,
		});
		result = "updated";
	}

	const credential = accounts.find(
		(entry) => entry.providerId === "credential",
	);
	const current = credential?.password;
	const matches =
		typeof current === "string" &&
		(await context.password.verify({ hash: current, password }));
	if (!matches) {
		const hash = await context.password.hash(password);
		if (credential) {
			await context.internalAdapter.updatePassword(user.id, hash);
		} else {
			await context.internalAdapter.linkAccount({
				providerId: "credential",
				accountId: user.id,
				password: hash,
				userId: user.id,
			});
		}
		result = "updated";
	}
	return result;
}
