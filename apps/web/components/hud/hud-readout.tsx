import type { ReactNode } from "react";
import {
	FRAME_BUDGET_MS,
	type FrameTimeLevel,
	formatBytesPerSecond,
	formatCount,
	formatFps,
	formatFrameMs,
	formatWorkMs,
	frameTimeLevel,
} from "@/lib/hud-format";
import type { PerformanceReadings } from "@/lib/interface-store";
import { cn } from "@/lib/utils";

const LEVEL_TEXT: Record<FrameTimeLevel, string> = {
	none: "text-muted-foreground",
	ok: "text-status-ok",
	over: "text-status-warn",
	slow: "text-destructive",
};

/**
 * The performance HUD's panel, drawn from one set of readings. Plain props
 * and no state: `PerformanceHud` gives it the interface store's.
 *
 * The two frame-time percentiles are coloured against the 16.7 ms target:
 * green up to it, amber up to two frames (33.3 ms), red beyond, with half a
 * millisecond allowed on each for jitter (lib/hud-format.ts).
 */
export function HudReadout({ readings }: { readings: PerformanceReadings }) {
	const bytes = formatBytesPerSecond(readings.bytesPerSecond);
	return (
		<dl
			data-slot="performance-hud"
			aria-label="Performance"
			className="pointer-events-none w-44 select-none rounded-sm border bg-background px-2.5 py-2 font-mono text-[11px] leading-[1.125rem] text-foreground tabular-nums shadow-sm"
		>
			<Row name="fps" label="FPS" value={formatFps(readings.fps)} />
			<FrameTimeRow
				name="frame-p95"
				label="Frame p95"
				ms={readings.frameTimeP95Ms}
			/>
			<FrameTimeRow
				name="frame-p99"
				label="Frame p99"
				ms={readings.frameTimeP99Ms}
			/>

			<Heading>Main thread, per frame</Heading>
			<Row
				name="wasm-advance"
				label="WASM"
				value={formatWorkMs(readings.wasmAdvanceMs)}
				unit="ms"
			/>
			<Row
				name="attribute-update"
				label="Attributes"
				value={formatWorkMs(readings.attributeUpdateMs)}
				unit="ms"
			/>
			<Row
				name="map-render"
				label="Map"
				value={formatWorkMs(readings.mapRenderMs)}
				unit="ms"
			/>

			<Heading>Traffic</Heading>
			<Row
				name="aircraft"
				label="Aircraft"
				value={formatCount(readings.aircraftCount)}
			/>
			<Row name="bytes" label="Network" value={bytes.value} unit={bytes.unit} />
			<Row
				name="skipped-frames"
				label="Skipped"
				value={formatCount(readings.skippedFrames)}
				unit="frames"
			/>
		</dl>
	);
}

function FrameTimeRow({
	name,
	label,
	ms,
}: {
	name: string;
	label: string;
	ms: number;
}) {
	const level = frameTimeLevel(ms);
	return (
		<Row
			name={name}
			label={label}
			value={formatFrameMs(ms)}
			unit="ms"
			level={level}
			title={`Target: ${FRAME_BUDGET_MS} ms or less`}
		/>
	);
}

function Row({
	name,
	label,
	value,
	unit,
	level,
	title,
}: {
	name: string;
	label: string;
	value: string;
	unit?: string;
	level?: FrameTimeLevel;
	title?: string;
}) {
	return (
		<div
			data-reading={name}
			data-level={level}
			title={title}
			className="flex items-baseline gap-1.5"
		>
			<dt className="mr-auto text-muted-foreground">{label}</dt>
			<dd className={cn("text-right", level && LEVEL_TEXT[level])}>{value}</dd>
			{/* A fixed column, so the figures line up whatever their unit. */}
			<dd className="w-10 text-foreground/60">{unit}</dd>
		</div>
	);
}

function Heading({ children }: { children: ReactNode }) {
	return (
		<div className="mt-1.5 border-t pt-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
			{children}
		</div>
	);
}
