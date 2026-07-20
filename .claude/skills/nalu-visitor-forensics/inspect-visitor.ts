/**
 * Read-only inspector for who hit Nalu in production, from where, and what they did.
 * A `.claude/` tool, never imported by the app; SELECT-only DB reads + read-only HTTP.
 *
 * Joins the three sources the app already produces:
 *   - PostHog `$pageview` events — geo, `client_ip`, referrer, user agent
 *   - `whois` (Team Cymru) — the IP's ASN and owning org
 *   - the production DB — `courses`, joined on `distinct_id` = `courses.user_id`
 *
 * Read `client_ip`, never `$ip`: PostHog consumes the magic `$ip` for GeoIP and
 * strips it from the stored event, so `src/lib/analytics/buildPageviewEvent.ts`
 * mirrors the value into `client_ip`. Querying `$ip` returns nothing.
 *
 * Env (both from `.env.local`, auto-loaded by `bun` from the project root):
 *   - `POSTHOG_PERSONAL_API_KEY` — a `phx_` personal key, scope `query:read`.
 *     The `phc_` POSTHOG_KEY is the ingestion key and CANNOT read.
 *   - `DATABASE_URL` — pooled (PgBouncer) production Supabase.
 *
 * Usage (run from the project root so bun loads .env.local):
 *   bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts [flags]
 *
 * `--minutes N` (default 1440): window, N minutes back.
 * `--since <ISO>`: absolute timestamp; wins over `--minutes`.
 * `--ip <addr>`: every event ever from one IP, across both apps. Ignores the window.
 * `--distinct <id>`: every event ever for one distinct_id. Ignores the window.
 */
/* eslint-disable no-console -- standalone CLI debugging tool: stdout (console.log / console.table) IS the output, unlike app code in src/ */
import { execFileSync } from "node:child_process";
import postgres from "postgres";

// --- argument parsing ------------------------------------------------------
const args = process.argv.slice(2);
/** Read the value following a `--flag` token, or undefined if absent. */
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ipArg = flag("--ip");
const distinctArg = flag("--distinct");
const sinceArg = flag("--since");
const minutes = Number(flag("--minutes") ?? 1440);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("Invalid --minutes value: expected a positive number");
  process.exit(1);
}

// Lower time bound for the window query. `--since` (absolute ISO) wins when
// present; otherwise look back `--minutes` from now. Both are ignored entirely
// by --ip / --distinct, which are "everything ever for this one subject".
const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - minutes * 60_000);
if (Number.isNaN(since.getTime())) {
  console.error("Invalid time window — check --since (ISO 8601) / --minutes (number)");
  process.exit(1);
}

const posthogKey = process.env.POSTHOG_PERSONAL_API_KEY;
if (!posthogKey) {
  console.error(
    "POSTHOG_PERSONAL_API_KEY not set — add a phx_ personal key (scope: query:read) to\n" +
      ".env.local and run from the project root so bun loads it. The phc_ POSTHOG_KEY is\n" +
      "the write-only ingestion key and cannot read events. See this skill's SKILL.md.",
  );
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set — run from the project root so bun loads .env.local");
  process.exit(1);
}

// `prepare: false`: mandatory for the pooled PgBouncer URL.
const sql = postgres(dbUrl, { prepare: false });

// --- PostHog ---------------------------------------------------------------
/** Single-quote a value as a HogQL literal, escaping embedded quotes. */
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

// --ip / --distinct pin one subject and deliberately drop the app/source filter,
// so a cross-app hit (the PostHog project is shared with resumate) still shows up.
const where = ipArg
  ? `properties.client_ip = ${lit(ipArg)}`
  : distinctArg
    ? `distinct_id = ${lit(distinctArg)}`
    : `properties.app = 'nalu' AND properties.source = 'production' AND timestamp > ${lit(since.toISOString())}`;

const hogql = `SELECT timestamp, distinct_id, properties.app, properties.$pathname,
    properties.client_ip, properties.$geoip_city_name, properties.$geoip_country_name,
    properties.$referrer, properties.$raw_user_agent
  FROM events WHERE ${where} ORDER BY timestamp DESC LIMIT 200`;

