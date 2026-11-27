import { describe, expect, test } from "bun:test";
import { createInterfaceStore } from "@/lib/interface-store";
import {
	ABSENT_FRAMES_BEFORE_CLEARING,
	createSelectionSync,
	HOVER_TRACK_DELAY_MS,
	pickedId,
} from "@/lib/selection";
import type { ClientMessage } from "@/lib/socket-client";

/**
 * A stand-in for the WASM store: a picture of aircraft ids in rows, which
 * a positions frame replaces. Like the real one, a row means an aircraft
 * only until the next frame.
 */
class FakeStore {
	rows: number[] = [];
	version = 0;
	selected: number | null | undefined;
	hovered: number | null | undefined;

	/** A positions frame is taken up: these aircraft, in these rows. */
	frame(ids: number[]) {
		this.rows = ids;
		this.version += 1;
	}
	id_at(row: number) {
		return this.rows[row];
	}
	row_of(id: number) {
		const row = this.rows.indexOf(id);
		return row === -1 ? undefined : row;
	}
	rows_version() {
		return this.version;
	}
	set_selected(id?: number | null) {
		this.selected = id;
	}
	set_hovered(id?: number | null) {
		this.hovered = id;
	}
}

/** A socket client that writes only while `open`, as the real one does. */
class FakeClient {
	open = true;
	sent: ClientMessage[] = [];
	send(message: ClientMessage) {
		if (!this.open) return false;
		this.sent.push(message);
		return true;
	}
}

/** Timers that fire only when the test moves the clock. */
class FakeTimers {
	private nowMs = 0;
	private next = 1;
	private pending = new Map<number, { at: number; callback: () => void }>();
	setTimeout(callback: () => void, ms: number) {
		this.pending.set(this.next, { at: this.nowMs + ms, callback });
		return this.next++;
	}
	clearTimeout(handle: unknown) {
		this.pending.delete(handle as number);
	}
	waiting() {
		return this.pending.size;
	}
	advance(ms: number) {
		this.nowMs += ms;
		for (const [handle, timer] of [...this.pending]) {
			if (timer.at <= this.nowMs) {
				this.pending.delete(handle);
				timer.callback();
			}
		}
	}
}

function started({ open = true } = {}) {
	const interfaceStore = createInterfaceStore();
	const store = new FakeStore();
	const client = new FakeClient();
	const timers = new FakeTimers();
	client.open = open;
	if (open) interfaceStore.getState().setConnectionStatus("open");
	const selection = createSelectionSync({
		interfaceStore,
		store,
		client,
		timers,
	});
	selection.start();
	const state = () => interfaceStore.getState();
	return { interfaceStore, state, store, client, selection, timers };
}

describe("a pick", () => {
	test("is the aircraft in the row picked", () => {
		const store = new FakeStore();
		store.frame([70, 71, 72]);
		expect(pickedId(store, 0)).toBe(70);
		expect(pickedId(store, 2)).toBe(72);
	});

	test("of nothing is null", () => {
		const store = new FakeStore();
		store.frame([70, 71, 72]);
		// deck.gl reports -1 for the empty map.
		expect(pickedId(store, -1)).toBeNull();
		// A row past the picture, which the store answers with undefined.
		expect(pickedId(store, 3)).toBeNull();
		expect(pickedId(store, Number.NaN)).toBeNull();
	});

	test("names the aircraft and not the row: the same row later is another aircraft", () => {
		const store = new FakeStore();
		store.frame([70, 71, 72]);
		const picked = pickedId(store, 1);
		// 70 leaves and the last row takes its place.
		store.frame([72, 71]);
		store.frame([72, 73, 71]);
		expect(picked).toBe(71);
		expect(pickedId(store, 1)).toBe(73);
		expect(store.row_of(71)).toBe(2);
	});
});

