CREATE TYPE "matching_service"."job_status" AS ENUM('ACTIVE', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "matching_service"."offer_status" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "matching_service"."match_jobs" (
	"trip_id" uuid PRIMARY KEY NOT NULL,
	"status" "matching_service"."job_status" NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"radius_m" integer NOT NULL,
	"pickup_lat" double precision NOT NULL,
	"pickup_lng" double precision NOT NULL,
	"dropoff_lat" double precision NOT NULL,
	"dropoff_lng" double precision NOT NULL,
	"started_sim" bigint NOT NULL,
	"updated_sim" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_service"."offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"status" "matching_service"."offer_status" NOT NULL,
	"eta_s" double precision NOT NULL,
	"attempt" integer NOT NULL,
	"driver_lat" double precision NOT NULL,
	"driver_lng" double precision NOT NULL,
	"pickup_lat" double precision NOT NULL,
	"pickup_lng" double precision NOT NULL,
	"dropoff_lat" double precision NOT NULL,
	"dropoff_lng" double precision NOT NULL,
	"created_sim" bigint NOT NULL,
	"expires_sim" bigint NOT NULL,
	"resolved_sim" bigint
);
--> statement-breakpoint
CREATE INDEX "offers_driver_pending_idx" ON "matching_service"."offers" USING btree ("driver_id") WHERE "matching_service"."offers"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "offers_trip_idx" ON "matching_service"."offers" USING btree ("trip_id");