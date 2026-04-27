# UX Simulation — Rust Ownership

> A full new-course simulation of the Nalu learning flow, used to stress-test the baseline assessment design and the harness/model seams. Raw tagged blocks are shown verbatim and harness actions are narrated inline so every seam is visible.
>
> **This document has been edited post-simulation to reflect the target behaviour we want to build**, incorporating decisions captured in `docs/TODO.md`. Where the live sim diverged from the target design, the doc shows the target.
>
> Custom instructions applied: `I have ADHD, so consider this in your teaching style`.
> Topic chosen: **Rust ownership** (medium scope).

---

## Design decisions reflected in this doc

1. **Clarification estimates a starting tier.** The clarification turn asks questions specifically designed to produce an estimated tier, which narrows the baseline assessment to `tier ± 1`. The learner never sees questions far outside their likely range.
2. **Baseline questions are standalone.** No question references another. Each card stands alone.
3. **Baseline runs client-side; evaluation is batched.** Cards advance instantly on answer. The LLM is called exactly once at the end with all answers, returning an array of evaluations. MC answers may be scored deterministically (no LLM needed) leaving only free-text for the model — a cost and latency win.
4. **MC questions are 4 options; freetext is always available as an escape hatch.** There is no dedicated "Not sure" button, and the model shouldn't give a "not sure" as an option in the MC. If the learner doesn't know, they type into the freetext box — including literally "not sure". The harness forwards it to the model with context: _"user did not select a multiple-choice answer; they wrote the following instead: …"_. The model infers understanding (or lack of it) from the prose. This turns every non-engagement into a valuable signal the model can reason about, and score on quality, rather than a flat opt-out - also opens up the case of the user saying something like: "it's probably B or C because of x and y" which will be a better response than an incorrect guess.
5. **Assessment UI cards can contain multiple questions. Or just one question.** The model decides batch size per beat. The same card component is used for clarification test, baseline test, and in-session assessments.
6. **Custom instructions are verbatim.** `I have ADHD, so consider this in your teaching style` is passed through as-is. The model infers pacing from its own understanding of the term. We do not pre-expand into explicit directives — that belongs to the model's inherent inference, not prompt engineering on our side.
7. **Tier adjustment is bidirectional.** `progression.ts` can demote as well as promote, triggered by sustained low quality on current-tier concepts. The user sees a gentle signal ("let's revisit Tier 1 for a beat"), not a rank drop.

---

## 1. Topic input

`[UI: /dashboard → "New Course" → topic input field]`

**Nalu:** What would you like to learn?

**User:** Rust ownership

---

## 2. Clarification (scoping turn)

`[tRPC: course.clarify({ topic: "Rust ownership" })]`
`[Harness builds scoping prompt from src/lib/prompts/clarification.ts — ephemeral, discarded after baseline. Prompt is instructed to produce questions whose answers will let the framework generator output both a tier structure AND an estimated_starting_tier.]`
`[LLM call → clarification model]`

**Model response (raw):**

```xml
<clarification_questions>
{
  "questions": [
    {
      "id": "q1",
      "text": "What's your current Rust background?",
      "type": "single_select",
      "options": [
        "Never written Rust, coming from another language",
        "Written some Rust but ownership keeps biting me",
        "Comfortable with basics, want to go deep on lifetimes / borrow checker edge cases",
        "Experienced Rust, looking to fill specific gaps"
      ]
    },
    {
      "id": "q2",
      "text": "Which systems-programming background do you have? This shapes the analogies the tutor will use.",
      "type": "single_select",
      "options": [
        "Mostly GC'd languages (Python, JS, Go, Java)",
        "C/C++ with manual memory management",
        "Functional languages (Haskell, OCaml)",
        "Mixed / none of the above"
      ]
    },
    {
      "id": "q3",
      "text": "What's pulling you toward this specifically — a project, interview prep, curiosity? One line is fine.",
      "type": "free_text"
    }
  ]
}
</clarification_questions>
```

`[Zod validates → 3 questions parsed OK]`
`[UI renders: three cards in sequence. One visible at a time with progress dots. ADHD system prompt inference by the model would naturally produce short question blocks; the harness doesn't enforce this.]`

**User answers (collected):**

- q1: "Written some Rust but ownership keeps biting me"
- q2: "Mostly GC'd languages (Python, JS, Go, Java)"
- q3: "I'd like to try some embedded systems programming, and would like to understand the difference of rust from what I know already, like python."

---

## 3. Framework generation (with estimated starting tier)

NB: It is likely we will add a WebSearch tool at this point so that the model can fetch context on the most up to date resources to supplement the model knowledge. This will be ongoing that the model will, at regular intervals, fetch reputable resources to dynamically expand the topic and concepts being learned. This will later enable the platform to fetch YouTube videos for the user to watch for example, which will have the transcription fed into the model so that the model can test comprehension based on the videos watched. For this example, we use the trivial case to demonstrate the MVP before tool calling is added. Tool calling may also expand to allow the model to query the db to see what concepts have been covered beyond being actively fed the SM-2 information.

`[tRPC: course.generateFramework({ topic, clarification })]`
`[Prompt: src/lib/prompts/framework.ts — topic + clarification answers. Prompt instructs the model to also return an estimated starting tier based on the learner's self-report, which will scope the baseline.]`
`[LLM call → framework generator]`

**Model response (raw):**

