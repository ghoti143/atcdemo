import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactCompiler: true,
	turbopack: {
		// The WASM package is built into packages/atc-wasm at the repo root.
		// Turbopack resolves nothing outside its root, so the root is the repo.
		root: path.join(import.meta.dirname, "../.."),
	},
};

export default nextConfig;
