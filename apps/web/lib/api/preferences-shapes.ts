// A user's preferences as the API carries them and the database keeps
// them. No import of the database, so the browser can load this file.

import { z } from "zod";
import {
	LAYER_IDS,
	type LayerId,
	MAX_VERTICAL_EXAGGERATION,
	UNIT_CHOICES,
	type Units,
} from "@/lib/interface-store";

export type Preferences = {
	units: Units;
	layers: Record<LayerId, boolean>;
	/** One value for terrain, aircraft height and airspace. */
	verticalExaggeration: number;
};

/** What someone who has changed nothing has. */
export function defaultPreferences(): Preferences {
	return {
		units: { altitude: "ft", speed: "kt", verticalRate: "fpm" },
		layers: Object.fromEntries(
			LAYER_IDS.map((layer) => [layer, true]),
		) as Record<LayerId, boolean>,
		verticalExaggeration: 1,
	};
}

const exaggeration = z
	.number({ error: "must be a number" })
	.gt(0, "must be more than 0")
	.max(
		MAX_VERTICAL_EXAGGERATION,
		`must be at most ${MAX_VERTICAL_EXAGGERATION}`,
	);

/**
 * What `PUT /api/preferences` takes: all of it, every value one this
 * version knows. Anything else is refused, so nothing unreadable is stored.
 */
export const preferencesSchema: z.ZodType<Preferences> = z.strictObject({
	units: z.strictObject({
		altitude: z.enum(UNIT_CHOICES.altitude),
		speed: z.enum(UNIT_CHOICES.speed),
		verticalRate: z.enum(UNIT_CHOICES.verticalRate),
	}),
	layers: z.strictObject(
		Object.fromEntries(
			LAYER_IDS.map((layer) => [layer, z.boolean()]),
		) as Record<LayerId, z.ZodBoolean>,
	),
	verticalExaggeration: exaggeration,
});

/**
 * Reads what is stored, whatever it is. A setting that is missing, or holds
 * a value this version does not know, takes its default, and anything
 * unknown is dropped. So a row written by an older version loads, and so
 * does one written by a newer version that has been rolled back.
 */
export function readStoredPreferences(stored: unknown): Preferences {
	const defaults = defaultPreferences();
	const record = (value: unknown): Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const data = record(stored);
	const units = record(data.units);
	const layers = record(data.layers);
	const choice = <Kind extends keyof Units>(kind: Kind): Units[Kind] => {
		const allowed = UNIT_CHOICES[kind] as readonly string[];
		const value = units[kind];
		return typeof value === "string" && allowed.includes(value)
			? (value as Units[Kind])
			: defaults.units[kind];
	};
	const scale = exaggeration.safeParse(data.verticalExaggeration);
	return {
		units: {
			altitude: choice("altitude"),
			speed: choice("speed"),
			verticalRate: choice("verticalRate"),
		},
		layers: Object.fromEntries(
			LAYER_IDS.map((layer) => [
				layer,
				typeof layers[layer] === "boolean"
					? (layers[layer] as boolean)
					: defaults.layers[layer],
			]),
		) as Record<LayerId, boolean>,
		verticalExaggeration: scale.success
			? scale.data
			: defaults.verticalExaggeration,
	};
}

/** What both routes answer with. */
export const preferencesAnswerSchema = z.object({
	preferences: preferencesSchema,
});
