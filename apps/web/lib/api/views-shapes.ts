// A saved view as the API carries it and the database keeps it. No import
// of the database, so the browser can load this file.

import { z } from "zod";
import type { Camera, ViewMode } from "@/lib/interface-store";

/** What a view remembers. Milestone 6 adds to it. */
export type ViewData = {
	camera: Camera;
	viewMode: ViewMode;
	filters: { text: string };
};

export type SavedView = {
	id: number;
	name: string;
	view: ViewData;
	createdAt: string;
	updatedAt: string;
};

/** The most views one user may keep. */
export const MAX_VIEWS = 50;
export const MAX_NAME_LENGTH = 60;
const MAX_FILTER_LENGTH = 64;

/** The whole picture: where a view lacking a camera opens. */
export const DEFAULT_CAMERA: Camera = {
	longitude: -96,
	latitude: 38.5,
	zoom: 3.6,
	pitch: 0,
	bearing: 0,
};

const number = (least: number, most: number) =>
	z
		.number({ error: "must be a number" })
		.min(least, `must be at least ${least}`)
		.max(most, `must be at most ${most}`);

const cameraSchema = z.strictObject({
	longitude: number(-180, 180),
	latitude: number(-90, 90),
	zoom: number(0, 24),
	pitch: number(0, 85),
	bearing: number(-180, 360),
});

/** What a view must be to be stored: all of it, nothing unknown. */
export const viewDataSchema: z.ZodType<ViewData> = z.strictObject({
	camera: cameraSchema,
	viewMode: z.enum(["2d", "3d"]),
	filters: z.strictObject({
		text: z
			.string({ error: "must be text" })
			.max(MAX_FILTER_LENGTH, `is at most ${MAX_FILTER_LENGTH} characters`),
	}),
});

export const viewNameSchema = z
	.string({ error: "is required" })
	.trim()
	.min(1, "is required")
	.max(MAX_NAME_LENGTH, `is at most ${MAX_NAME_LENGTH} characters`);

/** The body of `POST /api/views`. */
export const createViewSchema = z.strictObject({
	name: viewNameSchema,
	view: viewDataSchema,
});

/** The body of `PUT /api/views/:id`: a new name, a new view, or both. */
export const updateViewSchema = z
	.strictObject({
		name: viewNameSchema.optional(),
		view: viewDataSchema.optional(),
	})
	.refine((body) => body.name !== undefined || body.view !== undefined, {
		path: ["name"],
		error: "or view must be given",
	});

/** `:id` in `/api/views/:id`. */
export const viewParamsSchema = z.object({
	id: z
		.string()
		.regex(/^[1-9][0-9]{0,15}$/, "must be a view id")
		.transform(Number),
});

/**
 * Reads what is stored, whatever it is: a part that is missing or out of
 * range takes its default, and anything unknown is dropped. So a row from
 * another version of the app still opens.
 */
export function readStoredView(stored: unknown): ViewData {
	const record = (value: unknown): Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const data = record(stored);
	const camera = record(data.camera);
	const part = (name: keyof Camera): number => {
		const parsed = cameraSchema.shape[name].safeParse(camera[name]);
		return parsed.success ? parsed.data : DEFAULT_CAMERA[name];
	};
	const text = record(data.filters).text;
	return {
		camera: {
			longitude: part("longitude"),
			latitude: part("latitude"),
			zoom: part("zoom"),
			pitch: part("pitch"),
			bearing: part("bearing"),
		},
		viewMode: data.viewMode === "3d" ? "3d" : "2d",
		filters: {
			text: typeof text === "string" ? text.slice(0, MAX_FILTER_LENGTH) : "",
		},
	};
}

const savedViewSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	view: viewDataSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export const viewsAnswerSchema = z.object({ views: z.array(savedViewSchema) });
export const viewAnswerSchema = z.object({ view: savedViewSchema });
export const deletedAnswerSchema = z.object({ deleted: z.literal(true) });
