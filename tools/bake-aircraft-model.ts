// Writes the aircraft model the 3D map draws at close zoom.
//
//   bun run bake:model
//
// tools/aircraft-model/model.ts builds it; the same code always gives the
// same bytes, and a test checks the committed file against it.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildAircraft, toGlb } from "./aircraft-model/model";

export const MODEL_FILE = join(
	import.meta.dir,
	"../apps/web/public/models/aircraft.glb",
);

if (import.meta.main) {
	const mesh = buildAircraft();
	const glb = toGlb(mesh);
	mkdirSync(dirname(MODEL_FILE), { recursive: true });
	writeFileSync(MODEL_FILE, glb);
	console.log(
		`${MODEL_FILE}: ${mesh.positions.length / 9} triangles, ${glb.length} bytes`,
	);
}
