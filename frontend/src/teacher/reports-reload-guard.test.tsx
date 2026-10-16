import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../api";
import { TeacherWorkspace } from "../app-shell";
import type { TeacherReport } from "../types";

const restorers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  restorers.splice(0).forEach((restore) => restore());
});

const report: TeacherReport = {
  account_id: 7, username: "student", display_name: "第一位学生", student_no: "S1", enrollments: [],
  markdown: "# 已提交报告", state: "pending", score: null, feedback: "", graded_by: null,
  generated_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
  submitted_at: "2026-10-15T00:01:00Z", graded_at: null,
  provenance: {
    release_id: "a".repeat(32), session_version: "experiment-session-simple-v4",
    generated_at: "2026-10-15T00:00:00Z", years: [2020], session_fingerprint: "fp", runs: [], custom_results: [],
  },
};
const nextReport = { ...report, account_id: 8, username: "student02", display_name: "第二位学生" };
const latest = { ...report, updated_at: "2026-10-15T00:03:00Z" };
const draft = { score: "91", feedback: "冲突后仍须保留的评语" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function protectedOnUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function setup() {
  const reload = deferred<TeacherReport>();
  const detail = spyOn(api.classroom, "reportDetail")
    .mockResolvedValueOnce(report).mockReturnValueOnce(reload.promise)
    .mockImplementation(async (accountId) => accountId === nextReport.account_id ? nextReport : latest);
  const grade = spyOn(api.classroom, "grade").mockRejectedValueOnce(new ApiError(409, "学生重新提交报告", ""));
  const confirm = spyOn(window, "confirm").mockReturnValue(false);
  const spies = [detail, grade, confirm,
    spyOn(api.classroom, "reports").mockResolvedValue({ reports: [report, nextReport] }),
    spyOn(api.classroom, "students").mockResolvedValue({ students: [] }),
    spyOn(api.classroom, "semesters").mockResolvedValue({ semesters: [] }),
  ];
  restorers.push(...spies.map((spy) => () => spy.mockRestore()));
  const logout = mock(() => {});
  const password = mock(() => {});
  render(<TeacherWorkspace user={{ username: "teacher", name: "老师", role: "teacher" }} meta={null}
    showPasswordChange={false} onRequestPasswordChange={password} onClosePasswordChange={() => {}}
    onPasswordChanged={() => {}} onLogout={logout} />);
  return { reload, detail, grade, confirm, logout, password };
}

async function openDraftAndReload() {
  fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
  fireEvent.click(await screen.findByRole("button", { name: "评阅报告：第一位学生" }));
  fireEvent.change(await screen.findByRole("spinbutton"), { target: { value: draft.score } });
  fireEvent.change(screen.getByRole("textbox", { name: "评语（选填）" }), { target: { value: draft.feedback } });
  fireEvent.click(screen.getByRole("button", { name: "提交评阅" }));
  fireEvent.click(await screen.findByRole("button", { name: "载入最新报告" }));
  await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
}

function expectDraft() {
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(draft.score);
  expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe(draft.feedback);
}

describe("report draft protection throughout conflict reloads", () => {
  for (const mode of ["pending", "failed"] as const) {
    test(`${mode} reload protects sidebar, password, logout and unload; cancelling preserves the recovered draft`, async () => {
      const { reload, detail, confirm, logout, password } = setup();
      await openDraftAndReload();
      if (mode === "failed") {
        await act(async () => reload.reject(new Error("重载失败")));
        await screen.findByRole("alert");
      }
      expect(protectedOnUnload()).toBe(true);
      for (const name of [/学生与进度 账号/, /^修改密码$/, /^退出登录$/]) {
        fireEvent.click(screen.getByRole("button", { name }));
        expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("报告评阅");
      }
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(logout).not.toHaveBeenCalled();
      expect(password).not.toHaveBeenCalled();
      expect(protectedOnUnload()).toBe(true);
      if (mode === "failed") {
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
      } else {
        await act(async () => reload.resolve(latest));
      }
      await screen.findByDisplayValue(draft.feedback);
      expectDraft();
      expect(detail).toHaveBeenCalledTimes(mode === "failed" ? 3 : 2);
      expect(protectedOnUnload()).toBe(true);
    });

    test(`${mode} reload allows confirmed sidebar departure and cannot restore its draft into another student`, async () => {
      const { reload, confirm } = setup();
      await openDraftAndReload();
      if (mode === "failed") {
        await act(async () => reload.reject(new Error("重载失败")));
        await screen.findByRole("alert");
      }
      confirm.mockReturnValue(true);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /学生与进度 账号/ })); });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("学生与进度");
      expect(protectedOnUnload()).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
      fireEvent.click(await screen.findByRole("button", { name: "评阅报告：第二位学生" }));
      await screen.findByRole("spinbutton");
      if (mode === "pending") await act(async () => reload.resolve(latest));
      expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
      expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe("");
      expect(protectedOnUnload()).toBe(false);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "← 返回列表" })); });
      expect(confirm).toHaveBeenCalledTimes(1);
    });
  }

  test("failed reload protects its return button and clears the discarded draft after one accepted confirmation", async () => {
    const { reload, confirm } = setup();
    await openDraftAndReload();
    await act(async () => reload.reject(new Error("重载失败")));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "← 返回列表" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("重载失败");
    expect(protectedOnUnload()).toBe(true);
    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "← 返回列表" })); });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(protectedOnUnload()).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "评阅报告：第一位学生" }));
    expect((await screen.findByRole("spinbutton") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe("");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "← 返回列表" })); });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("adopting the current server review after a failed reload clears the retained dirty guard", async () => {
    const { reload, detail, confirm } = setup();
    detail.mockResolvedValue({ ...latest, state: "graded", score: 84, feedback: "另一位教师的评语" });
    await openDraftAndReload();
    await act(async () => reload.reject(new Error("重载失败")));
    await screen.findByRole("alert");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试" })); });
    await screen.findByRole("button", { name: "改用这份评阅" });
    expectDraft();
    expect(protectedOnUnload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "改用这份评阅" }));
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("84");
    expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe("另一位教师的评语");
    expect(protectedOnUnload()).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "← 返回列表" })); });
    expect(confirm).not.toHaveBeenCalled();
  });

  for (const thenNext of [false, true]) {
    test(`saving the recovered draft${thenNext ? " and moving to the next report" : ""} clears protection without a leave prompt`, async () => {
      const { reload, grade, confirm } = setup();
      grade.mockResolvedValue({ ...latest, state: "graded", score: 91, feedback: draft.feedback });
      await openDraftAndReload();
      await act(async () => reload.resolve(latest));
      await screen.findByDisplayValue(draft.feedback);
      expectDraft();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: thenNext ? "保存并评阅下一份" : "提交评阅" }));
      });
      expect(grade).toHaveBeenLastCalledWith(report.account_id, 91, draft.feedback, latest.updated_at);
      expect(confirm).not.toHaveBeenCalled();
      expect(protectedOnUnload()).toBe(false);
      if (thenNext) {
        expect((await screen.findByRole("spinbutton") as HTMLInputElement).value).toBe("");
        expect((screen.getByRole("textbox", { name: "评语（选填）" }) as HTMLTextAreaElement).value).toBe("");
        fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "72" } });
        expect(protectedOnUnload()).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "← 返回列表" }));
        expect(confirm).toHaveBeenCalledTimes(1);
        expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("72");
      } else {
        expect(screen.queryByRole("spinbutton")).toBeNull();
      }
    });
  }

  test("an initial report load failure has no unsaved draft and can return without prompting", async () => {
    const { detail, confirm } = setup();
    detail.mockReset().mockRejectedValue(new Error("第一次加载失败"));
    fireEvent.click(screen.getByRole("button", { name: /报告评阅 评阅与打分/ }));
    fireEvent.click(await screen.findByRole("button", { name: "评阅报告：第一位学生" }));
    await screen.findByRole("alert");
    expect(protectedOnUnload()).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "← 返回列表" })); });
    expect(confirm).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: "评阅报告：第一位学生" });
  });
});
