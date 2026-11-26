/** The loaded WASM module, ready to call. */
export type AtcWasm = {
	module: typeof import("atc-wasm");
	/** WASM linear memory, for typed-array views over the aircraft store. */
	memory: WebAssembly.Memory;
	/** The wire protocol version the module speaks. */
	protocolVersion: number;
};

export type WasmLoader = () => Promise<AtcWasm>;

let loading: Promise<AtcWasm> | undefined;

/**
 * Fetches and instantiates the WASM module, once per page. Every caller
 * gets the same instance. A failed attempt is forgotten, so calling again
 * tries again.
 *
 * Browser only: call it from an effect or an event handler, never while
 * rendering, so nothing WASM-related runs during prerendering.
 */
export const loadAtcWasm: WasmLoader = () => {
	loading ??= instantiate().catch((cause: unknown) => {
		loading = undefined;
		throw cause;
	});
	return loading;
};

async function instantiate(): Promise<AtcWasm> {
	// Imported here, not at the top of the file, so the module and its .wasm
	// file are fetched only in the browser.
	const module = await import("atc-wasm");
	const { memory } = await module.default();
	return { module, memory, protocolVersion: module.protocol_version() };
}
