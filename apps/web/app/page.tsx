import { redirect } from "next/navigation";
import { connection } from "next/server";
import { signOut } from "@/app/sign-in/actions";
import { AppShell } from "@/components/shell/app-shell";
import { env } from "@/lib/env";
import { signInPath } from "@/lib/next-path";
import { currentUser } from "@/lib/session";
import { parseShellPreview } from "@/lib/shell-preview";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	// Rendered on every request, never at build time: the socket's address
	// is configuration, and the image is built once and configured where it
	// runs (DESIGN.md section 4).
	await connection();

	// proxy.ts has already turned away a visit with no session; the page
	// checks again, and needs the user to show anyway.
	const query = await searchParams;
	const user = await currentUser();
	if (!user) {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			for (const item of [value].flat()) {
				if (item !== undefined) search.append(key, item);
			}
		}
		const suffix = search.size > 0 ? `?${search}` : "";
		redirect(signInPath(`/${suffix}`));
	}

	const socketUrl = env().ATC_WS_URL;

	// `?preview=` pins shell states so each can be looked at without a
	// server. It does nothing in a production build.
	const preview =
		process.env.NODE_ENV === "production"
			? null
			: parseShellPreview(query.preview);

	// `?aircraft=hidden` runs the render loop and draws no aircraft, so the
	// cost of drawing them can be read off the HUD by comparison. It works in
	// a production build, which is where frame times are worth reading.
	const aircraftHidden = query.aircraft === "hidden";

	return (
		<AppShell
			preview={preview}
			socketUrl={socketUrl}
			aircraftHidden={aircraftHidden}
			user={{ name: user.name, email: user.email, role: user.role }}
			onSignOut={signOut}
		/>
	);
}
