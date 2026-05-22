/**
 * Read-only production-DB inspector for debugging Nalu LLM-pipeline failures.
 *
 * This is a DEBUGGING TOOL, not application code — it lives under `.claude/`
 * and is never imported by the app. It issues SELECT statements only.
 *
 * Connection: reads `DATABASE_URL` from `.env.local`, which `bun` auto-loads
 * from the project root. That URL points at the pooled (PgBouncer) production
 * Supabase endpoint, so `prepare: false` is required — prepared statements do
 * not survive PgBouncer's per-transaction connection binding.
 *
 * Usage (run from the project root):
 *   bun .claude/skills/debugging-nalu-llm-pipeline/inspect-db.ts --minutes 30
 *   bun .claude/skills/debugging-nalu-llm-pipeline/inspect-db.ts --since 2026-05-21T19:00:00Z
 *   bun .claude/skills/debugging-nalu-llm-pipeline/inspect-db.ts --course <uuid>
 *
 * `--minutes N` (default 30): overview window — looks back N minutes from now.
 * `--since <ISO>`: overview window from an absolute timestamp. Use this for an
 *   incident older than a convenient `--minutes` lookback (it wins over
 *   `--minutes` when both are given).
 * `--course <uuid>`: drill into one course — prints every context_messages row
 *   with a content preview, so you can read the actual prompts and the failed
 *   model replies that the SKILL.md decision tree refers to.
 */
/* eslint-disable no-console -- standalone CLI debugging tool: stdout (console.log / console.table) IS the output, unlike app code in src/ */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — run from the project root so bun loads .env.local");
  process.exit(1);
}

// `prepare: false`: mandatory for the pooled PgBouncer URL (see file header).
const sql = postgres(url, { prepare: false });

// --- argument parsing ------------------------------------------------------
const args = process.argv.slice(2);
/** Read the value following a `--flag` token, or undefined if absent. */
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const courseId = flag("--course");
const sinceArg = flag("--since");
const minutes = Number(flag("--minutes") ?? 30);

// Lower time bound for the overview queries. `--since` (an absolute ISO
// timestamp) wins when given — reach for it when the incident is older than a
// convenient `--minutes` lookback. Otherwise look back `--minutes` from now.
const cutoff = sinceArg ? new Date(sinceArg) : new Date(Date.now() - minutes * 60_000);
if (Number.isNaN(cutoff.getTime())) {
  console.error("Invalid time window — check --since (ISO 8601) / --minutes (number)");
  process.exit(1);
}

/** Collapse newlines and clip long content so a row fits one terminal line. */
const preview = (text: string, max = 160): string => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

console.log("query time:", new Date().toISOString());

