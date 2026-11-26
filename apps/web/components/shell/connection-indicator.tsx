import type { ConnectionStatus } from "@/lib/connection-status";
import { cn } from "@/lib/utils";

const LOOK: Record<
	ConnectionStatus,
	{ label: string; text: string; dot: string }
> = {
	connecting: {
		label: "Connecting",
		text: "text-status-warn",
		dot: "bg-status-warn animate-pulse",
	},
	open: { label: "Live", text: "text-status-ok", dot: "bg-status-ok" },
	reconnecting: {
		label: "Reconnecting",
		text: "text-status-warn",
		dot: "bg-status-warn animate-pulse",
	},
	closed: {
		label: "Offline",
		text: "text-destructive",
		dot: "bg-destructive",
	},
};

/** The socket's state, as a coloured dot and a word in the top bar. */
export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
	const look = LOOK[status];
	return (
		<div
			role="status"
			aria-label={`Connection: ${look.label}`}
			data-slot="connection-indicator"
			data-status={status}
			className={cn(
				"flex h-6 items-center gap-2 rounded-sm border bg-background/60 px-2 font-mono text-[11px] uppercase tracking-wider",
				look.text,
			)}
		>
			<span aria-hidden className={cn("size-2 rounded-full", look.dot)} />
			{look.label}
		</div>
	);
}
