"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type {
	FlightList as FlightListData,
	FlightRow,
} from "@/lib/flight-list";
import {
	formatAltitude,
	formatSpeed,
	formatVerticalRate,
} from "@/lib/flight-list";
import {
	interfaceStore,
	type SortKey,
	type SortOrder,
	useInterfaceStore,
} from "@/lib/interface-store";
import { cn } from "@/lib/utils";

/** The height of a row, which the virtualiser is told and the CSS keeps. */
export const ROW_HEIGHT_PX = 24;
/** Rows kept rendered above and below the ones on screen. */
const OVERSCAN_ROWS = 8;

type Column = {
	key: SortKey;
	label: string;
	/** What a screen reader calls it, with its unit. */
	name: string;
	className: string;
	/** Numbers start sorted from the largest. */
	descendingFirst: boolean;
};

export const COLUMNS: readonly Column[] = [
	{
		key: "callsign",
		label: "Callsign",
		name: "Callsign",
		className: "w-[5.5rem] text-left",
		descendingFirst: false,
	},
	{
		key: "aircraftType",
		label: "Type",
		name: "Aircraft type",
		className: "w-[3.25rem] text-left",
		descendingFirst: false,
	},
	{
		key: "altitude",
		label: "Alt ft",
		name: "Altitude in feet",
		className: "flex-1 text-right",
		descendingFirst: true,
	},
	{
		key: "groundSpeed",
		label: "Kt",
		name: "Ground speed in knots",
		className: "w-[3rem] text-right",
		descendingFirst: true,
	},
	{
		key: "verticalRate",
		label: "Ft/min",
		name: "Vertical rate in feet a minute",
		className: "w-[4.25rem] text-right",
		descendingFirst: true,
	},
];

/**
 * The order a click on a column's heading gives: that column, in its usual
 * direction, or the other way if it is already the one sorted by.
 */
export function nextSort(current: SortOrder, column: Column): SortOrder {
	if (current.key === column.key) {
		return { key: column.key, descending: !current.descending };
	}
	return { key: column.key, descending: column.descendingFirst };
}

const SERVER_SNAPSHOT = { count: 0, version: 0, refreshMs: 0 };

/**
 * The sortable, filterable table of the aircraft in the picture.
 *
 * It renders only the rows on screen, and asks the list for only those, so
 * its cost does not grow with the number of aircraft. A click on a row
 * selects that aircraft on the map; an aircraft selected on the map is
 * scrolled to and marked here.
 */