```xml
<framework>
{
  "topic": "Rust ownership",
  "scope_summary": "Ownership, borrowing, and lifetimes in Rust — framed for a Python developer aiming at embedded systems. Emphasis on the mental model shift from GC to compile-time ownership, and on patterns relevant to no_std / embedded contexts.",
  "estimated_starting_tier": 2,
  "estimate_rationale": "Learner self-reports 'ownership keeps biting me' → core mental model likely present but borrowing rules unstable. Coming from Python (GC background) means no prior mental model for ownership transfer. Embedded goal is a long-term anchor, not an immediate floor. Tier 2 is the central hypothesis; baseline will confirm or adjust.",
  "baseline_scope_tiers": [1, 2, 3],
  "tiers": [
    {
      "number": 1,
      "name": "The Ownership Mental Model",
      "description": "Why ownership exists. Stack vs heap. What 'move' means and why Python's reference semantics don't apply. Drop and RAII.",
      "example_concepts": ["move semantics", "stack vs heap placement", "Drop trait", "Copy vs Move"]
    },
    {
      "number": 2,
      "name": "Borrowing Basics",
      "description": "Shared (&T) and mutable (&mut T) references. The aliasing-XOR-mutability rule. Reading borrow checker errors without panic.",
      "example_concepts": ["&T vs &mut T", "aliasing XOR mutability", "reborrowing", "reading E0502/E0499"]
    },
    {
      "number": 3,
      "name": "Lifetimes in Practice",
      "description": "What lifetimes actually are (not what they look like). Elision rules. Writing functions and structs that hold references. When you genuinely need to name a lifetime.",
      "example_concepts": ["lifetime elision", "'a annotations", "structs holding references", "lifetime subtyping basics"]
    },
    {
      "number": 4,
      "name": "Owned Alternatives and Smart Pointers",
      "description": "When to clone, when to use Box/Rc/Arc, interior mutability (Cell/RefCell). Trade-offs explicitly contrasted with Python's 'everything is a reference' default.",
      "example_concepts": ["Clone vs Copy", "Box<T>", "Rc vs Arc", "RefCell and runtime borrow checking"]
    },
    {
      "number": 5,
      "name": "Ownership in Embedded Contexts",
      "description": "no_std implications. Static lifetimes, 'static bounds, singletons, owning peripherals. Why ownership maps beautifully onto hardware resources. Interrupt-safety and Send/Sync at a glance.",
      "example_concepts": ["'static bound", "owning a peripheral once", "no_std + no heap", "Send/Sync intuition"]
    }
  ]
}
</framework>
```

`[Zod validates → 5 tiers, estimated_starting_tier=2, baseline_scope_tiers=[1,2,3] ✓. Stored in courses.framework JSONB.]`
`[courses row: id=c_xxx, current_tier=null (set after baseline), status='active']`

**UI:**

> ### Your course: _Rust ownership_
>
> Shaped for: Python background → embedded systems
>
> 🌊 **5 tiers**
>
> 1. The Ownership Mental Model
> 2. Borrowing Basics
> 3. Lifetimes in Practice
> 4. Owned Alternatives and Smart Pointers
> 5. Ownership in Embedded Contexts
>
> Next: a **baseline assessment** 9 questions, ~4 min.
>
> `[Continue →]` `[Edit framework]`

---

## 4. Baseline assessment

`[tRPC: course.generateBaseline({ courseId: c_xxx })]`
`[Prompt: src/lib/prompts/assessment.ts in baseline mode. Prompt is given estimated_starting_tier=2 and baseline_scope_tiers=[1,2,3], and is instructed:]`

- _Generate 3 questions per tier in scope (9 total). All questions must be standalone — no question may reference another ("the snippet above", "the previous code")._
- _Multiple-choice questions should have 4 options. Do not add a "Not sure" option; freetext is always available in the UI as a contextual escape._
- _Return correct answers and a freetext rubric for each question so the harness can score without re-prompting for mechanical cases._

`[Single LLM call → baseline generator]`

**Model response (raw):**

