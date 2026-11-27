"use client";

import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LAYER_CONTROLS, UNIT_CONTROLS } from "@/lib/display-controls";
import {
	interfaceStore,
	type Units,
	useInterfaceStore,
} from "@/lib/interface-store";
import { UNIT_NAMES } from "@/lib/units";
import { cn } from "@/lib/utils";

/**
 * The display menu in the top bar: which layers the map draws and which
 * units values are shown in. Each change goes to the interface store, so
 * it takes effect at once, and from there to the user's preferences
 * (components/shell/use-preferences-sync.ts), so it is kept.
 */
export function DisplayMenu() {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	// Closed by Escape, and by a press anywhere outside it.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		const onPress = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPress);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPress);
		};
	}, [open]);

	return (
		<div ref={root} data-slot="display-menu" className="relative">
			<button
				type="button"
				data-slot="display-menu-toggle"
				aria-expanded={open}
				aria-controls="display-menu-panel"
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex h-6 items-center gap-1.5 rounded-sm border px-2 uppercase tracking-wider outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
					open
						? "border-status-info/40 bg-background/60 text-status-info"
						: "text-muted-foreground",
				)}
			>
				<SlidersHorizontal aria-hidden className="size-3.5" />
				Display
			</button>
			{open && <DisplayPanel />}
		</div>
	);
}

function DisplayPanel() {
	const layers = useInterfaceStore((state) => state.layers);
	const units = useInterfaceStore((state) => state.units);
	const heading =
		"mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground";

	return (
		<div
			id="display-menu-panel"
			data-slot="display-menu-panel"
			className="absolute right-0 top-8 z-30 w-64 rounded-md border bg-card p-3 font-sans text-xs normal-case tracking-normal text-foreground shadow-2xl"
		>
			<fieldset className="m-0 border-0 p-0">
				<legend className={heading}>Layers</legend>
				<ul className="space-y-1">
					{LAYER_CONTROLS.map((layer) => (
						<li key={layer.id}>
							<label className="flex cursor-pointer items-center gap-2">
								<input
									type="checkbox"
									data-slot="layer-toggle"
									data-layer={layer.id}
									checked={layers[layer.id]}
									onChange={(event) =>
										interfaceStore
											.getState()
											.setLayerVisible(layer.id, event.target.checked)
									}
									className="size-3.5 accent-[var(--status-info)]"
								/>
								<span>{layer.label}</span>
								{layer.arrivesIn !== null && (
									<span
										className="ml-auto text-[10px] text-muted-foreground"
										title={`Nothing draws this layer until milestone ${layer.arrivesIn}. The choice is kept for then.`}
									>
										milestone {layer.arrivesIn}
									</span>
								)}
							</label>
						</li>
					))}
				</ul>
			</fieldset>

			<div className="mt-3 space-y-2 border-t pt-3">
				<p className={heading}>Units</p>
				{UNIT_CONTROLS.map((control) => (
					<fieldset
						key={control.kind}
						data-slot="unit-choice"
						data-kind={control.kind}
						className="m-0 flex items-center justify-between border-0 p-0"
					>
						<legend className="float-left">{control.label}</legend>
						<div className="flex overflow-hidden rounded-sm border">
							{control.choices.map((choice) => {
								const chosen = units[control.kind] === choice.value;
								return (
									<label
										key={choice.value}
										title={UNIT_NAMES[choice.value]}
										className={cn(
											"cursor-pointer px-2 py-0.5 font-mono text-[11px] has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring/60",
											chosen
												? "bg-status-info/20 text-status-info"
												: "text-muted-foreground hover:bg-accent",
										)}
									>
										<input
											type="radio"
											name={`unit-${control.kind}`}
											value={choice.value}
											checked={chosen}
											onChange={() =>
												interfaceStore.getState().setUnits({
													[control.kind]: choice.value,
												} as Partial<Units>)
											}
											className="sr-only"
										/>
										{choice.label}
									</label>
								);
							})}
						</div>
					</fieldset>
				))}
			</div>
		</div>
	);
}
