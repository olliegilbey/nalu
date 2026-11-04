/**
 * Fixed Wave Contexts for the teaching-prompt probes in `probe-model.ts`
 * (issues #164, #215). One Rust-ownership course at tier 2. Every row is
 * built with the Harness's own envelope code, so the probe sends the bytes
 * a live Wave would: `buildLearnerInput` wraps the learner's text,
 * `renderWaveTurnEnvelope` adds `<turns_remaining>`, and the caller renders
 * the rows through `assembleLlmMessages`.
 *
 * The history is hand-written, not model output. It mirrors the
 * `wave.live.test.ts` learner script: chat turns, two quizzes the learner
 * answers on the next turn, and "no quiz this turn" on Turn 8.
 */

import type { AppendMessageParams } from "@/db/queries/contextMessages";
import type { WaveSeedInputs } from "@/lib/types/context";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";
import type { ToolQuestionInput } from "@/lib/course/waveTurnTools";
import { buildLearnerInput, type OpenQuestionnaireRecord } from "@/lib/course/buildLearnerInput";
import { renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import { WAVE } from "@/lib/config/tuning";

/** The probe Wave's seed: what `buildWaveSeed` reads from the course and Wave rows. */
export const PROBE_WAVE_SEED: WaveSeedInputs = {
  kind: "wave",
  courseTopic: "Rust ownership",
  topicScope:
    "Ownership, borrowing and lifetimes in Rust, for a Python developer who wants to write safe systems code.",
  framework: {
    userMessage: "Here is how we will climb from moves to lifetimes.",
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2, 3],
    tiers: [
      {
        number: 1,
        name: "Ownership basics",
        description: "Each value has one owner; assignment moves it; scope end drops it.",
        exampleConcepts: ["move semantics", "drop at scope end"],
      },
      {
        number: 2,
        name: "Borrowing",
        description: "References lend access without moving: many readers or one writer.",
        exampleConcepts: ["shared references", "mutable references", "borrowing rules"],
      },
      {
        number: 3,
        name: "Lifetimes",
        description: "Annotating how long references stay valid across functions and structs.",
        exampleConcepts: ["lifetime annotations", "lifetime elision"],
      },
    ],
  },
  currentTier: 2,
  customInstructions: null,
  courseSummary:
    "The learner knows Python and basic Rust syntax. The baseline showed solid move semantics and shaky borrowing rules, so lessons start at tier 2.",
  dueConcepts: [],
  seedSource: {
    kind: "scoping_handoff",
    blueprint: {
      topic: "Borrowing: shared and mutable references",
      outline: [
        "Why borrow instead of move",
        "Shared references (&T)",
        "Mutable references (&mut T)",
        "Many readers or one writer",
        "A borrow ends at its last use",
      ],
      openingText:
        "Welcome back! You already know that assigning a String moves it. Today we look at borrowing: how a function can use a value without taking it from you. Ready to start with why borrowing exists?",
      plannedConcepts: [
        { name: "shared references", tier: 2, role: "fresh" },
        { name: "mutable references", tier: 2, role: "fresh" },
        { name: "borrowing rules", tier: 2, role: "fresh" },
        { name: "non-lexical lifetimes", tier: 2, role: "fresh" },
      ],
    },
  },
};

/** The learner's chat line on most turns of `wave.live.test.ts`. */
const NEXT_CONCEPT = "Got it — could you walk me through the next concept with a concrete example?";

/** The Turn-1 quiz request the #192 A/B used (issue #215 probe). */
export const TURN_1_QUIZ_REQUEST =
  "Teach me the first idea, then give me one short-answer question.";

/** The final mid-turn quiz request `wave.live.test.ts` sends on Turn 9 (issue #164 probe). */
export const FINAL_MID_TURN_QUIZ_REQUEST =
  "Teach me one more small idea, then quiz me with one short-answer question.";

const MC_QUESTION: ToolQuestionInput = {
  id: "q1",
  type: "multiple_choice",
  prompt: "What does `calculate_length(&s)` hand to the function?",
  conceptName: "shared references",
  freetextRubric:
    "A correct answer says the function gets a reference that borrows s; ownership stays with the caller.",
  options: {
    A: "A reference that borrows s",
    B: "A copy of the String",
    C: "Ownership of s",
    D: "A mutable reference to s",
  },
  correct: "A",
  tier: 2,
};

const FREE_TEXT_QUESTION: ToolQuestionInput = {
  id: "q1",
  type: "free_text",
  prompt: "Why does Rust reject taking `&mut v` while a shared reference to `v` is still in use?",
  conceptName: "borrowing rules",
  freetextRubric:
    "A correct answer says a value may have many shared readers or one writer, never both at once, so a write cannot change data a reader still relies on.",
  tier: 2,
};

