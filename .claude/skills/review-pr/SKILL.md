---
name: review-pr
description: Fetch PR review comments from CodeRabbit/Codex, triage, fix valid issues, reply to threads, and resolve. Use when addressing automated PR review feedback.
user-invocable: true
argument-hint: [pr-number]
allowed-tools: Bash(gh *) Bash(git *) Bash(npx *) Read Edit Grep Glob TaskCreate TaskUpdate
---

# Address PR Review Comments

You are resolving automated review feedback on PR #$ARGUMENTS.

## Step 1: Gather context

Fetch all review data using these commands. This is critical — only pull what's needed to avoid context bloat.

**Inline review comments** (file-specific, actionable):

```bash
gh api --paginate repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pulls/$ARGUMENTS/comments --jq '.[] | {id, user: .user.login, path: .path, line: .line, body: .body, in_reply_to_id: .in_reply_to_id}' 2>&1 | head -300
```

**Review bodies** (summary-level feedback):

```bash
gh api --paginate repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pulls/$ARGUMENTS/reviews --jq '.[] | select(.body != "") | {id, user: .user.login, body: .body}' 2>&1 | head -300
```

**PR diff** (for verifying comments against current code):

```bash
gh pr diff $ARGUMENTS --name-only 2>&1
```

## Step 2: Triage each comment

For each review comment, determine:

1. **Is it actionable?** Skip bot boilerplate, "about this review" sections, and duplicate/threaded replies (comments with `in_reply_to_id` are replies — skip unless they add new feedback).
2. **Is it valid?** Read the referenced file and line to verify the issue exists in current code. Reviewers sometimes flag things already fixed or make incorrect assumptions.
3. **Classify the action:**
   - **Fix** — Valid issue, make the code change
   - **Acknowledge** — Valid observation but not worth fixing (e.g., theoretical race condition, acceptable trade-off). Explain why.
   - **Reject** — Incorrect finding. Explain why it's wrong.

Create tasks (TaskCreate) to track each actionable comment.

## Step 3: Apply fixes

For each comment classified as "Fix":

1. Read the file at the referenced path/line
2. Make the minimal change to address the feedback
3. Run tests (`npx vitest run`) to verify nothing breaks
4. Mark the task as completed

Group related fixes into a single commit when possible.

## Step 4: Commit and push

Fixes must be pushed **before** replying to or resolving any comments. This ensures the code backs up your replies.

1. Run the full test suite: `npx vitest run`
2. Run typecheck: `npx tsc --noEmit`
3. Stage only the files you changed
4. Commit with message format: `fix: address PR review feedback from [reviewer names]`
5. Push to the current branch

## Step 5: Reply to each comment thread

Only reply after the fix commit is pushed.

For **inline comments** (have `id` and `path`), reply directly to the thread:

```bash
gh api repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pulls/$ARGUMENTS/comments/{comment_id}/replies \
  -f body="<your response>"
```

For **review-body-only feedback** (CodeRabbit often puts nitpicks only in the review body, not as inline comments), post a single PR comment summarizing all responses:

```bash
gh pr comment $ARGUMENTS --body "<summary of all responses>"
```

### Reply format

Keep replies concise. Use one of these patterns:

- **Fixed:** "Fixed — [what was changed]."
- **Acknowledged:** "Acknowledged, not fixing — [brief reason]."
- **Rejected:** "Not applicable — [brief reason]."

Do NOT be defensive or over-explain. One sentence per comment is ideal.

## Step 6: Resolve review threads

After replying, resolve each thread via the GraphQL API. This requires thread IDs (not comment IDs).

**Fetch thread IDs and resolution status:**

```bash
gh api graphql -f query='{ repository(owner: "OWNER", name: "REPO") { pullRequest(number: PR_NUMBER) { reviewThreads(first: 50) { nodes { id isResolved comments(first: 1) { nodes { body author { login } } } } } } } }' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | {id, author: .comments.nodes[0].author.login, body: (.comments.nodes[0].body[:100])}'
```

Replace `OWNER`, `REPO`, and `PR_NUMBER` with actual values (use `gh repo view --json owner,name` to resolve).

**Resolve each thread:**

```bash
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'
```

Resolve all threads that have been addressed (fixed, acknowledged, or rejected with explanation).

## Step 7: Post summary

Post a single PR comment listing how each comment was handled:

```markdown
## Addressing [Reviewer] feedback

**1. [Short description]** — Fixed / Acknowledged / Rejected
[One line explanation]

**2. [Short description]** — Fixed / Acknowledged / Rejected
[One line explanation]
```

## Opportunistic observations

While reading the code to address review comments, keep an eye out for your own findings — things the automated reviewers missed. Examples: dead code, missing error handling, inconsistent naming, stale comments, obvious bugs adjacent to the reviewed lines.

- **Minor fixes** (typos, stale comments, trivial cleanup): include them in the same commit, mention in the PR summary under a separate "Additional fixes" heading.
- **Non-trivial observations** (architectural concerns, potential bugs requiring discussion): flag them to the user rather than silently fixing. These may warrant their own issue or PR.

Do not go hunting — only flag things you naturally encounter while working on the review comments.

## Important guidelines

- **Do not blindly apply suggestions.** Verify each finding against the actual code first. Automated reviewers frequently flag non-issues or suggest changes that don't match the codebase conventions.
- **Preserve intentional patterns.** If something looks like a bug but is deliberate (e.g., a reinforced instruction, an intentional fallback), check with the user before changing it.
- **One commit for review fixes.** Don't create separate commits per comment — batch them.
- **Run tests before pushing.** Never push without green tests.
- **Ask the user** when a comment raises a genuine architectural question with multiple valid approaches.
