// The aircraft: one deck.gl IconLayer whose position, angle and colour
// attributes are GPU buffers filled every frame straight from the store's
// buffers in WASM memory. Browser only, and loaded with the map libraries.
// See docs/DESIGN.md sections 8 and 9.
//
// How a frame reaches the screen:
//
// - The three attributes are luma.gl buffers this file owns, given to the
//   layer as `data.attributes`. Each frame `buffer.write(view)` hands the
//   typed-array view over WASM memory to `gl.bufferSubData`: one copy, from
//   WASM memory to the GPU, with no JavaScript array between.
// - The layer itself is left alone. deck.gl is given a new one only when
//   the number of aircraft changes, which is at most once a second, when a
//   positions frame arrives, or when the buffers are made again because the
//   store's capacity has grown.
// - `map.redraw()` then has MapLibre draw at once, and deck.gl draws the
//   layer inside that, from the buffers as they now are. Drawing in the
//   render loop's own turn, and not in a frame the map asks for, means
//   the picture on screen is the one just advanced to, the map is drawn
//   once per animation frame however many things ask it to repaint, and
//   the time the draw takes on the main thread can be read off a clock.
//
// Why not hand deck.gl the views as `{ value: view }` and let it upload?
// deck.gl 9.4.2 uploads a binary attribute only when the object it is given
// is not the one it was given last (`Attribute.setBinaryValue`), and it
// looks only when the layer is updated. So every frame would need a new
// layer through `overlay.setProps`, which in interleaved mode also resolves
// the map's layer groups and makes a new view each call. Writing to the
// buffers skips all of that.
//
// No accessor runs per aircraft. Position, angle and colour are buffers;
// size, icon and pixel offset are constants, which deck.gl sets as constant
// vertex attributes (`Attribute.setConstantValue`). `getIcon` is the icon's
// name and not a function: a function would be called once per aircraft
// every time the layer's data changed.

import { IconLayer } from "@deck.gl/layers";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import { Buffer, type Device } from "@luma.gl/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeMapLayer } from "@/components/map/base-map";
import type { AircraftTarget, AircraftViews } from "@/lib/aircraft-frame";

export const AIRCRAFT_LAYER_ID = "aircraft";

/**
 * The icon: `public/aircraft.svg`, drawn for the project, nose up. deck.gl
 * rasterizes it at the size the file states. Its origin and licence are in
 * data/README.md.
 */
const ICON_URL = "/aircraft.svg";
const ICON_NAME = "aircraft";
const ICON_MAPPING = {
	// `mask` keeps the icon's alpha and takes the colour from the aircraft.
	[ICON_NAME]: { x: 0, y: 0, width: 128, height: 128, mask: true },
};

// Icon size. The icon is a size on the ground, so it grows as the camera
// closes in, held between a smallest and a largest size on screen:
//
// - Far out, where the whole country is in view, it is the smallest size.
//   That size depends on how many aircraft there are: 10 px for the real
//   picture of about 8,000, where each can be made out and its heading
//   read, down to 6 px from about 22,000 up. At 60,000 the country as a
//   whole is then still a picture of separate aircraft, though the busiest
//   terminal areas are solid at any size an icon can be read at. See
//   `smallestIconPixels`.
// - From about zoom 7.5, where 3.4 km is 10 px, it grows with the map, to
//   28 px at most from about zoom 9: the scale of one terminal area, where
//   there is room. Fewer aircraft arrive for a narrower view, so by then
//   the smallest size is back to 10 px whatever the multiplier.
const ICON_SIZE_METERS = 3_400;
const ICON_MAX_PIXELS = 28;
const ICON_MIN_PIXELS_SPARSE = 10;
const ICON_MIN_PIXELS_DENSE = 6;
/** The real picture: at or under this many aircraft, icons are full size. */
const SPARSE_COUNT = 8_000;

/**
 * The smallest size an icon is drawn at, in pixels, for a picture of
 * `count` aircraft. Above SPARSE_COUNT the icon's area shrinks as the
 * count grows, so the ink on screen stays about what the real picture
 * has, until the icon is as small as it can be and still show a heading.
 * Whole pixels, so the size changes in a few steps and not every second.
 */
export function smallestIconPixels(count: number): number {
	if (count <= SPARSE_COUNT) return ICON_MIN_PIXELS_SPARSE;
	const pixels = Math.round(
		ICON_MIN_PIXELS_SPARSE * Math.sqrt(SPARSE_COUNT / count),
	);
	return Math.max(ICON_MIN_PIXELS_DENSE, pixels);
}

export type AircraftLayerOptions = {
	map: MapLibreMap;
	overlay: MapLibreOverlay;
	/**
	 * deck.gl's device, or null until it has attached to the map's WebGL
	 * context. Nothing is drawn before then.
	 */
	device: () => Device | null;
	/**
	 * False uploads every frame as usual and draws nothing: a measuring aid,
	 * for telling the cost of drawing the aircraft from the rest.
	 */
	visible?: boolean;
};