export function FlightList({ list }: { list: FlightListData }) {
	const snapshot = useSyncExternalStore(
		list.subscribe,
		list.getSnapshot,
		() => SERVER_SNAPSHOT,
	);
	const selectedId = useInterfaceStore((state) => state.selectedId);
	const hoveredId = useInterfaceStore((state) => state.hoveredId);
	const sort = useInterfaceStore((state) => state.sort);
	const filter = useInterfaceStore((state) => state.filters.text);

	const scroller = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: snapshot.count,
		getScrollElement: () => scroller.current,
		estimateSize: () => ROW_HEIGHT_PX,
		overscan: OVERSCAN_ROWS,
	});

	// An aircraft selected anywhere, the map included, is brought into view,
	// once: the list is not dragged back to it every second after that.
	const scrolledTo = useRef<number | null>(null);
	useEffect(() => {
		if (selectedId === null) {
			scrolledTo.current = null;
			return;
		}
		// Looked for again whenever the list changes: an aircraft just
		// selected on the map may not be in it yet.
		if (scrolledTo.current === selectedId || snapshot.count === 0) return;
		const index = list.indexOf(selectedId);
		// Not in the list yet, or filtered out.
		if (index === -1) return;
		scrolledTo.current = selectedId;
		virtualizer.scrollToIndex(index, { align: "auto" });
	}, [selectedId, snapshot, list, virtualizer]);

	const select = useCallback((id: number) => {
		const state = interfaceStore.getState();
		// A click on the selected row lets go of it.
		state.select(state.selectedId === id ? null : id);
	}, []);

	return (
		<div data-slot="flight-list-table" className="flex h-full min-h-0 flex-col">
			<FilterBox value={filter} count={snapshot.count} />
			{/* Not a <table>: the rows are positioned by the virtualiser, not laid
			    out, and only the ones on screen exist. The headings and the rows
			    are buttons, which is what they are to the keyboard. */}
			<div className="flex min-h-0 flex-1 flex-col font-mono text-[11px]">
				<div className="flex h-6 shrink-0 items-stretch border-b bg-secondary/30 px-2 uppercase tracking-wider text-muted-foreground">
					{COLUMNS.map((column) => (
						<ColumnHeading key={column.key} column={column} sort={sort} />
					))}
				</div>
				<div
					ref={scroller}
					data-slot="flight-list-rows"
					data-refresh-ms={snapshot.refreshMs.toFixed(2)}
					className="min-h-0 flex-1 overflow-y-auto"
				>
					{snapshot.count === 0 ? (
						<p className="px-3 py-4 font-sans text-xs text-muted-foreground">
							{filter.trim() === ""
								? "No aircraft in the picture."
								: "No aircraft match."}
						</p>
					) : (
						<div
							className="relative w-full"
							style={{ height: virtualizer.getTotalSize() }}
						>
							{virtualizer.getVirtualItems().map((item) => {
								const row = list.row(item.index);
								if (row === null) return null;
								return (
									<Row
										key={row.id}
										row={row}
										index={item.index}
										top={item.start}
										selected={row.id === selectedId}
										hovered={row.id === hoveredId}
										onSelect={select}
									/>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function FilterBox({ value, count }: { value: string; count: number }) {
	// The box keeps its own text so typing is never a keystroke behind; the
	// store is told at once, and WASM filters on the next turn.
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const change = (next: string) => {
		setText(next);
		interfaceStore.getState().setFilters({ text: next });
	};
	return (
		<div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
			<Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
			<input
				type="search"
				data-slot="flight-list-filter"
				aria-label="Filter flights by callsign, type, origin or destination"
				placeholder="Filter: callsign, type, airport"
				value={text}
				onChange={(event) => change(event.target.value)}
				spellCheck={false}
				autoComplete="off"
				className="h-6 min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none placeholder:normal-case placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
			/>
			{text !== "" && (
				<button
					type="button"
					aria-label="Clear the filter"
					onClick={() => change("")}
					className="rounded-sm p-0.5 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<X aria-hidden className="size-3.5" />
				</button>
			)}
			<output
				data-slot="flight-list-count"
				aria-label="Flights listed"
				className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
			>
				{count.toLocaleString("en-US")}
			</output>
		</div>
	);
}

function ColumnHeading({ column, sort }: { column: Column; sort: SortOrder }) {
	const sorted = sort.key === column.key;
	const Arrow = sort.descending ? ArrowDown : ArrowUp;
	const direction = sort.descending ? "descending" : "ascending";
	return (
		<button
			type="button"
			data-slot="flight-list-sort"
			data-key={column.key}
			data-sorted={sorted ? direction : undefined}
			aria-label={
				sorted
					? `${column.name}, sorted ${direction}`
					: `Sort by ${column.name.toLowerCase()}`
			}
			title={`Sort by ${column.name.toLowerCase()}`}
			onClick={() => interfaceStore.getState().setSort(nextSort(sort, column))}
			className={cn(
				"flex shrink-0 items-center gap-0.5 uppercase tracking-wider outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
				column.className,
				column.className.includes("text-right") && "justify-end",
				sorted && "text-foreground",
			)}
		>
			{column.label}
			{sorted && <Arrow aria-hidden className="size-3 shrink-0" />}
		</button>
	);
}

function Row({
	row,
	index,
	top,
	selected,
	hovered,
	onSelect,
}: {
	row: FlightRow;
	index: number;
	top: number;
	selected: boolean;
	hovered: boolean;
	onSelect: (id: number) => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			data-slot="flight-row"
			data-index={index}
			data-id={row.id}
			data-selected={selected || undefined}
			data-synthetic={row.synthetic || undefined}
			onClick={() => onSelect(row.id)}
			onPointerEnter={() => interfaceStore.getState().hover(row.id)}
			onPointerLeave={() => {
				const state = interfaceStore.getState();
				if (state.hoveredId === row.id) state.hover(null);
			}}
			className={cn(
				"absolute left-0 flex w-full cursor-pointer items-center px-2 text-left tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
				selected
					? "bg-status-info/20 text-foreground"
					: hovered
						? "bg-accent/60"
						: "hover:bg-accent/60",
				row.synthetic && !selected && "text-muted-foreground",
			)}
			style={{ top, height: ROW_HEIGHT_PX }}
		>
			<Cell className={COLUMNS[0].className}>
				<span className="truncate font-medium">{row.callsign || "—"}</span>
			</Cell>
			<Cell className={COLUMNS[1].className}>{row.aircraftType || "—"}</Cell>
			<Cell className={COLUMNS[2].className}>{formatAltitude(row)}</Cell>
			<Cell className={COLUMNS[3].className}>
				{formatSpeed(row.groundSpeedKt)}
			</Cell>
			<Cell className={COLUMNS[4].className}>
				{formatVerticalRate(row.verticalRateFpm)}
			</Cell>
		</button>
	);
}

function Cell({
	className,
	children,
}: {
	className: string;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"flex shrink-0",
				className,
				className.includes("text-right") && "justify-end",
			)}
		>
			{children}
		</span>
	);
}
