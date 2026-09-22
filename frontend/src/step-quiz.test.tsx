import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "./api";
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
  test("keeps passed understanding separate from missing, saving and confirmed materials", () => {
    let opened = 0;
    const view = (materialStatus: "missing" | "saving" | "ready") => <QuizPanel step={step}
      state={{ ...state, complete: true }} materialStatus={materialStatus} onRecordMaterials={() => { opened++; }} />;
    const { rerender } = render(view("missing"));
    expect(screen.getByText("✓ 理解题已完成")).toBeTruthy();
    expect(screen.queryByText("✓ 本步已完成")).toBeNull();
    expect(screen.getByText(/报告材料：尚未齐全/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去补齐材料" }));
    expect(opened).toBe(1);
    rerender(view("saving"));
    expect(screen.getByText(/报告材料：正在保存/)).toBeTruthy();
    expect(screen.queryByText(/报告材料：已齐全/)).toBeNull();
    rerender(view("ready"));
    expect(screen.getByText(/报告材料：已齐全/)).toBeTruthy();
  });

  test("keeps normal valid-release quiz submission available", () => {
    const html = renderToStaticMarkup(<QuizPanel step={step} state={state} />);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });
});


afterEach(cleanup);

type Grade = Awaited<ReturnType<typeof api.classroom.submitQuiz>>;
function pendingGrade() {
  let resolve!: (value: Grade) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Grade>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const passed: Grade = {
  passed: true, version: "v1", quiz: { version: "v1", answers: { q1: "a" } },
  results: [{ question_id: "q1", correct: true, explanation: "已通过" }],
};

test("locks choices only while grading or confirming completion and retains choices on network failure", async () => {
  const original = api.classroom.submitQuiz;
  const pending = pendingGrade();
  const requests: unknown[] = [];
  api.classroom.submitQuiz = async (request) => { requests.push(request); return pending.promise; };
  try {
    const { container, rerender } = render(<QuizPanel step={step} state={{ ...state, data: {} }} />);
    fireEvent.click(screen.getByLabelText("通过后"));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(screen.getByLabelText("始终"));
    expect((screen.getByLabelText("通过后") as HTMLInputElement).checked).toBe(true);
    expect(requests).toEqual([{ step: 2, version: "v1", answers: { q1: "a" } }]);
    await act(async () => { pending.reject(new Error("Failed to fetch")); });
    expect(screen.getByRole("alert").textContent).toContain("选择已保留，可重试");
    expect(screen.getByRole("alert").textContent).toContain("网络连接中断");
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
    expect((screen.getByLabelText("通过后") as HTMLInputElement).checked).toBe(true);
    rerender(<QuizPanel step={step} state={{ ...state, syncing: true }} />);
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    rerender(<QuizPanel step={step} state={{ ...state, syncing: false, syncError: "offline" }} />);
    expect(container.querySelector("fieldset")?.disabled).toBe(false);
  } finally { api.classroom.submitQuiz = original; }
});

test("editing one answer retains feedback for the unedited question", async () => {
  const original = api.classroom.submitQuiz;
  const two = { ...step, quiz: { ...step.quiz!, questions: [...step.quiz!.questions, { ...step.quiz!.questions[0], id: "q2" }] } };
  api.classroom.submitQuiz = async () => ({ passed: false, version: "v1", results: [
    { question_id: "q1", correct: false, explanation: "请调整第一题" },
    { question_id: "q2", correct: true, explanation: "第二题反馈应保留" },
  ] });
  try {
    const { container } = render(<QuizPanel step={two} state={{ ...state, data: {} }} />);
    for (const q of ["q1", "q2"]) fireEvent.click(container.querySelector(`input[name="quiz-2-${q}"][value="a"]`)!);
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await screen.findByText(/请调整第一题/);
    fireEvent.click(container.querySelector('input[name="quiz-2-q1"][value="b"]')!);
    expect(screen.queryByText(/请调整第一题/)).toBeNull();
    expect(screen.getByText(/第二题反馈应保留/)).not.toBeNull();
    expect(container.querySelectorAll(".quiz-feedback")).toHaveLength(1);
  } finally { api.classroom.submitQuiz = original; }
});

test("a late passing response saves the submitted answers without deleting a newer cross-step draft", async () => {
  const original = api.classroom.submitQuiz;
  const pending = pendingGrade();
  api.classroom.submitQuiz = async () => pending.promise;
  const drafts: QuizDraftStore = new Map();
  let saved: Record<string, unknown> = {};
  let syncs = 0;
  const empty = { ...state, data: {}, save: (patch: Record<string, unknown>) => { saved = patch; }, syncNow: () => { syncs++; } };
  try {
    const first = render(<QuizPanel step={step} state={empty} draftStore={drafts} />);
    fireEvent.click(screen.getByLabelText("通过后"));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    first.unmount();
    const second = render(<QuizPanel step={step} state={empty} draftStore={drafts} />);
    fireEvent.click(screen.getByLabelText("始终"));
    await act(async () => { pending.resolve(passed); });
    expect(saved).toEqual({ quiz: passed.quiz });
    expect(syncs).toBe(1);
    expect(drafts.get(step.n)?.answers).toEqual({ q1: "b" });
    second.rerender(<QuizPanel step={step} state={{ ...state, data: saved, complete: true }} draftStore={drafts} />);
    expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/已保存答案已通过；当前修改尚未提交/)).not.toBeNull();
    second.unmount();
    render(<QuizPanel step={step} state={{ ...state, data: saved, complete: true }} draftStore={drafts} />);
    expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(true);
  } finally { api.classroom.submitQuiz = original; }
});

test("ordinary passed submission clears only its own draft and keeps the original completion rule", async () => {
  const original = api.classroom.submitQuiz;
  api.classroom.submitQuiz = async () => passed;
  const drafts: QuizDraftStore = new Map();
  let saved: Record<string, unknown> = {};
  try {
    render(<QuizPanel step={step} state={{ ...state, data: {}, save: (patch) => { saved = patch; } }} draftStore={drafts} />);
    fireEvent.click(screen.getByLabelText("通过后"));
    fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
    await waitFor(() => expect(saved).toEqual({ quiz: passed.quiz }));
    expect(drafts.has(step.n)).toBe(false);
    expect(screen.queryByText("✓ 理解题已完成")).toBeNull();
  } finally { api.classroom.submitQuiz = original; }
});

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
  expect(screen.queryByText("✓ 理解题已完成")).toBeNull();
  second.rerender(<QuizPanel step={{ ...step, quiz: { ...step.quiz!, version: "v2" } }} state={empty} draftStore={drafts} />);
  expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(false);
  second.rerender(<QuizPanel step={step} state={empty} draftStore={new Map()} />);
  expect((screen.getByLabelText("始终") as HTMLInputElement).checked).toBe(false);
});
