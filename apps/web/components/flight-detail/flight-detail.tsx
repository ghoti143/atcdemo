"use client";

import { useSyncExternalStore } from "react";
import { AltitudeProfile } from "@/components/flight-detail/altitude-profile";
import { type Units, useInterfaceStore } from "@/lib/interface-store";
import { UNIT_LABELS } from "@/lib/units";

const DEFAULT_UNITS: Units = {
	altitude: "ft",
	speed: "kt",
	verticalRate: "fpm",
};

import {
	type FlightDetail as Detail,
	type FlightDetailStore,
	formatRoute,
	formatTrack,
} from "@/lib/flight-detail";
import {
	formatAltitude,
	formatSpeed,
	formatVerticalRate,
} from "@/lib/flight-list";

/**
 * What is known about the selected aircraft: who it is, where it is now,
 * and the altitude it has flown. It follows the picture once a second, and
 * reads only the store, so a stress-mode clone is shown like any other.
 */
export function FlightDetail({ detail }: { detail: FlightDetailStore }) {
	const units = useInterfaceStore((state) => state.units);
	const snapshot = useSyncExternalStore(
		detail.subscribe,
		detail.getSnapshot,
		() => null,
	);
	if (snapshot === null) {
		return (
			<p
				data-slot="flight-detail-empty"
				className="px-3 py-4 text-xs text-muted-foreground"
			>
				Select an aircraft on the map or in the list to see its detail.
			</p>
		);
	}
	return <DetailCard detail={snapshot} units={units} />;
}

export function DetailCard({
	detail,
	units = DEFAULT_UNITS,
}: {
	detail: Detail;
	/** What the readings are written in. */
	units?: Units;
}) {
	const route = formatRoute(detail);
	return (
		<div
			data-slot="flight-detail-card"
			data-id={detail.id}
			data-synthetic={detail.synthetic || undefined}
			className="space-y-2.5 px-3 py-2.5"
		>
			<div className="flex items-baseline gap-2">
				<h3
					data-slot="flight-detail-callsign"
					className="font-mono text-base font-semibold leading-none"
				>
					{detail.callsign || "No callsign"}
				</h3>
				<span className="font-mono text-xs text-muted-foreground">
					{detail.aircraftType || "Type not known"}
				</span>
				{detail.synthetic && (
					<span
						data-slot="flight-detail-clone"
						title="A copy made by the stress multiplier, not a recorded flight"
						className="rounded-sm border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
					>
						Clone
					</span>
				)}
				<span
					data-slot="flight-detail-route"
					className="ml-auto font-mono text-xs text-foreground/90"
				>
					{route ?? (
						<span className="text-muted-foreground">Route not known</span>
					)}
				</span>
			</div>

			{/* The readings' widths go by what each holds: the vertical rate has
			    the longest value and unit, the track the shortest. */}
			{detail.present ? (
				<dl className="grid grid-cols-[1.1fr_0.8fr_1.45fr_0.65fr] gap-x-2 whitespace-nowrap font-mono">
					{/* Feet above mean sea level, so not a flight level. */}
					<Reading
						name="altitude"
						label="Altitude"
						unit={UNIT_LABELS[units.altitude]}
					>
						{formatAltitude(detail, units.altitude)}
					</Reading>
					<Reading name="speed" label="Speed" unit={UNIT_LABELS[units.speed]}>
						{formatSpeed(detail.groundSpeedKt, units.speed)}
					</Reading>
					<Reading
						name="vertical-rate"
						label="Vert rate"
						unit={UNIT_LABELS[units.verticalRate]}
					>
						{formatVerticalRate(detail.verticalRateFpm, units.verticalRate)}
					</Reading>
					<Reading name="track" label="Track">
						{formatTrack(detail.trackDeg)}
					</Reading>
				</dl>
			) : (
				<p
					role="status"
					data-slot="flight-detail-gone"
					className="text-xs text-status-warn"
				>
					No longer in the picture.
				</p>
			)}

			<AltitudeProfile profile={detail.profile} unit={units.altitude} />
		</div>
	);
}

function Reading({
	name,
	label,
	unit,
	children,
}: {
	name: string;
	label: string;
	unit?: string;
	children: React.ReactNode;
}) {
	return (
		<div data-reading={name}>
			<dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
				{label}
			</dt>
			<dd className="text-sm tabular-nums leading-tight">
				{children}
				{unit && (
					<span className="ml-1 text-[10px] text-muted-foreground">{unit}</span>
				)}
			</dd>
		</div>
	);
}
