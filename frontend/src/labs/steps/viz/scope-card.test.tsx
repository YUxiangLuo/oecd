import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { lineEnds, ScopeCard } from "./scope-card";

afterEach(cleanup);

test("a separator is hidden where the summary wraps, so no line ends in a dangling · (1000 px, round 5)", () => {
  // 所选国家 · 范围 · 年份 on the first line, 指标 below it.
  const boxes = [{ top: 0, bottom: 40 }, { top: 8, bottom: 32 }, { top: 8, bottom: 32 }, { top: 44, bottom: 68 }];
  expect(lineEnds(boxes)).toEqual([false, false, true, false]);
  // A centred, shorter neighbour on the same line is not a new line; an unlaid-out card hides nothing.
  expect(lineEnds([{ top: 0, bottom: 40 }, { top: 12, bottom: 28 }])).toEqual([false, false]);
  expect(lineEnds([{ top: 0, bottom: 0 }, { top: 0, bottom: 0 }])).toEqual([false, false]);
});

test("the rendered card hides only the separator at a line end", () => {
  const layout: Record<string, { top: number; height: number }> = {
    所选国家: { top: 0, height: 40 }, 范围: { top: 8, height: 24 }, 年份: { top: 8, height: 24 }, 指标: { top: 44, height: 24 },
  };
  const box = (node: HTMLElement) => layout[node.querySelector(".scope-chip > span")?.textContent ?? ""];
  const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return box(this)?.top ?? 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return box(this)?.height ?? 0; } });
  try {
    const view = render(<ScopeCard items={["所选国家", "范围", "年份", "指标"].map((label) => ({ label, value: label }))} />);
    const separators = [...view.container.querySelectorAll<HTMLElement>(".scope-sep")];
    expect(separators.map((sep) => sep.style.visibility)).toEqual(["", "", "hidden"]);
  } finally {
    for (const [name, descriptor] of [["offsetTop", top], ["offsetHeight", height]] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
});
