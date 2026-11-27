// What the display menu offers: each layer and unit, with the words it is
// shown under. No import of React or the DOM, so `bun test` runs it.

import { type LayerId, UNIT_CHOICES, type Units } from "@/lib/interface-store";
import { UNIT_LABELS } from "@/lib/units";

export type LayerControl = {
	id: LayerId;
	label: string;
	/**
	 * The milestone that draws the layer, for one nothing draws yet: its
	 * toggle is shown, kept and saved, and changes nothing on the map
	 * until then. Null for a layer that is drawn today.
	 */
	arrivesIn: number | null;
};

/** The layers, in the order the menu lists them. */
export const LAYER_CONTROLS: readonly LayerControl[] = [
	{ id: "trails", label: "Trails", arrivesIn: null },
	{ id: "predictionVectors", label: "Prediction vectors", arrivesIn: 7 },
	{ id: "conflictLinks", label: "Conflict links", arrivesIn: 7 },
	{ id: "stems", label: "Altitude stems", arrivesIn: null },
	{ id: "classB", label: "Class B airspace", arrivesIn: null },
	{ id: "artcc", label: "ARTCC boundaries", arrivesIn: null },
];

export type UnitControl = {
	kind: keyof Units;
	label: string;
	choices: readonly { value: Units[keyof Units]; label: string }[];
};

const choices = (kind: keyof Units) =>
	UNIT_CHOICES[kind].map((value) => ({ value, label: UNIT_LABELS[value] }));

/** The kinds of value, each with the units it can be shown in. */
export const UNIT_CONTROLS: readonly UnitControl[] = [
	{ kind: "altitude", label: "Altitude", choices: choices("altitude") },
	{ kind: "speed", label: "Speed", choices: choices("speed") },
	{
		kind: "verticalRate",
		label: "Vertical rate",
		choices: choices("verticalRate"),
	},
];