/** One scripted Turn: what the learner sent, the tool calls the model made, and its message. */
interface ScriptedTurn {
  readonly payload: SubmitTurnPayload;
  readonly toolCall?: {
    readonly toolName: string;
    readonly input: unknown;
    readonly output: unknown;
  };
  readonly reply: string;
}

const quizCall = (question: ToolQuestionInput) => ({
  toolName: "presentQuestionnaire",
  input: { questions: [question] },
  output: { accepted: true, questionCount: 1 },
});

/** Turns 1 to 8 of the probe Wave, in order. */
const HISTORY: readonly ScriptedTurn[] = [
  {
    payload: { kind: "chat-text", text: NEXT_CONCEPT },
    reply:
      "Sure! Say you pass a String to a function: `let n = calculate_length(s);`. The function now owns `s`, so you cannot use `s` afterwards. That is a lot of ceremony just to read a length. Borrowing fixes it: write `calculate_length(&s)` and the function gets a reference. You keep ownership, and `s` is still yours when the call returns. How does that compare with how Python passes objects around?",
  },
  {
    payload: { kind: "chat-text", text: NEXT_CONCEPT },
    toolCall: quizCall(MC_QUESTION),
    reply:
      'Here is the shape of a borrowing function:\n\n```rust\nfn calculate_length(s: &String) -> usize {\n    s.len()\n}\n```\n\nThe `&String` parameter type says "I only look, I do not take". When the function ends, the reference goes away and nothing is dropped, because the function never owned the String. Have a go at the quick check below.',
  },
  {
    payload: {
      kind: "questionnaire-answers",
      questionnaireId: "probe-quiz-1",
      answers: [{ id: "q1", kind: "mc", selected: "A" }],
    },
    toolCall: {
      toolName: "recordComprehensionSignals",
      input: {
        signals: [
          {
            kind: "mc-index",
            questionId: "q1",
            rationale:
              "The learner knows a reference borrows without moving. Next, show that a shared reference cannot change the value.",
          },
        ],
      },
      output: { recorded: 1 },
    },
    reply:
      'Exactly right: `&s` lends the function a reference, and ownership stays with you. One catch: a shared reference is read-only. If `calculate_length` tried `s.push_str("!")`, the compiler would refuse. Want to see how we allow changes?',
  },
  {
    payload: { kind: "chat-text", text: NEXT_CONCEPT },
    reply:
      'To change a borrowed value, both sides opt in. The variable must be `let mut s`, and the reference must be `&mut s`:\n\n```rust\nfn add_bang(s: &mut String) {\n    s.push_str("!");\n}\n```\n\nCalling `add_bang(&mut s)` lends write access for the length of the call. Afterwards `s` holds the changed text and is still yours. Does the `mut` on both sides make sense?',
  },
  {
    payload: { kind: "chat-text", text: NEXT_CONCEPT },
    toolCall: quizCall(FREE_TEXT_QUESTION),
    reply:
      'Here is the big rule. At any moment a value can have either many shared references or exactly one mutable reference, never both. So this fails:\n\n```rust\nlet mut v = vec![1, 2, 3];\nlet first = &v[0];\nv.push(4);\nprintln!("{first}");\n```\n\n`first` is a reader, and `v.push(4)` needs a writer while that reader is still in use. Pushing may move the vector\'s buffer, which would leave `first` pointing at freed memory. Take a moment with the question below.',
  },
  {
    payload: {
      kind: "questionnaire-answers",
      questionnaireId: "probe-quiz-2",
      answers: [
        {
          id: "q1",
          kind: "freetext",
          text: "Because you can have many readers or one writer but not both at the same time, so the write could change data the reader still depends on.",
          fromEscape: false,
        },
      ],
    },
    toolCall: {
      toolName: "recordComprehensionSignals",
      input: {
        signals: [
          {
            kind: "free-text",
            questionId: "q1",
            verdict: "correct",
            qualityScore: 5,
            rationale:
              "The learner states the readers-or-writer rule and why it protects readers. Next, show when a borrow ends.",
          },
        ],
      },
      output: { recorded: 1 },
    },
    reply:
      "Spot on. Many readers or one writer, and you named the reason: a write could pull the data out from under a reader. That rule is how Rust rules out a whole class of memory bugs at compile time. Ready for the twist that makes it less strict than it sounds?",
  },
  {
    payload: { kind: "chat-text", text: NEXT_CONCEPT },
    reply:
      'The twist: a borrow lasts only until its last use, not until the end of the block. This compiles:\n\n```rust\nlet mut v = vec![1, 2, 3];\nlet first = &v[0];\nprintln!("{first}");\nv.push(4);\n```\n\n`first` is last used in the `println!`, so the shared borrow is over before `v.push(4)` asks for a writer. The compiler tracks this for you. People call it non-lexical lifetimes. Does the difference from the earlier example click?',
  },
  {
    payload: {
      kind: "chat-text",
      text: "Could you walk me through the next concept with a concrete example? No quiz this turn, please.",
    },
    reply:
      'No quiz, promise. Here is the rule from a function\'s side. A function may return a reference only if it points at something the caller owns. This fails:\n\n```rust\nfn longest_word() -> &str {\n    let text = String::from("borrow checker");\n    &text\n}\n```\n\n`text` is dropped when the function returns, so the reference would dangle. Returning the `String` itself moves ownership out and works fine. That idea leads into lifetimes, which is where the next level picks up.',
  },
];

