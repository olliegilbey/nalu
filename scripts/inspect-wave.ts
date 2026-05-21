/**
 * Dev inspection: dump a wave's `context_messages` (the LLM replay log —
 * exactly what the model is sent each turn, modulo renderContext's retry
 * filter) and `waves.chat_log` (the UI projection).
 *
 * Run: `bun --env-file=.env.local scripts/inspect-wave.ts <courseId> [waveNumber]`
 *
 * DB-only — needs `DATABASE_URL`, no `op run` / LLM key required.
 */

/* eslint-disable no-console -- CLI script: console is the output channel. */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { assessments, concepts, contextMessages, courses, waves } from "@/db/schema";

const CONTENT_CAP = 1600;

function show(content: string): string {
  return content.length > CONTENT_CAP
    ? `${content.slice(0, CONTENT_CAP)}\n…[+${content.length - CONTENT_CAP} chars truncated]`
    : content;
}

async function main(): Promise<void> {
  const courseId = process.argv[2];
  const waveNumber = Number(process.argv[3] ?? "1");
  if (!courseId) {
    console.error("usage: inspect-wave <courseId> [waveNumber]");
    process.exit(1);
  }

  const [wave] = await db
    .select()
    .from(waves)
    .where(and(eq(waves.courseId, courseId), eq(waves.waveNumber, waveNumber)));
  if (!wave) {
    console.error(`no wave ${waveNumber} for course ${courseId}`);
    process.exit(1);
  }
  console.log(`WAVE ${wave.id}  number=${wave.waveNumber} status=${wave.status} tier=${wave.tier}`);

  const msgs = await db
    .select()
    .from(contextMessages)
    .where(eq(contextMessages.waveId, wave.id))
    .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));

  console.log(`\n=== context_messages (${msgs.length} rows — the LLM replay log) ===`);
  for (const m of msgs) {
    console.log(`\n──[turn ${m.turnIndex} seq ${m.seq}] ${m.role} / ${m.kind}──`);
    console.log(show(m.content));
  }

  console.log(`\n\n=== waves.chat_log (UI projection) ===`);
  console.log(JSON.stringify(wave.chatLog, null, 2));

  // Course-wide scoring state: XP, SM-2 concepts, per-question assessments.
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  console.log(`\n\n=== course scoring ===`);
  console.log(`totalXp = ${course?.totalXp ?? "(course not found)"}`);

  const courseConcepts = await db.select().from(concepts).where(eq(concepts.courseId, courseId));
  console.log(`\n=== concepts (${courseConcepts.length}) ===`);
  for (const c of courseConcepts) {
    console.log(
      `- ${c.name}  tier=${c.tier}  reps=${c.repetitionCount}  lastQ=${c.lastQualityScore ?? "—"}  ` +
        `correct/incorrect=${c.timesCorrect}/${c.timesIncorrect}  nextReview=${c.nextReviewAt?.toISOString() ?? "—"}`,
    );
  }

  const allWaves = await db.select().from(waves).where(eq(waves.courseId, courseId));
  const waveIds = allWaves.map((w) => w.id);
  const courseAssessments =
    waveIds.length > 0
      ? await db.select().from(assessments).where(inArray(assessments.waveId, waveIds))
      : [];
  const totalAssessmentXp = courseAssessments.reduce((sum, a) => sum + a.xpAwarded, 0);
  console.log(
    `\n=== assessments across all waves (${courseAssessments.length}, xp sum=${totalAssessmentXp}) ===`,
  );
  for (const a of courseAssessments) {
    console.log(
      `- ${a.questionId ?? a.id}  ${a.assessmentKind}  correct=${a.isCorrect}  q=${a.qualityScore}  xp=${a.xpAwarded}`,
    );
  }

  process.exit(0);
}

void main();
