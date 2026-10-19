import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod/v4";
import { resolveRequestUserId } from "@/server/requestUser";
import { submitTurnInputSchema } from "@/lib/types/waveTurnInput";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";
import { streamWaveTurn } from "@/lib/course/streamWaveTurn";
import { clientErrorText } from "@/lib/security/clientErrorText";
import { errorLogLine } from "@/lib/security/errorLogLine";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

// A turn can span LLM retries + Cerebras pacing; keep the function alive
// well past the worst case (3 attempts × generation + slow-lane spacing).
export const maxDuration = 300;

/**
 * Wave-turn transport: every learner turn arrives here.
 * Protocol: AI SDK UI Message Stream (SSE) — text parts carry
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
  // Text that is not JSON maps to null, so it gets the fixed 400 below.
  // V8's SyntaxError quotes the body's start (learner text), so it is never
  // thrown on to a log. Any other read error is a server fault: rethrow.
  const body: unknown = await req.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  // JSON null, an array or a scalar carries no `payload` field either.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const input = submitTurnInputSchema.safeParse({
    courseId,
    waveNumber: Number(waveNumber),
    payload: "payload" in body ? body.payload : undefined,
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
    // Surfaced to useChat's onError. Guard messages pass through; any other
    // error gets fixed text, since its message can quote answer keys (#169).
    // The log line carries ids and safe codes only, for the same reason.
    onError: (error) => {
      const place = { course: input.data.courseId, wave: input.data.waveNumber };
      process.stderr.write(`${errorLogLine("[wave-turn] turn failed", place, error)}\n`);
      return clientErrorText(error);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
