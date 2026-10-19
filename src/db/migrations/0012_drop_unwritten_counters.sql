ALTER TABLE "concepts" DROP CONSTRAINT "concepts_times_correct_nonneg";--> statement-breakpoint
ALTER TABLE "concepts" DROP CONSTRAINT "concepts_times_incorrect_nonneg";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP CONSTRAINT "user_profiles_total_xp_nonneg";--> statement-breakpoint
ALTER TABLE "concepts" DROP COLUMN "times_correct";--> statement-breakpoint
ALTER TABLE "concepts" DROP COLUMN "times_incorrect";--> statement-breakpoint
ALTER TABLE "user_profiles" DROP COLUMN "total_xp";