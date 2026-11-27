import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
	buildAircraft,
	SHADES,
	shadeOf,
	shadingPng,
	toGlb,
} from "./aircraft-model/model";
import { MODEL_FILE } from "./bake-aircraft-model";

type Gltf = {
	asset: { version: string };
	meshes: {
		primitives: { attributes: Record<string, number>; mode: number }[];
	}[];
	accessors: {
		bufferView: number;
		count: number;
		type: string;
		min?: number[];
		max?: number[];
	}[];
	bufferViews: { byteOffset: number; byteLength: number }[];
	images: { bufferView: number; mimeType: string }[];
	samplers: { magFilter: number; minFilter: number }[];
};

/** Reads a GLB as a viewer would: the header, then the two chunks. */
function readGlb(glb: Uint8Array) {
	const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	expect(view.getUint32(0, true)).toBe(0x46546c67);
	expect(view.getUint32(4, true)).toBe(2);
	expect(view.getUint32(8, true)).toBe(glb.length);
	const jsonLength = view.getUint32(12, true);
	expect(view.getUint32(16, true)).toBe(0x4e4f534a);
	expect(jsonLength % 4).toBe(0);
	const json = JSON.parse(
		new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)),
	) as Gltf;
	const bin = 20 + jsonLength;
	const binLength = view.getUint32(bin, true);
	expect(view.getUint32(bin + 4, true)).toBe(0x004e4942);
	expect(bin + 8 + binLength).toBe(glb.length);
	const body = glb.slice(bin + 8, bin + 8 + binLength);
	const floats = (accessor: number) => {
		const { bufferView, count, type } = json.accessors[accessor];
		const { byteOffset } = json.bufferViews[bufferView];
		const size = type === "VEC3" ? 3 : 2;
		return new Float32Array(body.buffer, byteOffset, count * size);
	};
	return { json, body, floats };
}

const glb = toGlb(buildAircraft());
const { json, body, floats } = readGlb(glb);
const primitive = json.meshes[0].primitives[0];
const positions = floats(primitive.attributes.POSITION);
const uvs = floats(primitive.attributes.TEXCOORD_0);
const normals = floats(primitive.attributes.NORMAL);
const vertex = (i: number): [number, number, number] => [
	positions[i * 3],
	positions[i * 3 + 1],
	positions[i * 3 + 2],
];

describe("the model file", () => {
	test("is a GLB of glTF 2.0 with one primitive of triangles and a texture", () => {
		expect(json.asset.version).toBe("2.0");
		expect(primitive.mode).toBe(4);
		expect(positions.length % 9).toBe(0);
		expect(uvs.length / 2).toBe(positions.length / 3);
		expect(json.images[0].mimeType).toBe("image/png");
		// Nearest: a face takes one grey, not a blend of two.
		expect(json.samplers[0]).toMatchObject({
			magFilter: 9728,
			minFilter: 9728,
		});
	});

	test("is small", () => {
		expect(glb.length).toBeLessThan(20_000);
		expect(positions.length / 9).toBeLessThan(400);
	});

	test("the committed file is what the bake writes", () => {
		expect([...readFileSync(MODEL_FILE)]).toEqual([...glb]);
	});
});

