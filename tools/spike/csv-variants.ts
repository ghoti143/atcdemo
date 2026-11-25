// Milestone 2 spike (issue #10): from one shard of adsb-coverage.ts's CSV
// output, prints the gzipped size of the CSV for shorter windows, wider
// spacing and delta-encoded arrays. Sum the shards for the total.
//
//   bun tools/spike/csv-variants.ts <out dir> <candidate> <shard>

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
const delta = (v: string[], scale: number) => {
	let p = 0;
	return v
		.map((x) => {
			const n = Math.round(Number(x) * scale);
			const d = n - p;
			p = n;
			return d;
		})
		.join(" ");
};
const res: Record<string, number> = {};
for (const hours of [1.5, 2, 3, 4, 5])
	for (const step of [1, 2, 3])
		for (const enc of ["plain", "delta"]) {
			const limit = hours * 360;
			const rowsOut: string[] = [];
			for (const f of lines) {
				const first = Number(f[5]) / 10;
				if (first >= limit) continue;
				const keep = Math.min(limit - first, f[12].length);
				if (keep < 6) continue;
				const cut = (s: string) =>
					s
						.split(" ")
						.slice(0, keep)
						.filter((_, i) => i % step === 0);
				const cols = [6, 7, 8, 9, 10, 11].map((i) => cut(f[i]));
				const g = [...f[12].slice(0, keep)]
					.filter((_, i) => i % step === 0)
					.join("");
				const scales = [1e5, 1e5, 1 / 25, 1, 1, 1 / 64];
				rowsOut.push(
					[
						...f.slice(0, 6),
						...cols.map((c, i) =>
							enc === "delta" ? delta(c, scales[i]) : c.join(" "),
						),
						g,
					].join(","),
				);
			}
			res[`${hours}h ${step * 10}s ${enc}`] = gzipSync(rowsOut.join("\n"), {
				level: 9,
			}).length;
		}
console.log(JSON.stringify(res));