describe("selecting", () => {
	test("tells the server and the store, and asks for the track", () => {
		const { state, store, client } = started();
		state().select(71);
		expect(client.sent).toEqual([
			{ type: "select", id: 71 },
			{ type: "track", id: 71 },
		]);
		expect(store.selected).toBe(71);
	});

	test("another aircraft replaces the first", () => {
		const { state, store, client } = started();
		state().select(71);
		client.sent = [];
		state().select(72);
		expect(client.sent).toEqual([
			{ type: "select", id: 72 },
			{ type: "track", id: 72 },
		]);
		expect(store.selected).toBe(72);
	});

	test("the same aircraft again sends nothing", () => {
		const { state, client } = started();
		state().select(71);
		client.sent = [];
		state().select(71);
		expect(client.sent).toEqual([]);
	});

	test("deselecting sends select null, and no track", () => {
		const { state, store, client } = started();
		state().select(71);
		client.sent = [];
		state().select(null);
		expect(client.sent).toEqual([{ type: "select", id: null }]);
		expect(store.selected).toBeNull();
	});

	test("the selection survives the rows being reordered", () => {
		const { state, store, client, selection } = started();
		store.frame([70, 71, 72]);
		state().select(pickedId(store, 1));
		client.sent = [];

		for (const rows of [
			[72, 71],
			[72, 73, 71],
			[71, 74, 75, 76],
		]) {
			store.frame(rows);
			selection.afterAdvance();
		}

		expect(state().selectedId).toBe(71);
		expect(store.selected).toBe(71);
		expect(client.sent).toEqual([]);
	});

	test("hover is told to the store and not to the server", () => {
		const { state, store, client } = started();
		state().hover(72);
		expect(store.hovered).toBe(72);
		state().hover(null);
		expect(store.hovered).toBeNull();
		expect(client.sent).toEqual([]);
	});

	test("after stop, nothing more is sent", () => {
		const { state, store, client, selection } = started();
		selection.stop();
		state().select(71);
		state().hover(72);
		selection.afterAdvance();
		expect(client.sent).toEqual([]);
		expect(store.selected).toBeNull();
		expect(store.hovered).toBeNull();
	});
});

describe("a new connection", () => {
	test("is sent the selection when it opens", () => {
		const { state, client } = started();
		state().select(71);
		client.sent = [];

		// The server goes away and comes back.
		client.open = false;
		state().setConnectionStatus("reconnecting");
		expect(client.sent).toEqual([]);
		client.open = true;
		state().setConnectionStatus("open");

		expect(client.sent).toEqual([
			{ type: "select", id: 71 },
			{ type: "track", id: 71 },
		]);
	});

	test("is sent a selection made while there was none", () => {
		const { state, store, client } = started({ open: false });
		state().select(71);
		// Not written: no connection. The store is told all the same.
		expect(client.sent).toEqual([]);
		expect(store.selected).toBe(71);

		client.open = true;
		state().setConnectionStatus("open");
		expect(client.sent).toEqual([
			{ type: "select", id: 71 },
			{ type: "track", id: 71 },
		]);
	});

	test("is sent the selection that stands, not one made and undone meanwhile", () => {
		const { state, client } = started();
		state().select(71);
		client.open = false;
		state().setConnectionStatus("reconnecting");
		state().select(72);
		state().select(null);
		client.sent = [];

		client.open = true;
		state().setConnectionStatus("open");
		// Nothing selected is what a new connection starts with.
		expect(client.sent).toEqual([]);
	});

	test("is sent it every time, however often the connection drops", () => {
		const { state, client } = started();
		state().select(71);
		client.sent = [];
		for (let drop = 0; drop < 3; drop += 1) {
			state().setConnectionStatus("reconnecting");
			state().setConnectionStatus("open");
		}
		expect(
			client.sent.filter((message) => message.type === "select"),
		).toHaveLength(3);
	});

	test("starting with an aircraft already selected tells the store and the server", () => {
		const interfaceStore = createInterfaceStore();
		interfaceStore.getState().setConnectionStatus("open");
		interfaceStore.getState().select(71);
		interfaceStore.getState().hover(72);
		const store = new FakeStore();
		const client = new FakeClient();
		createSelectionSync({ interfaceStore, store, client }).start();
		expect(store.selected).toBe(71);
		expect(store.hovered).toBe(72);
		expect(client.sent).toEqual([
			{ type: "select", id: 71 },
			{ type: "track", id: 71 },
		]);
	});
});

