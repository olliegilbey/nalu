import { z } from "zod/v4";
import { getEnv } from "@/lib/config";
import { CORTI_EXPERT } from "@/lib/config/tuning";
import { CLINICAL_EXPERT_SYSTEM_PROMPT } from "@/lib/prompts/clinicalExpert";

/**
 * Client for Nalu's hosted Corti clinical-expert agent (feat/corti-path-a).
 *
 * This is NOT the models endpoint (`ai.eu.corti.app`, base64 bearer) — the
 * Agentic API uses OAuth client-credentials tokens (300s expiry) against
 * `api.eu.corti.app/v2/agentic` and speaks A2A `message:send`. Both flows
 * share the same CORTI_* credential trio from the console.
 *
 * EU-fixed hosts, matching the CORTI_BASE_URL default (branch experiment).
 */
const CORTI_AUTH_BASE = "https://auth.eu.corti.app";
const CORTI_AGENTIC_BASE = "https://api.eu.corti.app/v2/agentic";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

const agentSchema = z.object({ id: z.string(), name: z.string() });
const agentListSchema = z.object({ agents: z.array(agentSchema) });

// A2A SendMessage response, narrowed to the fields we consume. The reply
// text lives in task.artifacts[].parts[].text; credits in task.metadata.
const taskResponseSchema = z.object({
  task: z.object({
    status: z.object({ state: z.string() }),
    artifacts: z
      .array(z.object({ parts: z.array(z.object({ text: z.string().optional() })) }))
      .optional(),
    metadata: z
      .object({
        corti: z.object({ usage: z.object({ creditsConsumed: z.number() }).partial() }).partial(),
      })
      .partial()
      .optional(),
  }),
});

/** One expert reply: answer text plus Corti's per-task credit charge (absent if unreported). */
export interface ClinicalExpertReply {
  readonly answer: string;
  readonly creditsConsumed?: number;
}

// Module-level caches — intentional mutable singletons (token expires in
// 300s; the ephemeral agent id survives until Corti expires it, and a 404
// on send clears it for recreation).
let tokenCache: { token: string; expiresAtMs: number } | null = null;
let agentIdCache: string | null = null;

function requireTrio() {
  const env = getEnv();
  if (!env.CORTI_TENANT_NAME || !env.CORTI_CLIENT_ID || !env.CORTI_CLIENT_SECRET) {
    throw new Error(
      "Corti clinical expert needs CORTI_TENANT_NAME / CORTI_CLIENT_ID / CORTI_CLIENT_SECRET in the environment.",
    );
  }
  return {
    tenant: env.CORTI_TENANT_NAME,
    id: env.CORTI_CLIENT_ID,
    secret: env.CORTI_CLIENT_SECRET,
  };
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs) return tokenCache.token;
  const { tenant, id, secret } = requireTrio();
  const res = await fetch(`${CORTI_AUTH_BASE}/realms/${tenant}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
    }),
    signal: AbortSignal.timeout(CORTI_EXPERT.requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`Corti token mint failed: HTTP ${res.status}`);
  const parsed = tokenResponseSchema.parse(await res.json());
  tokenCache = {
    token: parsed.access_token,
    expiresAtMs: Date.now() + parsed.expires_in * 1000 - CORTI_EXPERT.tokenRefreshMarginMs,
  };
  return parsed.access_token;
}

function agenticHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Tenant-Name": requireTrio().tenant,
    "Content-Type": "application/json",
  };
}

/**
 * Find-or-create the expert agent by name. Corti creates agents with
 * `lifecycle: "ephemeral"` — they can disappear, so callers clear
 * `agentIdCache` on a 404 and retry once through here.
 */
async function ensureExpertAgentId(token: string): Promise<string> {
  if (agentIdCache) return agentIdCache;
  const listRes = await fetch(`${CORTI_AGENTIC_BASE}/agents`, {
    headers: agenticHeaders(token),
    signal: AbortSignal.timeout(CORTI_EXPERT.requestTimeoutMs),
  });
  if (!listRes.ok) throw new Error(`Corti agent list failed: HTTP ${listRes.status}`);
  const list = agentListSchema.parse(await listRes.json());
  const existing = list.agents.find((a) => a.name === CORTI_EXPERT.agentName);
  if (existing) {
    agentIdCache = existing.id;
    return existing.id;
  }
  const createRes = await fetch(`${CORTI_AGENTIC_BASE}/agents`, {
    method: "POST",
    headers: agenticHeaders(token),
    body: JSON.stringify({
      name: CORTI_EXPERT.agentName,
      description: "Nalu clinical grounding expert",
      systemPrompt: CLINICAL_EXPERT_SYSTEM_PROMPT,
    }),
    signal: AbortSignal.timeout(CORTI_EXPERT.requestTimeoutMs),
  });
  if (!createRes.ok) throw new Error(`Corti agent create failed: HTTP ${createRes.status}`);
  const created = agentSchema.parse(await createRes.json());
  agentIdCache = created.id;
  return created.id;
}

/**
 * Ask the hosted clinical expert one question (stateless: fresh A2A context
 * per call). Throws on transport/auth failure or non-completed task — the
 * tool wrapper converts throws into model-readable `{ error }` results.
 */
export async function askClinicalExpert(question: string): Promise<ClinicalExpertReply> {
  const token = await getAccessToken();
  let agentId = await ensureExpertAgentId(token);

  const send = (id: string) =>
    fetch(`${CORTI_AGENTIC_BASE}/agents/${id}/a2a/message:send`, {
      method: "POST",
      headers: agenticHeaders(token),
      body: JSON.stringify({
        message: {
          role: "user",
          parts: [{ kind: "text", text: question }],
          messageId: crypto.randomUUID(),
          kind: "message",
        },
      }),
      signal: AbortSignal.timeout(CORTI_EXPERT.requestTimeoutMs),
    });

  let res = await send(agentId);
  if (res.status === 404) {
    // Ephemeral agent expired server-side — recreate once and retry.
    agentIdCache = null;
    agentId = await ensureExpertAgentId(token);
    res = await send(agentId);
  }
  if (!res.ok) throw new Error(`Corti expert message:send failed: HTTP ${res.status}`);

  const { task } = taskResponseSchema.parse(await res.json());
  if (task.status.state !== "TASK_STATE_COMPLETED") {
    throw new Error(`Corti expert task ended in state ${task.status.state}`);
  }
  const answer = (task.artifacts ?? [])
    .flatMap((a) => a.parts)
    .map((p) => p.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n")
    .trim();
  if (!answer) throw new Error("Corti expert returned an empty answer");
  return { answer, creditsConsumed: task.metadata?.corti?.usage?.creditsConsumed };
}
