import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CourseSidebar } from "./app-shell";
import type { StepsResponse } from "./types";

afterEach(cleanup);

const stepsData: StepsResponse = {
  stages: { "1": "测试阶段" },
  steps: Array.from({ length: 15 }, (_, index) => ({
    n: index + 1, title: `步骤${index + 1}`, stage: 1, lab: "ind", status: "done",
    goal: "", tasks: ["one", "two", "three"], concept: "", tip: "", deps: [],
    handoff: { input: "", action: "", output: "" },
  })),
};

test("navigation reveals the active outline row but saving progress does not undo manual scrolling or steal focus", () => {
  const view = (current: number, completed: number[] = []) => <>
    <button>下一步测试</button>
    <CourseSidebar stepsData={stepsData} current={current}
      completion={{ steps: [], completed, completed_count: completed.length, total: 15 }}
      materialGate={null} onNavigate={() => {}} />
  </>;
  const { container, rerender } = render(view(1));
  const list = container.querySelector<HTMLElement>(".sidebar-list")!;
  const last = container.querySelector<HTMLElement>('[aria-label^="第 15 步"]')!;
  const first = container.querySelector<HTMLElement>('[aria-label^="第 1 步："]')!;
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect;
  last.getBoundingClientRect = () => ({ top: 800 - list.scrollTop, bottom: 850 - list.scrollTop }) as DOMRect;
  first.getBoundingClientRect = () => ({ top: 120 - list.scrollTop, bottom: 170 - list.scrollTop }) as DOMRect;
  const next = screen.getByRole("button", { name: "下一步测试" });
  next.focus();

  rerender(view(15));
  expect(list.scrollTop).toBe(350);
  expect(document.activeElement).toBe(next);
  expect(last.getAttribute("aria-current")).toBe("step");

  list.scrollTop = 0; // Student deliberately browses earlier steps.
  rerender(view(15, [1]));
  expect(list.scrollTop).toBe(0);
  expect(document.activeElement).toBe(next);

  list.scrollTop = 300;
  rerender(view(1, [1]));
  expect(list.scrollTop).toBe(20);
  expect(first.getAttribute("aria-current")).toBe("step");
  expect(document.activeElement).toBe(next);
});
