import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuizPanel, type QuizDraftStore } from "./step-quiz";
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


afterEach(cleanup);

test("keeps unsubmitted choices across step remounts without marking completion or crossing workspaces", () => {
  const drafts: QuizDraftStore = new Map();
  let writes = 0;
  const empty = { ...state, data: {}, save: () => { writes++; } };
  const first = render(<QuizPanel step={step} state={empty} draftStore={drafts} />);
  fireEvent.click(screen.getByLabelText("始终"));
  first.unmount();
  const second = render(<QuizPanel step={step} state={empty} draftStore={drafts} />);
  expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(true);
  expect(writes).toBe(0);
  expect(screen.queryByText("✓ 本步已完成")).toBeNull();
  second.rerender(<QuizPanel step={{ ...step, quiz: { ...step.quiz!, version: "v2" } }} state={empty} draftStore={drafts} />);
  expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(false);
  second.rerender(<QuizPanel step={step} state={empty} draftStore={new Map()} />);
  expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(false);
});
