// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WaveProgressBar } from "./WaveProgressBar";

beforeEach(() => {
  cleanup();
});

describe("WaveProgressBar", () => {
  it("shows the turn the learner is on and fills the bar with landed turns", () => {
    render(
      <WaveProgressBar
        progress={{ currentTurn: 4, turnBudget: 10, percent: 30, isComplete: false }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Wave progress" });
    expect(bar.textContent).toContain("Turn 4 of 10");
    expect(bar.getAttribute("aria-valuetext")).toBe("Turn 4 of 10");
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
  });

  it("says the Wave is complete once it closes", () => {
    render(
      <WaveProgressBar
        progress={{ currentTurn: 10, turnBudget: 10, percent: 100, isComplete: true }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Wave progress" });
    expect(bar.textContent).toContain("Wave complete");
    expect(bar.textContent).not.toContain("Turn");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });
});
