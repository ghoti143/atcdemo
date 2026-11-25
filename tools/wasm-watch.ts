// Rebuilds packages/atc-wasm whenever the Rust source behind it changes.
// Run it with `bun run wasm:watch` beside `bun dev`; Next.js serves the rebuilt
// module on the next page load.

import { watch } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const watched = ["crates/atc-core", "crates/atc-wasm"];
const DEBOUNCE_MS = 200;

let running = false;
let queued = false;
let timer: Timer | undefined;

async function build(): Promise<void> {
	if (running) {
		// A change arrived mid-build. Build once more when this one ends.
		queued = true;
		return;
	}
	running = true;
	const started = performance.now();
	const child = Bun.spawn(["bun", "run", "wasm:build"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	console.log(
		code === 0
			? `[wasm:watch] built in ${seconds} s`
			: `[wasm:watch] build failed (exit ${code}); waiting for changes`,
	);
	running = false;
	if (queued) {
		queued = false;
		await build();
	}
}

for (const dir of watched) {
	watch(path.join(root, dir), { recursive: true }, (_event, filename) => {
		if (!filename?.endsWith(".rs") && !filename?.endsWith("Cargo.toml")) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(build, DEBOUNCE_MS);
	});
}

console.log(`[wasm:watch] watching ${watched.join(", ")}`);
await build();
