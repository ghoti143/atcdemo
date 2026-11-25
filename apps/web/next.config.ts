import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactCompiler: true,
	turbopack: {
		// The WASM package is built into packages/atc-wasm at the repo root.
		// Turbopack resolves nothing outside its root, so the root is the repo.
		root: path.join(import.meta.dirname, "../.."),
	},
	// Next.js leaves `pg` out of the server bundle and loads it at run time
	// through a hashed alias under .next/node_modules. Under `next dev` on
	// Bun 1.4.5 that alias does not resolve, and every database call fails
	// with "Cannot find package 'pg-<hash>'". Listing it here bundles it
	// instead. A production build was not seen to need this.
	transpilePackages: ["pg"],
};

export default nextConfig;