````xml
<baseline_assessment>
{
  "questions": [
    {
      "id": "b1",
      "tier": 1,
      "concept_name": "move semantics",
      "type": "multiple_choice",
      "question": "In Rust:\n```rust\nlet s1 = String::from(\"hi\");\nlet s2 = s1;\nprintln!(\"{}\", s1);\n```\nWhat happens?",
      "options": {
        "A": "Prints \"hi\" — s1 and s2 both reference the same string (like Python).",
        "B": "Prints \"hi\" twice if you also print s2 — Rust auto-clones on assignment.",
        "C": "Compile error — s1 was moved into s2 and is no longer usable.",
        "D": "Runtime panic — use-after-free."
      },
      "correct": "C"
    },
    {
      "id": "b2",
      "tier": 1,
      "concept_name": "Copy vs Move",
      "type": "multiple_choice",
      "question": "The code `let x: i32 = 5; let y = x; println!(\"{}\", x);` compiles and prints 5. Swap `i32` for `String` and it fails. Why?",
      "options": {
        "A": "`i32` is a primitive and primitives are always special-cased by the compiler.",
        "B": "`i32` implements `Copy` (cheap, stack-only duplication); `String` does not, so assignment moves it.",
        "C": "`String` is a pointer type and pointers cannot be reassigned.",
        "D": "The compiler auto-clones `String` at runtime but not `i32`."
      },
      "correct": "B",
      "freetext_rubric": "Expects: Copy trait (or copy-vs-move), mention of stack-only / trivial types, contrasted with String being heap-backed and owning its data."
    },
    {
      "id": "b3",
      "tier": 1,
      "concept_name": "Drop and RAII",
      "type": "free_text",
      "question": "In Rust, when a `String` variable goes out of scope, its heap allocation is freed automatically. What mechanism does Rust use to do this, and what's the one-line analogy for someone coming from Python?",
      "freetext_rubric": "Expects: the `Drop` trait runs destructors at scope exit (RAII). Analogy: like a Python context manager / `__del__`, but guaranteed and deterministic — no GC. Credit partial answers mentioning 'destructor' or 'automatic cleanup at scope end'."
    },
    {
      "id": "b4",
      "tier": 2,
      "concept_name": "aliasing XOR mutability",
      "type": "multiple_choice",
      "question": "Which of these is allowed simultaneously for the same value in Rust?",
      "options": {
        "A": "Two `&mut` references",
        "B": "One `&mut` reference and one `&`",
        "C": "Many `&` references and zero `&mut`",
        "D": "Any combination — Rust only checks at runtime"
      },
      "correct": "C"
    },
    {
      "id": "b5",
      "tier": 2,
      "concept_name": "borrow checker error reading",
      "type": "free_text",
      "question": "You see `cannot borrow \\`v\\` as mutable because it is also borrowed as immutable`, from pushing to a Vec while iterating over it. In plain words: what's the rule you violated, and one way to fix it?",
      "freetext_rubric": "Expects: aliasing-XOR-mutability rule articulated (not variable-mutability). Fix should separate read from write phase — scoping the borrow, collecting first, or index loop. Credit for temporal intuition even if rule phrasing is imprecise."
    },
    {
      "id": "b6",
      "tier": 2,
      "concept_name": "reborrowing",
      "type": "multiple_choice",
      "question": "You have `fn takes(x: &mut i32) { ... }`. You call `takes(&mut n)` inside a function that already holds `&mut n`. Why does this often work?",
      "options": {
        "A": "Rust implicitly clones mutable references.",
        "B": "The compiler silently relaxes the borrow rules for function calls.",
        "C": "It's a reborrow — the outer `&mut` is temporarily suspended while the inner one is alive.",
        "D": "It only works because `i32` is `Copy`."
      },
      "correct": "C"
    },
    {
      "id": "b7",
      "tier": 3,
      "concept_name": "lifetime elision",
      "type": "multiple_choice",
      "question": "`fn first_word(s: &str) -> &str { ... }` — why does this compile without explicit lifetimes?",
      "options": {
        "A": "Rust infers lifetimes at runtime.",
        "B": "Elision rule: one input reference ⇒ the output reference gets the same lifetime.",
        "C": "`&str` is a special case that never needs lifetimes.",
        "D": "The compiler silently inserts `'static`."
      },
      "correct": "B"
    },
    {
      "id": "b8",
      "tier": 3,
      "concept_name": "what a lifetime is",
      "type": "free_text",
      "question": "A colleague says: \"a lifetime `'a` is how long a value lives.\" That's almost right but subtly wrong. What's the more precise statement? (A sentence is fine.)",
      "freetext_rubric": "Expects: a lifetime is a compile-time region/scope over which a reference is valid — it's about references, not values. Credit partial answers that identify the references-vs-values distinction."
    },
    {
      "id": "b9",
      "tier": 3,
      "concept_name": "structs holding references",
      "type": "multiple_choice",
      "question": "You write `struct Parser { input: &str }` and the compiler rejects it: `missing lifetime specifier`. Why?",
      "options": {
        "A": "Structs can never hold references in Rust; you must own the data.",
        "B": "The compiler needs to know the reference inside the struct will outlive the struct itself — that's what the lifetime annotation states.",
        "C": "`&str` specifically requires `'static` inside structs.",
        "D": "You need to wrap it in a `Box`."
      },
      "correct": "B"
    }
  ]
}
</baseline_assessment>
````

`[Zod validates: 9 questions, 3 per tier across scope [1,2,3]. All standalone. MC questions are 4 options each; no "Not sure" options. ✓]`

### 4.1 Card interaction (client-side, no network between cards)

`[UI renders: sequential cards, progress bar "1 of 9". Each card offers:]`

- MC options as tappable buttons (4 options, no "Not sure").
- A small _"…or write your own answer"_ affordance below the options. Tapping expands a freetext input; submitting marks the card with `type_override: "free_text"` and stores the text verbatim. The learner can literally type _"I'm not sure"_ or _"I don't know"_ here — that prose is the non-engagement signal.
- Instant advance on submit — no spinner, no LLM round-trip.

**User journey through the nine cards (answers collected locally):**

| Card | Tier | Concept                      | User action          | Stored answer                                                                                                                                                                          |
| ---- | ---- | ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b1   | 1    | move semantics               | clicked option C     | MC: C (correct)                                                                                                                                                                        |
| b2   | 1    | Copy vs Move                 | used freetext escape | free*text: *"Probably something to do with it being copied rather than moved, but I don't really know why the difference between string and int"\_                                     |
| b3   | 1    | Drop and RAII                | freetext (native)    | _"I think Rust frees it automatically at the end of scope. Don't know what it's called."_                                                                                              |
| b4   | 2    | aliasing XOR mutability      | clicked option B     | MC: B (incorrect — correct is C)                                                                                                                                                       |
| b5   | 2    | borrow checker error reading | freetext (native)    | _"Well, we were iterating over it while it was immutable, trying to push to it can't be done here because it's still immutable. We'd have to make it mutable before iterating maybe."_ |
| b6   | 2    | reborrowing                  | used freetext escape | free*text: *"not sure"\_                                                                                                                                                               |
| b7   | 3    | lifetime elision             | clicked option B     | MC: B (correct)                                                                                                                                                                        |
| b8   | 3    | what a lifetime is           | used freetext escape | free*text: *"I don't know lifetimes enough yet."\_                                                                                                                                     |
| b9   | 3    | structs holding references   | used freetext escape | free*text: *"idk"\_                                                                                                                                                                    |

`[All nine answers collected. No LLM calls yet. UI now shows: "Processing…" briefly while the batch runs.]`

### 4.2 Batch evaluation

`[tRPC: course.submitBaseline({ courseId: c_xxx, answers: [...] })]`
`[Harness splits the batch:]`

