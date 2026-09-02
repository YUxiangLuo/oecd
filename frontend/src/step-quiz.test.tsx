import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuizPanel } from "./step-quiz";
import type { Step, StepStateApi } from "./types";

const step: Step = {
  n: 2,
  stage: 1,
  lab: "ind",
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

describe("QuizPanel completion", () => {
  test("keeps normal valid-release quiz submission available", () => {
    const html = renderToStaticMarkup(<QuizPanel step={step} state={state} />);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });
});
