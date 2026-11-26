// The imperative half of the map: makes the MapLibre map and its deck.gl
// overlay in a container, keeps the interface store told where the camera
// is, and takes it all down again. Browser only. See docs/DESIGN.md
// section 9.

import type { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Device } from "@luma.gl/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { createAircraftLayer } from "@/components/map/aircraft-layer";
import {
	BASE_STYLE_URL,
	styleAdjustments,
	TRAFFIC_ATTRIBUTION,
	TRAFFIC_BEFORE_ID,
} from "@/components/map/base-map";
import { createAircraftFrame, createFrameLoop } from "@/lib/aircraft-frame";
import { interfaceStore } from "@/lib/interface-store";
import { currentTraffic } from "@/lib/traffic";
import {
	COVERAGE_BBOX,
	paced,
	VIEWPORT_REPORT_INTERVAL_MS,
	viewportOf,
} from "@/lib/viewport";

export type MapLibraries = {
	maplibre: typeof import("maplibre-gl");
	MapLibreOverlay: typeof MapLibreOverlay;
	createAircraftLayer: typeof createAircraftLayer;
};

let libraries: Promise<MapLibraries> | undefined;

/**
 * Fetches MapLibre and deck.gl, once per page. They are imported here, not
 * at the top of a file, so that nothing of them runs on the server or in a
 * test without a DOM, and so that they stay out of the first chunk.
 */
export function loadMapLibraries(): Promise<MapLibraries> {
	libraries ??= Promise.all([
		import("maplibre-gl"),
		import("@deck.gl/maplibre"),
		import("@/components/map/aircraft-layer"),
	]).then(([maplibre, deck, aircraft]) => {
		// MapLibre 6 finds its worker beside its own file, which works from a
		// CDN and not from a bundle. This hands it the file the bundler emits.
		maplibre.setWorkerUrl(
			new URL(
				"maplibre-gl/dist/maplibre-gl-worker.mjs",
				import.meta.url,
			).toString(),
		);
		return {
			maplibre,
			MapLibreOverlay: deck.MapLibreOverlay,
			createAircraftLayer: aircraft.createAircraftLayer,
		};
	});
	libraries.catch(() => {
		libraries = undefined;
	});
	return libraries;
}

export type TrafficMap = {
	map: MapLibreMap;
	/** The one deck.gl overlay, interleaved. Layers are set on it. */
	overlay: MapLibreOverlay;
	/** Stops the render loop and the reporting, and frees the map and its WebGL context. */
	remove: () => void;
};

export type TrafficMapOptions = {
	/**
	 * Draw the depth test layers and tilt the camera to them. The aircraft
	 * are then left out: the test has the overlay's layers to itself.
	 */
	depthTest?: boolean;
	/**
	 * Run the render loop as usual and draw no aircraft: a measuring aid
	 * (`/?aircraft=hidden`), for telling what drawing them costs.
	 */
	aircraftHidden?: boolean;
};

/**
 * Makes the map in `container`, showing the coverage area.
 *
 * Throws if the browser cannot give a WebGL2 context.
 */