describe("when the selected aircraft leaves the picture", () => {
	test("the selection is cleared after three frames without it, and the server told", () => {
		const { state, store, client, selection } = started();
		store.frame([70, 71, 72]);
		state().select(71);
		client.sent = [];

		for (let frame = 1; frame < ABSENT_FRAMES_BEFORE_CLEARING; frame += 1) {
			store.frame([70, 72]);
			selection.afterAdvance();
			expect(state().selectedId).toBe(71);
		}
		store.frame([70, 72]);
		selection.afterAdvance();

		expect(state().selectedId).toBeNull();
		expect(store.selected).toBeNull();
		expect(client.sent).toEqual([{ type: "select", id: null }]);
	});

	test("animation frames between positions frames do not count", () => {
		const { state, store, selection } = started();
		store.frame([70, 71]);
		state().select(71);
		store.frame([70]);
		// Sixty frames a second, one positions frame.
		for (let frame = 0; frame < 600; frame += 1) selection.afterAdvance();
		expect(state().selectedId).toBe(71);
	});

	test("a frame built before the server read the select does not clear it", () => {
		const { state, store, selection } = started();
		// Selected while outside the viewport, as from a list: not in the
		// picture until the server adds it.
		store.frame([70, 72]);
		state().select(71);
		store.frame([70, 72]);
		selection.afterAdvance();
		store.frame([70, 72, 71]);
		selection.afterAdvance();
		// Back, so the count starts again: two more misses are not three.
		store.frame([70, 72]);
		selection.afterAdvance();
		store.frame([70, 72]);
		selection.afterAdvance();
		expect(state().selectedId).toBe(71);
	});

	test("it is kept while the connection is down, and through the new connection's first frames", () => {
		const { state, store, client, selection } = started();
		store.frame([70, 71]);
		state().select(71);

		// The connection drops. The socket client empties the store when the
		// new socket opens, before any frame has come.
		client.open = false;
		state().setConnectionStatus("reconnecting");
		for (let frame = 0; frame < 5; frame += 1) {
			store.frame([]);
			selection.afterAdvance();
		}
		expect(state().selectedId).toBe(71);

		// Open at the first frame, which was built before the select is sent.
		client.open = true;
		state().setConnectionStatus("open");
		store.frame([70]);
		selection.afterAdvance();
		store.frame([70, 71]);
		selection.afterAdvance();
		expect(state().selectedId).toBe(71);
	});

	test("on a new connection that does not have it, it is cleared", () => {
		const { state, store, client, selection } = started();
		store.frame([70, 71]);
		state().select(71);
		state().setConnectionStatus("reconnecting");
		state().setConnectionStatus("open");
		client.sent = [];
		for (let frame = 0; frame < ABSENT_FRAMES_BEFORE_CLEARING; frame += 1) {
			store.frame([70]);
			selection.afterAdvance();
		}
		expect(state().selectedId).toBeNull();
		expect(client.sent).toEqual([{ type: "select", id: null }]);
	});

	test("with nothing selected, nothing is looked up", () => {
		const { store, selection } = started();
		let lookups = 0;
		const rowOf = store.row_of.bind(store);
		store.row_of = (id: number) => {
			lookups += 1;
			return rowOf(id);
		};
		store.frame([70]);
		selection.afterAdvance();
		expect(lookups).toBe(0);
	});
});

describe("the hovered aircraft's track", () => {
	test("is asked for once the pointer has rested on it", () => {
		const { state, client, timers } = started();
		state().hover(7);
		expect(client.sent).toEqual([]);
		timers.advance(HOVER_TRACK_DELAY_MS - 1);
		expect(client.sent).toEqual([]);
		timers.advance(1);
		expect(client.sent).toEqual([{ type: "track", id: 7 }]);
		// And once only, however long it stays hovered.
		timers.advance(10_000);
		expect(client.sent).toHaveLength(1);
	});

	test("a pointer crossing the map asks for nothing", () => {
		const { state, client, timers } = started();
		for (const id of [1, 2, 3, 4, 5]) {
			state().hover(id);
			timers.advance(HOVER_TRACK_DELAY_MS - 10);
		}
		state().hover(null);
		timers.advance(10_000);
		expect(client.sent).toEqual([]);
		expect(timers.waiting()).toBe(0);
	});

	test("only the aircraft the pointer came to rest on is asked for", () => {
		const { state, client, timers } = started();
		state().hover(1);
		timers.advance(20);
		state().hover(2);
		timers.advance(HOVER_TRACK_DELAY_MS);
		expect(client.sent).toEqual([{ type: "track", id: 2 }]);
	});

	test("the selected aircraft is not asked for again when hovered", () => {
		const { state, client, timers } = started();
		state().select(7);
		client.sent = [];
		state().hover(7);
		timers.advance(10_000);
		expect(client.sent).toEqual([]);
	});

	test("clicking the hovered aircraft asks once, not twice", () => {
		const { state, client, timers } = started();
		state().hover(7);
		timers.advance(20);
		state().select(7);
		timers.advance(10_000);
		expect(client.sent).toEqual([
			{ type: "select", id: 7 },
			{ type: "track", id: 7 },
		]);
	});

	test("the store is told at once, without the wait", () => {
		const { state, store } = started();
		state().hover(7);
		expect(store.hovered).toBe(7);
		state().hover(null);
		expect(store.hovered).toBeNull();
	});

	test("a new connection is asked for the aircraft still hovered", () => {
		const { state, client, timers } = started();
		state().hover(7);
		timers.advance(HOVER_TRACK_DELAY_MS);
		client.sent = [];

		state().setConnectionStatus("reconnecting");
		client.open = false;
		timers.advance(1_000);
		expect(client.sent).toEqual([]);

		client.open = true;
		state().setConnectionStatus("open");
		timers.advance(HOVER_TRACK_DELAY_MS);
		expect(client.sent).toEqual([{ type: "track", id: 7 }]);
	});

	test("nothing is asked for after stop", () => {
		const { state, client, selection, timers } = started();
		state().hover(7);
		selection.stop();
		timers.advance(10_000);
		expect(client.sent).toEqual([]);
		expect(timers.waiting()).toBe(0);
	});
});
