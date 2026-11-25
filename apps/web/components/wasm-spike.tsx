"use client";

import { useEffect, useState } from "react";

type Reading = {
	protocolVersion: number;
	count: number;
	sum: number;
};

const COUNT = 1000;

async function readFromWasm(): Promise<Reading> {
	// Loaded here, not at the top of the file, so the module and its .wasm
	// file are fetched only in the browser and never during prerendering.
	const wasm = await import("atc-wasm");
	const { memory } = await wasm.default();

	const buffer = new wasm.SpikeBuffer(COUNT);
	try {
		buffer.fill(0.5);
		// A view straight over WASM memory: no copy. It must be built after
		// the last allocation, because growing memory detaches older views.
		const view = new Float32Array(memory.buffer, buffer.ptr(), buffer.count());
		let sum = 0;
		for (const value of view) {
			sum += value;
		}
		return {
			protocolVersion: wasm.protocol_version(),
			count: view.length,
			sum,
		};
	} finally {
		buffer.free();
	}
}

export function WasmSpike() {
	const [reading, setReading] = useState<Reading | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		readFromWasm().then(
			(result) => {
				if (!cancelled) setReading(result);
			},
			(cause: unknown) => {
				if (!cancelled) setError(String(cause));
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	if (error) {
		return <p className="text-destructive">WASM failed to load: {error}</p>;
	}
	if (!reading) {
		return <p>Loading WASM…</p>;
	}
	return (
		<p data-testid="wasm-spike">
			WASM protocol v{reading.protocolVersion}; sum of {reading.count} values
			read from WASM memory: {reading.sum}
		</p>
	);
}
