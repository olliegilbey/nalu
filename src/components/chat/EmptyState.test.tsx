// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { i18n } from "@/i18n";
import { EmptyState } from "./EmptyState";

const pool = i18n.home.suggestionPool;

afterEach(() => {
  vi.restoreAllMocks();
});

/*
 * A home suggestion sends only its label as the topic (issue #78). The `kind`
 * tag ("concept", "skill") picks the accent colour. It is not part of the
 * learner's intent, so it must not reach the clarify prompt.
 */
describe("EmptyState suggestions", () => {
  it("picks the suggestion label alone, without its kind", () => {
    // 0 draws the first label of each kind.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onPick = vi.fn();
    render(<EmptyState onPick={onPick} />);

    fireEvent.click(screen.getByRole("button", { name: /how transformers work/ }));

    expect(onPick).toHaveBeenCalledWith("how transformers work");
  });
});

/*
 * Issue #79: each visit draws one suggestion per kind from the pool. The draw
 * runs after mount. The server HTML holds no suggestion, so it always matches
 * the client's first render and hydration never mismatches.
 */
describe("EmptyState suggestion pool", () => {
  it("server-renders no suggestion", () => {
    const html = renderToString(<EmptyState onPick={vi.fn()} />);

    for (const label of Object.values(pool).flat()) expect(html).not.toContain(label);
  });

  it("draws one suggestion per kind with Math.random after mount", () => {
    // 0.999 draws the last label of each kind.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    render(<EmptyState onPick={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(Object.keys(pool).length);
    for (const labels of Object.values(pool)) expect(screen.getByText(labels.at(-1)!)).toBeTruthy();
  });
});
