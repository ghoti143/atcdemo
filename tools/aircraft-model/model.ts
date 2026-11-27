// A low-poly airliner, built from a few slabs and written as a binary
// glTF (GLB). The project's own work, so it is under the project's MIT
// licence and nothing has to be credited. tools/bake-aircraft-model.ts
// writes it to apps/web/public/models/aircraft.glb.
//
// The frame is deck.gl's, not glTF's usual one: x east, y north, z up, so
// the layer draws it without a rotation to stand it up. The nose points
// along +y and the whole aircraft is one unit long, nose to tail, so the
// layer's `sizeScale` is its length in metres.
//
// The flat lighting deck.gl's ScenegraphLayer uses colours every pixel the
// same: the instance colour, times the base colour texture if there is
// one. So each face samples a texel of a strip of greys chosen by which
// way the face looks, and the altitude band's colour comes out shaded.

import { crc32, deflateSync } from "node:zlib";

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
	const length = Math.hypot(a[0], a[1], a[2]);
	return [a[0] / length, a[1] / length, a[2] / length];
};

/** How many greys the shading strip has. */
export const SHADES = 8;
/** The light the shading is baked for: from above, ahead and to the right. */
const LIGHT = unit([0.35, 0.45, 0.82]);
/** The darkest a face can be, so the band's colour still reads. */
const DARKEST = 0.5;

/** A face's grey, by which way it looks: 0 the darkest, SHADES − 1 the lightest. */
export function shadeOf(normal: Vec3): number {
	const lit = Math.max(0, dot(unit(normal), LIGHT));
	return Math.min(SHADES - 1, Math.round(lit * (SHADES - 1)));
}

export type Mesh = {
	/** Three floats a vertex; three vertices a triangle. */
	positions: number[];
	/** Two floats a vertex: where in the shading strip. */
	uvs: number[];
	/**
	 * Three floats a vertex: the face's outward normal. The flat lighting
	 * does not read them; luma.gl warns when a model has none.
	 */
	normals: number[];
};

/**
 * A closed solid between a face and the same face moved by `depth`: a
 * slab. `face` is a convex polygon. Every triangle is wound so that it
 * faces out, which is checked against the slab's centre.
 */
function slab(mesh: Mesh, face: Vec3[], depth: Vec3) {
	const back = face.map(
		(p): Vec3 => [p[0] + depth[0], p[1] + depth[1], p[2] + depth[2]],
	);
	const all = [...face, ...back];
	const centre = all
		.reduce(
			(sum, p): Vec3 => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]],
			[0, 0, 0],
		)
		.map((value) => value / all.length) as Vec3;
	const polygons: Vec3[][] = [face, [...back].reverse()];
	for (let i = 0; i < face.length; i++) {
		const j = (i + 1) % face.length;
		polygons.push([face[i], face[j], back[j], back[i]]);
	}
	for (const polygon of polygons) addPolygon(mesh, polygon, centre);
}

/**
 * A closed solid whose cross-sections, each a rectangle across x and z at
 * some y, are joined in order: the fuselage. Each section is
 * [y, half width, bottom z, top z].
 */
function loft(mesh: Mesh, sections: [number, number, number, number][]) {
	const corners = ([y, w, low, high]: [
		number,
		number,
		number,
		number,
	]): Vec3[] => [
		[-w, y, low],
		[w, y, low],
		[w, y, high],
		[-w, y, high],
	];
	const rings = sections.map(corners);
	const all = rings.flat();
	const centre = all
		.reduce(
			(sum, p): Vec3 => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]],
			[0, 0, 0],
		)
		.map((value) => value / all.length) as Vec3;
	for (let s = 0; s + 1 < rings.length; s++) {
		const a = rings[s];
		const b = rings[s + 1];
		for (let i = 0; i < 4; i++) {
			const j = (i + 1) % 4;
			// Each side of each stretch is its own outward test: a section's
			// centre, not the whole fuselage's, since the fuselage is long.
			const local = [...a, ...b]
				.reduce(
					(sum, p): Vec3 => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]],
					[0, 0, 0],
				)
				.map((value) => value / 8) as Vec3;
			addPolygon(mesh, [a[i], a[j], b[j], b[i]], local);
		}
	}
	addPolygon(mesh, rings[0], centre);
	addPolygon(mesh, rings[rings.length - 1], centre);
}

