import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlightList as FlightListData } from "@/lib/flight-list";
import { COLUMNS, FlightList, nextSort } from "./flight-list";

// Rendered to a string, as the server would: the virtualiser has no element
// to measure, so no rows are drawn. Rows are looked at in a browser.

function listOf(count: number): FlightListData {
	const snapshot = { count, version: 1, refreshMs: 0 };
	return {
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
		row: () => null,
		idAt: () => null,
		indexOf: () => -1,
		refresh() {},
	};
}

describe("FlightList", () => {
	test("has the filter box and a heading for each column", () => {
		const html = renderToStaticMarkup(<FlightList list={listOf(0)} />);
		expect(html).toContain('data-slot="flight-list-filter"');
		for (const column of COLUMNS) {
			expect(html).toContain(`data-key="${column.key}"`);
		}
		expect(html.match(/data-slot="flight-list-sort"/g)).toHaveLength(5);
	});

	test("says which column it is sorted by, and which way", () => {
		const html = renderToStaticMarkup(<FlightList list={listOf(0)} />);
		expect(html).toContain('aria-label="Callsign, sorted ascending"');
		expect(html).toContain('data-sorted="ascending"');
		expect(html).toContain('aria-label="Sort by altitude in feet"');
	});

	test("on the server it is empty, whatever the list holds", () => {
		const html = renderToStaticMarkup(<FlightList list={listOf(60_000)} />);
		expect(html).toContain("No aircraft in the picture.");
		expect(html).not.toContain('data-slot="flight-row"');
	});
});

describe("nextSort", () => {
	const [callsign, , altitude] = COLUMNS;

	test("a click on another column sorts by it, numbers from the largest", () => {
		const current = { key: "callsign", descending: false } as const;
		expect(nextSort(current, altitude)).toEqual({
			key: "altitude",
			descending: true,
		});
		expect(nextSort({ key: "altitude", descending: true }, callsign)).toEqual({
			key: "callsign",
			descending: false,
		});
	});

	test("a click on the sorted column turns it round", () => {
		expect(nextSort({ key: "altitude", descending: true }, altitude)).toEqual({
			key: "altitude",
			descending: false,
		});
		expect(nextSort({ key: "altitude", descending: false }, altitude)).toEqual({
			key: "altitude",
			descending: true,
		});
	});
});
