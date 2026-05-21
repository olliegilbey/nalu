// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCourseXp } from "./useCourseXp";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";

beforeEach(() => {
  // Bun/jsdom's localStorage stub is broken; install a working in-memory
  // Storage (fresh per test, so XP totals don't leak). See the module's TSDoc.
  installMemoryStorage();
});

describe("useCourseXp", () => {
  it("starts at zero for a fresh course", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    expect(result.current.xp).toBe(0);
    expect(result.current.pulseKey).toBe(0);
  });

  it("accumulates XP and bumps the pulse key on addXp", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(10));
    expect(result.current.xp).toBe(10);
    expect(result.current.gainAmount).toBe(10);
    expect(result.current.pulseKey).toBe(1);
    act(() => result.current.addXp(20));
    expect(result.current.xp).toBe(30);
    expect(result.current.gainAmount).toBe(20);
    expect(result.current.pulseKey).toBe(2);
  });

  it("ignores non-positive amounts", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(0));
    act(() => result.current.addXp(-5));
    expect(result.current.xp).toBe(0);
    expect(result.current.pulseKey).toBe(0);
  });

  it("persists the total to localStorage and rehydrates it", () => {
    const first = renderHook(() => useCourseXp("c1"));
    act(() => first.result.current.addXp(40));
    expect(window.localStorage.getItem("nalu:course:c1:xp")).toBe("40");
    const second = renderHook(() => useCourseXp("c1"));
    expect(second.result.current.xp).toBe(40);
  });

  it("scopes the counter per courseId", () => {
    const { result } = renderHook(() => useCourseXp("c1"));
    act(() => result.current.addXp(15));
    const other = renderHook(() => useCourseXp("c2"));
    expect(other.result.current.xp).toBe(0);
  });
});
