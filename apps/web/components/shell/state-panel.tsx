import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
	neutral: { border: "border-border", icon: "text-muted-foreground" },
	warn: { border: "border-status-warn/50", icon: "text-status-warn" },
	error: { border: "border-destructive/60", icon: "text-destructive" },
} as const;

/**
 * A centred card that says what state the app is in: loading, failed or
 * disconnected. `detail` is for the raw error text; `action` for a button.
 */
export function StatePanel({
	tone = "neutral",
	icon: Icon,
	spin = false,
	title,
	children,
	detail,
	action,
	...props
}: {
	tone?: keyof typeof TONES;
	icon: LucideIcon;
	spin?: boolean;
	title: string;
	children: ReactNode;
	detail?: string;
	action?: ReactNode;
	"data-state"?: string;
	"data-reason"?: string;
}) {
	return (
		<div
			role={tone === "error" ? "alert" : "status"}
			data-slot="state-panel"
			className={cn(
				"w-[26rem] max-w-full rounded-md border bg-card/95 p-5 shadow-2xl",
				TONES[tone].border,
			)}
			{...props}
		>
			<div className="flex items-start gap-3">
				<Icon
					aria-hidden
					className={cn(
						"mt-0.5 size-5 shrink-0",
						TONES[tone].icon,
						spin && "animate-spin",
					)}
				/>
				<div className="min-w-0 flex-1 space-y-2">
					<h2 className="text-sm font-semibold leading-tight">{title}</h2>
					<p className="text-sm text-muted-foreground">{children}</p>
					{detail && (
						<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-sm border bg-background/70 p-2 font-mono text-xs text-muted-foreground">
							{detail}
						</pre>
					)}
					{action && <div className="pt-1">{action}</div>}
				</div>
			</div>
		</div>
	);
}
