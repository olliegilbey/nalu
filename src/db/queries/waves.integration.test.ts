import { describe, it, expect } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { NotFoundError } from "./errors";
import { getWaveById } from "./waves";

describe("waves queries", () => {
  // -------------------------------------------------------------------------
  // Test 5: getWaveById throws NotFoundError for unknown id
  // -------------------------------------------------------------------------
  it("getWaveById throws NotFoundError for unknown id", async () => {
    await withTestDb(async () => {
      await expect(getWaveById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
