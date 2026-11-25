CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "auth_tokens_kind_enum" CHECK ("auth_tokens"."kind" IN ('email-verify','password-reset'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"prev_refresh_token_hash" text,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "auth_sessions_device_label_len" CHECK ("auth_sessions"."device_label" IS NULL OR char_length("auth_sessions"."device_label") <= 120)
);
--> statement-breakpoint
CREATE TABLE "auth_throttle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"request_times" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cooldown_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_throttle_scope_enum" CHECK ("auth_throttle"."scope" IN ('login','forgot-password')),
	CONSTRAINT "auth_throttle_failure_count" CHECK ("auth_throttle"."failure_count" >= 0),
	CONSTRAINT "auth_throttle_request_count" CHECK ("auth_throttle"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"role" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_display_name_len" CHECK (char_length("users"."display_name") BETWEEN 1 AND 80),
	CONSTRAINT "users_timezone_len" CHECK (char_length("users"."timezone") <= 64),
	CONSTRAINT "users_role_enum" CHECK ("users"."role" IN ('Patient','Caregiver'))
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_user_kind" ON "auth_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_expiry" ON "auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_user_id" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_prev_hash" ON "auth_sessions" USING btree ("prev_refresh_token_hash") WHERE "auth_sessions"."prev_refresh_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_expiry" ON "auth_sessions" USING btree ("expires_at") WHERE "auth_sessions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_throttle_scope_subject_key" ON "auth_throttle" USING btree ("scope","subject_hash");--> statement-breakpoint
CREATE INDEX "idx_auth_throttle_expiry" ON "auth_throttle" USING btree ("cooldown_until") WHERE "auth_throttle"."cooldown_until" IS NOT NULL;