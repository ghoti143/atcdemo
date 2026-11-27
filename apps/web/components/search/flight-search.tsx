"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { flightQuery, flightSearchQuery } from "@/lib/api/client";
import type { Flight } from "@/lib/api/flights-shapes";
import {
	cleanSearch,
	formatRoute,
	formatSeen,
	MAX_SEARCH_LENGTH,
	SEARCH_DELAY_MS,
	selectFlying,
	showFlight,
} from "@/lib/flight-search";
import { interfaceStore, useInterfaceStore } from "@/lib/interface-store";
import { cn } from "@/lib/utils";

/**
 * The flight search in the top bar: finds flights by the start of their
 * callsign among those flying and those seen in the last 24 hours. Choosing
 * one that is flying selects it on the map; choosing one that has finished
 * draws its recorded track.
 */
export function FlightSearch() {
	const client = useQueryClient();
	const listId = useId();
	const root = useRef<HTMLDivElement>(null);
	const [typed, setTyped] = useState("");
	// What the API is asked for: `typed`, cleaned, once typing has paused.
	const [term, setTerm] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [problem, setProblem] = useState<string | null>(null);
	const recorded = useInterfaceStore((state) => state.recordedFlight);

	const cleaned = cleanSearch(typed);
	useEffect(() => {
		const timer = setTimeout(() => setTerm(cleaned), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [cleaned]);

	const results = useQuery({
		...flightSearchQuery(term),
		enabled: term !== "",
	});
	const flights = term === "" ? [] : (results.data?.flights ?? []);
	// Typing has moved on from what the list shows.
	const waiting = cleaned !== "" && (cleaned !== term || results.isPending);

	// Closed by a press anywhere outside it.
	useEffect(() => {
		if (!open) return;
		const onPress = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPress);
		return () => document.removeEventListener("pointerdown", onPress);
	}, [open]);

	const choose = (flight: Flight) => {
		setOpen(false);
		setProblem(null);
		// At once, so a flying aircraft is marked before its detail arrives.
		if (flight.flying) selectFlying(interfaceStore, flight);
		client
			.fetchQuery({ ...flightQuery(flight.id), staleTime: 0 })
			.then((detail) => showFlight(interfaceStore, detail))
			.catch(() => {
				setProblem(`The track of ${flight.callsign} could not be loaded.`);
				setOpen(true);
			});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			setOpen(false);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			if (flights.length === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((was) => (was + step + flights.length) % flights.length);
			return;
		}
		if (event.key === "Enter" && open) {
			const flight = flights[Math.min(active, flights.length - 1)];
			if (flight) choose(flight);
		}
	};

	const shown = open && (cleaned !== "" || problem !== null);
	const activeIndex = Math.min(active, Math.max(flights.length - 1, 0));

	return (
		<div
			ref={root}
			data-slot="flight-search"
			className="relative flex items-center gap-2"
		>
			<div className="relative">
				<Search
					aria-hidden
					className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<input
					type="search"
					role="combobox"
					data-slot="flight-search-input"
					aria-label="Search flights by callsign"
					aria-expanded={shown}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={
						shown && flights.length > 0
							? `${listId}-${flights[activeIndex].id}`
							: undefined
					}
					autoComplete="off"
					spellCheck={false}
					placeholder="Find a callsign"
					value={typed}
					maxLength={MAX_SEARCH_LENGTH + 4}
					onChange={(event) => {
						setTyped(event.target.value);
						setActive(0);
						setProblem(null);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onKeyDown={onKeyDown}
					className="h-6 w-44 rounded-sm border bg-background/60 pl-7 pr-2 font-mono text-[11px] uppercase tracking-wider text-foreground outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-search-cancel-button]:hidden"
				/>
				{shown && (
					<div
						data-slot="flight-search-panel"
						className="absolute left-0 top-8 z-30 w-80 rounded-md border bg-card p-1 font-sans normal-case tracking-normal text-foreground shadow-2xl"
					>
						{problem && (
							<p
								role="alert"
								data-slot="flight-search-problem"
								className="px-2 py-1.5 text-xs text-destructive"
							>
								{problem}
							</p>
						)}
						{cleaned === "" ? null : results.isError && !waiting ? (
							<p role="alert" className="px-2 py-1.5 text-xs text-destructive">
								The search could not be run.
							</p>
						) : waiting && flights.length === 0 ? (
							<p className="px-2 py-1.5 text-xs text-muted-foreground">
								Searching…
							</p>
						) : flights.length === 0 ? (
							<p
								data-slot="flight-search-empty"
								className="px-2 py-1.5 text-xs text-muted-foreground"
							>
								No flight in the last 24 hours has a callsign starting {term}.
							</p>
						) : null}
						{/* A listbox of options is what a combobox controls; the
						    options are chosen from the input's keys or by a press. */}
						<div
							id={listId}
							role="listbox"
							aria-label="Flights found"
							className={cn(
								"max-h-80 overflow-y-auto",
								waiting && "opacity-60",
							)}
						>
							{flights.map((flight, index) => (
								// The keys are the input's: the arrows move through the options
								// and Enter chooses, as a combobox does.
								// biome-ignore lint/a11y/useKeyWithClickEvents: see above.
								<div
									tabIndex={-1}
									key={flight.id}
									id={`${listId}-${flight.id}`}
									role="option"
									aria-selected={index === activeIndex}
									data-slot="flight-search-result"
									data-flying={flight.flying || undefined}
									data-flight-id={flight.id}
									data-aircraft-id={flight.aircraftId}
									onPointerMove={() => setActive(index)}
									// Before the input loses focus to the press.
									onPointerDown={(event) => event.preventDefault()}
									onClick={() => choose(flight)}
									className={cn(
										"flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 text-xs",
										index === activeIndex && "bg-accent",
									)}
								>
									<span className="w-16 shrink-0 font-mono font-semibold">
										{flight.callsign}
									</span>
									<span className="w-10 shrink-0 font-mono text-muted-foreground">
										{flight.aircraftType}
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
										{formatRoute(flight)}
									</span>
									<span
										className={cn(
											"shrink-0",
											flight.flying
												? "text-status-ok"
												: "text-muted-foreground",
										)}
									>
										{formatSeen(flight, Date.now())}
									</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
			{recorded && (
				<span
					data-slot="recorded-flight"
					className="flex h-6 items-center gap-1 rounded-sm border border-status-info/40 pl-2 pr-1 text-status-info"
				>
					{recorded.callsign} · recorded track
					<button
						type="button"
						data-slot="recorded-flight-clear"
						aria-label={`Stop showing the track of ${recorded.callsign}`}
						onClick={() => interfaceStore.getState().showRecordedFlight(null)}
						className="rounded-sm p-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
					>
						<X aria-hidden className="size-3" />
					</button>
				</span>
			)}
		</div>
	);
}