export function createTrafficMap(
	container: HTMLElement,
	{ maplibre, MapLibreOverlay, createAircraftLayer }: MapLibraries,
	options: TrafficMapOptions = {},
): TrafficMap {
	const map = new maplibre.Map({
		container,
		style: BASE_STYLE_URL,
		bounds: [...COVERAGE_BBOX],
		fitBoundsOptions: { padding: 24 },
		// Off by default in MapLibre; deck.gl's paths and lines are drawn into
		// the map's own framebuffer and are jagged without it.
		canvasContextAttributes: { antialias: true },
		// Added below, with the traffic's notice in it.
		attributionControl: false,
	});

	// Both controls go bottom right: the top edge belongs to the shell's
	// reconnecting strip and the top left corner to the HUD. In a bottom
	// corner MapLibre puts each new control above the last, so the
	// attribution is added first and sits on the bottom edge.
	//
	// Always open: `compact: false` keeps the notices on screen at any width.
	// MapLibre would otherwise fold them behind a button on a narrow map.
	map.addControl(
		new maplibre.AttributionControl({
			compact: false,
			customAttribution: TRAFFIC_ATTRIBUTION,
		}),
		"bottom-right",
	);
	map.addControl(
		new maplibre.NavigationControl({ visualizePitch: true }),
		"bottom-right",
	);

	// deck.gl attaches to the map's WebGL context a moment after the overlay
	// is added. The aircraft layer makes its GPU buffers on this device.
	let device: Device | null = null;
	const overlay = new MapLibreOverlay({
		interleaved: true,
		layers: [],
		onDeviceInitialized: (attached) => {
			device = attached;
		},
	});
	map.addControl(overlay);

	// The render loop: every animation frame the store is advanced to the
	// frame's time and the aircraft layer redrawn from it. `currentTraffic`
	// is read each frame, so the loop draws nothing until the shell has
	// started the socket, and nothing at all under a preview that pins the
	// connection.
	const aircraft = options.depthTest
		? null
		: createAircraftLayer({
				map,
				overlay,
				device: () => device,
				visible: !options.aircraftHidden,
			});
	const loop = aircraft
		? createFrameLoop(
				createAircraftFrame({
					source: currentTraffic,
					target: aircraft,
					report: interfaceStore.getState().reportPerformance,
				}).frame,
			)
		: null;
	loop?.start();

	let removed = false;

	map.on("style.load", () => {
		// The style names no projection, which means mercator. Said outright,
		// because deck.gl does not draw flat icons on MapLibre's globe.
		map.setProjection({ type: "mercator" });
		for (const change of styleAdjustments(map.getStyle().layers)) {
			if (change.kind === "paint") {
				map.setPaintProperty(
					change.layerId,
					change.property as Parameters<MapLibreMap["setPaintProperty"]>[1],
					change.value as Parameters<MapLibreMap["setPaintProperty"]>[2],
				);
			} else {
				map.setLayoutProperty(
					change.layerId,
					change.property as Parameters<MapLibreMap["setLayoutProperty"]>[1],
					change.value as Parameters<MapLibreMap["setLayoutProperty"]>[2],
				);
			}
		}
		if (!map.getLayer(TRAFFIC_BEFORE_ID)) {
			console.warn(
				`The base style has no "${TRAFFIC_BEFORE_ID}" layer; traffic layers will draw over the place names.`,
			);
		}
	});

	if (options.depthTest) {
		map.once("load", () => {
			import("@/components/map/depth-test").then(
				({ addDepthTest }) => {
					if (!removed) addDepthTest(map, overlay);
				},
				(cause: unknown) => console.error(cause),
			);
		});
	}

	// The store hears the camera on every frame of a move, as its notes say,
	// and the viewport at the socket client's pace.
	const { setCamera, setViewport } = interfaceStore.getState();
	const reportViewport = paced(setViewport, VIEWPORT_REPORT_INTERVAL_MS);
	const report = () => {
		const center = map.getCenter();
		const zoom = map.getZoom();
		setCamera({
			longitude: center.lng,
			latitude: center.lat,
			zoom,
			pitch: map.getPitch(),
			bearing: map.getBearing(),
		});
		const bounds = map.getBounds();
		reportViewport(
			viewportOf(
				{
					west: bounds.getWest(),
					south: bounds.getSouth(),
					east: bounds.getEast(),
					north: bounds.getNorth(),
				},
				zoom,
			),
		);
	};
	map.on("move", report);
	// A resize changes the bounds without moving the camera.
	map.on("resize", report);
	report();

	return {
		map,
		overlay,
		remove: () => {
			removed = true;
			loop?.stop();
			// Before the map goes, and deck.gl's device with it.
			aircraft?.remove();
			reportViewport.cancel();
			// Takes the overlay with it: MapLibre removes its controls, and the
			// overlay finalizes deck.gl when it is removed.
			map.remove();
		},
	};
}
