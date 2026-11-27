"use client";

import {
	interfaceStore,
	useInterfaceStore,
	type ViewMode,
} from "@/lib/interface-store";
import { cn } from "@/lib/utils";

const MODES: readonly { mode: ViewMode; label: string; title: string }[] = [
	{ mode: "2d", label: "2D", title: "Flat, from straight above" },
	{
		mode: "3d",
		label: "3D",
		title: "Tipped over, with terrain and the aircraft at their altitudes",
	},
];

/** The 2D and 3D switch in the top bar. */
export function ViewModeToggle() {
	const viewMode = useInterfaceStore((state) => state.viewMode);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset draws a frame; this is a row of two buttons.
		<div
			role="group"
			aria-label="Map view"
			data-slot="view-mode"
			className="flex h-6 overflow-hidden rounded-sm border"
		>
			{MODES.map(({ mode, label, title }) => (
				<button
					key={mode}
					type="button"
					data-mode={mode}
					aria-pressed={viewMode === mode}
					title={title}
					onClick={() => interfaceStore.getState().setViewMode(mode)}
					className={cn(
						"px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
						viewMode === mode
							? "bg-status-info/20 text-status-info"
							: "text-muted-foreground hover:bg-accent",
					)}
				>
					{label}
				</button>
			))}
		</div>
	);
}
