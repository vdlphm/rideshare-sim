CREATE TYPE "user_service"."user_role" AS ENUM('rider', 'driver', 'admin', 'service');--> statement-breakpoint
CREATE TABLE "user_service"."driver_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"vehicle_make" text NOT NULL,
	"vehicle_model" text NOT NULL,
	"vehicle_color" text NOT NULL,
	"vehicle_plate" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_profiles_vehicle_plate_unique" UNIQUE("vehicle_plate")
);
--> statement-breakpoint
CREATE TABLE "user_service"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_service"."rider_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_service"."service_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_service"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_service"."user_role" NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "user_service"."driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "user_service"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "user_service"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service"."rider_profiles" ADD CONSTRAINT "rider_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "user_service"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "user_service"."refresh_tokens" USING btree ("family_id");