-- ONE-TIME BOOTSTRAP EDIT (see drizzle.config.ts comment + src/db/CLAUDE.md):
-- pgcrypto provides gen_random_uuid(); every table below defaults its PK to it.
-- Drizzle-kit doesn't auto-emit extension creation, and adding it via Drizzle's
-- `sql` template would require a custom migrator. Prepended here once and
-- never re-edited; subsequent migrations are pure drizzle-kit output.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wave_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"question" text,
	"user_answer" text NOT NULL,
	"is_correct" boolean NOT NULL,
	"quality_score" integer NOT NULL,
	"assessment_kind" text NOT NULL,
	"xp_awarded" integer DEFAULT 0 NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessments_kind_check" CHECK ("assessments"."assessment_kind" IN ('card_mc','card_freetext','inferred')),
	CONSTRAINT "assessments_question_required_for_card_kinds" CHECK ("assessments"."assessment_kind" = 'inferred' OR "assessments"."question" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tier" integer NOT NULL,
	"easiness_factor" real DEFAULT 2.5 NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"repetition_count" integer DEFAULT 0 NOT NULL,
	"last_quality_score" integer,
	"last_reviewed_at" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"times_correct" integer DEFAULT 0 NOT NULL,
	"times_incorrect" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wave_id" uuid,
	"scoping_pass_id" uuid,
	"turn_index" integer NOT NULL,
	"seq" smallint NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_messages_kind_check" CHECK ("context_messages"."kind" IN ('user_message','card_answer','assistant_response','harness_turn_counter','harness_review_block')),
	CONSTRAINT "context_messages_role_check" CHECK ("context_messages"."role" IN ('user','assistant','tool')),
	CONSTRAINT "context_messages_one_parent" CHECK (("context_messages"."wave_id" IS NOT NULL) <> ("context_messages"."scoping_pass_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"clarification" jsonb,
	"framework" jsonb,
	"baseline" jsonb,
	"starting_tier" integer,
	"current_tier" integer DEFAULT 1 NOT NULL,
	"total_xp" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'scoping' NOT NULL,
	"summary" text,
	"summary_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courses_status_check" CHECK ("courses"."status" IN ('scoping','active','archived'))
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"total_xp" integer DEFAULT 0 NOT NULL,
	"custom_instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoping_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "scoping_passes_status_check" CHECK ("scoping_passes"."status" IN ('open','closed'))
);
--> statement-breakpoint
CREATE TABLE "waves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"wave_number" integer NOT NULL,
	"tier" integer NOT NULL,
	"framework_snapshot" jsonb NOT NULL,
	"custom_instructions_snapshot" text,
	"due_concepts_snapshot" jsonb NOT NULL,
	"seed_source" jsonb NOT NULL,
	"turn_budget" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"blueprint_emitted" jsonb,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "waves_status_check" CHECK ("waves"."status" IN ('open','closed'))
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_scoping_pass_id_scoping_passes_id_fk" FOREIGN KEY ("scoping_pass_id") REFERENCES "public"."scoping_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_user_id_user_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoping_passes" ADD CONSTRAINT "scoping_passes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessments_wave_id_idx" ON "assessments" USING btree ("wave_id");--> statement-breakpoint
CREATE INDEX "assessments_concept_assessed_idx" ON "assessments" USING btree ("concept_id","assessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_course_name_lower_unique" ON "concepts" USING btree ("course_id",lower("name"));--> statement-breakpoint
CREATE INDEX "concepts_due_idx" ON "concepts" USING btree ("course_id","next_review_at") WHERE "concepts"."next_review_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "concepts_course_tier_idx" ON "concepts" USING btree ("course_id","tier");--> statement-breakpoint
CREATE UNIQUE INDEX "context_messages_wave_order" ON "context_messages" USING btree ("wave_id","turn_index","seq") WHERE "context_messages"."wave_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_messages_scoping_order" ON "context_messages" USING btree ("scoping_pass_id","turn_index","seq") WHERE "context_messages"."scoping_pass_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "courses_user_id_idx" ON "courses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scoping_passes_course_id_unique" ON "scoping_passes" USING btree ("course_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waves_course_wave_number_unique" ON "waves" USING btree ("course_id","wave_number");--> statement-breakpoint
CREATE UNIQUE INDEX "waves_one_open_per_course" ON "waves" USING btree ("course_id") WHERE "waves"."status" = 'open';