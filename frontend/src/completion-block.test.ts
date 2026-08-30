import { describe, expect, test } from "bun:test";
import {
  completedStepsForPresentation,
  completionForPresentation,
  effectiveCompletionBlockReason,
  QC_COMPLETION_PENDING,
} from "./completion-block";
import type { CompletionSummary, Step } from "./types";

const step = (n: number, lab: Step["lab"]): Step => ({
  n,
  stage: 1,
  lab,
  status: "done",
  title: "step",
  goal: "goal",
  tasks: ["one", "two", "three"],
  concept: "concept",
  tip: "tip",
  deps: [],
  handoff: { input: "input", action: "action", output: "output" },
});

const completion: CompletionSummary = {
  completed: [1, 2],
  completed_count: 2,
  total: 16,
  steps: [
    { step: 1, complete: true, missing: [] },
    { step: 2, complete: true, missing: [] },
  ],
};

describe("step-keyed completion blocking", () => {
  test("always ignores a stale QC block on another step", () => {
    const stale = { step: 2, visit: 4, reason: "质检无效" };
    expect(effectiveCompletionBlockReason(step(3, "ind"), stale, 5)).toBeNull();
  });

  test("enters a new Step 2 visit synchronously pending", () => {
    const oldVisit = { step: 2, visit: 3, reason: null };
    expect(effectiveCompletionBlockReason(step(2, "qc"), oldVisit, 5)).toBe(QC_COMPLETION_PENDING);
    expect(effectiveCompletionBlockReason(step(2, "qc"), { ...oldVisit, visit: 5 }, 5)).toBeNull();
  });

  test("temporarily removes blocked completion without mutating the server record", () => {
    const visible = completionForPresentation(completion, 2, "质检无效")!;
    expect(visible.completed).toEqual([1]);
    expect(visible.completed_count).toBe(1);
    expect(visible.steps.find((item) => item.step === 2)?.complete).toBeFalse();
    expect(completion.completed).toEqual([1, 2]);
    expect(completionForPresentation(completion, 2, null)).toBe(completion);

    expect([...completedStepsForPresentation(new Set([1, 2]), 2, "质检无效")]).toEqual([1]);
    expect([...completedStepsForPresentation(new Set([1, 2]), 2, null)]).toEqual([1, 2]);
  });
});