/** Adds a convex polygon as a fan of triangles, wound to face away from `inside`. */
function addPolygon(mesh: Mesh, polygon: Vec3[], inside: Vec3) {
	let normal = cross(sub(polygon[1], polygon[0]), sub(polygon[2], polygon[0]));
	// A polygon whose first three corners are in a line: use the next.
	for (let k = 3; Math.hypot(...normal) < 1e-12 && k < polygon.length; k++) {
		normal = cross(sub(polygon[1], polygon[0]), sub(polygon[k], polygon[0]));
	}
	if (Math.hypot(...normal) < 1e-12) return;
	const middle = polygon
		.reduce(
			(sum, p): Vec3 => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]],
			[0, 0, 0],
		)
		.map((value) => value / polygon.length) as Vec3;
	const ordered =
		dot(normal, sub(middle, inside)) >= 0 ? polygon : [...polygon].reverse();
	const facing =
		dot(normal, sub(middle, inside)) >= 0
			? normal
			: (normal.map((v) => -v) as Vec3);
	const u = (shadeOf(facing) + 0.5) / SHADES;
	const n = unit(facing);
	for (let i = 1; i + 1 < ordered.length; i++) {
		for (const p of [ordered[0], ordered[i], ordered[i + 1]]) {
			mesh.positions.push(p[0], p[1], p[2]);
			mesh.uvs.push(u, 0.5);
			mesh.normals.push(n[0], n[1], n[2]);
		}
	}
}

/** The airliner, one unit long, nose along +y, z up, centred on its middle. */
export function buildAircraft(): Mesh {
	const mesh: Mesh = { positions: [], uvs: [], normals: [] };
	// Fuselage: tail cone, cabin, nose.
	loft(mesh, [
		[-0.5, 0.012, 0.012, 0.042],
		[-0.38, 0.044, -0.03, 0.045],
		[0.36, 0.044, -0.04, 0.04],
		[0.46, 0.026, -0.03, 0.022],
		[0.5, 0.006, -0.012, 0.004],
	]);
	// Wings, swept back, a little below the middle.
	for (const side of [-1, 1]) {
		slab(
			mesh,
			[
				[side * 0.04, 0.13, -0.022],
				[side * 0.48, -0.15, -0.006],
				[side * 0.48, -0.21, -0.006],
				[side * 0.04, -0.07, -0.022],
			],
			[0, 0, 0.012],
		);
		// Tailplane.
		slab(
			mesh,
			[
				[side * 0.015, -0.34, 0.018],
				[side * 0.17, -0.44, 0.024],
				[side * 0.17, -0.49, 0.024],
				[side * 0.015, -0.47, 0.018],
			],
			[0, 0, 0.008],
		);
		// Engines under the wings.
		slab(
			mesh,
			[
				[side * 0.17, 0.07, -0.05],
				[side * 0.2, 0.07, -0.05],
				[side * 0.2, -0.04, -0.05],
				[side * 0.17, -0.04, -0.05],
			],
			[0, 0, 0.028],
		);
	}
	// Fin.
	slab(
		mesh,
		[
			[-0.005, -0.3, 0.04],
			[-0.005, -0.44, 0.19],
			[-0.005, -0.51, 0.19],
			[-0.005, -0.49, 0.04],
		],
		[0.01, 0, 0],
	);
	return mesh;
}

/** The shading strip as a PNG: SHADES texels wide, one high, darkest first. */
export function shadingPng(): Uint8Array {
	const width = SHADES;
	const row = new Uint8Array(1 + width * 4);
	row[0] = 0; // no filter
	for (let i = 0; i < width; i++) {
		const grey = Math.round(
			255 * (DARKEST + ((1 - DARKEST) * i) / (SHADES - 1)),
		);
		row.set([grey, grey, grey, 255], 1 + i * 4);
	}
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		out.set(new TextEncoder().encode(type), 4);
		out.set(data, 8);
		view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
		return out;
	};
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, 1);
	header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, no filter, no interlace
	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(row, { level: 9 }))),
		chunk("IEND", new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}

