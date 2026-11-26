// A test picture that shows deck.gl and MapLibre drawing one scene: a
// development preview, `/?preview=open,map-depth-test`, loaded only then.
//
// Over Colorado, with the camera tilted, it draws:
//
// - A grey block, 40 km square and 60 km tall. This is MapLibre's own: a
//   fill-extrusion layer.
// - An orange bar at 30 km up that runs east to west through the block.
//   This is deck.gl's. It goes into the near face of the block and comes out
//   of the far one, and the block hides the part of it that is behind. That
//   is the depth buffer shared: in overlaid mode the whole bar would lie on
//   top of the block.
// - A cyan disc on the ground over Denver, also deck.gl's, placed with
//   `beforeId`. The roads show under it, where it is see-through, and the
//   place names are drawn on top of it. That is the layer stack shared.

import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeMapLayer, TRAFFIC_BEFORE_ID } from "@/components/map/base-map";

const BLOCK_SOURCE_ID = "depth-test-block";

// The block, south-east of Denver: about 40 km on a side.
const BLOCK = { west: -104.5, east: -104.03, south: 39.02, north: 39.38 };
const BLOCK_HEIGHT_M = 60_000;
const BAR_HEIGHT_M = 30_000;
const BAR_LATITUDE = 39.2;
const DENVER: [number, number] = [-104.99, 39.74];

export function addDepthTest(map: MapLibreMap, overlay: MapLibreOverlay) {
	map.addSource(BLOCK_SOURCE_ID, {
		type: "geojson",
		data: {
			type: "Feature",
			properties: {},
			geometry: {
				type: "Polygon",
				coordinates: [
					[
						[BLOCK.west, BLOCK.south],
						[BLOCK.east, BLOCK.south],
						[BLOCK.east, BLOCK.north],
						[BLOCK.west, BLOCK.north],
						[BLOCK.west, BLOCK.south],
					],
				],
			},
		},
	});
	map.addLayer(
		{
			id: BLOCK_SOURCE_ID,
			type: "fill-extrusion",
			source: BLOCK_SOURCE_ID,
			paint: {
				"fill-extrusion-color": "#8a93a0",
				"fill-extrusion-height": BLOCK_HEIGHT_M,
				"fill-extrusion-opacity": 1,
			},
		},
		TRAFFIC_BEFORE_ID,
	);

	overlay.setProps({
		layers: [
			new ScatterplotLayer(
				beforeMapLayer({
					id: "depth-test-disc",
					data: [{ position: DENVER }],
					getPosition: (d: { position: [number, number] }) => d.position,
					getRadius: 30_000,
					radiusUnits: "meters" as const,
					getFillColor: [0, 200, 255, 110] as [number, number, number, number],
					stroked: true,
					getLineColor: [0, 200, 255, 255] as [number, number, number, number],
					lineWidthMinPixels: 2,
				}),
			),
			new PathLayer(
				beforeMapLayer({
					id: "depth-test-bar",
					data: [
						{
							path: [
								[BLOCK.west - 0.7, BAR_LATITUDE, BAR_HEIGHT_M],
								[BLOCK.east + 0.7, BAR_LATITUDE, BAR_HEIGHT_M],
							],
						},
					],
					getPath: (d: { path: [number, number, number][] }) => d.path,
					getColor: [255, 150, 0, 255] as [number, number, number, number],
					getWidth: 6,
					widthUnits: "pixels" as const,
					billboard: true,
				}),
			),
		],
	});

	map.jumpTo({
		center: [-104.4, 39.35],
		zoom: 7.6,
		pitch: 60,
		bearing: 25,
	});
}
