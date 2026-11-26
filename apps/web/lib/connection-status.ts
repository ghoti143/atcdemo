/**
 * Where the socket to `atc-server` stands, as the interface shows it.
 *
 * - `connecting`: the first attempt of this page load; no frame has arrived.
 * - `open`: connected and receiving frames.
 * - `reconnecting`: the connection dropped and the client is retrying with
 *   backoff; the last picture is still on screen.
 * - `closed`: the client has stopped trying.
 */
export const CONNECTION_STATUSES = [
	"connecting",
	"open",
	"reconnecting",
	"closed",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
