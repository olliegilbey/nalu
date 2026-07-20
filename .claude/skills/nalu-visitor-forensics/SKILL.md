---
name: nalu-visitor-forensics
description: Use when asked who visited Nalu in production and where they came from — "someone hit the site", "who was that visitor", "where is this traffic from", "was that a real person or a bot", "what did that visitor actually do". Recovers a production visitor's IP, geo, owning organisation (ASN), referrer and device from PostHog, and joins them to the course they started in the DB. Also use to check whether recent prod traffic is human or automated.
---

# Nalu Visitor Forensics

## Overview

Nalu's `src/proxy.ts` captures one anonymous server-side PostHog `$pageview` per
production navigation. That event carries everything needed to answer "who hit the
site, from where, and what did they do" — the only trick is that the two halves of
the answer live in different systems, joined by one key:

**`distinct_id` (PostHog) = `courses.user_id` (DB).** `proxy.ts` sets `distinct_id`
to the anon Supabase user id, so a visitor's network origin and their actual
conversation are the same person on both sides.

`inspect-visitor.ts` does the whole join in one command.

**Use for:** who visited, from where, which org owns the IP, human vs bot, what they
typed, how far they got.
**Not for:** debugging a failed LLM request — that's `debugging-nalu-llm-pipeline`
(DB-only; it deliberately knows nothing about visitors).

## Step 0 — One-time setup

The script needs `POSTHOG_PERSONAL_API_KEY` in `.env.local` (a `phx_` key, scope
**`query:read`**). Create one at PostHog → Settings → Personal API keys.

**`POSTHOG_KEY` is NOT this key.** That's the `phc_` ingestion key — write-only, it
can capture events but cannot read one back. Sending it to the query API returns 401.

## Step 1 — Run it

```bash
bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts                 # last 24h
bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts --minutes 300   # last 5h
bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts --since 2026-07-17T09:00:00Z
bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts --ip 203.0.113.42       # this IP, ever
bun .claude/skills/nalu-visitor-forensics/inspect-visitor.ts --distinct <uuid>       # this visitor, ever
```

One row per pageview: `when`, `where` (geo), `ip`, `org` (ASN + owner), `from`
(referrer), `device`, plus `topic` / `got` from the joined course. It prints a
ready-to-paste `dump-chat.ts` line for any visitor who started one.

`--ip` / `--distinct` ignore the time window and drop the `app=nalu` filter, so a
visitor who also hit the other app in the shared PostHog project still shows up.

## Step 2 — Read the result

| Column   | How to read it                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org`    | The ASN owner. **Residential ISP** (Virgin Media, BT, Comcast) = a real person at home. **Datacenter** (M247, DataCamp, AWS) = VPN, proxy or automation. |
| `device` | `bot` = automated. Anything else = a real browser.                                                                                                       |
| `topic`  | `-` means they never started a course — landed and left.                                                                                                 |
| `got`    | `scoping` = started but never finished. `active` = got through baseline.                                                                                 |
| `from`   | The referring domain. `direct` = typed/pasted, no referrer.                                                                                              |

**A course row is proof of a human.** `course.clarify` only fires from a real React
`onClick` → tRPC mutation, so a link-unfurl bot or crawler can never create one.

## Common mistakes

- **Querying `$ip`.** PostHog consumes the magic `$ip` for GeoIP and **strips it from
  the stored event**. `buildPageviewEvent.ts` mirrors it into `client_ip` for exactly
  this reason. Query `client_ip`; `$ip` silently returns nothing.
- **Looking for a Person in the PostHog UI.** Capture sets
  `$process_person_profile: false` (anonymous by design), so there are no Person
  profiles. Query **events**, not people.
- **Reading a residential IP as an employer.** An ISP-owned IP is someone's home
  broadband. It identifies the ISP and nothing else. Organisation attribution only
  works when the IP belongs to the organisation itself.
- **Trusting a bot list.** `device` tests for the _absence_ of `Mozilla/` rather than
  a list of known bot names — a `last25-scanner` deploy probe sailed through a
  `bot|crawl|spider` list and read as human. Never "improve" this into a name list.
- **Expecting anything before 2026-07-08.** Server-side capture landed then. Earlier
  visits have no event and are unrecoverable (Vercel runtime logs are ~1h retention).
- **Using the project id in the API path.** The key's scope is `query:read` with no
  `project:read`, so it cannot enumerate projects. Use `@current`.
- **POSTing from Python.** `urllib` SSL-fails against this endpoint on macOS. The
  script uses `fetch`; if reaching for a shell one-liner, use `curl`.

## Caveats on geo and ASN

- GeoIP is a centroid — city is roughly right, the exact suburb wobbles. Don't read
  precision into it.
- iCloud Private Relay masks the origin to a relay ASN; the visitor is not there.
- A VPN shows the exit node's ASN and city, not the person. **Check the ASN before
  concluding anything from geo** — a datacenter ASN means the location is fiction.

## Quick reference

| Want to know                 | Where                                                     |
| ---------------------------- | --------------------------------------------------------- |
| Who visited recently         | `inspect-visitor.ts --minutes N`                          |
| Everything about one IP      | `inspect-visitor.ts --ip <addr>`                          |
| What a visitor actually said | `dump-chat.ts --course <id>` (printed by inspect-visitor) |
| Why a request _failed_       | `debugging-nalu-llm-pipeline` skill                       |
| What gets captured           | `src/lib/analytics/buildPageviewEvent.ts`                 |
| Where capture is wired       | `src/proxy.ts` (prod-gated; sets `distinct_id`)           |
