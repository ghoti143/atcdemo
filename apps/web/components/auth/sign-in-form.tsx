"use client";

import { CircleAlert, Info, LogIn } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type SignInFormState = { error: string | null; email: string };

export type DemoLogin = {
	role: string;
	email: string;
	/** The `.env` variable that holds this account's password. */
	passwordVariable: string;
};

/**
 * The sign-in card: the email and password form with the demo accounts named
 * beside it, and the GitHub button when GitHub is configured. The actions are
 * props so the form can be rendered without the server.
 */
export function SignInForm({
	next,
	demoAccounts,
	githubEnabled,
	notice,
	error,
	passwordAction,
	githubAction,
}: {
	/** Where to go after signing in. Already checked by the page. */
	next: string;
	demoAccounts: readonly DemoLogin[];
	githubEnabled: boolean;
	/** Why the page is shown: a session that ended, a sign-out. */
	notice?: string;
	/** An error from outside the form: a GitHub sign-in that failed. */
	error?: string;
	passwordAction: (
		state: SignInFormState,
		form: FormData,
	) => Promise<SignInFormState>;
	githubAction: (form: FormData) => Promise<void>;
}) {
	const [state, submit, pending] = useActionState(passwordAction, {
		error: null,
		email: "",
	});
	const [email, setEmail] = useState("");
	const [selected, setSelected] = useState<DemoLogin | null>(null);
	const shownError = state.error ?? error;

	return (
		<div
			data-slot="sign-in"
			className="w-[24rem] max-w-full rounded-md border bg-card/95 p-6 shadow-2xl"
		>
			<h2 className="text-base font-semibold leading-tight">Sign in</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Use a demo account{githubEnabled ? " or GitHub" : ""} to open the live
				traffic picture.
			</p>

			{notice && !shownError && (
				<p
					role="status"
					data-slot="sign-in-notice"
					className="mt-4 flex items-start gap-2 rounded-sm border border-status-info/40 bg-background/60 p-2 text-sm text-status-info"
				>
					<Info aria-hidden className="mt-0.5 size-4 shrink-0" />
					{notice}
				</p>
			)}
			{shownError && (
				<p
					role="alert"
					data-slot="sign-in-error"
					className="mt-4 flex items-start gap-2 rounded-sm border border-destructive/60 bg-background/60 p-2 text-sm text-destructive"
				>
					<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
					{shownError}
				</p>
			)}

			<form action={submit} className="mt-4 space-y-3">
				<input type="hidden" name="next" value={next} />
				<fieldset className="space-y-1.5">
					<legend className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
						Demo accounts
					</legend>
					<div className="flex gap-2">
						{demoAccounts.map((account) => (
							<Button
								key={account.email}
								type="button"
								variant="outline"
								size="sm"
								data-slot="demo-account"
								data-role={account.role}
								aria-pressed={selected?.email === account.email}
								className="flex-1 capitalize"
								onClick={() => {
									setEmail(account.email);
									setSelected(account);
								}}
							>
								{account.role}
							</Button>
						))}
					</div>
				</fieldset>

				<div className="space-y-1.5">
					<label htmlFor="sign-in-email" className="text-sm font-medium">
						Email
					</label>
					<Input
						id="sign-in-email"
						name="email"
						type="email"
						autoComplete="username"
						required
						value={email}
						onChange={(event) => {
							setEmail(event.target.value);
							setSelected(null);
						}}
					/>
				</div>
				<div className="space-y-1.5">
					<label htmlFor="sign-in-password" className="text-sm font-medium">
						Password
					</label>
					<Input
						id="sign-in-password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						aria-describedby={selected ? "sign-in-password-hint" : undefined}
					/>
					{selected && (
						<p
							id="sign-in-password-hint"
							data-slot="password-hint"
							className="text-xs text-muted-foreground"
						>
							The {selected.role}&rsquo;s password is{" "}
							<code className="font-mono">{selected.passwordVariable}</code> in{" "}
							<code className="font-mono">.env</code>.
						</p>
					)}
				</div>
				<Button type="submit" className="w-full" disabled={pending}>
					<LogIn aria-hidden />
					{pending ? "Signing in…" : "Sign in"}
				</Button>
			</form>

			{githubEnabled && (
				<form
					action={githubAction}
					data-slot="github-sign-in"
					className="mt-4 border-t pt-4"
				>
					<input type="hidden" name="next" value={next} />
					<Button type="submit" variant="outline" className="w-full">
						Sign in with GitHub
					</Button>
				</form>
			)}
		</div>
	);
}
