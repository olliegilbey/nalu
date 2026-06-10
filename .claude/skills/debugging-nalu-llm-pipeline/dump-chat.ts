/**
 * Read-only, human-readable dump of one course's entire Context (scoping + waves).
 * Sibling to inspect-db.ts but renders the actual chat — colored per side, with
 * the assistant's JSON payloads (questions, framework, gradings, blueprint)
 * parsed into readable blocks instead of raw one-liners. SELECT only.
 *
 *   bun .claude/skills/debugging-nalu-llm-pipeline/dump-chat.ts --course <uuid>
 *   bun .../dump-chat.ts --course <uuid> --json | jq      # structured output
 *   bun .../dump-chat.ts --course <uuid> --full           # include retry schema
 *
 * Colors auto-disable when stdout isn't a TTY (piping to a file / jq) or when
 * NO_COLOR is set, so redirected output stays clean.
 */
/* eslint-disable no-console -- standalone CLI debugging tool: stdout IS the output */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — run from project root so bun loads .env.local");
  process.exit(1);
}
const sql = postgres(url, { prepare: false });

const argv = process.argv.slice(2);
const courseId = argv[argv.indexOf("--course") + 1];
const asJson = argv.includes("--json");
const showFullSchema = argv.includes("--full");
if (!courseId || courseId.startsWith("--")) {
  console.error("Usage: dump-chat.ts --course <uuid> [--json] [--full]");
  process.exit(1);
}

// --- ANSI styling ----------------------------------------------------------
// Disable when piped (no TTY) or NO_COLOR set, so redirected output is plain.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
/** Wrap `s` in the given SGR codes (e.g. 1=bold, 2=dim, 31=red). No-op if color off. */
const sty = (s: string, ...codes: number[]): string =>
  useColor ? `\x1b[${codes.join(";")}m${s}\x1b[0m` : s;

// Per-role palette: learner=cyan, tutor=green, rejected=red, harness=yellow.
const C = {
  learner: 36,
  tutor: 32,
  rejected: 31,
  harness: 33,
  q: 33,
  grade: 35,
  fw: 34,
  dim: 2,
  bold: 1,
} as const;

