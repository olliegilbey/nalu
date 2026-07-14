import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod/v4";
import { resolveRequestUserId } from "@/server/requestUser";
import { submitTurnInputSchema } from "@/server/routers/waveTurnInput";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";
import { streamWaveTurn } from "@/lib/course/streamWaveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

// A turn can span LLM retries + Cerebras pacing; keep the function alive
// well past the worst case (3 attempts × generation + slow-lane spacing).
export const maxDuration = 300;

/**
 * Streaming wave-turn transport (replaces tRPC `wave.submitTurn` on the
 * client; the mutation remains server-side as a rollback path for one
 * release). Protocol: AI SDK UI Message Stream (SSE) — text parts carry
 * teaching prose, transient `data-turn-result` carries the grading/XP
 * projection, a non-transient `data-turn-reset` marker part precedes a
 * validation re-stream (the client slices the parts array on it).
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/20-streaming-data.mdx
 *       https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ courseId: string; waveNumber: string }> },
) {
  const userId = await resolveRequestUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  await ensureUserProfile(userId);

  const { courseId, waveNumber } = await params;
  // The body carries ONLY the payload — context is rebuilt from the DB
  // (LLM-stateless principle; client messages are never trusted/needed).
  const body: unknown = await req.json();
  const input = submitTurnInputSchema.safeParse({
    courseId,
    waveNumber: Number(waveNumber),
    payload: (body as { payload?: unknown }).payload,
  });
  if (!input.success) {
    return Response.json({ error: z.treeifyError(input.error) }, { status: 400 });
  }

  const stream = createUIMessageStream<WaveTurnUIMessage>({
    // Bind userId into ALS for the Cerebras rate limiter — same contract
    // as protectedProcedure (src/server/trpc.ts).
    execute: ({ writer }) =>
      userIdStore.run(userId, async () => {
        // Return value (token usage, logged by the live smoke only) is
        // deliberately dropped on the route.
        await streamWaveTurn(
          {
            userId,
            courseId: input.data.courseId,
            waveNumber: input.data.waveNumber,
            payload: input.data.payload,
          },
          writer,
        );
      }),
    // Surfaced to useChat's onError. Keep messages generic; TRPCError codes
    // from the guards (PRECONDITION_FAILED etc.) map to their message text.
    onError: (error) => (error instanceof Error ? error.message : "turn failed"),
  });

  return createUIMessageStreamResponse({ stream });
}
