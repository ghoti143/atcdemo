// What 2D and 3D mean for the map and for the aircraft's height. Plain
// values and functions, with no import of the map libraries, so `bun test`
// runs it.

import type { ViewMode } from "@/lib/interface-store";

const METRES_PER_FOOT = 0.3048;

/**
 * What the store multiplies an altitude in feet by for the positions it
 * writes. In 2D, nothing: the picture lies flat. In 3D, metres, stretched
 * by the vertical exaggeration, which the terrain is stretched by too.
 */
export function altitudeScaleFor(mode: ViewMode, exaggeration: number): number {
	return mode === "3d" ? METRES_PER_FOOT * exaggeration : 0;
}

/** How far the camera tips over when 3D is turned on, in degrees. */
export const PITCH_3D = 55;
/** How long the camera takes to tip over or to stand up again. */
export const PITCH_MOVE_MS = 800;

export const TERRAIN_SOURCE_ID = "terrain-dem";

/**
 * Mapterhorn's elevation tiles, as its TileJSON describes them
 * (https://tiles.mapterhorn.com/tilejson.json). Heights are metres above
 * mean sea level, the reference the aircraft's altitudes use. The
 * attribution goes in the map's attribution control while the source is
 * on the map.
 */
export const TERRAIN_SOURCE = {
	type: "raster-dem",
	tiles: ["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
	encoding: "terrarium",
	tileSize: 512,
	maxzoom: 12,
	attribution:
		'<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>',
} as const;

/**
 * The relief, shaded, so the terrain can be seen on a map that is nearly
 * black: without it the ground rises and nothing shows it. It has a source
 * of its own, as MapLibre asks when the same tiles also make the terrain,
 * and goes under the style's first line layer, so borders and roads are
 * drawn over it.
 */
export const HILLSHADE_SOURCE_ID = "terrain-shade";
export const HILLSHADE_LAYER = {
	id: "terrain-shade",
	type: "hillshade",
	source: HILLSHADE_SOURCE_ID,
	paint: {
		"hillshade-shadow-color": "#000000",
		"hillshade-highlight-color": "#5b6b82",
		"hillshade-accent-color": "#05070a",
		"hillshade-exaggeration": 0.55,
	},
} as const;

/** The layer the hillshade goes under: the style's first line layer. */
export function hillshadeBefore(
	layers: readonly { id: string; type: string }[],
): string | undefined {
	return layers.find((layer) => layer.type === "line")?.id;
}

/**
 * The sky over a pitched map: the shell's blue-black overhead, a little
 * lighter at the horizon, and the far ground fading into it.
 */
export const SKY = {
	"sky-color": "#070a0f",
	"horizon-color": "#16202e",
	"fog-color": "#0a0d12",
	"sky-horizon-blend": 0.7,
	"horizon-fog-blend": 0.6,
	"fog-ground-blend": 0.4,
	"atmosphere-blend": 0,
} as const;
