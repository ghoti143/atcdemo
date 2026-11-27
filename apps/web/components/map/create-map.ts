// The imperative half of the map: makes the MapLibre map and its deck.gl
// overlay in a container, keeps the interface store told where the camera
// is, and takes it all down again. Browser only. See docs/DESIGN.md
// section 9.

import type { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Device } from "@luma.gl/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import type * as AircraftLayerModule from "@/components/map/aircraft-layer";
import {
	BASE_STYLE_URL,
	styleAdjustments,
	TRAFFIC_ATTRIBUTION,
	TRAFFIC_BEFORE_ID,
} from "@/components/map/base-map";
import { createAircraftFrame, createFrameLoop } from "@/lib/aircraft-frame";
import { interfaceStore } from "@/lib/interface-store";
import { createMapHover } from "@/lib/map-hover";
import { pickedId } from "@/lib/selection";
import { currentTraffic } from "@/lib/traffic";
import {
	COVERAGE_BBOX,
	paced,
	VIEWPORT_REPORT_INTERVAL_MS,
	viewportOf,
} from "@/lib/viewport";

/** How long the map takes to move to a view that is applied. */
const CAMERA_MOVE_MS = 600;
/** Room left round a box the map is asked to show, in CSS pixels. */
const FIT_PADDING_PIXELS = 80;
/** The closest the map goes to show a box, so one point is not a street. */
const FIT_MAX_ZOOM = 8;

export type MapLibraries = {
	maplibre: typeof import("maplibre-gl");
	MapLibreOverlay: typeof MapLibreOverlay;
	aircraftLayer: typeof AircraftLayerModule;
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
			aircraftLayer: aircraft,
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
	{ maplibre, MapLibreOverlay, aircraftLayer }: MapLibraries,
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
	const { createAircraftLayer, AIRCRAFT_LAYER_ID, PICK_RADIUS_PIXELS } =
		aircraftLayer;

	// Picking. What deck.gl reports is a layer and an index into it, and for
	// the aircraft layer the index is a row of the store's buffers as of the
	// last `advance`. It is turned into an aircraft id here, in the same
	// turn as the pick, and only the id is kept: the next positions frame
	// may put another aircraft in that row.
	const aircraftAt = (
		pick: { layer?: { id: string } | null; index: number } | null,
	): number | null => {
		const traffic = currentTraffic();
		if (!traffic || !pick || pick.layer?.id !== AIRCRAFT_LAYER_ID) return null;
		return pickedId(traffic.store, pick.index);
	};

	// Whether the last hover pick found an aircraft.
	let overAircraft = false;
	const mapHover = createMapHover(interfaceStore);
	const overlay = new MapLibreOverlay({
		interleaved: true,
		layers: [],
		onDeviceInitialized: (attached) => {
			device = attached;
		},
		pickingRadius: PICK_RADIUS_PIXELS,
		// Hover. deck.gl listens on the map's canvas itself and picks at most
		// once per animation frame, at the pointer's newest position, however
		// many times the pointer moved; not at all while a button is down, so
		// not during a drag; and with nothing when the pointer leaves.
		// That last pick comes a frame late, so `createMapHover` keeps it from
		// clearing a hover a row of the flight list has set meanwhile.
		onHover: (pick) => {
			const id = aircraftAt(pick);
			overAircraft = id !== null;
			mapHover(id);
		},
		// deck.gl writes this to the canvas every frame. Empty leaves the
		// cursor to MapLibre's stylesheet: the open hand, and the closed one
		// during a drag. Not deck.gl's own `isHovering`, which stays true for
		// one more pick after the pointer has left an aircraft: the pick that
		// finds nothing still reports the layer that was left.
		getCursor: () => (overAircraft ? "pointer" : ""),
	});
	map.addControl(overlay);

	// Click. A click on an aircraft selects it and a click on the empty map
	// selects nothing. MapLibre says what a click is: not the end of a drag.
	// The pick is made now and not taken from deck.gl's own click event,
	// which reports the pick it made when the button went down: a positions
	// frame can arrive between down and up, and that row would then be
	// another aircraft's.
	map.on("click", (event) => {
		// Nothing can be picked until deck.gl has attached to the context.
		if (device === null) return;
		const pick = overlay.pickObject({
			x: event.point.x,
			y: event.point.y,
			radius: PICK_RADIUS_PIXELS,
			layerIds: [AIRCRAFT_LAYER_ID],
		});
		interfaceStore.getState().select(aircraftAt(pick));
	});

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
					marked: interfaceStore.getState,
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
	// And the other way: something asks the map to move, a saved view being
	// applied. The move is reported back like any other.
	const stopFollowing = interfaceStore.subscribe(
		(state) => state.cameraTarget,
		(target) => {
			if (target === null) return;
			const { longitude, latitude, zoom, pitch, bearing } = target.camera;
			map.easeTo({
				center: [longitude, latitude],
				zoom,
				pitch,
				bearing,
				duration: CAMERA_MOVE_MS,
			});
		},
	);
	// And a box to show whole: a flight found by search.
	const stopFitting = interfaceStore.subscribe(
		(state) => state.boundsTarget,
		(target) => {
			if (target === null) return;
			const [west, south, east, north] = target.bounds;
			map.fitBounds(
				[
					[west, south],
					[east, north],
				],
				{
					padding: FIT_PADDING_PIXELS,
					maxZoom: FIT_MAX_ZOOM,
					duration: CAMERA_MOVE_MS,
				},
			);
		},
	);
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
			stopFollowing();
			stopFitting();
			// Takes the overlay with it: MapLibre removes its controls, and the
			// overlay finalizes deck.gl when it is removed.
			map.remove();
		},
	};
}
