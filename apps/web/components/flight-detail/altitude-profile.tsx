"use client";

import { useState } from "react";
import {
	formatAgo,
	type AltitudeProfile as Profile,
	profileCeilingFt,
} from "@/lib/flight-detail";

const WIDTH = 328;
const HEIGHT = 76;
/** Room for the axis labels: the ceiling at the left, the times beneath. */
const PLOT = { left: 0, right: WIDTH, top: 6, bottom: HEIGHT - 14 };
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Where each sample of a profile falls in the plot. */
export function profilePoints(
	profile: Profile,
	ceilingFt: number,
): { x: number; y: number }[] {
	const { timesS, altitudesFt } = profile;
	if (timesS.length === 0) return [];
	const first = timesS[0];
	const span = Math.max(timesS[timesS.length - 1] - first, 1);
	return timesS.map((time, index) => ({
		x: PLOT.left + ((time - first) / span) * (PLOT.right - PLOT.left),
		y:
			PLOT.bottom -
			(Math.max(altitudesFt[index], 0) / ceilingFt) * (PLOT.bottom - PLOT.top),
	}));
}

/**
 * Altitude against time for one aircraft: what it has flown, ending at now.
 * One series, so no legend: the heading above it names it. The pointer
 * reads off any point of it.
 */
export function AltitudeProfile({ profile }: { profile: Profile }) {
	const [hovered, setHovered] = useState<number | null>(null);
	const { timesS, altitudesFt } = profile;
	if (timesS.length < 2) {
		return (
			<p
				data-slot="altitude-profile-empty"
				className="flex items-center text-xs text-muted-foreground"
				style={{ height: HEIGHT }}
			>
				{timesS.length === 0
					? "Waiting for the aircraft's track."
					: "Just appeared: no track yet."}
			</p>
		);
	}

	const ceilingFt = profileCeilingFt(altitudesFt);
	const points = profilePoints(profile, ceilingFt);
	const last = timesS.length - 1;
	const spanS = timesS[last] - timesS[0];
	const lowest = Math.min(...altitudesFt);
	const highest = Math.max(...altitudesFt);
	// The point read out: the one under the pointer, or else the newest.
	const shown = hovered ?? last;

	const nearest = (clientX: number, target: SVGSVGElement) => {
		const box = target.getBoundingClientRect();
		const x = ((clientX - box.left) / box.width) * WIDTH;
		let best = 0;
		for (let index = 1; index < points.length; index++) {
			if (Math.abs(points[index].x - x) < Math.abs(points[best].x - x)) {
				best = index;
			}
		}
		return best;
	};

	return (
		<figure data-slot="altitude-profile" className="m-0">
			<figcaption className="flex items-baseline justify-between font-mono text-[11px] text-muted-foreground">
				<span className="uppercase tracking-wider">Altitude profile</span>
				<output
					data-slot="altitude-profile-readout"
					className="tabular-nums text-foreground/90"
				>
					{WHOLE.format(altitudesFt[shown])} ft ·{" "}
					{formatAgo(timesS[last] - timesS[shown])}
				</output>
			</figcaption>
			<svg
				role="img"
				aria-label={`Altitude over the last ${formatAgo(spanS).replace(" ago", "")}: between ${WHOLE.format(lowest)} and ${WHOLE.format(highest)} feet, now ${WHOLE.format(altitudesFt[last])} feet.`}
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				width="100%"
				height={HEIGHT}
				className="block touch-none"
				onPointerMove={(event) =>
					setHovered(nearest(event.clientX, event.currentTarget))
				}
				onPointerLeave={() => setHovered(null)}
			>
				{/* The ceiling and the ground: recessive, behind the line. */}
				<line
					x1={PLOT.left}
					x2={PLOT.right}
					y1={PLOT.top}
					y2={PLOT.top}
					className="stroke-border"
					strokeDasharray="2 3"
				/>
				<line
					x1={PLOT.left}
					x2={PLOT.right}
					y1={PLOT.bottom}
					y2={PLOT.bottom}
					className="stroke-border"
				/>
				<text
					x={PLOT.left + 2}
					y={PLOT.top + 10}
					className="fill-muted-foreground font-mono text-[9px]"
				>
					{WHOLE.format(ceilingFt)} ft
				</text>
				<text
					x={PLOT.left}
					y={HEIGHT - 2}
					className="fill-muted-foreground font-mono text-[9px]"
				>
					{formatAgo(spanS)}
				</text>
				<text
					x={PLOT.right}
					y={HEIGHT - 2}
					textAnchor="end"
					className="fill-muted-foreground font-mono text-[9px]"
				>
					now
				</text>

				<polyline
					data-slot="altitude-profile-line"
					points={points
						.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
						.join(" ")}
					fill="none"
					strokeWidth={2}
					strokeLinejoin="round"
					strokeLinecap="round"
					className="stroke-status-info"
				/>
				{hovered !== null && (
					<line
						x1={points[hovered].x}
						x2={points[hovered].x}
						y1={PLOT.top}
						y2={PLOT.bottom}
						className="stroke-foreground/40"
					/>
				)}
				{/* The point read out, ringed in the surface so it sits on the line. */}
				<circle
					cx={points[shown].x}
					cy={points[shown].y}
					r={4}
					strokeWidth={2}
					className="fill-status-info stroke-card"
				/>
			</svg>
		</figure>
	);
}
