CREATE TYPE "trip_service"."trip_status" AS ENUM('REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'NO_DRIVERS');--> statement-breakpoint
CREATE TABLE "trip_service"."trip_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_status" "trip_service"."trip_status",
	"to_status" "trip_service"."trip_status" NOT NULL,
	"at_sim" bigint NOT NULL,
	"at_real" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_service"."trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_id" uuid NOT NULL,
	"driver_id" uuid,
	"status" "trip_service"."trip_status" NOT NULL,
	"pickup" "postgis"."geography"(Point,4326) NOT NULL,
	"dropoff" "postgis"."geography"(Point,4326) NOT NULL,
	"trip_route" "postgis"."geography"(LineString,4326) NOT NULL,
	"pickup_route" "postgis"."geography"(LineString,4326),
	"trip_route_durations" double precision[] NOT NULL,
	"pickup_route_durations" double precision[],
	"pickup_route_distance_m" double precision,
	"pickup_route_duration_s" double precision,
	"est_distance_m" double precision NOT NULL,
	"est_duration_s" double precision NOT NULL,
	"requested_at" bigint NOT NULL,
	"matched_at" bigint,
	"arrived_at" bigint,
	"started_at" bigint,
	"completed_at" bigint,
	"ended_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_service"."trip_events" ADD CONSTRAINT "trip_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "trip_service"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_events_trip_at_sim_idx" ON "trip_service"."trip_events" USING btree ("trip_id","at_sim");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_rider_non_terminal_uq" ON "trip_service"."trips" USING btree ("rider_id") WHERE "status" IN ('REQUESTED', 'MATCHED', 'ARRIVED', 'IN_PROGRESS');--> statement-breakpoint
CREATE UNIQUE INDEX "trips_driver_active_uq" ON "trip_service"."trips" USING btree ("driver_id") WHERE "status" IN ('MATCHED', 'ARRIVED', 'IN_PROGRESS');--> statement-breakpoint
CREATE INDEX "trips_status_idx" ON "trip_service"."trips" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trips_requested_at_idx" ON "trip_service"."trips" USING btree ("requested_at");