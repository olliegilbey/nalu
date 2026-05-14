ALTER TABLE "context_messages" DROP CONSTRAINT "context_messages_kind_check";--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_kind_check" CHECK ("context_messages"."kind" IN (
        'user_message','card_answer','assistant_response',
        'harness_turn_counter','harness_review_block',
        'failed_assistant_response','harness_retry_directive'
      ));