ALTER TABLE "assessments" ADD CONSTRAINT "assessments_turn_index_nonneg" CHECK ("assessments"."turn_index" >= 0);--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_quality_score_range" CHECK ("assessments"."quality_score" >= 0 AND "assessments"."quality_score" <= 5);--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_xp_awarded_nonneg" CHECK ("assessments"."xp_awarded" >= 0);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_tier_positive" CHECK ("concepts"."tier" > 0);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_interval_days_nonneg" CHECK ("concepts"."interval_days" >= 0);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_repetition_count_nonneg" CHECK ("concepts"."repetition_count" >= 0);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_easiness_factor_min" CHECK ("concepts"."easiness_factor" >= 1.3);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_last_quality_score_range" CHECK ("concepts"."last_quality_score" IS NULL OR ("concepts"."last_quality_score" >= 0 AND "concepts"."last_quality_score" <= 5));--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_times_correct_nonneg" CHECK ("concepts"."times_correct" >= 0);--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_times_incorrect_nonneg" CHECK ("concepts"."times_incorrect" >= 0);--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_turn_index_nonneg" CHECK ("context_messages"."turn_index" >= 0);--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_seq_nonneg" CHECK ("context_messages"."seq" >= 0);--> statement-breakpoint
ALTER TABLE "scoping_passes" ADD CONSTRAINT "scoping_passes_closed_at_consistency" CHECK (("scoping_passes"."status" = 'closed') = ("scoping_passes"."closed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_wave_number_positive" CHECK ("waves"."wave_number" > 0);--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_tier_positive" CHECK ("waves"."tier" > 0);--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_turn_budget_positive" CHECK ("waves"."turn_budget" > 0);--> statement-breakpoint
ALTER TABLE "waves" ADD CONSTRAINT "waves_closed_at_consistency" CHECK (("waves"."status" = 'closed') = ("waves"."closed_at" IS NOT NULL));