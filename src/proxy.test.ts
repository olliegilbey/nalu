// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("non-production: passes through without touching Supabase", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await proxy(new NextRequest("http://localhost/"));
    expect(res).toBeInstanceOf(NextResponse);
  });
});
