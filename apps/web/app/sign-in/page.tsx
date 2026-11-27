import { Radar } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SignInForm } from "@/components/auth/sign-in-form";
import { githubSignInEnabled } from "@/lib/auth";
import { DEMO_ACCOUNTS } from "@/lib/demo-accounts";
import { safeNextPath } from "@/lib/next-path";
import { currentUser } from "@/lib/session";
import { signInWithGithub, signInWithPassword } from "./actions";

export const metadata: Metadata = { title: "Sign in · ATC Demo" };

const NOTICES: Record<string, string> = {
	expired: "Your session has ended. Sign in again to carry on.",
	"signed-out": "You have signed out.",
};

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export default async function SignInPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
	// Rendered on every request: whether GitHub is offered is configuration.
	await connection();
	const query = await searchParams;
	const next = safeNextPath(first(query.next));

	// proxy.ts sends a signed-in visitor on already; this is the second check.
	if (await currentUser()) {
		redirect(next);
	}

	const notice = NOTICES[first(query.reason) ?? ""];
	// Better Auth reports a failed GitHub sign-in in `error`, as a code. The
	// codes are not shown: they are the provider's and the library's words.
	const error =
		first(query.error) === undefined
			? undefined
			: first(query.error) === "account_not_linked"
				? "An account with that email address already exists, so GitHub cannot sign in to it."
				: "The GitHub sign-in did not complete. Try again.";

	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
			<div className="flex items-center gap-3">
				<Radar aria-hidden className="size-5 text-status-ok" />
				<h1 className="font-mono text-sm font-semibold uppercase tracking-[0.2em]">
					ATC Demo
				</h1>
			</div>
			<SignInForm
				next={next}
				demoAccounts={DEMO_ACCOUNTS.map(
					({ role, email, passwordVariable }) => ({
						role,
						email,
						passwordVariable,
					}),
				)}
				githubEnabled={githubSignInEnabled}
				notice={notice}
				error={error}
				passwordAction={signInWithPassword}
				githubAction={signInWithGithub}
			/>
		</main>
	);
}
