// The Class B shelves as a deck.gl layer. Imported only through
// aircraft-layer.ts, which is loaded with the map libraries.

import { PolygonLayer } from "@deck.gl/layers";
import { beforeMapLayer } from "@/components/map/base-map";
import type { ShelfVolume } from "@/lib/airspace";

export const CLASS_B_LAYER_ID = "airspace-class-b";

// The map's own blue for airspace, as a chart's is: faint enough to see
// the aircraft and the map through a stack of shelves.
const FILL: [number, number, number, number] = [96, 165, 250, 26];
const EDGE: [number, number, number, number] = [96, 165, 250, 150];

/**
 * The shelves, each a prism from its floor to its ceiling. `volumes` is
 * made again whenever the altitude scale changes, so a new array is a new
 * picture and the same array is the same one.
 */
export function classBLayer(volumes: ShelfVolume[], raised: boolean) {
	return new PolygonLayer<ShelfVolume>(
		beforeMapLayer({
			id: CLASS_B_LAYER_ID,
			data: volumes,
			getPolygon: (volume: ShelfVolume) => volume.polygon,
			// Added to the height the polygon's own positions carry: the floor.
			getElevation: (volume: ShelfVolume) => volume.thickness,
			extruded: raised,
			// Flat, a shelf is an outline and a tint. Raised, its edges are
			// drawn as a wireframe.
			wireframe: raised,
			stroked: !raised,
			filled: true,
			getFillColor: FILL,
			getLineColor: EDGE,
			getLineWidth: 1,
			lineWidthUnits: "pixels" as const,
			pickable: false,
		}),
	);
}
