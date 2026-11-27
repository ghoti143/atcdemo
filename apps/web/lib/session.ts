import { headers } from "next/headers";
import { auth, type Role } from "./auth";

/** The signed-in user, as much of it as the interface shows. */
export type SessionUser = {
	id: string;
	name: string;
	email: string;
	role: Role;
};

/**
 * The user behind the request's session cookie, checked against the database,
 * or null. For server components, route handlers and server actions.
 */
export async function currentUser(): Promise<SessionUser | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) {
		return null;
	}
	const { id, name, email, role } = session.user;
	return {
		id,
		name,
		email,
		// Anything but `controller` is a viewer, including a role this version
		// does not know.
		role: role === "controller" ? "controller" : "viewer",
	};
}
