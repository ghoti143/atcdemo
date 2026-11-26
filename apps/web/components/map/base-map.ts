// The base map: which style, where deck.gl's layers go in it, and what the
// attribution control says. Plain values and functions, with no import of
// MapLibre or deck.gl, so they load anywhere. See docs/DESIGN.md sections 9
// and 14.

/**
 * OpenFreeMap's "dark" style: near-black land and water, grey roads and
 * grey place names, and nothing coloured. Of the five styles OpenFreeMap
 * publishes it is the one that leaves the colour to the traffic.
 */
export const BASE_STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

/**
 * The first place-name layer of the "dark" style. Its place names, from
 * hamlets to countries, are the last layers of the style, so a deck.gl
 * layer placed before this one draws over all the land, water, roads, road
 * names and borders, and under every place name.
 */
export const FIRST_PLACE_LABEL_LAYER_ID = "place_other";

/**
 * Where the traffic layers go in the map's layer stack: over the geography,
 * under the place names, which stay readable across a busy sky.
 */
export const TRAFFIC_BEFORE_ID = FIRST_PLACE_LABEL_LAYER_ID;

/**
 * Gives a deck.gl layer's props the `beforeId` that `MapLibreOverlay` reads
 * in interleaved mode. deck.gl's layer types do not declare the property.
 */
export function beforeMapLayer<P extends object>(
	props: P,
	beforeId: string = TRAFFIC_BEFORE_ID,
): P {
	return { ...props, beforeId };
}

/**
 * The notice the ODbL asks for wherever the picture is shown (section 4.3
 * of the licence). It goes in the map's attribution control, after the
 * credits the style's sources bring with them: OpenFreeMap, OpenMapTiles
 * and OpenStreetMap.
 */
export const TRAFFIC_ATTRIBUTION =
	'Contains information from <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a>, ' +
	'made available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL</a>';

/** Just enough of a style layer to adjust it. */
type StyleLayer = { id: string; type: string };

export type StyleChange = {
	layerId: string;
	kind: "paint" | "layout";
	property: string;
	/** Undefined puts the property back to its default. */
	value: unknown;
};

// The shell's background, oklch(0.15 0.012 250), as sRGB.
const SHELL_BACKGROUND = "#0a0d12";
// Water a step lighter than the land, as in the stock style, in the same hue.
const WATER = "#141a22";

/**
 * The few changes made to the stock style once it has loaded, and why:
 *
 * - Land and water take the shell's blue-black in place of the style's
 *   neutral black, so the map and the panels read as one surface. Water
 *   stays a step lighter than land, which is what draws the coastline.
 * - Water names are near-black on a grey halo in the stock style, which
 *   reads as a smudge on dark water. They take the place names' quiet grey.
 * - The style asks its sprite for two images the sprite does not have, and
 *   MapLibre warns in the console about each. The dot beside a town or city
 *   name is `circle_11` in the sprite and `circle-11` in the style; the
 *   name is corrected. Woodland asks for a `wood-pattern` that does not
 *   exist, and so is not drawn at all; without the pattern it is filled
 *   with its own colour, the same grey as the parks.
 *
 * A layer the style does not have is skipped, so a change to the hosted
 * style costs an adjustment, not an error.
 */
export function styleAdjustments(layers: readonly StyleLayer[]): StyleChange[] {
	const cityDot: StyleChange[] = [
		"place_town",
		"place_city",
		"place_city_large",
	].map((layerId) => ({
		layerId,
		kind: "layout",
		property: "icon-image",
		value: ["step", ["zoom"], "circle_11", 9, ""],
	}));
	const wanted: StyleChange[] = [
		{
			layerId: "background",
			kind: "paint",
			property: "background-color",
			value: SHELL_BACKGROUND,
		},
		{ layerId: "water", kind: "paint", property: "fill-color", value: WATER },
		{
			layerId: "waterway",
			kind: "paint",
			property: "line-color",
			value: WATER,
		},
		{
			layerId: "water_name",
			kind: "paint",
			property: "text-color",
			value: "#4a5560",
		},
		{
			layerId: "water_name",
			kind: "paint",
			property: "text-halo-color",
			value: "rgba(0,0,0,0.7)",
		},
		...cityDot,
		{
			layerId: "landcover_wood",
			kind: "paint",
			property: "fill-pattern",
			value: undefined,
		},
	];
	const present = new Set(layers.map((layer) => layer.id));
	return wanted.filter((change) => present.has(change.layerId));
}
