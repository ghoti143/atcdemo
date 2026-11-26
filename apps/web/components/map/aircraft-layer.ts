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
//
// Picking is on. deck.gl draws the layer once more, into a framebuffer of
// its own, with each instance in a colour that encodes its index, and reads
// back the pixels round the pointer. The index is a row of the store's
// buffers as last written, which is as of the last `advance`; rows are
// reused, so whoever picks turns it into an aircraft id at once
// (`pickedId` in lib/selection.ts) and keeps only the id. The picking
// colours are deck.gl's own attribute, made from the instance count alone,
// so buffers it holds no copy of do not get in its way.
//
// The marks: a ring round the selected aircraft and a fainter one round the
// hovered. They are a second layer of two instances, drawn over the icons,
// whose positions are a GPU buffer of two rows that is written each frame
// from the row the frame loop names. The loop finds that row from the
// aircraft's id every frame, so a ring stays on its aircraft as it moves
// and as its row changes, and deck.gl is given no new layer for it.

import { IconLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { MapLibreOverlay } from "@deck.gl/maplibre";
import { Buffer, type Device } from "@luma.gl/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeMapLayer } from "@/components/map/base-map";
import {
	type AircraftTarget,
	type AircraftViews,
	NO_ROW,
} from "@/lib/aircraft-frame";

export const AIRCRAFT_LAYER_ID = "aircraft";
export const AIRCRAFT_MARKS_LAYER_ID = "aircraft-marks";

/**
 * How far from an icon the pointer may be and still pick it, in CSS pixels:
 * deck.gl reads a square this far each way from the pointer and takes the
 * nearest aircraft in it. Icons are 6 to 10 px across when the whole
 * country is in view, so with this the target is about 18 to 22 px across,
 * and a pointer between two aircraft takes the nearer.
 */
export const PICK_RADIUS_PIXELS = 6;

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

// The rings. A ring is a size on the ground like the icon it goes round,
// held a few pixels clear of the icon at the icon's smallest and largest.
const RING_RADIUS_METERS = ICON_SIZE_METERS * 0.8;
const RING_CLEARANCE_PIXELS = 4;
const RING_WIDTH_PIXELS = 2;
const SELECTED_MARK = 0;
const HOVERED_MARK = 1;
const SELECTED_ALPHA = 255;
/** The hovered aircraft's ring is the same white, fainter. */
const HOVERED_ALPHA = 140;
// Where a ring that marks nothing is kept: transparent, and far from the
// coverage area, so it cannot be in the way of anything drawn after it.
const PARKED_LONGITUDE = 0;
const PARKED_LATITUDE = 89;

/**
 * The smallest radius a ring is drawn at, in pixels, for a picture of
 * `count` aircraft: clear of the smallest icon.
 */
export function smallestRingPixels(count: number): number {
	return smallestIconPixels(count) / 2 + RING_CLEARANCE_PIXELS;
}

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

/** The two rings: rows SELECTED_MARK and HOVERED_MARK of two small buffers. */
type Marks = {
	positions: Buffer;
	colors: Buffer;
	/** What is written to `positions`: lon, lat, altitude for each ring. */
	positionValues: Float32Array;
	/** What is written to `colors`: white, with an alpha of 0 for no ring. */
	colorValues: Uint8Array;
	/** The marks layer's `data`: the same object for the buffers' life. */
	data: {
		length: 2;
		attributes: {
			getPosition: { buffer: Buffer; size: 3; type: "float32"; stride: number };
			getLineColor: { buffer: Buffer; size: 4; type: "unorm8" };
		};
	};
};

const NO_VIEWS: AircraftViews = {
	positions: new Float32Array(0),
	angles: new Float32Array(0),
	colors: new Uint8Array(0),
	capacity: 0,
};

/**
 * Puts one ring on `row` of `views`, or parks it for NO_ROW. Returns
 * whether its colour changed, which it does only when a ring appears or
 * goes.
 */
function placeMark(
	marks: Marks,
	mark: number,
	alpha: number,
	views: AircraftViews,
	row: number,
): boolean {
	const { positionValues, colorValues } = marks;
	const shown = row === NO_ROW ? 0 : alpha;
	if (row === NO_ROW) {
		positionValues[mark * 3] = PARKED_LONGITUDE;
		positionValues[mark * 3 + 1] = PARKED_LATITUDE;
		positionValues[mark * 3 + 2] = 0;
	} else {
		positionValues[mark * 3] = views.positions[row * 3];
		positionValues[mark * 3 + 1] = views.positions[row * 3 + 1];
		positionValues[mark * 3 + 2] = views.positions[row * 3 + 2];
	}
	if (colorValues[mark * 4 + 3] === shown) return false;
	colorValues[mark * 4 + 3] = shown;
	return true;
}

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
	let marks: Marks | null = null;

	function makeMarks(gpu: Device): Marks {
		const usage = Buffer.VERTEX | Buffer.COPY_DST;
		const positionValues = new Float32Array(6);
		const colorValues = new Uint8Array(8).fill(255);
		for (const mark of [SELECTED_MARK, HOVERED_MARK]) {
			positionValues[mark * 3] = PARKED_LONGITUDE;
			positionValues[mark * 3 + 1] = PARKED_LATITUDE;
			colorValues[mark * 4 + 3] = 0;
		}
		const positions = gpu.createBuffer({
			id: "aircraft-mark-positions",
			usage,
			data: positionValues,
		});
		const colors = gpu.createBuffer({
			id: "aircraft-mark-colors",
			usage,
			data: colorValues,
		});
		return {
			positions,
			colors,
			positionValues,
			colorValues,
			data: {
				length: 2,
				attributes: {
					getPosition: {
						buffer: positions,
						size: 3,
						type: "float32",
						stride: 12,
					},
					getLineColor: { buffer: colors, size: 4, type: "unorm8" },
				},
			},
		};
	}

	function writeMarks(
		held: Marks,
		views: AircraftViews,
		selectedRow: number,
		hoveredRow: number,
	) {
		const selected = placeMark(
			held,
			SELECTED_MARK,
			SELECTED_ALPHA,
			views,
			selectedRow,
		);
		const hovered = placeMark(
			held,
			HOVERED_MARK,
			HOVERED_ALPHA,
			views,
			hoveredRow,
		);
		// The colours are written only when a ring appears or goes, and the
		// positions only while there is a ring to move or one to park.
		const changed = selected || hovered;
		if (changed) held.colors.write(held.colorValues);
		if (changed || selectedRow !== NO_ROW || hoveredRow !== NO_ROW) {
			held.positions.write(held.positionValues);
		}
	}

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

	function setLayer(count: number, held: Buffers, rings: Marks) {
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

						// A pick's `index` is a row of the store's buffers as of the
						// last `advance`: see the notes at the top.
						pickable: true,
					}),
				),
				// After the icons, so over them. Its data is the same object
				// every time, so deck.gl has no attribute of it to update when
				// the aircraft layer is replaced.
				new ScatterplotLayer(
					beforeMapLayer({
						id: AIRCRAFT_MARKS_LAYER_ID,
						data: rings.data,
						visible,

						filled: false,
						stroked: true,
						billboard: false,
						getRadius: RING_RADIUS_METERS,
						radiusUnits: "meters" as const,
						radiusMinPixels: smallestRingPixels(count),
						radiusMaxPixels: ICON_MAX_PIXELS / 2 + RING_CLEARANCE_PIXELS,
						getLineWidth: RING_WIDTH_PIXELS,
						lineWidthUnits: "pixels" as const,

						// A ring is not an aircraft: the pointer picks through it.
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

			marks ??= makeMarks(gpu);
			if (buffers === null || buffers.rows < views.capacity) {
				const old = buffers;
				buffers = makeBuffers(gpu, views.capacity);
				// The layer is given the new buffers below, before the old ones
				// go: deck.gl draws only on the map's next repaint.
				setLayer(count, buffers, marks);
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
				setLayer(count, buffers, marks);
			}
		},

		mark(views: AircraftViews, selectedRow: number, hoveredRow: number) {
			// Null until `draw` has had a device to make them on.
			if (marks !== null) writeMarks(marks, views, selectedRow, hoveredRow);
		},

		repaint() {
			// Synchronous, and it takes the place of any frame the map has
			// asked for and not yet drawn.
			map.redraw();
		},

		clear() {
			if (buffers !== null && marks !== null && layerCount > 0) {
				// No row is read for NO_ROW, so there need be no views.
				writeMarks(marks, NO_VIEWS, NO_ROW, NO_ROW);
				setLayer(0, buffers, marks);
				map.triggerRepaint();
			}
		},

		remove() {
			if (buffers) destroyBuffers(buffers);
			if (marks) {
				marks.positions.destroy();
				marks.colors.destroy();
			}
			marks = null;
			buffers = null;
			layerBuffers = null;
			layerCount = -1;
		},
	};
}