/** The open questionnaire a scripted answer Turn replies to, as `loadWaveContext` would load it. */
function openQuestionnaireFor(turn: ScriptedTurn, prior: ScriptedTurn | undefined) {
  if (turn.payload.kind !== "questionnaire-answers") return null;
  const posed = prior?.toolCall?.input as { questions: readonly ToolQuestionInput[] } | undefined;
  if (!posed) throw new Error("waveTurnProbe fixture: an answer Turn must follow a quiz Turn");
  return {
    questionnaireId: turn.payload.questionnaireId,
    questions: posed.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      correct: q.correct,
      freetextRubric: q.freetextRubric,
    })),
  } satisfies OpenQuestionnaireRecord;
}

const PARENT = { kind: "wave", id: "00000000-0000-4000-8000-00000000fade" } as const;

/** The Turn's user row: learner input plus the Harness's `<turns_remaining>` tag. */
function userRow(turnIndex: number, learnerInput: string): AppendMessageParams {
  return {
    parent: PARENT,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: renderWaveTurnEnvelope({
      learnerInput,
      turnsRemaining: WAVE.turnCount - turnIndex,
    }),
  };
}

/** The rows one scripted Turn persists, in `executeToolTurnStream`'s order. */
function turnRows(turn: ScriptedTurn, turnIndex: number, prior: ScriptedTurn | undefined) {
  const toolRows: readonly AppendMessageParams[] = turn.toolCall
    ? [
        {
          parent: PARENT,
          turnIndex,
          seq: 1,
          kind: "assistant_tool_call",
          role: "assistant",
          content: JSON.stringify({
            text: "",
            toolCalls: [
              {
                toolCallId: `call-${turnIndex}`,
                toolName: turn.toolCall.toolName,
                input: turn.toolCall.input,
              },
            ],
          }),
        },
        {
          parent: PARENT,
          turnIndex,
          seq: 2,
          kind: "tool_result",
          role: "tool",
          content: JSON.stringify({
            results: [
              {
                toolCallId: `call-${turnIndex}`,
                toolName: turn.toolCall.toolName,
                output: turn.toolCall.output,
              },
            ],
          }),
        },
      ]
    : [];
  const reply: AppendMessageParams = {
    parent: PARENT,
    turnIndex,
    seq: toolRows.length + 1,
    kind: "assistant_response",
    role: "assistant",
    content: turn.reply,
  };
  return [
    userRow(turnIndex, buildLearnerInput(turn.payload, openQuestionnaireFor(turn, prior))),
    ...toolRows,
    reply,
  ];
}

/** Turn 0: the blueprint's opening message, as the scoping close seeds it. */
const OPENING_ROW: AppendMessageParams = {
  parent: PARENT,
  turnIndex: 0,
  seq: 0,
  kind: "assistant_response",
  role: "assistant",
  content: PROBE_WAVE_SEED.seedSource.blueprint.openingText,
};

/**
 * The probe Wave's rows up to and including the asked Turn's user row.
 * `turn` 1 sends the opening only; `turn` 9 replays all eight scripted
 * Turns first. The asked Turn's learner text is chat.
 */
export function probeWaveRows(turn: number, learnerText: string): readonly AppendMessageParams[] {
  const history = HISTORY.slice(0, turn - 1).flatMap((t, i) => turnRows(t, i + 1, HISTORY[i - 1]));
  return [
    OPENING_ROW,
    ...history,
    userRow(turn, buildLearnerInput({ kind: "chat-text", text: learnerText }, null)),
  ];
}
