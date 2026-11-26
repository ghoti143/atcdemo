import { AppShell } from "@/components/shell/app-shell";
import { parseShellPreview } from "@/lib/shell-preview";

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	// `?preview=` pins shell states so each can be looked at without a
	// server. It does nothing in a production build.
	const preview =
		process.env.NODE_ENV === "production"
			? null
			: parseShellPreview((await searchParams).preview);

	return <AppShell preview={preview} />;
}
