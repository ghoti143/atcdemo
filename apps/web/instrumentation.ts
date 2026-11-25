// Called once when the server starts, before it accepts a request. The check
// lives in its own module, imported only on the server runtime, because it
// ends the process and the Edge runtime has no process to end.
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { checkEnv } = await import("./lib/check-env");
		checkEnv();
	}
}
