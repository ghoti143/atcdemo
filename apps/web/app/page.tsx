import { connection } from "next/server";
import { AppShell } from "@/components/shell/app-shell";
import { env } from "@/lib/env";
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
	const socketUrl = env().ATC_WS_URL;

	// `?preview=` pins shell states so each can be looked at without a
	// server. It does nothing in a production build.
	const preview =
		process.env.NODE_ENV === "production"
			? null
			: parseShellPreview((await searchParams).preview);

	return <AppShell preview={preview} socketUrl={socketUrl} />;
}