if (courseId) {
  // --- DRILL-DOWN MODE: one course, full context-message trail -------------
  console.log(`\n=== COURSE ${courseId} ===`);
  const course = await sql`
    SELECT id, user_id, topic, status,
           clarification IS NOT NULL AS has_clarification,
           framework     IS NOT NULL AS has_framework,
           baseline      IS NOT NULL AS has_baseline,
           starting_tier, current_tier, total_xp, created_at, updated_at
    FROM courses WHERE id = ${courseId}`;
  console.table(course);

  const passes = await sql`
    SELECT id, status, opened_at, closed_at
    FROM scoping_passes WHERE course_id = ${courseId}
    ORDER BY opened_at`;
  console.log("\n=== SCOPING PASSES ===");
  console.table(passes);

  // Every scoping context message in turn order. Zero rows here when the
  // course has a scoping pass means the LLM never returned (transport failure).
  const msgs = await sql`
    SELECT cm.turn_index, cm.seq, cm.kind, cm.role,
           length(cm.content) AS len, cm.created_at, cm.content
    FROM context_messages cm
    JOIN scoping_passes sp ON sp.id = cm.scoping_pass_id
    WHERE sp.course_id = ${courseId}
    ORDER BY cm.turn_index, cm.seq`;
  console.log(`\n=== SCOPING CONTEXT MESSAGES (${msgs.length} rows) ===`);
  for (const m of msgs) {
    console.log(
      `\n[turn ${m.turn_index} seq ${m.seq}] ${m.kind} (${m.role}) — ${m.len} chars — ${m.created_at.toISOString()}`,
    );
    console.log("  " + preview(m.content as string, 400));
  }

  // --- scoping-close lifecycle: did submitBaseline complete? -------------
  // submitBaseline persists the learner's answers into the baseline JSONB
  // BEFORE its LLM call; then, on success, persistScopingClose widens that
  // JSONB, opens Wave 1, upserts concepts, and flips status to 'active' — all
  // one transaction. A transport failure on the close LLM call leaves the
  // answers saved but none of the rest: baseline NOT widened, 0 waves,
  // 0 concepts, status still 'scoping', no new context_messages turn.
  const baselineShape = await sql`
    SELECT baseline ? 'startingTier' AS widened,
           baseline ? 'responses'   AS has_responses,
           jsonb_array_length(baseline->'responses') AS n_responses,
           jsonb_array_length(baseline->'questions') AS n_questions
    FROM courses WHERE id = ${courseId}`;
  console.log("\n=== BASELINE JSONB SHAPE (widened = submitBaseline closed) ===");
  console.table(baselineShape);

  // `chatlog_entries` is the UI log length. Compare it against the wave's
  // `assistant_response` rows below: `context_messages` is the LLM replay log,
  // `chat_log` is the UI log, and a turn present in the former but not the
  // latter is a POST-PERSIST failure (see SKILL.md Step 4).
  const waves = await sql`
    SELECT id, wave_number, tier, status,
           jsonb_array_length(chat_log) AS chatlog_entries,
           opened_at, closed_at
    FROM waves WHERE course_id = ${courseId}
    ORDER BY wave_number`;
  console.log(`\n=== WAVES (${waves.length}) ===`);
  console.table(waves);

  // Wave teaching turns. A turn whose `executeTurn` committed a clean
  // `assistant_response` here — yet is not reflected in `chatlog_entries`
  // above — is a POST-PERSIST failure: executeWaveMid/Close threw AFTER
  // executeTurn's atomic batch (grading, assessments, or the chat_log append).
  const waveMsgs = await sql`
    SELECT w.wave_number, cm.turn_index, cm.seq, cm.kind, cm.role,
           length(cm.content) AS len, cm.created_at, cm.content
    FROM context_messages cm
    JOIN waves w ON w.id = cm.wave_id
    WHERE w.course_id = ${courseId}
    ORDER BY w.wave_number, cm.turn_index, cm.seq`;
  console.log(`\n=== WAVE CONTEXT MESSAGES (${waveMsgs.length} rows) ===`);
  for (const m of waveMsgs) {
    console.log(
      `\n[wave ${m.wave_number} turn ${m.turn_index} seq ${m.seq}] ${m.kind} (${m.role}) — ${m.len} chars — ${m.created_at.toISOString()}`,
    );
    console.log("  " + preview(m.content as string, 400));
  }

  const concepts = await sql`
    SELECT count(*)::int AS concept_count FROM concepts WHERE course_id = ${courseId}`;
  console.log("\n=== CONCEPTS ===");
  console.table(concepts);
} else {
  // --- OVERVIEW MODE: recent activity across all users --------------------
  console.log(`\n(window: since ${cutoff.toISOString()})`);

  const courses = await sql`
    SELECT id, user_id, topic, status,
           clarification IS NOT NULL AS has_clarification,
           framework     IS NOT NULL AS has_framework,
           baseline      IS NOT NULL AS has_baseline,
           created_at
    FROM courses
    WHERE created_at > ${cutoff}
    ORDER BY created_at DESC`;
  console.log(`\n=== RECENT COURSES (${courses.length}) ===`);
  console.table(courses);

  // One row per recent scoping pass, with message counts via LEFT JOIN so a
  // pass with ZERO messages still appears (msgs = 0) instead of vanishing.
  // This row IS the diagnosis (see SKILL.md decision tree):
  //   msgs = 0    → TRANSPORT failure — the LLM never returned a byte
  //   failed > 0  → SCHEMA failure — the LLM replied but output failed Zod
  //   ok > 0      → that turn succeeded; look at the next stage
  const passes = await sql`
    SELECT sp.id AS scoping_pass_id, sp.course_id, c.topic,
           c.status AS course_status, sp.status AS pass_status, sp.opened_at,
           count(cm.id)::int AS msgs,
           count(*) FILTER (WHERE cm.kind = 'failed_assistant_response')::int AS failed,
           count(*) FILTER (WHERE cm.kind = 'assistant_response')::int AS ok
    FROM scoping_passes sp
    JOIN courses c ON c.id = sp.course_id
    LEFT JOIN context_messages cm ON cm.scoping_pass_id = sp.id
    WHERE sp.opened_at > ${cutoff}
    GROUP BY sp.id, sp.course_id, c.topic, c.status, sp.status, sp.opened_at
    ORDER BY sp.opened_at DESC`;
  console.log(
    `\n=== RECENT SCOPING PASSES — msgs=0 transport / failed>0 schema (${passes.length}) ===`,
  );
  console.table(passes);

  const users = await sql`
    SELECT id, display_name, total_xp, created_at
    FROM user_profiles
    WHERE created_at > ${cutoff}
    ORDER BY created_at DESC`;
  console.log(`\n=== RECENT USER PROFILES (${users.length}) ===`);
  console.table(users);

  console.log("\nDrill into any course with:  --course <uuid>");
}

await sql.end();
