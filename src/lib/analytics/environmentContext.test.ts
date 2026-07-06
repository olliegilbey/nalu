import { describe, it, expect, afterEach, vi } from "vitest";
import { getServerEnvironmentContext } from "./environmentContext";

afterEach(() => vi.unstubAllEnvs());

describe("getServerEnvironmentContext", () => {
  it("maps VERCEL_ENV=production to source 'production'", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getServerEnvironmentContext().source).toBe("production");
  });

  it("maps VERCEL_ENV=preview to source 'preview' (separates preview data)", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(getServerEnvironmentContext().source).toBe("preview");
  });

  it("maps unset/other VERCEL_ENV to source 'local'", () => {
    vi.stubEnv("VERCEL_ENV", "");
    expect(getServerEnvironmentContext().source).toBe("local");
  });

  it("is always server-side", () => {
    expect(getServerEnvironmentContext().is_server).toBe(true);
  });
});