- **Mechanical MC scoring** (no LLM): b1 ✓, b4 ✗, b7 ✓.
- **LLM evaluation** (single batched call) for everything else, including the freetext-escape answers that look like "not sure" prose. The harness does NOT filter these out — the model is the right place to interpret "I don't know lifetimes enough yet" vs. a partial-knowledge answer. Each freetext answer arriving via the escape hatch is wrapped with context: _"The learner did not select a multiple-choice option. They wrote the following instead: …"_.

**Model batch response (raw):**

```xml
<batch_evaluation>
{
  "evaluations": [
    {
      "question_id": "b2",
      "concept_name": "Copy vs Move",
      "quality_score": 3,
      "is_correct": true,
      "rationale": "Identifies copy vs move distinction correctly but explicitly states not knowing the underlying reason (Copy trait / stack-only trivial types). Partial, honest."
    },
    {
      "question_id": "b3",
      "concept_name": "Drop and RAII",
      "quality_score": 3,
      "is_correct": true,
      "rationale": "Correctly identifies automatic-cleanup-at-scope-end behaviour without naming Drop/RAII. Mechanism is right; vocabulary is missing."
    },
    {
      "question_id": "b5",
      "concept_name": "borrow checker error reading",
      "quality_score": 2,
      "is_correct": false,
      "rationale": "Correctly identifies the temporal overlap ('while iterating') but conflates variable-mutability with borrow-state. The Vec is already `mut`; the real rule is aliasing XOR mutability. Partial credit for the instinct."
    },
    {
      "question_id": "b6",
      "concept_name": "reborrowing",
      "quality_score": 0,
      "is_correct": false,
      "rationale": "Non-engagement ('not sure'). No signal of understanding. Concept not yet reached — flag for teaching, not for immediate re-testing."
    },
    {
      "question_id": "b8",
      "concept_name": "what a lifetime is",
      "quality_score": 0,
      "is_correct": false,
      "rationale": "Non-engagement. Learner explicitly names the concept as unfamiliar. Teach from scratch when the time comes."
    },
    {
      "question_id": "b9",
      "concept_name": "structs holding references",
      "quality_score": 0,
      "is_correct": false,
      "rationale": "Non-engagement ('idk'). Tier 3 concept; expected gap given Tier 2 friction."
    }
  ]
}
</batch_evaluation>
```

`[Harness merges mechanical + LLM results:]`

| ID  | Concept                      | Tier | Quality                      | XP  | Notes                                                  |
| --- | ---------------------------- | ---- | ---------------------------- | --- | ------------------------------------------------------ |
| b1  | move semantics               | 1    | 4 (mechanical: correct MC)   | 10  |                                                        |
| b2  | Copy vs Move                 | 1    | 3 (LLM)                      | 8   |                                                        |
| b3  | Drop and RAII                | 1    | 3 (LLM)                      | 8   |                                                        |
| b4  | aliasing XOR mutability      | 2    | 1 (mechanical: incorrect MC) | 0   |                                                        |
| b5  | borrow checker error reading | 2    | 2 (LLM)                      | 5   |                                                        |
| b6  | reborrowing                  | 2    | 0 (LLM, non-engagement)      | 0   | Concept stored with `last_quality=0`; SM-2 interval=1d |
| b7  | lifetime elision             | 3    | 4 (mechanical: correct MC)   | 30  |                                                        |
| b8  | what a lifetime is           | 3    | 0 (LLM, non-engagement)      | 0   |                                                        |
| b9  | structs holding references   | 3    | 0 (LLM, non-engagement)      | 0   |                                                        |

`[For every question: concepts row upsert, SM-2 run, assessments row insert. Non-engagement signals are still stored — they are valuable for the model on future turns ("learner explicitly didn't know this yet"), and SM-2 will naturally schedule them for early review. We do NOT track "taught vs tested" separately — concept prowess is the only state we track. If a future SM-2 review surfaces a concept the learner still can't answer, the model teaches it in-place during that turn, just as it would teach any weak area.]`

---

## 5. Starting-tier determination

`[Harness aggregates. Every answered question contributes, including non-engagement (quality=0 is data, not noise):]`

```
Tier 1: avg q=3.33, n=3        → solid (mechanics present, vocabulary a bit fuzzy)
Tier 2: avg q=1.0,  n=3        → weak (core gap, matches self-report; reborrowing not yet reached)
Tier 3: avg q=1.33, n=3        → not yet reached (one correct MC, two "don't know" freetexts)

Starting tier: estimated=2, confirmed by baseline (T1 solid, T2 weak, T3 unreached).
Total XP earned: 61
```

`[UPDATE courses SET current_tier=2, total_xp=61 WHERE id=c_xxx]`
`[UPDATE user_profiles SET total_xp = total_xp + 61]`
`[Scoping prompts discarded.]`

### 🌊 Baseline done

> **Let's start at Tier 2: Borrowing Basics**
> Tier 1 is solid — Copy vs Move and Drop are fuzzy on naming but the intuition is there; we'll brush past them in passing. Tier 2 is where the friction lives, which matches what you said at the start. Tier 3 is ahead of where you are now; we'll pick it up naturally as we go.
>
> Session XP: **+61 🌊**
>
> `[Start first session →]`

---

## 6. First session — course-start prompt assembly

`[tRPC: session.start({ courseId: c_xxx })]`
`[Fresh course-start system prompt assembled from src/lib/prompts/system.ts + teaching.ts:]`

