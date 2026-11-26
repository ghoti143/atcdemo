import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The brief notice shown when the recording starts a new pass and the whole
 * picture empties and refills. The caller decides when and for how long:
 * the server flags the first frame of a new pass.
 *
 * The element is always present, so screen readers announce the text when
 * it appears and it can fade in and out.
 */
export function ReplayNotice({ visible }: { visible: boolean }) {
	return (
		<div
			role="status"
			data-slot="replay-notice"
			data-visible={visible}
			className={cn(
				"pointer-events-none absolute left-1/2 top-12 z-20 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-status-info/40 bg-card/95 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-status-info shadow-lg transition-opacity duration-500",
				visible ? "opacity-100" : "opacity-0",
			)}
		>
			{visible && (
				<>
					<RotateCcw aria-hidden className="size-3.5" />
					Replay restarted
					<span className="normal-case tracking-normal text-muted-foreground">
						The recording has started a new pass.
					</span>
				</>
			)}
		</div>
	);
}
