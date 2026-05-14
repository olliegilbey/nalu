/**
 * Fixture topic pool for live scoping smoke tests.
 *
 * Three deliberately diverse topics so a single live run exercises the
 * framework/baseline generation across different domains and vocabulary.
 * Diversity also makes structural regressions easier to spot (one topic
 * flaking is more likely a domain-specific prompt issue than a common one).
 *
 * `answerPool` entries are intentionally generic freetext sentences a real
 * learner might type. The live test cycles them by index `i % pool.length`
 * to satisfy however many clarifying questions the model returns (2–4).
 * They don't need to map 1:1 to specific questions — they just need to be
 * coherent enough that the framework generation step produces a valid result.
 */

/** A single topic fixture for the live scoping smoke test. */
export interface ScopingTopic {
  /** Short identifier used in test descriptions and log labels. */
  readonly slug: string;
  /** The topic string sent to `course.clarify`. */
  readonly topic: string;
  /**
   * Pool of freetext answers to cycle through when the model returns
   * clarifying questions. Must have ≥4 entries; the live test uses
   * `pool[i % pool.length]` to fill any number of questions (2–4).
   */
  readonly answerPool: readonly string[];
}

/**
 * Three diverse topics for the live smoke-test loop.
 *
 * Suggested by the brief (§3 — "Files to create → topicPool.ts").
 * Answer pools are generic learner-voice responses that work for any
 * plausible clarifying question a tutor might ask about the domain.
 */
export const SCOPING_TOPICS: readonly ScopingTopic[] = [
  {
    slug: "rust-ownership-embedded",
    topic: "Rust ownership for an engineer moving into embedded firmware development",
    answerPool: [
      "I want to write bare-metal firmware for ARM microcontrollers without a standard OS.",
      "I have about three years of C experience and a little C++, but Rust is new to me.",
      "My main concern is understanding how ownership and borrowing interact with interrupt handlers and shared mutable state.",
      "I am comfortable with pointers and manual memory management but want to avoid data races at compile time.",
      "I have read the Rust Book up to chapter 6 but have not written anything larger than a toy project yet.",
      "I plan to use no_std and ideally cortex-m with RTIC for scheduling tasks.",
    ],
  },
  {
    slug: "sourdough-fermentation",
    topic: "Sourdough baking with a focus on fermentation timing and temperature control",
    answerPool: [
      "I have made a few loaves with commercial yeast but never successfully maintained a sourdough starter for more than two weeks.",
      "My kitchen runs between 18 and 22 degrees Celsius depending on the season, and I want to adapt timing to that range.",
      "I am most interested in understanding what is happening biologically during bulk fermentation so I can diagnose flat or over-proofed loaves.",
      "I bake once or twice a week and want a reliable process rather than a flexible open-ended one.",
      "I tried following a recipe exactly and the loaf was dense, so I suspect my bulk ferment was off.",
      "I am happy to use a kitchen scale and thermometer but do not have a proofing box.",
    ],
  },
  {
    slug: "k8s-operators",
    topic: "Kubernetes operators for someone with Go and Kubernetes API basics",
    answerPool: [
      "I am comfortable writing Go services and have used kubectl and basic manifests for deployments, but I have never written a controller.",
      "My goal is to build a custom operator that manages lifecycle of a stateful application including rolling upgrades and backup triggers.",
      "I want to understand the reconciler pattern, status sub-resources, and how to handle edge cases like partial failures.",
      "I have read the controller-runtime docs once but could not translate them into a working project.",
      "I know what a Custom Resource Definition is and have applied a few, but I have not authored one from scratch.",
      "I am most unsure about how to handle re-queue logic and back-off correctly in the reconcile loop.",
    ],
  },
];