// `@current` resolves the project from the key itself — required, because the key's
// scope is query:read only, with no project:read to enumerate project ids.
const response = await fetch("https://eu.posthog.com/api/projects/@current/query/", {
  method: "POST",
  headers: { Authorization: `Bearer ${posthogKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
});
if (!response.ok) {
  console.error(`PostHog query failed: HTTP ${response.status} ${response.statusText}`);
  console.error(await response.text());
  await sql.end();
  process.exit(1);
}

/** One PostHog row, positional per the SELECT above. */
type Event = {
  timestamp: string;
  distinctId: string;
  app: string | null;
  pathname: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
  referrer: string | null;
  userAgent: string | null;
};
const payload = (await response.json()) as { results?: unknown[][] };
const events: Event[] = (payload.results ?? []).map((r) => ({
  timestamp: String(r[0] ?? ""),
  distinctId: String(r[1] ?? ""),
  app: (r[2] as string) ?? null,
  pathname: (r[3] as string) ?? null,
  ip: (r[4] as string) ?? null,
  city: (r[5] as string) ?? null,
  country: (r[6] as string) ?? null,
  referrer: (r[7] as string) ?? null,
  userAgent: (r[8] as string) ?? null,
}));

// --- enrichment ------------------------------------------------------------
const asnCache = new Map<string, string>();
/**
 * `AS<n> <org>` for an IP via Team Cymru's whois. The owning org is the whole
 * point: a residential ASN (Virgin Media, BT) means a real visitor on home
 * broadband, while a datacenter ASN (M247, DataCamp) means a VPN or proxy.
 * execFileSync runs whois without a shell, so the IP can't inject.
 */
const lookupAsn = (ip: string): string => {
  const cached = asnCache.get(ip);
  if (cached) return cached;
  let result: string;
  try {
    const out = execFileSync("whois", ["-h", "whois.cymru.com", ` -v ${ip}`], {
      encoding: "utf8",
      timeout: 15_000,
    });
    // Cymru replies with a header line, then: AS | IP | BGP Prefix | CC | Registry | Allocated | AS Name
    const cols = (out.trim().split("\n").at(-1) ?? "").split("|").map((c) => c.trim());
    result = cols.length >= 7 && cols[0] ? `AS${cols[0]} ${cols[6]}` : "(unknown)";
  } catch {
    result = "(whois failed)";
  }
  asnCache.set(ip, result);
  return result;
};

/** Collapse newlines and clip long content so a row fits one terminal line. */
const preview = (text: string, max = 160): string => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

/**
 * Compact `Chrome/macOS` label, or `bot` for anything automated.
 * Bot test is deliberately the INVERSE of a name list: every real browser sends
 * `Mozilla/`, so its absence catches scanners, curl and monitoring probes we've
 * never heard of. Enumerating bot names misses each new one (a `last25-scanner`
 * deploy probe slipped through a `bot|crawl|spider` list and read as a human).
 */
const device = (ua: string | null): string => {
  if (!ua) return "-";
  if (!/Mozilla\//.test(ua) || /bot\b|crawl|spider|slurp|headless|scanner|probe/i.test(ua)) {
    return "bot";
  }
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "?";
  const os = /Macintosh|Mac OS X/.test(ua)
    ? "macOS"
    : /Windows/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /X11|Linux/.test(ua)
            ? "Linux"
            : "?";
  return `${browser}/${os}`;
};

/** Hostname of a referrer URL; `direct` when absent, raw value if it won't parse. */
const refDomain = (referrer: string | null): string => {
  if (!referrer || referrer === "$direct") return "direct";
  try {
    return new URL(referrer).hostname;
  } catch {
    return referrer;
  }
};

// --- DB join ---------------------------------------------------------------
// distinct_id IS the anon Supabase user id (src/proxy.ts sets it), so it joins
// straight to courses.user_id — that's what turns "someone visited" into "someone
// visited AND here is the course they started".
type CourseRow = { user_id: string; id: string; topic: string; status: string };
const ids = [...new Set(events.map((e) => e.distinctId).filter(Boolean))];
const courses =
  ids.length > 0
    ? await sql<CourseRow[]>`
        SELECT user_id::text AS user_id, id::text AS id, topic, status
        FROM courses WHERE user_id::text IN ${sql(ids)}
        ORDER BY created_at DESC`
    : [];
await sql.end();

// One user can start several courses; keep the newest (the ORDER BY above) per user.
const courseByUser = new Map<string, CourseRow>();
for (const c of courses) if (!courseByUser.has(c.user_id)) courseByUser.set(c.user_id, c);

// --- output ----------------------------------------------------------------
const scope = ipArg
  ? `ip ${ipArg}`
  : distinctArg
    ? `distinct_id ${distinctArg}`
    : `app=nalu, source=production, since ${since.toISOString()}`;
console.log(`\n=== VISITORS (${events.length}) — ${scope} ===`);

if (events.length === 0) {
  console.log("\nNo events. If you expected some: the window may be too narrow (--minutes),");
  console.log("or the visit predates PostHog capture landing in production (2026-07-08).");
} else {
  console.table(
    events.map((e) => ({
      when: e.timestamp.slice(0, 19).replace("T", " "),
      app: e.app ?? "-",
      path: e.pathname ?? "-",
      where: [e.city, e.country].filter(Boolean).join(", ") || "-",
      ip: e.ip ?? "-",
      org: e.ip ? preview(lookupAsn(e.ip), 44) : "-",
      from: refDomain(e.referrer),
      device: device(e.userAgent),
      topic: courseByUser.get(e.distinctId)?.topic ?? "-",
      got: courseByUser.get(e.distinctId)?.status ?? "-",
    })),
  );

  // Iterate the courses, not the events: `events` is one row per pageview, so a
  // visitor who navigated several pages would otherwise get the same dump-chat
  // line printed once per page.
  const started = [...courseByUser.values()];
  if (started.length > 0) {
    console.log("\nRead a visitor's full conversation:");
    for (const course of started.slice(0, 10)) {
      console.log(
        `  bun .claude/skills/debugging-nalu-llm-pipeline/dump-chat.ts --course ${course.id}`,
      );
    }
    if (started.length > 10) {
      console.log(`  … and ${started.length - 10} more — use --distinct <id> to isolate one`);
    }
  }
}