describe("the shape", () => {
	test("is one unit long, nose along +y, wider than tall, in deck.gl's frame (z up)", () => {
		const { min, max } = json.accessors[primitive.attributes.POSITION];
		expect(min?.[1]).toBeCloseTo(-0.51, 5);
		expect(max?.[1]).toBeCloseTo(0.5, 5);
		const span = (max?.[0] ?? 0) - (min?.[0] ?? 0);
		const height = (max?.[2] ?? 0) - (min?.[2] ?? 0);
		expect(span).toBeGreaterThan(0.9);
		expect(height).toBeLessThan(0.3);
		// The fin stands up, along +z, at the back.
		let highest = 0;
		for (let i = 0; i < positions.length / 3; i++) {
			if (vertex(i)[2] > vertex(highest)[2]) highest = i;
		}
		expect(vertex(highest)[1]).toBeLessThan(-0.4);
		// The nose is the point farthest along +y, on the centre line.
		let nose = 0;
		for (let i = 0; i < positions.length / 3; i++) {
			if (vertex(i)[1] > vertex(nose)[1]) nose = i;
		}
		expect(Math.abs(vertex(nose)[0])).toBeLessThan(0.01);
	});

	test("is mirror-symmetric across x = 0", () => {
		const key = ([x, y, z]: number[]) =>
			`${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
		const points = new Set<string>();
		for (let i = 0; i < positions.length / 3; i++) points.add(key(vertex(i)));
		for (const point of points) {
			const [x, y, z] = point.split(",").map(Number);
			// The fin is a slab 0.01 thick from x = -0.005: its own mirror.
			expect(points.has(key([-x, y, z]))).toBe(true);
		}
	});

	test("every vertex has a unit normal that agrees with its triangle's winding", () => {
		expect(normals.length).toBe(positions.length);
		for (let t = 0; t < positions.length / 9; t++) {
			const [a, b, c] = [vertex(t * 3), vertex(t * 3 + 1), vertex(t * 3 + 2)];
			const cross = [
				(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
				(b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
				(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
			];
			for (let k = 0; k < 3; k++) {
				const at = (t * 3 + k) * 3;
				const n = [normals[at], normals[at + 1], normals[at + 2]];
				expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
				expect(
					n[0] * cross[0] + n[1] * cross[1] + n[2] * cross[2],
				).toBeGreaterThan(0);
			}
		}
	});

	test("every solid is closed and every face looks outwards", () => {
		// In a closed, consistently wound surface each edge a→b is matched by
		// one b→a. Solids that overlap share no edge, so this holds for all.
		const key = (a: number, b: number) =>
			`${vertex(a).map((v) => v.toFixed(6))}>${vertex(b).map((v) => v.toFixed(6))}`;
		const edges = new Map<string, number>();
		for (let t = 0; t < positions.length / 9; t++) {
			for (let k = 0; k < 3; k++) {
				const id = key(t * 3 + k, t * 3 + ((k + 1) % 3));
				edges.set(id, (edges.get(id) ?? 0) + 1);
			}
		}
		for (const [id, count] of edges) {
			const [a, b] = id.split(">");
			expect(edges.get(`${b}>${a}`)).toBe(count);
		}
		// Outwards: the volume the triangles enclose is positive.
		let volume = 0;
		for (let t = 0; t < positions.length / 9; t++) {
			const [a, b, c] = [vertex(t * 3), vertex(t * 3 + 1), vertex(t * 3 + 2)];
			volume +=
				(a[0] * (b[1] * c[2] - b[2] * c[1]) -
					a[1] * (b[0] * c[2] - b[2] * c[0]) +
					a[2] * (b[0] * c[1] - b[1] * c[0])) /
				6;
		}
		expect(volume).toBeGreaterThan(0);
	});
});

describe("the shading", () => {
	test("faces that look up are lighter than faces that look down", () => {
		expect(shadeOf([0, 0, 1])).toBeGreaterThan(shadeOf([1, 0, 0]));
		expect(shadeOf([0, 0, -1])).toBe(0);
		expect(shadeOf([0, 0, 1])).toBeLessThanOrEqual(SHADES - 1);
	});

	test("every face samples the middle of one texel", () => {
		for (let i = 0; i < uvs.length; i += 2) {
			const texel = uvs[i] * SHADES - 0.5;
			expect(Math.abs(texel - Math.round(texel))).toBeLessThan(1e-5);
			expect(uvs[i + 1]).toBe(0.5);
		}
	});

	test("the strip is a PNG of greys from half to full, darkest first", () => {
		const png = shadingPng();
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const view = new DataView(png.buffer);
		expect(view.getUint32(16)).toBe(SHADES);
		expect(view.getUint32(20)).toBe(1);
		const idatLength = view.getUint32(33);
		const pixels = inflateSync(png.subarray(41, 41 + idatLength));
		expect(pixels[0]).toBe(0);
		expect(pixels[1]).toBe(128);
		expect(pixels[1 + (SHADES - 1) * 4]).toBe(255);
		// The image in the GLB is this strip.
		const image = json.bufferViews[json.images[0].bufferView];
		expect([
			...body.subarray(image.byteOffset, image.byteOffset + image.byteLength),
		]).toEqual([...png]);
	});
});
