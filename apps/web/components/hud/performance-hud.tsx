"use client";

import { useEffect } from "react";
import { HudReadout } from "@/components/hud/hud-readout";
import { startFrameMeter } from "@/lib/frame-meter";
import {
	interfaceStore,
	type PerformanceReadings,
	useInterfaceStore,
} from "@/lib/interface-store";

/**
 * Made-up readings for everything the frame meter does not measure, at
 * about what multiplier 7 should give, so the HUD can be looked at without
 * a server (`?preview=hud-sample`, development only).
 */
export const HUD_SAMPLE: Partial<PerformanceReadings> = {
	wasmAdvanceMs: 0.16,
	attributeUpdateMs: 0.85,
	mapRenderMs: 4.2,
	aircraftCount: 52_431,
	bytesPerSecond: 1_258_344,
	skippedFrames: 3,
};

/**
 * The performance HUD, for the shell's `hud` slot. It shows the interface
 * store's `performance`, which changes at most four times a second, and
 * renders nothing while `hudVisible` is false.
 *
 * It also owns the frame meter: frames are timed only while the HUD is
 * shown, so a hidden HUD costs nothing at all.
 */
export function PerformanceHud({
	sample = false,
}: {
	/** Fill the readings nothing reports yet with HUD_SAMPLE. */
	sample?: boolean;
}) {
	const visible = useInterfaceStore((state) => state.hudVisible);

	useEffect(() => {
		if (visible) return startFrameMeter();
	}, [visible]);

	useEffect(() => {
		// Held by the store until the frame meter's next report publishes it.
		if (sample) {
			interfaceStore
				.getState()
				.reportPerformance(HUD_SAMPLE, performance.now());
		}
	}, [sample]);

	return visible ? <LiveReadout /> : null;
}

// Apart, so that only a shown HUD listens to the readings.
function LiveReadout() {
	const readings = useInterfaceStore((state) => state.performance);
	return <HudReadout readings={readings} />;
}
