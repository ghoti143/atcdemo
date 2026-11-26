/**
 * Where the socket to `atc-server` stands, as the interface shows it. The
 * socket client (lib/socket-client.ts) writes it.
 *
 * - `connecting`: no frame has arrived since the page loaded. The client is
 *   making its first attempt, or retrying one that failed.
 * - `open`: connected and receiving frames. Set by the first frame of a
 *   connection, not by the socket opening.
 * - `reconnecting`: the connection dropped and the client is retrying with
 *   backoff; the last picture is still on screen.
 * - `closed`: the client has stopped trying. `ConnectionClosedReason` says
 *   why.
 */
export const CONNECTION_STATUSES = [
	"connecting",
	"open",
	"reconnecting",
	"closed",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * Why the client stopped trying.
 *
 * - `unreachable`: every retry failed. Trying again may work.
 * - `protocol-mismatch`: the server speaks another protocol version than
 *   the page's WASM module (close code 4001). Trying again cannot work;
 *   loading the page again fetches the current module.
 */
export type ConnectionClosedReason = "unreachable" | "protocol-mismatch";
