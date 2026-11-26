import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The frame down the right-hand side that the panels dock into. */
export function SidePanel({ children }: { children: ReactNode }) {
	return (
		<aside
			aria-label="Panels"
			data-slot="side-panel"
			className="flex w-[22rem] shrink-0 flex-col divide-y border-l bg-card"
		>
			{children}
		</aside>
	);
}

/**
 * One docked panel: a dense title row and a scrolling body. `slot` names it
 * for whoever fills it in later (`flight-list`, `flight-detail`, `alerts`).
 */
export function PanelSection({
	slot,
	title,
	meta,
	className,
	children,
}: {
	slot: string;
	title: string;
	/** Short text at the right of the title row, such as a count. */
	meta?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			data-slot={slot}
			className={cn("flex min-h-0 flex-col", className)}
		>
			<header className="flex h-7 shrink-0 items-center justify-between border-b bg-secondary/40 px-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
				<h2 className="font-medium text-foreground/90">{title}</h2>
				{meta}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

/** What an unbuilt panel shows. */
export function PanelPlaceholder({ children }: { children: ReactNode }) {
	return <p className="px-3 py-4 text-xs text-muted-foreground">{children}</p>;
}
