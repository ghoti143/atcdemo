"use client";

import { useEffect, useRef, useState } from "react";
import {
	createTrafficMap,
	loadMapLibraries,
	type TrafficMap as TrafficMapHandle,
} from "@/components/map/create-map";

/**
 * The map: MapLibre with deck.gl drawing into the same scene, and the
 * render loop that draws the aircraft on it every animation frame. It goes
 * in the shell's `map` slot and fills it.
 *
 * The map is an imperative object made in an effect and removed when the
 * effect is cleaned up, so React's double mount in development makes one,
 * removes it and makes another. Nothing here touches the DOM, WebGL or the
 * map libraries while rendering.
 */
export function TrafficMap({
	depthTest = false,
	aircraftHidden = false,
}: {
	/** Draw the depth test layers (development preview only). */
	depthTest?: boolean;
	/** Run the render loop and draw no aircraft (a measuring aid). */
	aircraftHidden?: boolean;
}) {
	// The React Compiler must not memoize a component that owns the map and
	// its render loop: it mutates an imperative object (DESIGN.md section 4).
	"use no memo";

	const container = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const element = container.current;
		if (!element) return;

		let cancelled = false;
		let created: TrafficMapHandle | undefined;

		loadMapLibraries()
			.then((libraries) => {
				// Checked before the map is made, so a mount that was cleaned up
				// while the libraries loaded never takes a WebGL context.
				if (cancelled) return;
				created = createTrafficMap(element, libraries, {
					depthTest,
					aircraftHidden,
				});
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			});

		return () => {
			cancelled = true;
			created?.remove();
		};
	}, [depthTest, aircraftHidden]);

	return (
		<div data-slot="traffic-map" className="map-grid relative size-full">
			{/* Sized, not positioned: MapLibre's stylesheet sets `position` on
			    its container, and wins over a utility class. */}
			<div ref={container} className="size-full" />
			{error !== null && (
				<div
					role="alert"
					className="absolute inset-0 flex items-center justify-center p-6"
				>
					<p className="max-w-sm text-center font-mono text-xs text-status-warn">
						The map could not start. It needs WebGL2.
						<span className="mt-2 block text-muted-foreground">{error}</span>
					</p>
				</div>
			)}
		</div>
	);
}