const pad = (length: number) => (4 - (length % 4)) % 4;

/** The mesh, with the shading strip in it, as a GLB. */
export function toGlb(mesh: Mesh): Uint8Array {
	const count = mesh.positions.length / 3;
	const positions = new Float32Array(mesh.positions);
	const uvs = new Float32Array(mesh.uvs);
	const normals = new Float32Array(mesh.normals);
	const png = shadingPng();
	const min = [0, 1, 2].map((axis) => {
		let least = Number.POSITIVE_INFINITY;
		for (let i = axis; i < positions.length; i += 3)
			least = Math.min(least, positions[i]);
		return least;
	});
	const max = [0, 1, 2].map((axis) => {
		let most = Number.NEGATIVE_INFINITY;
		for (let i = axis; i < positions.length; i += 3)
			most = Math.max(most, positions[i]);
		return most;
	});

	const normalsOffset = positions.byteLength + uvs.byteLength;
	const pngOffset = normalsOffset + normals.byteLength;
	const binLength = pngOffset + png.length;
	const json = {
		asset: {
			version: "2.0",
			generator: "atcdemo tools/bake-aircraft-model.ts",
			copyright: "atcdemo contributors, MIT licence",
		},
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ name: "aircraft", mesh: 0 }],
		meshes: [
			{
				name: "aircraft",
				primitives: [
					{
						attributes: { POSITION: 0, TEXCOORD_0: 1, NORMAL: 2 },
						material: 0,
						mode: 4,
					},
				],
			},
		],
		materials: [
			{
				name: "shaded",
				pbrMetallicRoughness: {
					baseColorTexture: { index: 0 },
					metallicFactor: 0,
					roughnessFactor: 1,
				},
				doubleSided: true,
			},
		],
		textures: [{ sampler: 0, source: 0 }],
		// Nearest, and clamped: each face takes exactly one grey.
		samplers: [
			{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 },
		],
		images: [{ bufferView: 2, mimeType: "image/png" }],
		buffers: [{ byteLength: binLength }],
		bufferViews: [
			{
				buffer: 0,
				byteOffset: 0,
				byteLength: positions.byteLength,
				target: 34962,
			},
			{
				buffer: 0,
				byteOffset: positions.byteLength,
				byteLength: uvs.byteLength,
				target: 34962,
			},
			{ buffer: 0, byteOffset: pngOffset, byteLength: png.length },
			{
				buffer: 0,
				byteOffset: normalsOffset,
				byteLength: normals.byteLength,
				target: 34962,
			},
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
			{ bufferView: 1, componentType: 5126, count, type: "VEC2" },
			// The normals: accessor 2, buffer view 3, since view 2 is the image.
			{ bufferView: 3, componentType: 5126, count, type: "VEC3" },
		],
	};
	const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
	const jsonLength = jsonBytes.length + pad(jsonBytes.length);
	const binPadded = binLength + pad(binLength);
	const total = 12 + 8 + jsonLength + 8 + binPadded;
	const glb = new Uint8Array(total);
	const view = new DataView(glb.buffer);
	view.setUint32(0, 0x46546c67, true); // "glTF"
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonLength, true);
	view.setUint32(16, 0x4e4f534a, true); // "JSON"
	glb.set(jsonBytes, 20);
	glb.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
	const bin = 20 + jsonLength;
	view.setUint32(bin, binPadded, true);
	view.setUint32(bin + 4, 0x004e4942, true); // "BIN\0"
	glb.set(new Uint8Array(positions.buffer), bin + 8);
	glb.set(new Uint8Array(uvs.buffer), bin + 8 + positions.byteLength);
	glb.set(new Uint8Array(normals.buffer), bin + 8 + normalsOffset);
	glb.set(png, bin + 8 + pngOffset);
	return glb;
}