```xml
<!-- STATIC (cache-hot) -->
<role>You are Nalu, a patient and adaptive personal tutor. [...full role block per PRD §5.1...]</role>
<course_topic>Rust ownership</course_topic>
<topic_scope>
Learner background: some Rust written, ownership keeps biting. Primary language Python.
Motivation: wants to do embedded systems programming; frame contrasts against Python.
</topic_scope>
<proficiency_framework>{...5 tiers JSON...}</proficiency_framework>

<!-- SEMI-STATIC -->
<learner_level>Tier 2: Borrowing Basics — Shared (&T) and mutable (&mut T) references...</learner_level>
<custom_instructions>I have ADHD, so consider this in your teaching style</custom_instructions>
<progress_summary>
First session. Baseline results:
- Tier 1 solid: move semantics clicked; Copy vs Move intuition right, trait name unknown; Drop/RAII behaviour understood, vocabulary missing.
- Tier 2 starting point: aliasing-XOR-mutability rule not internalised (picked &mut + & as compatible). Borrow-checker error reading showed temporal intuition but conflated variable-mut with borrow-state. Reborrowing: non-engagement — concept not yet reached.
- Tier 3 not yet reached: lifetime elision MC correct (possible guess); "what a lifetime is" and "structs holding references" — learner wrote variations of "I don't know" via freetext escape.
- Tiers 4–5 untouched.
</progress_summary>

<!-- DYNAMIC -->
<output_formats>[...assessment / comprehension_signal / curriculum_note tag specs per PRD §5.1...]</output_formats>
<!-- No <due_for_review> block: first session, nothing due yet. -->
```

Note: `<custom_instructions>I have ADHD, so consider this in your teaching style</custom_instructions>` is passed through verbatim. The model's inherent inference handles pacing — the harness does not pre-expand into explicit directives.

`[LLM call → opening message]`

---

## 7. Opening turn

**Nalu (raw):**

```xml
<opening>
Welcome in. Quick recap of where the baseline landed us, then we dive.

You crushed Tier 1's core idea — moves vs references. The spot where things bent was the borrowing rule itself, so that's where we're starting (Tier 2). I want to get one mental model locked in before anything else, because if you have it, 80% of borrow-checker fights go away.

Here's the whole rule, in Python terms first:

In Python, every name is basically a pointer, and multiple names can point to the same object and mutate it. That's why `list.append` surprises beginners when two variables share the list.

Rust's entire borrow-checker is built on one trade: **at any moment, for a given value, you can have EITHER many readers OR exactly one writer — never both.** That's it. Not "`&mut` means mutable variable." Not "you can't have two references." Readers-or-writer. **Aliasing XOR mutability.**

Quick check before we go further — no pressure, I just want to see if this framing sticks. Imagine this Python-flavoured pseudocode:

```

v = [1, 2, 3]
reader = v # just looking
v.append(4) # mutating
print(reader)

```

In Rust, if `reader` were `&v` (a shared reference) and `v.append(4)` needed `&mut v`, what would the compiler say, and why — in your own words?
</opening>
```

`[UI renders as chat message. Markdown + code block via react-markdown + shiki (or equivalent). No assessment card yet — this is a dialogue comprehension check; the model will emit <comprehension_signal> from the user's response.]`

---

**User:** Well, you said that there can only be either readers or exactly one writer, but we are reading v by setting reader which I think is borrowing it - then the writer wants to mutate but reader already is looking. So the borrow checker would throw, and the compiler would probably say that's used after borrowed or something.

---

## 8. Teaching turn 1 — comprehension signal

**Nalu (raw):**

````xml
<response>
Yes — that's exactly it. You applied the rule cleanly:

- `reader = &v` → a live shared borrow (a reader)
- `v.append(…)` → needs `&mut v` (a writer)
- Readers XOR writer → compile error

The actual wording Rust gives you is worth memorising because you'll see it a lot:

> `cannot borrow \`v\` as mutable because it is also borrowed as immutable`

So: not "use after borrow" — that's more of a move-semantics phrase. The borrow-checker's vocabulary is always framed as *coexistence*: "X and Y can't both be alive right now."

One follow-on that unlocks a lot. The rule is about *simultaneous* life, not *ever*. So this works fine:

```rust
let mut v = vec![1, 2, 3];
{
    let reader = &v;
    println!("{reader:?}");
}               // ← reader's borrow ends here
v.push(4);      // now allowed: no live & borrows
````

Modern Rust is even smarter — it ends borrows at the **last use**, not the end of the scope (this is called NLL, non-lexical lifetimes). So often you can just… stop using the reader, and the compiler silently lets you mutate.

Small sharper question — and this is the one I actually care about for Tier 2. What's the _shape_ of the fix for code like this?

```rust
let mut scores = vec![10, 20, 30];
for s in &scores {
    if *s > 15 {
        scores.push(*s * 2);
    }
}
```

You already know _why_ it fails. In English, how would you reorganise so the borrows don't overlap? (There's more than one right answer.)
</response>
<comprehension_signal>
{"concept_name":"aliasing XOR mutability","demonstrated_quality":4,"evidence":"Correctly mapped &v=reader, append=&mut v, concluded readers-XOR-writer conflict. Minor terminology slip ('used after borrowed') but mechanism is right."}
</comprehension_signal>

````

`[Harness parses:]`
- `<comprehension_signal>` extracted → silent path.
- Concept lookup: `aliasing XOR mutability` exists (baseline q=1).
- SM-2(ef=2.3, int=1, rep=0, q=4) → ef=2.3, int=6d, rep=1 (recovery).
- XP = tier(2) × 10 × 1.0 = **20 XP**.

`[UI renders chat + code + question. Comprehension-signal stripped, not shown. Toast: "+20 XP 🌊".]`

---

**User:** I guess you'd have to copy the vector, I don't really know how you could be operating on it like this otherwise. But you probably have a way of doing that...

---

## 9. Teaching turn 2 — multi-question card

**Nalu (raw):** *(The model chooses to attach a 2-question card — assessment cards accept an array of questions. First question probes the newly-introduced concept; second revisits the baseline-weak `borrow checker error reading` now that the rule is clearer. Both have "Not sure" and freetext escape.)*

```xml
<response>
That's the right *instinct*. The core move is what you just said — **separate the reading phase from the writing phase so their borrows never overlap.** Copying/cloning is one way. There are cheaper ones too. Three common shapes:

