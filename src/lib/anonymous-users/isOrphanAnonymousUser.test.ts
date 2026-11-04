import { describe, it, expect } from "vitest";
import type { AuthUserActivity } from "@/lib/types/authUserActivity";
import { isOrphanAnonymousUser } from "./isOrphanAnonymousUser";

// Fixed cutoff for deterministic tests: activity before it is idle.
const IDLE_BEFORE = new Date("2026-10-05T00:00:00Z");
const LONG_AGO = new Date("2026-06-01T00:00:00Z");
const RECENT = new Date("2026-11-01T00:00:00Z");

/** An idle, courseless anonymous user: the one shape the rule selects. */
const IDLE_ORPHAN: AuthUserActivity = {
  id: "a0000000-0000-4000-8000-000000000001",
  isAnonymous: true,
  ownsCourse: false,
  createdAt: LONG_AGO,
  lastSignInAt: LONG_AGO,
  lastSessionRefreshedAt: LONG_AGO,
  lastSessionUpdatedAt: LONG_AGO,
};

describe("isOrphanAnonymousUser", () => {
  it("selects an idle anonymous user who owns no course", () => {
    expect(isOrphanAnonymousUser(IDLE_ORPHAN, IDLE_BEFORE)).toBe(true);
  });

  it("keeps an anonymous user who owns a course", () => {
    expect(isOrphanAnonymousUser({ ...IDLE_ORPHAN, ownsCourse: true }, IDLE_BEFORE)).toBe(false);
  });

  it("keeps a user who is not anonymous", () => {
    expect(isOrphanAnonymousUser({ ...IDLE_ORPHAN, isAnonymous: false }, IDLE_BEFORE)).toBe(false);
  });

  it("keeps an anonymous user created recently", () => {
    const user = { ...IDLE_ORPHAN, createdAt: RECENT, lastSignInAt: RECENT };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(false);
  });

  it("keeps an old user whose last sign-in is recent", () => {
    expect(isOrphanAnonymousUser({ ...IDLE_ORPHAN, lastSignInAt: RECENT }, IDLE_BEFORE)).toBe(
      false,
    );
  });

  it("keeps an old user whose session refreshed recently", () => {
    const user = { ...IDLE_ORPHAN, lastSessionRefreshedAt: RECENT };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(false);
  });

  it("keeps an old user whose session updated recently", () => {
    const user = { ...IDLE_ORPHAN, lastSessionUpdatedAt: RECENT };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(false);
  });

  it("selects an idle user with no sessions and no sign-in", () => {
    const user = {
      ...IDLE_ORPHAN,
      lastSignInAt: null,
      lastSessionRefreshedAt: null,
      lastSessionUpdatedAt: null,
    };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(true);
  });

  it("keeps a user whose every activity time is null: an unknown age is not idle", () => {
    const user = {
      ...IDLE_ORPHAN,
      createdAt: null,
      lastSignInAt: null,
      lastSessionRefreshedAt: null,
      lastSessionUpdatedAt: null,
    };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(false);
  });

  it("keeps a user whose last activity falls exactly on the cutoff", () => {
    const user = { ...IDLE_ORPHAN, lastSessionRefreshedAt: IDLE_BEFORE };
    expect(isOrphanAnonymousUser(user, IDLE_BEFORE)).toBe(false);
  });
});
