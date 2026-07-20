# TODO

The backlog lives in **[GitHub Issues](https://github.com/olliegilbey/nalu/issues)**
(migrated 2026-07-21 — every entry formerly in this file is now an issue,
labels: `tech-debt`, `deferred`, `needs-decision`, plus the defaults).

Working agreements:

- New follow-up work goes to a GitHub issue (`gh issue create`), not this file.
  Include file paths, the concern, and the promote-when trigger in the body.
- PRs that resolve an issue say `Fixes #N` so the issue auto-closes on merge.
- Agents: read an issue with `gh issue view N` before starting work on it.
- `deferred` issues state their promote-when trigger — don't pick them up
  before the trigger fires.
- `needs-decision` issues are blocked on a product/architecture call from
  Ollie — surface them, don't unilaterally resolve them.

This file stays only as the pointer (and for scratch notes mid-session that
haven't earned an issue yet). Older speccy/post-MVP notes remain in
`docs/TODO.md`.