**1. Collect first, mutate after.**
```rust
let to_add: Vec<i32> = scores.iter().filter(|&&s| s > 15).map(|&s| s * 2).collect();
scores.extend(to_add);
````

**2. Index loop with a snapshot length.**

```rust
let len = scores.len();
for i in 0..len {
    if scores[i] > 15 {
        scores.push(scores[i] * 2);
    }
}
```

**3. Clone the whole thing.** Your instinct. Legit when data's small or clarity wins.

```rust
for &s in &scores.clone() {
    if s > 15 { scores.push(s * 2); }
}
```

The meta-lesson: **the borrow checker isn't blocking your logic — it's making the phases explicit.**
</response>

<comprehension_signal>
{"concept_name":"separating read and write phases","demonstrated_quality":3,"evidence":"Identified the right instinct (clone to avoid overlapping borrows) but framed it as a last resort rather than one of several shapes. On the correct path."}
</comprehension_signal>

<assessment>
{
  "questions": [
    {
      "id": "t1_q1",
      "concept_name": "separating read and write phases",
      "tier": 2,
      "type": "multiple_choice",
      "question": "Of the three fixes above, which is usually the most idiomatic for 'build a list of changes, then apply them'?",
      "options": {
        "A": "Clone the whole vector",
        "B": "Collect into a new Vec, then extend",
        "C": "Index loop with snapshot length",
        "D": "All three are equally idiomatic — pick whichever feels right"
      },
      "correct": "B",
      "explanation": "Collect-then-extend is iterator-native, reads left-to-right, and the types make the two phases explicit. Clone is wasteful; index loop is fine but chattier."
    },
    {
      "id": "t1_q2",
      "concept_name": "borrow checker error reading",
      "tier": 2,
      "type": "free_text",
      "question": "Given the 'readers XOR writer' rule, what does this compiler error *actually* tell you, in one sentence? `cannot borrow \\`v\\` as mutable more than once at a time`.",
      "freetext_rubric": "Expects: two live &mut borrows attempted simultaneously — the writer-exclusivity half of the rule. Credit for noting 'only one writer at a time'."
    }
  ]
}
</assessment>
```

`[Harness parses:]`

- `<comprehension_signal>` → new concept `separating read and write phases`, tier 2, q=3, XP = 15.
- `<assessment>` → 2-question card rendered. Harness awaits both answers before evaluating (local collection, then single batch eval — same pattern as baseline).
- Running session XP: 20 + 15 = **35 XP**.

`[UI: prose + 3 code shapes + 2-question card (tabbed or stacked). Each question independently answerable, freetext escape available on the MC. Submit once both done.]`

---

## 10. Design principles & directives

Everything below is the accumulated intent from this simulation and from `docs/TODO.md`. These are the invariants the implementation must honour. They are organised by layer for easy reference during build.

### 10.1 Onboarding (topic → clarification → framework → baseline → first session)

**P-ON-01 — Clarification assessment produces a tier estimate.** The clarification turn is not just information-gathering; it is actively shaping a starting-tier hypothesis. The prompt must instruct the model to ask questions whose answers meaningfully discriminate between tiers. The framework-generation output includes an `estimated_starting_tier` and `baseline_scope_tiers` (typically `[estimate-1, estimate, estimate+1]`).

**P-ON-02 — Baseline is narrow, not broad.** Never ask baseline questions spanning all 5 tiers. Scope to `tier ± 1` around the estimate. This protects the learner from the "asked about something far beyond me on my first minute" feeling, and concentrates signal where decisions actually happen.

**P-ON-03 — Baseline questions are standalone.** No question references another ("the snippet above", "in the previous question"). This is a hard rule in the baseline prompt, because batched generation tends to chain references otherwise.

**P-ON-04 — Baseline generation is one LLM call; baseline grading is at most one more.** All questions generated up front with correct answers and rubrics. Cards advance instantly client-side (no network between cards). On submit, the harness splits the batch: mechanical MC scoring where answers match exactly, one batched LLM call for everything else (free-text and freetext-escape answers, including non-engagement prose). Never one-LLM-call-per-card. (Note: free-text and freetext-escape can be treated basically the same way DRY principle possible here).

**P-ON-05 — Scoping prompts are ephemeral.** `clarification.ts` and the baseline-mode `assessment.ts` are discarded once the baseline is graded (the prompt history is discarded, but the useful information is extracted and built into the new starting prompt). The first learning session assembles a fresh course-start system prompt that embeds the clarification and baseline assessment answers as `<topic_scope>` semi-static context, plus the framework, plus the starting tier, plus the baseline-derived progress summary, generated at the end of the baseline assessment. Scoping instructions never leak into ongoing course turns - the prompts are separate and distinct. Enforce via test.

### 10.2 Assessment cards (baseline and in-session)

**P-AC-01 — One card component, used everywhere.** Baseline cards and mid-session assessment cards share one component. A card holds an array of questions (1+) with mixed types. The model decides batch size when emitting an `<assessment>` tag.

**P-AC-02 — Multiple-choice is 4 options. No "Not sure" button.** The UI always offers a freetext escape below the MC options. If the learner taps it, the card's type flips to `free_text` for grading and their prose is stored verbatim. A learner who doesn't know simply writes "not sure" (or anything) in the freetext. This keeps the signal rich — the model reads the actual words — and removes a UX dead-end.

