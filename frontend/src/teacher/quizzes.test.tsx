import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api, ApiError } from "../api";
import type { TeacherQuizBank, TeacherQuizQuestion } from "../types";
import { QuizzesTab } from "./quizzes";
import { TeacherReviewGuardProvider } from "./review-guard";

afterEach(cleanup);
const question: TeacherQuizQuestion = { id: "q1", kind: "single_choice", prompt: "原题", options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }], correct: "a", hint: "提示", explanation: "秘密解析" };
const bank = (): TeacherQuizBank => ({ revision: 1, steps: [1, 2].map((step) => ({ step, title: `步骤${step}`, version: "v1", questions: [structuredClone(question)], defaults: [{ ...structuredClone(question), prompt: "默认题" }], is_default: false, updated_at: null, updated_by: null })) });
const pressSave = () => {
  fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认" }));
};

test("defaults remain a draft, confirmed saves use current expected version and preview hides answers", async () => {
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(bank());
  const save = spyOn(api.classroom, "saveQuizStep").mockImplementation(async (_step, body) => {
    const next = bank(); next.steps[0].version = "v2"; next.steps[0].questions = body.questions; return next;
  });
  try {
    render(<TeacherReviewGuardProvider><QuizzesTab /></TeacherReviewGuardProvider>);
    const prompt = await screen.findByLabelText("题干（最多 500 字）");
    expect((screen.getByRole("button", { name: "保存并生效" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole("region", { name: "学生预览" })).queryByText("秘密解析")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(save).not.toHaveBeenCalled();
    expect((prompt as HTMLTextAreaElement).value).toBe("默认题");
    pressSave(); await screen.findByText("已保存并生效。");
    expect(save.mock.calls[0][1].version).toBe("v1");
    fireEvent.change(prompt, { target: { value: "再次修改" } }); pressSave();
    await screen.findByText("已保存并生效。");
    expect(save.mock.calls[1][1].version).toBe("v2");
  } finally { load.mockRestore(); save.mockRestore(); }
});

test("validation locates duplicate options and missing answer; type change requires confirmation", async () => {
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(bank());
  try {
    render(<QuizzesTab />); await screen.findByLabelText("题型");
    fireEvent.change(screen.getByLabelText("选项 2"), { target: { value: "甲" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    expect(screen.getByRole("alert").textContent).toContain("不能重复");
    expect(document.activeElement).toBe(screen.getByLabelText("选项 2"));
    // The field is marked and described by the message right under it (focus scrolls there, so it is in view);
    // beside the save button a line says why nothing was saved.
    expect(screen.getByLabelText("选项 2").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("选项 2").getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    expect(screen.getByLabelText("选项 2").closest(".teacher-quiz-option")?.nextElementSibling).toBe(screen.getByRole("alert"));
    expect(document.querySelector(".quiz-save-blocked")?.textContent).toBe("没有保存：请先修改上方标红的内容。");
    fireEvent.change(screen.getByLabelText("选项 2"), { target: { value: "丙" } });
    expect(screen.getByLabelText("选项 2").getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(screen.getByLabelText("选项 2"), { target: { value: "甲" } });
    fireEvent.change(screen.getByLabelText("题型"), { target: { value: "true_false" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect((screen.getByLabelText("题型") as HTMLSelectElement).value).toBe("single_choice");
    fireEvent.change(screen.getByLabelText("题型"), { target: { value: "true_false" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect((screen.getByLabelText("选项 1") as HTMLInputElement).value).toBe("正确");
    fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    expect(screen.getByRole("alert").textContent).toContain("请选择一个正确答案");
    expect(document.activeElement).toBe(screen.getByLabelText("正确答案"));
  } finally { load.mockRestore(); }
});

test("conflict retains input, latest reload asks before discarding, step switch is guarded", async () => {
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(bank());
  const save = spyOn(api.classroom, "saveQuizStep").mockRejectedValue(new ApiError(409, "版本冲突", ""));
  const confirm = spyOn(window, "confirm").mockReturnValue(false);
  try {
    render(<TeacherReviewGuardProvider><QuizzesTab /></TeacherReviewGuardProvider>);
    const prompt = await screen.findByLabelText("题干（最多 500 字）");
    fireEvent.change(prompt, { target: { value: "保留输入" } });
    fireEvent.click(screen.getByRole("button", { name: /^2\./ }));
    expect(confirm).toHaveBeenCalled(); expect((prompt as HTMLTextAreaElement).value).toBe("保留输入");
    pressSave(); await screen.findByRole("alert");
    expect((prompt as HTMLTextAreaElement).value).toBe("保留输入");
    fireEvent.click(screen.getByRole("button", { name: "载入最新" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "载入最新" })); fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await screen.findByDisplayValue("原题"); expect(load).toHaveBeenCalledTimes(2);
  } finally { load.mockRestore(); save.mockRestore(); confirm.mockRestore(); }
});

test("question limits, reordering and Unicode code-point validation are public editor behavior", async () => {
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(bank());
  try {
    render(<QuizzesTab />); await screen.findByLabelText("题型");
    expect((screen.getByRole("button", { name: "删除题目" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加题目" }));
    fireEvent.click(screen.getByRole("button", { name: "添加题目" }));
    expect((screen.getByRole("button", { name: "添加题目" }) as HTMLButtonElement).disabled).toBe(true);
    const second = within(screen.getByRole("region", { name: "第 2 题" }));
    fireEvent.change(second.getByLabelText("题干（最多 500 字）"), { target: { value: "第二题" } });
    fireEvent.click(second.getByRole("button", { name: "上移" }));
    expect((within(screen.getByRole("region", { name: "第 1 题" })).getByLabelText("题干（最多 500 字）") as HTMLTextAreaElement).value).toBe("第二题");
    fireEvent.click(within(screen.getByRole("region", { name: "第 1 题" })).getByRole("button", { name: "删除题目" }));
    fireEvent.click(within(screen.getByRole("region", { name: "第 2 题" })).getByRole("button", { name: "删除题目" }));
    const prompt = screen.getByLabelText("题干（最多 500 字）");
    fireEvent.change(prompt, { target: { value: "😀".repeat(500) } });
    fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    expect(screen.getByRole("dialog")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.change(prompt, { target: { value: "😀".repeat(501) } });
    fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    expect(screen.getByRole("alert").textContent).toContain("500"); expect(document.activeElement).toBe(prompt);
  } finally { load.mockRestore(); }
});

test("saving locks editing and step navigation; a 422 keeps input and allows retry", async () => {
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(bank());
  let reject!: (cause: Error) => void;
  const save = spyOn(api.classroom, "saveQuizStep").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  try {
    const { container } = render(<TeacherReviewGuardProvider><QuizzesTab /></TeacherReviewGuardProvider>);
    const prompt = await screen.findByLabelText("题干（最多 500 字）");
    fireEvent.change(prompt, { target: { value: "待保存" } }); pressSave();
    expect((container.querySelector(".quiz-editor") as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^2\./ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { reject(new ApiError(422, "题干不符合要求", "")); });
    expect(screen.getByRole("alert").textContent).toContain("题干不符合要求");
    expect((prompt as HTMLTextAreaElement).value).toBe("待保存");
    expect((screen.getByRole("button", { name: "保存并生效" }) as HTMLButtonElement).disabled).toBe(false);
  } finally { load.mockRestore(); save.mockRestore(); }
});

test("restoring defaults on a step that already holds them is no edit, whatever order the stored keys come in", async () => {
  const stored = bank();
  // The server's stored questions spell their keys in another order than the defaults.
  const { id, kind, prompt, options, correct, hint, explanation } = structuredClone(question);
  stored.steps[0].questions = [{ correct, explanation, hint, id, kind, options, prompt } as TeacherQuizQuestion];
  stored.steps[0].defaults = [{ id, prompt, options, kind, correct, hint, explanation }];
  stored.steps[0].is_default = true;
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(stored);
  try {
    render(<TeacherReviewGuardProvider><QuizzesTab /></TeacherReviewGuardProvider>);
    await screen.findByLabelText("题干（最多 500 字）");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect((screen.getByRole("button", { name: "保存并生效" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("本步当前就是默认题目，无需保存。")).toBeTruthy();
  } finally { load.mockRestore(); }
});

test("after a failed check, a later server error is shown even when the marked question was deleted", async () => {
  const twoQuestions = bank();
  twoQuestions.steps[0].questions = [structuredClone(question), { ...structuredClone(question), id: "q2", prompt: "第二题" }];
  const load = spyOn(api.classroom, "quizBank").mockResolvedValue(twoQuestions);
  const save = spyOn(api.classroom, "saveQuizStep").mockRejectedValue(new ApiError(422, "题目 ID 必须全局唯一", ""));
  try {
    render(<TeacherReviewGuardProvider><QuizzesTab /></TeacherReviewGuardProvider>);
    const second = within(await screen.findByRole("region", { name: "第 2 题" }));
    fireEvent.change(second.getByLabelText("题干（最多 500 字）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并生效" }));
    expect(document.querySelector(".quiz-save-blocked")).not.toBeNull();
    fireEvent.click(second.getByRole("button", { name: "删除题目" }));
    pressSave();
    expect((await screen.findByRole("alert")).textContent).toContain("题目 ID 必须全局唯一");
    expect(document.querySelector(".quiz-save-blocked")).toBeNull();
  } finally { load.mockRestore(); save.mockRestore(); }
});