/** Word-wrap `text` to `width` cols, prefixing every line with `indent` spaces. */
const wrap = (text: string, indent = 2, width = 84): string => {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = "";
    for (const word of rawLine.split(/\s+/).filter(Boolean)) {
      if (line && pad.length + line.length + 1 + word.length > width) {
        out.push(pad + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(pad + line); // preserves blank lines and short lines
  }
  return out.join("\n");
};

const hr = (label = ""): string =>
  sty(
    label ? `──── ${label} ` + "─".repeat(Math.max(0, 60 - label.length)) : "─".repeat(66),
    C.dim,
  );

const hhmmss = (d: Date): string => d.toISOString().slice(11, 19);

/** Try to parse JSON content; null when it's plain text (e.g. a wave opening). */
const tryJson = (s: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// --- renderers for the known assistant payload shapes ----------------------

type Q = {
  id: string;
  type: string;
  prompt: string;
  options?: Record<string, string>;
  correct?: string;
  conceptName?: string;
  tier?: number;
};

const renderQuestions = (qs: readonly Q[]): string =>
  qs
    .map((q) => {
      const kind = q.type === "multiple_choice" ? "MC" : "free";
      const prefix = sty(`   ${q.id}`, C.bold, C.q) + sty(` [${kind}] `, C.dim);
      // Wrap the prompt with a hanging indent: first line follows the id/kind
      // prefix, continuations align under it.
      const promptLines = wrap(q.prompt, 8).split("\n");
      promptLines[0] = promptLines[0].trimStart();
      const lines = [prefix + promptLines[0], ...promptLines.slice(1)];
      if (q.options) {
        const opts = Object.entries(q.options)
          .map(([k, v]) => {
            const mark = q.correct === k ? sty("✓", C.bold, C.tutor) : "·";
            return `${k}${mark} ${v}`;
          })
          .join("   ");
        lines.push("        " + opts);
      }
      if (q.conceptName) {
        lines.push(
          sty(`        ↳ ${q.conceptName}${q.tier != null ? ` (tier ${q.tier})` : ""}`, C.dim),
        );
      }
      return lines.join("\n");
    })
    .join("\n");

type Tier = {
  number: number;
  name: string;
  description: string;
  exampleConcepts?: readonly string[];
};

const renderTiers = (tiers: readonly Tier[]): string =>
  tiers
    .map((t) => {
      const lines = [sty(`   Tier ${t.number}: ${t.name}`, C.bold, C.fw), wrap(t.description, 6)];
      for (const ex of t.exampleConcepts ?? []) lines.push(sty(`        • ${ex}`, C.dim));
      return lines.join("\n");
    })
    .join("\n\n");

type Grading = {
  questionId: string;
  verdict?: string;
  qualityScore?: number;
  conceptName?: string;
  rationale?: string;
};

const renderGradings = (gs: readonly Grading[]): string =>
  gs
    .map((g) => {
      const vColor =
        g.verdict === "correct" ? C.tutor : g.verdict === "incorrect" ? C.rejected : C.q;
      const verdict = g.verdict ? sty(g.verdict, vColor) : sty("graded", C.dim);
      const score = g.qualityScore != null ? sty(` q${g.qualityScore}`, C.dim) : "";
      const concept = g.conceptName ? sty(`  ${g.conceptName}`, C.dim) : "";
      const lines = [`   ${sty(g.questionId, C.bold)}  ${verdict}${score}${concept}`];
      if (g.rationale) lines.push(sty(wrap(g.rationale, 6), C.dim));
      return lines.join("\n");
    })
    .join("\n");

type Blueprint = {
  topic?: string;
  outline?: readonly string[];
  plannedConcepts?: readonly { name: string; tier?: number; role?: string }[];
};

const renderBlueprint = (b: Blueprint): string => {
  const lines = [sty("  Next-lesson blueprint", C.bold, C.fw)];
  if (b.topic) lines.push(`    topic: ${b.topic}`);
  for (const o of b.outline ?? []) lines.push(sty(`      • ${o}`, C.dim));
  for (const pc of b.plannedConcepts ?? []) {
    lines.push(sty(`      ↳ ${pc.name} (tier ${pc.tier ?? "?"}, ${pc.role ?? "?"})`, C.dim));
  }
  return lines.join("\n");
};

/** Render an assistant payload (already JSON-parsed) into readable blocks. */
const renderAssistant = (p: Record<string, unknown>): string => {
  const blocks: string[] = [];
  if (typeof p.userMessage === "string") blocks.push(wrap(p.userMessage, 2));

  const nested = p.questions as { questions?: readonly Q[] } | undefined;
  if (nested?.questions)
    blocks.push(sty("  Questions", C.bold, C.q) + "\n" + renderQuestions(nested.questions));

  if (Array.isArray(p.tiers)) {
    const tail = sty(
      `   (estimated starting tier ${String(p.estimatedStartingTier)}, baseline scope ${JSON.stringify(p.baselineScopeTiers)})`,
      C.dim,
    );
    blocks.push(
      sty("  Framework", C.bold, C.fw) + "\n" + renderTiers(p.tiers as Tier[]) + "\n" + tail,
    );
  }

  if (Array.isArray(p.gradings)) {
    blocks.push(sty("  Grading", C.bold, C.grade) + "\n" + renderGradings(p.gradings as Grading[]));
  }
  if (typeof p.summary === "string")
    blocks.push(sty("  Summary", C.bold) + "\n" + wrap(p.summary, 4));
  if (typeof p.immutableSummary === "string") {
    blocks.push(
      sty("  Immutable summary (locked into course)", C.bold) + "\n" + wrap(p.immutableSummary, 4),
    );
  }
  if (p.nextUnitBlueprint && typeof p.nextUnitBlueprint === "object") {
    blocks.push(renderBlueprint(p.nextUnitBlueprint as Blueprint));
  }
  return blocks.join("\n\n");
};

type Answer = { id: string; kind: string; selected?: string; text?: string; fromEscape?: boolean };

/** Render a learner message: parse <stage>/<learner_input>, prettify JSON answers. */
const renderLearner = (content: string): string => {
  const stage = /<stage>(.*?)<\/stage>/s.exec(content)?.[1]?.trim() ?? "";
  const input =
    /<learner_input>(.*?)<\/learner_input>/s.exec(content)?.[1]?.trim() ?? content.trim();
  const json = tryJson(input);
  const answers = json?.answers as Answer[] | undefined;
  if (answers) {
    const lines = answers.map((a) =>
      a.kind === "mc"
        ? `    ${sty(a.id, C.bold)}: chose ${a.selected}`
        : `    ${sty(a.id, C.bold)}: "${a.text}"${a.fromEscape ? sty(" (free-text escape)", C.dim) : ""}`,
    );
    return (stage ? sty(`  [${stage}]`, C.dim) + "\n" : "") + lines.join("\n");
  }
  return (stage ? sty(`  [${stage}]`, C.dim) + "\n" : "") + wrap(input || "(empty)", 2);
};

/** Render the harness retry directive: keep the human note, fold the big schema. */
const renderHarness = (content: string): string => {
  const idx = content.indexOf("<response_schema>");
  if (idx === -1 || showFullSchema) return wrap(content, 2);
  const note = content.slice(0, idx).trim();
  const schemaLen = content.length - idx;
  return (
    wrap(note, 2) +
    "\n" +
    sty(`  [response schema folded — ${schemaLen} chars; pass --full to show]`, C.dim)
  );
};

// Map a DB row to a colored header + rendered body.
type Row = {
  kind: string;
  role: string;
  content: string;
  created_at: Date;
  turn_index: number;
  seq: number;
};

const render = (m: Row): string => {
  const t = hhmmss(m.created_at);
  if (m.role === "user" && m.kind === "user_message") {
    return (
      sty(`▶ LEARNER`, C.bold, C.learner) + sty(` · ${t}`, C.dim) + "\n" + renderLearner(m.content)
    );
  }
  if (m.kind === "harness_retry_directive") {
    return (
      sty(`⚙ HARNESS retry directive`, C.bold, C.harness) +
      sty(` · ${t}`, C.dim) +
      "\n" +
      renderHarness(m.content)
    );
  }
  const rejected = m.kind === "failed_assistant_response";
  const label = rejected
    ? sty(`◀ TUTOR (rejected — schema fail)`, C.bold, C.rejected)
    : sty(`◀ TUTOR`, C.bold, C.tutor);
  const parsed = tryJson(m.content);
  const body = parsed ? renderAssistant(parsed) : wrap(m.content, 2);
  return label + sty(` · ${t}`, C.dim) + "\n" + body;
};

// --- query -----------------------------------------------------------------
const course = (
  await sql`SELECT topic, status, created_at FROM courses WHERE id = ${courseId}`
)[0] as { topic: string; status: string; created_at: Date } | undefined;
if (!course) {
  console.error(`No course ${courseId}`);
  await sql.end();
  process.exit(1);
}

const scoping = (await sql`
  SELECT cm.turn_index, cm.seq, cm.kind, cm.role, cm.created_at, cm.content
  FROM context_messages cm
  JOIN scoping_passes sp ON sp.id = cm.scoping_pass_id
  WHERE sp.course_id = ${courseId}
  ORDER BY cm.turn_index, cm.seq`) as unknown as Row[];

const waves = (await sql`
  SELECT cm.turn_index, cm.seq, cm.kind, cm.role, cm.created_at, cm.content, w.wave_number
  FROM context_messages cm
  JOIN waves w ON w.id = cm.wave_id
  WHERE w.course_id = ${courseId}
  ORDER BY w.wave_number, cm.turn_index, cm.seq`) as unknown as (Row & { wave_number: number })[];

await sql.end();

// --- output ----------------------------------------------------------------
if (asJson) {
  // Structured dump for jq: parse JSON content where possible, else keep text.
  const shape = (m: Row & { wave_number?: number }) => {
    const parsed = m.role === "user" && m.kind === "user_message" ? null : tryJson(m.content);
    return {
      wave: m.wave_number ?? null,
      turn: m.turn_index,
      seq: m.seq,
      kind: m.kind,
      role: m.role,
      at: m.created_at.toISOString(),
      ...(parsed ? { content: parsed } : { text: m.content }),
    };
  };
  console.log(
    JSON.stringify(
      { course: { id: courseId, ...course }, scoping: scoping.map(shape), waves: waves.map(shape) },
      null,
      2,
    ),
  );
} else {
  console.log(sty(`COURSE  ${course.topic}`, C.bold));
  console.log(sty(`status ${course.status}  ·  created ${course.created_at.toISOString()}`, C.dim));
  console.log("\n" + hr("SCOPING") + "\n");
  console.log(scoping.map(render).join("\n\n"));
  if (waves.length) {
    console.log("\n" + hr("WAVES") + "\n");
    console.log(waves.map(render).join("\n\n"));
  }
  console.log("");
}