**P-AC-03 — Freetext-escape answers are wrapped with context for the grader.** When a freetext-escape answer reaches the evaluation prompt, the harness prepends: _"The learner did not select a multiple-choice option. They wrote the following instead:"_. This lets the model distinguish a genuine-but-unsure attempt from a flat "don't know" from a sideways insight.

**P-AC-04 — MC grading is deterministic; free-text grading uses the LLM.** Never call the LLM to check whether a user clicked the correct letter. Save tokens for where judgment is actually needed. The card can handle pure freetext input too (where no MC is present, which would otherwise imply freetext-escape - this also signifies how free-text and freetext-escape are functionally similar)

**P-AC-05 — Client-side answer collection.** Cards advance locally on submit. Answers are stored in component state until the whole card (or card group, for baseline) is submitted in a single batch. Must survive tab switch / refresh mid-baseline.

### 10.3 XP, SM-2, and concept state

**P-XP-01 — XP is calculated by the harness, never by the model.** The model returns a `quality_score` (0–5) and a concept name; the harness computes XP as `tier × 10 × qualityMultiplier`. The model has no knowledge of XP values and cannot inflate them.

**P-XP-02 — Non-engagement (`quality=0`) is data, not noise.** When a learner writes "I don't know" into a freetext (or freetext escape), the harness stores a concept row with `last_quality=0`. This is better than a "not_sure" null path because it keeps the concept in SM-2 rotation (interval = 1 day), surfaces it to the model on future turns with evidence ("learner explicitly didn't know this in the baseline"), and converts every attempt into structured state. The signal is "not yet reached", which is a real position, not an absence of data. This will likely also give rise to the model naturally continuing the dynamic lesson from the concept where the user has stated that they don't know about it yet - this is crucial.

**P-XP-03 — Concept prowess is the only state we track per concept.** We do NOT track "has this been taught yet?" separately. SM-2 plus `last_quality` plus `times_correct/incorrect` are enough. If a review surfaces a concept the learner still can't answer, the model naturally re-teaches it inside that same conversational turn. Adding a `taught_recently` boolean is redundant state — because these are added to the SM-2 anyway, which is the "taught" tracking. (There may however be scope for building an untaught concepts array which would be appended to at baseline assessment time, and over a longer teaching time as the model reasons on sections that need to be taught but haven't yet)

**P-XP-04 — Tier advancement AND reduction.** `progression.ts` is bidirectional. Promotion: 80% of current-tier concepts at `last_quality ≥ 3`, minimum 5 assessed concepts. Demotion: sustained low quality on current-tier concepts, or repeated low-quality signals on lower-tier concepts, trigger a soft demotion. UX presents it as "let's revisit Tier N for a beat", never as a rank drop or shame moment. This as a teaching style needs to be considered deeply against what works with teaching, so that SM-2 recall works correctly in this scenario: SM-2 continually surfaces concepts from other tiers, but injection is **Wave-boundary** — due concepts are embedded in the Wave's fresh system prompt at Wave start, and re-injected on the Wave's final turn (`turns_remaining == 0`) so the LLM can design the next Wave's blueprint around them. Within a Wave the Context is append-only; the review block is not rebuilt every turn. Eg: "lifetimes are due for a review, when appropriate, weave them into the Wave or pivot when sensible" — appended by the harness at the Wave boundaries.

### 10.4 Conversation & teaching turns

**P-CV-01 — Nalu always opens.** Never leave the learner facing a blank chat - this will be the UI at the beginning asking for a topic, and later, each time the user opens the chat, there needs to be some text to respond to - usually this will simply be the conversation they left off at - however, we will likely want to break things into timeboxed sessions which then, when one finishes, the user will leave the app and when they return, they must be greeted with something to begin the next course - likely, the last LLM call of the previous session at course end will also create a summary and opening question for the next course for the UI to show the user - should the user want to proceed immediately, it will then be present for them to pick up then and there. First session: context-aware greeting based on baseline results. Returning sessions: greeting + recap from summary.

**P-CV-02 — The model decides when to drop a card into the chat.** Cards are not on a fixed cadence. The model emits `<assessment>` when it judges a probe is worth more than more dialogue. A teaching turn may contain zero, one, or multiple questions inside a single `<assessment>` tag, those questions could be either freetext or multiple-choice (which itself has a freetext escape that then converts the multiple choice question type into a freetext - due to the DRY principles we can reuse the freetext mechanism easily for both).

**P-CV-03 — Comprehension signals are silent to the learner.** `<comprehension_signal>` is stripped from rendered output. The only visible downstream effect is an XP toast. This keeps free-flowing dialogue conversational — the learner doesn't feel constantly graded.

**P-CV-04 — At most two consecutive assessments before teaching returns.** Per PRD §5.1 role block. Keeps the session a tutorial, not a quiz.

**P-CV-05 — Curriculum notes surface gaps but don't auto-mutate the framework.** The model can emit `<curriculum_note>` suggesting a new micro-concept or tier tweak. Post-MVP: could trigger framework edit proposals. This could feed the untaught concept queue idea mentioned earlier. This would need to be considered on the implementation as to whether the heuristics would work for the harness to act on the notes which requires consistently perfect structure passed to the harness - this may even be done as a tool call - which are currently not considered.

### 10.5 Prompt assembly

**P-PR-01 — All prompt text lives in `src/lib/prompts/`.** No prompt strings anywhere else. Pure template functions: typed params in, string out, zero logic.

