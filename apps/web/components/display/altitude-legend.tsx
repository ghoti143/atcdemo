"use client";

import { useInterfaceStore } from "@/lib/interface-store";
import { altitudeLegend, UNIT_LABELS } from "@/lib/units";

/**
 * What the aircraft's colours mean: the altitude bands, highest first, in
 * the unit the user has chosen. It sits over the map's bottom left corner
 * and lets the pointer through.
 */
export function AltitudeLegend() {
	const unit = useInterfaceStore((state) => state.units.altitude);
	return (
		<figure
			data-slot="altitude-legend"
			className="m-0 rounded-md border bg-card/85 px-2.5 py-2 font-mono text-[10px] text-muted-foreground shadow-lg backdrop-blur-sm"
		>
			<figcaption className="mb-1 uppercase tracking-wider">
				Altitude, {UNIT_LABELS[unit]}
			</figcaption>
			<ul className="space-y-0.5">
				{altitudeLegend(unit).map((entry) => (
					<li key={entry.label} className="flex items-center gap-1.5">
						<span
							aria-hidden
							className="size-2 shrink-0 rounded-[2px]"
							style={{ backgroundColor: entry.color }}
						/>
						<span className="tabular-nums text-foreground/90">
							{entry.label}
						</span>
					</li>
				))}
			</ul>
		</figure>
	);
}
