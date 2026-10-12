ALTER TABLE "context_messages" DROP CONSTRAINT "context_messages_role_check";--> statement-breakpoint
ALTER TABLE "context_messages" ADD CONSTRAINT "context_messages_kind_role_pair" CHECK (("context_messages"."role" = 'user' AND "context_messages"."kind" IN (
        'user_message','card_answer',
        'harness_turn_counter','harness_review_block','harness_retry_directive'
      ))
      OR ("context_messages"."role" = 'assistant' AND "context_messages"."kind" IN (
        'assistant_response','failed_assistant_response','assistant_tool_call'
      ))
      OR ("context_messages"."role" = 'tool' AND "context_messages"."kind" = 'tool_result'));