**P-PR-02 — Static content first, dynamic content last, per the cache-efficiency ordering in PRD §5.1.** The static block is set once per phase (scoping, or a single Wave) and kept byte-stable so the prompt cache stays warm. Dynamic tail is appended each turn: `<turns_remaining>N</turns_remaining>` every turn, plus `<due_for_review>…</due_for_review>` and the next-Wave blueprint instruction on the Wave's final turn only.

**P-PR-03 — Review injection is Wave-boundary, not per-turn.** Due concepts are embedded in the Wave's fresh system prompt at Wave start (so they seed the opening teaching), and re-injected on the Wave's final turn as part of the dynamic tail so the LLM can design the next Wave's blueprint around them. Between those two points the Context is append-only; the review block is not rebuilt every turn. Concepts assessed within the current Wave are excluded from the final-turn injection. If nothing is due, the block is omitted entirely (no empty tags).

**P-PR-04 — Custom instructions pass through verbatim.** `<custom_instructions>I have ADHD, so consider this in your teaching style</custom_instructions>` is literally what goes in the prompt.

### 10.6 Security & anti-gaming

**P-SEC-01 — Sanitise user input before prompt insertion.** Strip/encode XML-like tags; wrap in `<user_message>` tags. System prompt instructs the model to treat `<user_message>` content as data, never instructions.

**P-SEC-02 — The model cannot award XP.** XP values are never in the prompt, never in the model's output schema. Model returns `quality_score`; harness computes XP from `tier × quality`. Prompt injection attempting to award XP is structurally impossible.

**P-SEC-03 — Tier advancement requires minimum concept counts.** Cannot be gamed by inflated single-concept scores. See P-XP-04.

### 10.7 UI

**P-UI-01 — Markdown + syntax-highlighted code blocks in chat.** Library selection: `react-markdown` + `shiki` (or `rehype-highlight`) — needs evaluation. Must render code blocks legibly against the Kanagawa palette.

**P-UI-02 — Assessment cards are visually distinct from chat messages.** Not a styled chat bubble. Glassmorphic card UI with MC buttons, freetext escape affordance, submit button, inline result after submission. Note: the assessment card will be placed into the chat input box at the bottom of the UI - this is ultimately a chat app, the user will usually be typing into a chat input field at the bottom of the display, but when assessments are presented to the user, the text box becomes the MC response options and the freetext field. For pure freetext questions, the chat input field doesn't need to change, but there should be a visual distinction that this is a system question that's posed to the user, not just the chat conversation happening to have a question present.

**P-UI-03 — XP toast for every scored answer.** Brief, no explanation. For non-engagement (quality=0), no toast. While the assessments aren't sent back to the model on every question, the harness will have the information for whether the answer is correct or not already passed to it, so it can award XP and show the correct answer as the user submits it in real time without intermediary calls to the model.

### 10.8 Implementation discipline (for the AI agent building this)

**P-IM-01 — All business logic in `src/lib/`.** Components and routers are thin.
**P-IM-02 — All LLM calls through `src/lib/llm/`.** No direct `ai` SDK imports elsewhere.
**P-IM-03 — All DB access through `src/db/queries/`.** No raw SQL in routers or components.
**P-IM-04 — Max 200 lines per file, one concern per file, TSDoc on every export.**
**P-IM-05 — TDD for SM-2, XP, and progression.** Write tests first.
**P-IM-06 — Comment WHY (and during MVP, also WHAT for reviewer speed).** Explicit, boring names.
**P-IM-07 — All algorithm tunables in `src/lib/config/tuning.ts`.** No magic numbers in scoring or SM-2 code.

### 10.9 Open items still to specify

- **Tier-reduction thresholds** — concrete numbers in `tuning.ts` (e.g. demote after 3 consecutive current-tier signals with q < 2, or after a flagged lower-tier concept scores 0 on review).
- **Card-answer collection state machine** — exact storage (localStorage? IndexedDB? server-side draft?) for survival across refresh.
- **Multi-question card UX** — tabbed vs. stacked vs. progressive-reveal when a card has multiple questions. Likely progressive-reveal.
- **Concept deduplication across baseline → teaching turns** — when the model emits a new concept name that's a near-synonym of an existing concept, who reconciles? (Probably the harness, with a post-MVP fuzzy-match pass.) Ideally, the model won't create duplicates if it is able to see the topic list.
- **Cache hot-path** — verifying static-block stability across turns so that, on a cacheable provider, the static prefix actually stays byte-identical.

---

## 11. If this course continued…

This simulation cuts off mid-Wave. In the target flow, the first teaching Wave runs for `WAVE_TURN_COUNT` turns (default 10, in `src/lib/config/tuning.ts`) with `<turns_remaining>N</turns_remaining>` appended to the Context each turn so the model can pace its teaching and land a closing quiz in the wrap-up window.

On the final turn (`turns_remaining == 0`) the Harness injects `<due_for_review>…</due_for_review>` with any SM-2 concepts now due, and instructs the LLM to emit, in one structured response:

1. The closing exchange for the current Wave (quiz / summary).
2. The **next Wave's blueprint** — topic, outline, and the opening user-facing text the next Wave will greet the User with.

The blueprint is persisted on the course row. When the User returns (immediately or after a break), a fresh Context is crystallised from that blueprint plus up-to-date SM-2 state, and the User sees the pre-drafted opening text rather than a blank chat. The prior Wave's Context stays in the UI history but is never replayed into the LLM — the blueprint is the whole handoff.

Internally: **Wave** = one such 5-7 minute teaching unit (append-only Context, byte-stable prefix, fixed turn count). **Tier** = rung of the proficiency framework (e.g. "Tier 2: Borrowing Basics"). In LLM-facing prompt text the Wave is called a **lesson**; "tier" stays as "tier". Everywhere else — code, DB, docs, and user-facing chat copy — the canonical terms are Wave and Tier.
