import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuizPanel } from "./step-quiz";
import type { Step, StepStateApi } from "./types";

const step: Step = {
  n: 2,
  stage: 1,
  lab: "qc",
  status: "done",
  title: "质检",
  goal: "质检",
  tasks: ["one", "two", "three"],
  concept: "质检",
  tip: "质检",
  deps: [],
  handoff: { input: "input", action: "action", output: "output" },
  quiz: {
    version: "v1",
    questions: [
      {
        id: "q1",
        prompt: "何时发布？",
        options: [{ id: "a", label: "通过后" }, { id: "b", label: "始终" }],
      },
    ],
  },
};

const state: StepStateApi<Record<string, unknown>> = {
  data: { quiz: { version: "v1", answers: { q1: "a" } } },
  save: () => {},
  complete: false,
  syncing: false,
  syncError: null,
  syncNow: () => {},
};

describe("QuizPanel completion blocking", () => {
  test("disables an otherwise submittable quiz and exposes the QC reason", () => {
    const html = renderToStaticMarkup(
      <QuizPanel step={step} state={state} completionBlockedReason="核心质检不完整，不能提交" />,
    );
    expect(html).toContain("核心质检不完整，不能提交");
    expect(html).toContain("role=\"alert\"");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  test("hides stale durable success presentation while blocked", () => {
    const html = renderToStaticMarkup(
      <QuizPanel
        step={step}
        state={{ ...state, complete: true }}
        completionBlockedReason="核心质检不完整，不能提交"
      />,
    );
    expect(html).not.toContain("quiz-box done");
    expect(html).not.toContain("✓ 本步已完成");
    expect(html).toContain("质检状态有效后才能显示并提交本步完成状态");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  test("keeps normal valid-release quiz submission available", () => {
    const html = renderToStaticMarkup(<QuizPanel step={step} state={state} />);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });
});
