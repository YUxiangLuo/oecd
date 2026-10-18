import { expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { api, AUTH_TOKEN_KEY, getActiveAuthToken, setActiveAuthToken } from "./api";
import { emptySession } from "./session-store";
import { keptEditsKey } from "./use-session";

test("self-service password change preserves the failed-save draft before logout", async () => {
  const KEPT_EDITS_KEY = keptEditsKey("draft-student", "a".repeat(32));
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const active = getActiveAuthToken();
  const href = window.location.href;
  const recovery = sessionStorage.getItem(KEPT_EDITS_KEY);
  const intro = sessionStorage.getItem("gvcsim_show_intro");
  const releaseId = "a".repeat(32);
  sessionStorage.setItem(AUTH_TOKEN_KEY, "valid-session");
  setActiveAuthToken("valid-session");
  sessionStorage.removeItem(KEPT_EDITS_KEY);
  sessionStorage.removeItem("gvcsim_show_intro");
  window.history.replaceState(null, "", "/?step=15");
  const me = spyOn(api, "me").mockResolvedValue({ username: "draft-student", name: "学生", role: "student", account_id: 42 });
  const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN", "USA"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
  const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
    n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
    concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
  }] });
  const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: emptySession(), updated_at: null, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_gate: [], material_gate: [],
  });
  const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new Error("offline"));
  const password = spyOn(api, "changePassword").mockResolvedValue({ ok: true, reauthenticate: true });
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  try {
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector("textarea")).toBeTruthy());
    fireEvent.change(view.container.querySelector("textarea")!, { target: { value: "未保存的研究问题，改密后必须保留。" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "重试保存" })).toBeTruthy(), { timeout: 2500 });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    fireEvent.change(document.querySelector("#account-current-password")!, { target: { value: "old-password-2026" } });
    fireEvent.change(document.querySelector("#account-new-password")!, { target: { value: "new-password-2026" } });
    fireEvent.change(document.querySelector("#account-confirm-password")!, { target: { value: "new-password-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "修改并重新登录" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    const draft = JSON.parse(sessionStorage.getItem(KEPT_EDITS_KEY)!);
    expect(draft.version).toBe(4);
    expect(draft.base_updated_at).toBeNull();
    expect(draft.release_id).toBe(releaseId);
    expect(draft.username).toBe("draft-student");
    expect(draft.session.steps["15"].data.research_question).toBe("未保存的研究问题，改密后必须保留。");
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  } finally {
    cleanup();
    for (const mock of [reload, password, save, session, steps, meta, me]) mock.mockRestore();
    if (token == null) sessionStorage.removeItem(AUTH_TOKEN_KEY); else sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    setActiveAuthToken(active);
    if (recovery == null) sessionStorage.removeItem(KEPT_EDITS_KEY); else sessionStorage.setItem(KEPT_EDITS_KEY, recovery);
    if (intro == null) sessionStorage.removeItem("gvcsim_show_intro"); else sessionStorage.setItem("gvcsim_show_intro", intro);
    window.history.replaceState(null, "", href);
  }
});

test("a failed local draft backup does not label a pending server save as failed", async () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  const original = sessionStorage;
  const contents = Array.from({ length: original.length }, (_, i) => original.key(i)!)
    .map((key) => [key, original.getItem(key)!] as const);
  const active = getActiveAuthToken();
  const href = window.location.href;
  original.clear();
  original.setItem(AUTH_TOKEN_KEY, "valid-session");
  setActiveAuthToken("valid-session");
  window.history.replaceState(null, "", "/?step=15");
  const releaseId = "d".repeat(32);
  const response = { release_id: releaseId, session: emptySession(), updated_at: null, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_updated_at: null, report_gate: [], material_gate: [],
  };
  const me = spyOn(api, "me").mockResolvedValue({ username: "backup-student", name: "学生", role: "student" });
  const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
  const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
    n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
    concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
  }] });
  const session = spyOn(api.classroom, "session").mockResolvedValue(response);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const save = spyOn(api.classroom, "saveSession").mockImplementation(async () => {
    await pending;
    return { ...response, updated_at: "2026-10-17T00:00:00Z" };
  });
  try {
    render(<App />);
    const field = await screen.findByRole("textbox", { name: "研究问题" });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: (key: string) => original.getItem(key), removeItem: (key: string) => original.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key.startsWith("gvcsim_kept_edits_v4:")) throw new DOMException("full", "QuotaExceededError");
        original.setItem(key, value);
      },
    } });
    fireEvent.change(field, { target: { value: "本地备份失败不代表服务器保存失败。" } });
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2500 });
    expect(screen.getByText(/本标签页草稿备份失败/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "报告完成清单" }).textContent).toContain("保存后将重新核对材料");
    expect(screen.getAllByRole("button", { name: "正在保存实验记录…" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^步骤 15：/ }).textContent).toContain("你的分析保存中");
    expect(screen.queryByText("保存失败，请先重试保存")).toBeNull();
    await act(async () => { finish(); await pending; });
    await waitFor(() => expect(screen.getByText("已保存")).toBeTruthy());
    expect(screen.queryByText(/本标签页草稿备份失败/)).toBeNull();
    save.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.change(field, { target: { value: "服务器真正断网时仍须提示保存失败。" } });
    await waitFor(() => expect(screen.getByText("保存失败，请先重试保存")).toBeTruthy(), { timeout: 2500 });
    expect(screen.getByRole("button", { name: "保存失败，请先重试" })).toBeTruthy();
  } finally {
    cleanup();
    finish();
    Object.defineProperty(globalThis, "sessionStorage", storage);
    original.clear();
    for (const [key, value] of contents) original.setItem(key, value);
    for (const mock of [save, session, steps, meta, me]) mock.mockRestore();
    setActiveAuthToken(active);
    window.history.replaceState(null, "", href);
  }
});
