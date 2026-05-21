// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCourseXp } from "./useCourseXp";

/**
 * In-memory `Storage` polyfill.
 *
 * Bun + jsdom in this repo exposes a `window.localStorage` object whose
 * methods (`getItem`/`setItem`/`clear`/...) are all `undefined` — Bun's
 * experimental native `--localstorage-file` stub shadows jsdom's working
 * implementation. The hook's `try/catch` survives that gracefully, but a
 * persistence test needs a *real* Storage, so we install one per test.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    // eslint-disable-next-line functional/immutable-data -- a Storage polyfill is inherently stateful
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    // eslint-disable-next-line functional/immutable-data -- a Storage polyfill is inherently stateful
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    // eslint-disable-next-line functional/immutable-data -- a Storage polyfill is inherently stateful
    this.store.set(key, String(value));
  }
}

beforeEach(() => {
  // Replace the broken Bun/jsdom stub with a working in-memory Storage.
  // eslint-disable-next-line functional/immutable-data -- swapping in a working localStorage shim for the test
  Object.defineProperty(window, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
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
