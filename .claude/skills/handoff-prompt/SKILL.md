---
name: handoff-prompt
description: Craft a self-contained exploratory handoff prompt for the next agent session. Use when the user wants to end a session cleanly and seed the next one with enough context to pick up without re-briefing. Default scope ~30 min; override via argument.
user-invocable: true
argument-hint: [optional time budget, e.g. "1h"]
allowed-tools: Bash(git *) Bash(gh *) Read Grep Glob
---

# Craft a Handoff Prompt

Produce an exploratory brief the _next_ agent will receive cold. Not a plan, not a task list — a prompt that equips them to discover the right next chunk themselves.

Time budget for the handoff's scope: **$ARGUMENTS** (default ~30 min if empty).

## Step 1: Reconstruct "what just landed"

Discover it from the repo, don't rely on session memory.

- `git log --oneline -10` and `git log -1 --stat` on the last commit or two — pick out the merged PR, its key exports, and the file paths touched.
- Skim the actual changed files enough to name the _shape_ of what landed (main exported functions, schemas, modules), not just the commit subject.
- If there's a PR platform (`gh pr view`), fetch title + body for the latest merged PR for framing.

## Step 2: Find the reference materials the next agent should read

Generic, project-agnostic — look for whatever exists:

- Root-level and nested `CLAUDE.md` / `AGENTS.md` / `README.md` / `CONTRIBUTING.md` files.
- A spec / PRD / design doc if one exists (look in `docs/`, `spec/`, top-level markdown). Name the _relevant section_ for the next chunk, not the whole doc.
- The closest-pattern sibling modules the next work should mirror (e.g. the most recently merged feature is usually the canonical pattern).

List these by path. Do not paste their content into the handoff.

## Step 3: Identify the next chunk

Not a prescription — a pointer. Look for:

- Explicit "next step" markers in the spec/PRD (numbered flows, phase lists, TODO sections).
- Roadmap/checklist files.
- The natural continuation of what just merged (if step N shipped, step N+1 is usually obvious).
- Open issues / draft PRs if relevant.

Name the chunk. Flag any non-obvious design wrinkles (e.g. "this touches both X and Y — they may or may not belong in the same PR") without choosing for the next agent.

## Step 4: Extract durable constraints

Skim the convention docs and recent PRs for the rules that apply to _all_ work, not just this chunk: architecture boundaries, file size caps, testing conventions, commit / hook rules, forbidden shortcuts (`--no-verify`, magic numbers, etc.). Include only the ones actually enforced in this repo.

## Step 5: Draft the prompt

Write it as one continuous brief. Structure (adapt — don't force empty sections):

1. **Context line** — "PR #N (short title) just merged — key exports in `path/`. [Link to any PRD section covered so far.]"
2. **What to read first** — bullet list of the docs + sibling modules from Step 2, each with a one-clause reason.
3. **Next chunk** — what it is, where it's pointed to in the spec. State the _output_ it produces and who consumes it downstream, so the agent picks a shape the later flows actually need.
4. **Design wrinkles worth thinking about before coding** — non-obvious trade-offs, boundaries between deterministic and model-driven logic, things that might split into multiple PRs. Phrase as things to consider, not choices to make.
5. **Scope for ~$ARGUMENTS** — bulleted scope budget. Say what's explicitly _out_ (adjacent layers, wiring, persistence) as well as what's in.
6. **Constraints** — one line listing the durable rules from Step 4.
7. **Close** — "Open a branch, sketch a short plan, get it approved, then implement. If unsure about X, ask rather than guess."

## Style rules

- **Exploratory, not prescriptive.** Tell the agent where to look and what to think about; don't dictate file names, function signatures, or test counts.
- **Don't paste doc content.** Reference paths; let the agent read.
- **Name the downstream consumers** of whatever the next chunk produces — that's what forces the right shape.
- **Flag at least one judgement call** the agent will need to make (scope split, format choice, what to persist) instead of pre-deciding it.
- **Absolute dates**, not relative. If the handoff mentions timing, write the date.
- **No emoji, no headers inside the prompt.** One continuous brief in a few paragraphs — mirror the tone of a smart colleague handing off to another.
- **Don't mention memory, tasks, or session mechanics** — the next agent will handle their own tooling.

## Output

Render the prompt in a single fenced block at the end of your reply so the user can copy it. Above the block, list in two lines what you discovered (most recent PR, next chunk) so the user can sanity-check before handing it off.
