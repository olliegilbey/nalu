// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

/*
 * A home suggestion sends only its label as the topic (issue #78). The `kind`
 * tag ("concept", "skill") picks the accent colour. It is not part of the
 * learner's intent, so it must not reach the clarify prompt.
 */
describe("EmptyState suggestions", () => {
  it("picks the suggestion label alone, without its kind", () => {
    const onPick = vi.fn();
    render(<EmptyState onPick={onPick} />);

    fireEvent.click(screen.getByRole("button", { name: /how transformers work/ }));

    expect(onPick).toHaveBeenCalledWith("how transformers work");
  });
});
