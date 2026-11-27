import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlightDetail as Detail } from "@/lib/flight-detail";
import { AltitudeProfile, profilePoints } from "./altitude-profile";
import { DetailCard, FlightDetail } from "./flight-detail";

const detail = (changes: Partial<Detail> = {}): Detail => ({
	id: 7,
	present: true,
	callsign: "UAL12",
	aircraftType: "B738",
	origin: "KORD",
	destination: "KJFK",
	icao24: "0a1b2c",
	synthetic: false,
	altitudeFt: 35_000,
	groundSpeedKt: 450,
	trackDeg: 92.4,
	verticalRateFpm: -640,
	onGround: false,
	profile: {
		timesS: [0, 600, 1_200, 2_400],
		altitudesFt: [2_000, 18_000, 35_000, 35_000],
	},
	...changes,
});

const render = (changes?: Partial<Detail>) =>
	renderToStaticMarkup(<DetailCard detail={detail(changes)} />);
/** The text of one reading, without its markup. */
const reading = (html: string, name: string) =>
	(html.match(new RegExp(`data-reading="${name}".*?</dd>`))?.[0] ?? "").replace(
		/<[^>]+>/g,
		" ",
	);

describe("the detail panel", () => {
	test("with nothing selected, says how to select", () => {
		const html = renderToStaticMarkup(
			<FlightDetail
				detail={{
					subscribe: () => () => {},
					getSnapshot: () => null,
					refresh() {},
				}}
			/>,
		);
		expect(html).toContain('data-slot="flight-detail-empty"');
	});

	test("shows the callsign, the type and the route", () => {
		const html = render();
		expect(html).toContain("UAL12");
		expect(html).toContain("B738");
		expect(html).toContain("KORD → KJFK");
	});

	test("shows altitude as an altitude in feet, with speed, vertical rate and track", () => {
		const html = render();
		expect(reading(html, "altitude")).toContain("Altitude");
		expect(reading(html, "altitude")).toContain("35,000");
		expect(reading(html, "altitude")).toContain("ft");
		// Feet above mean sea level, so never written as a flight level.
		expect(html).not.toMatch(/FL\s?\d/);
		expect(reading(html, "speed")).toContain("450");
		expect(reading(html, "vertical-rate")).toContain("−640");
		expect(reading(html, "track")).toContain("092°");
	});

	test("an aircraft on the ground says so", () => {
		expect(
			reading(render({ onGround: true, altitudeFt: 600 }), "altitude"),
		).toContain("GND");
	});

	test("a clone is marked as one, and shown like any other", () => {
		const html = render({ synthetic: true });
		expect(html).toContain('data-slot="flight-detail-clone"');
		expect(html).toContain('data-synthetic="true"');
		expect(reading(html, "altitude")).toContain("35,000");
		expect(html).toContain('data-slot="altitude-profile"');
		expect(render()).not.toContain('data-slot="flight-detail-clone"');
	});

	test("says when the route, the type or the callsign is not known", () => {
		const html = render({
			origin: "",
			destination: "",
			aircraftType: "",
			callsign: "",
		});
		expect(html).toContain("Route not known");
		expect(html).toContain("Type not known");
		expect(html).toContain("No callsign");
	});

	test("an aircraft that has left says so, and keeps its profile", () => {
		const html = render({
			present: false,
			altitudeFt: null,
			groundSpeedKt: null,
			trackDeg: null,
			verticalRateFpm: null,
		});
		expect(html).toContain("No longer in the picture.");
		expect(html).not.toContain('data-reading="altitude"');
		expect(html).toContain('data-slot="altitude-profile"');
	});
});

describe("the altitude profile", () => {
	const profile = detail().profile;

	test("draws one line through every sample, ending at now on the right", () => {
		const html = renderToStaticMarkup(<AltitudeProfile profile={profile} />);
		const line = html.match(
			/data-slot="altitude-profile-line" points="([^"]+)"/,
		)?.[1];
		expect(line?.split(" ")).toHaveLength(4);
		expect(line?.split(" ")[0].startsWith("0.0,")).toBe(true);
		expect(line?.split(" ")[3].startsWith("328.0,")).toBe(true);
		expect(html).toContain(">now<");
		expect(html).toContain("40 min ago");
		expect(html).toContain("50,000 ft");
	});

	test("reads out the newest point until the pointer picks another", () => {
		const html = renderToStaticMarkup(<AltitudeProfile profile={profile} />);
		expect(html).toMatch(
			/data-slot="altitude-profile-readout"[^>]*>35,000 ft · (<!-- -->)?now/,
		);
	});

	test("describes itself for someone who cannot see it", () => {
		const html = renderToStaticMarkup(<AltitudeProfile profile={profile} />);
		expect(html).toContain(
			'aria-label="Altitude over the last 40 min: between 2,000 and 35,000 feet, now 35,000 feet."',
		);
	});

	test("higher is higher up, and time runs left to right", () => {
		const points = profilePoints(profile, 40_000);
		expect(points.map((point) => point.x)).toEqual([0, 82, 164, 328]);
		expect(points[0].y).toBeGreaterThan(points[1].y);
		expect(points[1].y).toBeGreaterThan(points[2].y);
		expect(points[2].y).toBe(points[3].y);
		// Below sea level is drawn at the ground.
		const below = profilePoints(
			{ timesS: [0, 10], altitudesFt: [-300, 0] },
			1_000,
		);
		expect(below[0].y).toBe(below[1].y);
	});

	test("with no track yet, or one point, says so in the chart's place", () => {
		const waiting = renderToStaticMarkup(
			<AltitudeProfile profile={{ timesS: [], altitudesFt: [] }} />,
		);
		expect(waiting).toContain("Waiting for the aircraft");
		const one = renderToStaticMarkup(
			<AltitudeProfile profile={{ timesS: [5], altitudesFt: [100] }} />,
		);
		expect(one).toContain("Just appeared");
		expect(one).not.toContain("<svg");
	});
});
