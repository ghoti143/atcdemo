// Milestone 2 spike (issue #10): re-encodes one shard of adsb-coverage.ts's
// CSV output in three binary layouts and prints the size of each, raw, with
// gzip and with zstd, for 2 to 5 hour windows. Sum the shards for the total.
//
//   bun tools/spike/seed-formats.ts <out dir> <candidate> <shard>
//
// fixed:  every value at a fixed width
// delta:  every value as the difference from the one before, as a varint
// delta2: the same, with lat and lon as the difference between differences

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
const [out, cand, shard] = process.argv.slice(2);
const text = gunzipSync(
	readFileSync(`${out}/flights-${cand}-${shard}.csv.gz`),
).toString();
const lines = text
	.split("\n")
	.filter(Boolean)
	.map((l) => l.split(","));
class W {
	b = new Uint8Array(1 << 20);
	n = 0;
	grow(k: number) {
		if (this.n + k > this.b.length) {
			const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k));
			nb.set(this.b);
			this.b = nb;
		}
	}
	u8(v: number) {
		this.grow(1);
		this.b[this.n++] = v & 255;
	}
	varint(v: number) {
		let z = v < 0 ? -2 * v - 1 : 2 * v;
		this.grow(8);
		while (z >= 128) {
			this.b[this.n++] = (z % 128) | 128;
			z = Math.floor(z / 128);
		}
		this.b[this.n++] = z;
	}
	fixed(v: number, bytes: number) {
		this.grow(bytes);
		for (let i = 0; i < bytes; i++) this.b[this.n++] = (v >> (8 * i)) & 255;
	}
	str(s: string) {
		this.varint(s.length);
		for (const c of s) this.u8(c.charCodeAt(0));
	}
	done() {
		return this.b.subarray(0, this.n);
	}
}
const scales = [1e5, 1e5, 1 / 25, 1, 1, 1 / 64];
const widths = [4, 4, 2, 2, 2, 1];
const res: Record<string, number> = {};
for (const hours of [2, 3, 4, 5]) {
	const limit = hours * 360;
	// one writer per column so like values sit together
	const mk = () => Array.from({ length: 8 }, () => new W());
	const fixed = mk(),
		d1 = mk(),
		d2 = mk();
	let samples = 0,
		flights = 0;
	for (const f of lines) {
		const first = Number(f[5]) / 10;
		if (first >= limit) continue;
		const keep = Math.min(limit - first, f[12].length);
		if (keep < 6) continue;
		flights++;
		samples += keep;
		for (const w of [fixed, d1, d2]) {
			w[7].str(f[0]);
			w[7].str(f[1]);
			w[7].str(f[2]);
			w[7].varint(first);
			w[7].varint(keep);
		}
		for (let c = 0; c < 6; c++) {
			const v = f[6 + c]
				.split(" ")
				.slice(0, keep)
				.map((x) => Math.round(Number(x) * scales[c]));
			let p = 0,
				pd = 0;
			for (const x of v) {
				fixed[c].fixed(x, widths[c]);
				const d = c === 4 ? ((x - p + 540) % 360) - 180 : x - p;
				d1[c].varint(d);
				// second difference for position: constant velocity becomes zeros
				d2[c].varint(c < 2 ? d - pd : d);
				p = x;
				pd = d;
			}
		}
		for (const w of [fixed, d1, d2])
			for (let i = 0; i < keep; i += 8) {
				let b = 0;
				for (let j = 0; j < 8 && i + j < keep; j++)
					if (f[12][i + j] === "1") b |= 1 << j;
				w[6].u8(b);
			}
	}
	for (const [name, w] of [
		["fixed", fixed],
		["delta", d1],
		["delta2", d2],
	] as const) {
		const raw = Buffer.concat(w.map((x) => x.done()));
		res[`${hours}h ${name} raw`] = raw.length;
		res[`${hours}h ${name} gzip`] = gzipSync(raw, { level: 9 }).length;
		res[`${hours}h ${name} zstd`] = Bun.zstdCompressSync(raw, {
			level: 19,
		}).length;
	}
	res[`${hours}h samples`] = samples;
	res[`${hours}h flights`] = flights;
}
console.log(JSON.stringify(res));
