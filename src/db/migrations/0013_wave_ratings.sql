CREATE TABLE "wave_ratings" (
	"wave_id" uuid PRIMARY KEY NOT NULL,
	"overall" integer NOT NULL,
	"difficulty" integer,
	"pacing" integer,
	"usefulness" integer,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wave_ratings_overall_range" CHECK ("wave_ratings"."overall" BETWEEN 1 AND 5),
	CONSTRAINT "wave_ratings_difficulty_range" CHECK ("wave_ratings"."difficulty" BETWEEN 1 AND 5),
	CONSTRAINT "wave_ratings_pacing_range" CHECK ("wave_ratings"."pacing" BETWEEN 1 AND 5),
	CONSTRAINT "wave_ratings_usefulness_range" CHECK ("wave_ratings"."usefulness" BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "wave_ratings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wave_ratings" ADD CONSTRAINT "wave_ratings_wave_id_waves_id_fk" FOREIGN KEY ("wave_id") REFERENCES "public"."waves"("id") ON DELETE cascade ON UPDATE no action;