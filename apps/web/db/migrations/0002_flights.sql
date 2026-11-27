CREATE TABLE "flight_tracks" (
	"flight_id" bigint NOT NULL,
	"first_sample_sim_s" bigint NOT NULL,
	"sample_count" integer NOT NULL,
	"samples" "bytea" NOT NULL,
	CONSTRAINT "flight_tracks_flight_id_first_sample_sim_s_pk" PRIMARY KEY("flight_id","first_sample_sim_s")
);
--> statement-breakpoint
CREATE TABLE "flights" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aircraft_id" bigint NOT NULL,
	"icao24" integer NOT NULL,
	"callsign" text NOT NULL,
	"aircraft_type" text NOT NULL,
	"origin" text,
	"destination" text,
	"pass" integer NOT NULL,
	"first_seen_sim_s" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_sim_s" bigint,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "flight_tracks" ADD CONSTRAINT "flight_tracks_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flights_callsign_idx" ON "flights" USING btree (upper("callsign") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "flights_aircraft_id_idx" ON "flights" USING btree ("aircraft_id");--> statement-breakpoint
CREATE INDEX "flights_first_seen_at_idx" ON "flights" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "flights_open_idx" ON "flights" USING btree ("id") WHERE "flights"."last_seen_at" is null;