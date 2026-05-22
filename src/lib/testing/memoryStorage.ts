/**
 * In-memory `Storage` polyfill for tests that touch `localStorage`.
 *
 * WHY this exists: Bun + jsdom in this repo exposes a `window.localStorage`
 * object whose methods (`getItem`/`setItem`/`clear`/...) are all `undefined` —
 * Bun's experimental native `--localstorage-file` stub shadows jsdom's working
 * implementation. Hooks that read/write storage (`useCourseXp`, and anything
 * that depends on it like `useWaveState`) guard with `try/catch` and survive
 * the broken stub gracefully, but a test that asserts XP *persistence* or
 * *accumulation* needs a real working Storage. This module provides one.
 *
 * `installMemoryStorage()` installs a fresh empty instance per call, so calling
 * it in a `beforeEach` both fixes the stub and resets state between tests — no
 * separate `.clear()` is needed.
 */

/**
 * Minimal `Storage` implementation backed by an in-memory `Map`.
 *
 * A Storage polyfill is inherently a stateful class with mutating methods;
 * `eslint-plugin-functional`'s `immutable-data` rule is disabled narrowly
 * per-line below with justifications rather than blanket-ignored.
 */
class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();
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

/**
 * Install a fresh in-memory `Storage` onto `window.localStorage`.
 *
 * Call this in a test's `beforeEach`. Each call swaps in a brand-new empty
 * instance, so storage-backed state cannot leak between tests.
 */
export function installMemoryStorage(): void {
  // Replace the broken Bun/jsdom stub with a working in-memory Storage.
  // eslint-disable-next-line functional/immutable-data -- swapping in a working localStorage shim for the test
  Object.defineProperty(window, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
