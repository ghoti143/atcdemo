"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
	type ApiError,
	apiDelete,
	apiPost,
	apiPut,
	VIEWS_KEY,
	viewsQuery,
} from "@/lib/api/client";
import {
	deletedAnswerSchema,
	MAX_NAME_LENGTH,
	type SavedView,
	viewAnswerSchema,
} from "@/lib/api/views-shapes";
import { interfaceStore } from "@/lib/interface-store";
import { applyView, captureView } from "@/lib/saved-views";
import { cn } from "@/lib/utils";

/**
 * The saved views menu in the top bar: save where the map is now under a
 * name, and go back to, rename or delete one saved before. The views are
 * the signed-in user's own and are kept by the server.
 */
export function SavedViews() {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	// Closed by Escape, and by a press anywhere outside it.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		const onPress = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPress);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPress);
		};
	}, [open]);

	return (
		<div ref={root} data-slot="saved-views" className="relative">
			<button
				type="button"
				data-slot="saved-views-toggle"
				aria-expanded={open}
				aria-controls="saved-views-panel"
				onClick={() => setOpen((was) => !was)}
				className={cn(
					"flex h-6 items-center gap-1.5 rounded-sm border px-2 uppercase tracking-wider outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
					open
						? "border-status-info/40 bg-background/60 text-status-info"
						: "text-muted-foreground",
				)}
			>
				<Bookmark aria-hidden className="size-3.5" />
				Views
			</button>
			{open && <ViewsPanel />}
		</div>
	);
}

function ViewsPanel() {
	const client = useQueryClient();
	const views = useQuery(viewsQuery());
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	const changed = () => client.invalidateQueries({ queryKey: VIEWS_KEY });
	const failed = (error: ApiError) =>
		setProblem(
			error.fields?.name ? `The name ${error.fields.name}.` : error.message,
		);

	const save = useMutation({
		mutationFn: (viewName: string) => {
			const view = captureView(interfaceStore);
			if (view === null) {
				return Promise.reject(new Error("The map is not ready yet."));
			}
			return apiPost("/api/views", { name: viewName, view }, viewAnswerSchema);
		},
		onSuccess: () => {
			setName("");
			setProblem(null);
			return changed();
		},
		onError: (error: ApiError | Error) =>
			"status" in error ? failed(error) : setProblem(error.message),
	});
	const rename = useMutation({
		mutationFn: ({ id, name: next }: { id: number; name: string }) =>
			apiPut(`/api/views/${id}`, { name: next }, viewAnswerSchema),
		onSuccess: () => {
			setProblem(null);
			return changed();
		},
		onError: failed,
	});
	const remove = useMutation({
		mutationFn: (id: number) =>
			apiDelete(`/api/views/${id}`, deletedAnswerSchema),
		onSuccess: () => {
			setProblem(null);
			return changed();
		},
		onError: failed,
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed !== "") save.mutate(trimmed);
	};

	return (
		<div
			id="saved-views-panel"
			data-slot="saved-views-panel"
			className="absolute right-0 top-8 z-30 w-72 rounded-md border bg-card p-2 font-sans normal-case tracking-normal text-foreground shadow-2xl"
		>
			<form onSubmit={submit} className="flex gap-1.5">
				<input
					data-slot="saved-view-name"
					aria-label="Name for the view the map shows now"
					placeholder="Name this view"
					value={name}
					maxLength={MAX_NAME_LENGTH}
					onChange={(event) => setName(event.target.value)}
					className="h-7 min-w-0 flex-1 rounded-sm border bg-background/60 px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				/>
				<button
					type="submit"
					data-slot="saved-view-save"
					disabled={name.trim() === "" || save.isPending}
					className="h-7 rounded-sm border px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
				>
					Save
				</button>
			</form>
			{problem && (
				<p
					role="alert"
					data-slot="saved-views-problem"
					className="mt-1.5 text-xs text-destructive"
				>
					{problem}
				</p>
			)}

			<div className="mt-2 max-h-64 overflow-y-auto border-t pt-1.5">
				{views.isPending ? (
					<p className="px-1 py-2 text-xs text-muted-foreground">Loading…</p>
				) : views.isError ? (
					<p role="alert" className="px-1 py-2 text-xs text-destructive">
						Your saved views could not be loaded.
					</p>
				) : views.data.length === 0 ? (
					<p
						data-slot="saved-views-empty"
						className="px-1 py-2 text-xs text-muted-foreground"
					>
						No saved views yet. Move the map where you want it and name it
						above.
					</p>
				) : (
					<ul className="space-y-0.5">
						{views.data.map((view) => (
							<ViewRow
								key={view.id}
								view={view}
								onRename={(next) => rename.mutate({ id: view.id, name: next })}
								onDelete={() => remove.mutate(view.id)}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function ViewRow({
	view,
	onRename,
	onDelete,
}: {
	view: SavedView;
	onRename: (name: string) => void;
	onDelete: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(view.name);
	const icon =
		"rounded-sm p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

	if (editing) {
		const done = (event: FormEvent) => {
			event.preventDefault();
			const trimmed = name.trim();
			if (trimmed !== "" && trimmed !== view.name) onRename(trimmed);
			setEditing(false);
		};
		return (
			<li data-slot="saved-view" data-id={view.id}>
				<form onSubmit={done} className="flex items-center gap-1">
					<input
						data-slot="saved-view-rename"
						aria-label={`New name for ${view.name}`}
						value={name}
						maxLength={MAX_NAME_LENGTH}
						// The row was just asked to be renamed: the caret belongs here.
						// biome-ignore lint/a11y/noAutofocus: see above.
						autoFocus
						onChange={(event) => setName(event.target.value)}
						className="h-6 min-w-0 flex-1 rounded-sm border bg-background/60 px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					/>
					<button type="submit" aria-label="Keep the new name" className={icon}>
						<Check aria-hidden className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="Leave the name as it was"
						onClick={() => {
							setName(view.name);
							setEditing(false);
						}}
						className={icon}
					>
						<X aria-hidden className="size-3.5" />
					</button>
				</form>
			</li>
		);
	}
	return (
		<li
			data-slot="saved-view"
			data-id={view.id}
			className="flex items-center gap-1"
		>
			<button
				type="button"
				data-slot="saved-view-apply"
				title={`Go to ${view.name}`}
				onClick={() => applyView(interfaceStore, view.view)}
				className="min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				{view.name}
			</button>
			<button
				type="button"
				data-slot="saved-view-rename-start"
				aria-label={`Rename ${view.name}`}
				onClick={() => setEditing(true)}
				className={icon}
			>
				<Pencil aria-hidden className="size-3.5" />
			</button>
			<button
				type="button"
				data-slot="saved-view-delete"
				aria-label={`Delete ${view.name}`}
				onClick={onDelete}
				className={icon}
			>
				<Trash2 aria-hidden className="size-3.5" />
			</button>
		</li>
	);
}