export type AircraftLayer = AircraftTarget & {
	/** Frees the GPU buffers. The overlay and the map are the caller's. */
	remove(): void;
};

type Buffers = {
	positions: Buffer;
	angles: Buffer;
	colors: Buffer;
	/** Rows each has room for. */
	rows: number;
	/** The layer's `data.attributes`: the same objects for the buffers' life. */
	attributes: {
		getPosition: { buffer: Buffer; size: 3; type: "float32"; stride: number };
		getAngle: { buffer: Buffer; size: 1; type: "float32" };
		getColor: { buffer: Buffer; size: 4; type: "unorm8" };
	};
};

export function createAircraftLayer({
	map,
	overlay,
	device,
	visible = true,
}: AircraftLayerOptions): AircraftLayer {
	let buffers: Buffers | null = null;
	// What the layer deck.gl holds was made with. -1: no layer yet.
	let layerCount = -1;
	let layerBuffers: Buffers | null = null;

	function makeBuffers(gpu: Device, rows: number): Buffers {
		const usage = Buffer.VERTEX | Buffer.COPY_DST;
		const positions = gpu.createBuffer({
			id: "aircraft-positions",
			usage,
			byteLength: rows * 12,
		});
		const angles = gpu.createBuffer({
			id: "aircraft-angles",
			usage,
			byteLength: rows * 4,
		});
		const colors = gpu.createBuffer({
			id: "aircraft-colors",
			usage,
			byteLength: rows * 4,
		});
		return {
			positions,
			angles,
			colors,
			rows,
			attributes: {
				// deck.gl takes a position buffer for 64-bit unless told its
				// stride: three 32-bit floats a row.
				getPosition: {
					buffer: positions,
					size: 3,
					type: "float32",
					stride: 12,
				},
				getAngle: { buffer: angles, size: 1, type: "float32" },
				getColor: { buffer: colors, size: 4, type: "unorm8" },
			},
		};
	}

	function destroyBuffers(old: Buffers) {
		old.positions.destroy();
		old.angles.destroy();
		old.colors.destroy();
	}

	function setLayer(count: number, held: Buffers) {
		layerCount = count;
		layerBuffers = held;
		overlay.setProps({
			layers: [
				new IconLayer(
					beforeMapLayer({
						id: AIRCRAFT_LAYER_ID,
						data: { length: count, attributes: held.attributes },
						visible,

						iconAtlas: ICON_URL,
						iconMapping: ICON_MAPPING,
						// The icon's name, not a function that returns it: see the
						// notes at the top. deck.gl's types ask for a function; its
						// code takes either (`AttributeManager.update`, step 3).
						getIcon: ICON_NAME as unknown as () => string,

						// Flat on the map, not turned to the camera, so the nose
						// points along the track whatever the map's bearing or pitch.
						billboard: false,
						getSize: ICON_SIZE_METERS,
						sizeUnits: "meters" as const,
						sizeMinPixels: smallestIconPixels(count),
						sizeMaxPixels: ICON_MAX_PIXELS,

						// Picking is issue #31. Turn this on there. A pick's `index`
						// is a row of the store's buffers as of the last `advance`,
						// and `currentTraffic().store.id_at(index)` is the aircraft:
						// rows are reused, so keep the id and never the row.
						pickable: false,
					}),
				),
			],
		});
	}

	return {
		draw(views: AircraftViews, count: number) {
			const gpu = device();
			if (gpu === null) return;

			if (buffers === null || buffers.rows < views.capacity) {
				const old = buffers;
				buffers = makeBuffers(gpu, views.capacity);
				// The layer is given the new buffers below, before the old ones
				// go: deck.gl draws only on the map's next repaint.
				setLayer(count, buffers);
				if (old) destroyBuffers(old);
			}

			if (count > 0) {
				// The whole view, in use or not: luma.gl's `write` has no length,
				// and a view of just the rows in use would be a new object every
				// time the count changed.
				buffers.positions.write(views.positions);
				buffers.angles.write(views.angles);
				buffers.colors.write(views.colors);
			}

			if (count !== layerCount || layerBuffers !== buffers) {
				setLayer(count, buffers);
			}
		},

		repaint() {
			// Synchronous, and it takes the place of any frame the map has
			// asked for and not yet drawn.
			map.redraw();
		},

		clear() {
			if (buffers !== null && layerCount > 0) {
				setLayer(0, buffers);
				map.triggerRepaint();
			}
		},

		remove() {
			if (buffers) destroyBuffers(buffers);
			buffers = null;
			layerBuffers = null;
			layerCount = -1;
		},
	};
}
