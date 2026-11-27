import { Gauge, LogOut, Radar } from "lucide-react";
import { ConnectionIndicator } from "@/components/shell/connection-indicator";
import type { ConnectionStatus } from "@/lib/connection-status";
import { cn } from "@/lib/utils";

/** The strip across the top: name on the left, status on the right. */
export function TopBar({
	connection,
	protocolVersion,
	preview = false,
	hudVisible = false,
	onToggleHud,
	user,
	onSignOut,
}: {
	connection: ConnectionStatus;
	/** Shown once the WASM module has loaded. */
	protocolVersion?: number;
	/** Marks the page as showing pinned states, not real ones. */
	preview?: boolean;
	hudVisible?: boolean;
	/** The HUD's button is drawn only when this is given. */
	onToggleHud?: () => void;
	/** Who is signed in. Left out in tests and nowhere else. */
	user?: { name: string; email: string; role: string };
	/** The sign-out server action; the button is drawn only with it. */
	onSignOut?: () => Promise<void>;
}) {
	return (
		<header
			data-slot="top-bar"
			className="flex h-10 shrink-0 items-center gap-3 border-b bg-card px-3"
		>
			<Radar aria-hidden className="size-4 text-status-ok" />
			<h1 className="font-mono text-sm font-semibold uppercase tracking-[0.2em]">
				ATC Demo
			</h1>
			<span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
				Continental US · replay
			</span>

			<div className="ml-auto flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
				{preview && (
					<span
						data-slot="preview-badge"
						className="rounded-sm border border-status-info/40 px-1.5 py-0.5 text-status-info"
					>
						Preview states
					</span>
				)}
				{protocolVersion !== undefined && (
					<span data-slot="protocol-version">Protocol v{protocolVersion}</span>
				)}
				{onToggleHud && (
					<button
						type="button"
						data-slot="hud-toggle"
						aria-pressed={hudVisible}
						aria-keyshortcuts="H"
						title={`${hudVisible ? "Hide" : "Show"} the performance HUD (H)`}
						onClick={onToggleHud}
						className={cn(
							"flex h-6 items-center gap-1.5 rounded-sm border px-2 uppercase tracking-wider outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
							hudVisible
								? "border-status-info/40 bg-background/60 text-status-info"
								: "text-muted-foreground",
						)}
					>
						<Gauge aria-hidden className="size-3.5" />
						HUD
					</button>
				)}
				<ConnectionIndicator status={connection} />
				{user && (
					<div
						data-slot="user"
						data-role={user.role}
						title={user.email}
						className="flex h-6 items-center gap-2 border-l pl-3"
					>
						<span className="max-w-40 truncate normal-case tracking-normal text-foreground">
							{user.name}
						</span>
						<span
							data-slot="user-role"
							className={cn(
								"rounded-sm border px-1.5 py-0.5",
								user.role === "controller"
									? "border-status-warn/50 text-status-warn"
									: "text-muted-foreground",
							)}
						>
							{user.role}
						</span>
					</div>
				)}
				{onSignOut && (
					<form action={onSignOut}>
						<button
							type="submit"
							data-slot="sign-out"
							className="flex h-6 items-center gap-1.5 rounded-sm border px-2 uppercase tracking-wider text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
						>
							<LogOut aria-hidden className="size-3.5" />
							Sign out
						</button>
					</form>
				)}
			</div>
		</header>
	);
}
