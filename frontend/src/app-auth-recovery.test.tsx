import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { api, AUTH_TOKEN_KEY, setActiveAuthToken } from "./api";
import { emptySession } from "./session-store";

const restorers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const restore of restorers.splice(0).reverse()) restore();
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem("gvcsim_auth_notice");
  localStorage.removeItem(AUTH_TOKEN_KEY);
  setActiveAuthToken(null);
});

function retainedLogin() {
  sessionStorage.setItem(AUTH_TOKEN_KEY, "valid-session");
  setActiveAuthToken("valid-session");
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  restorers.push(() => reload.mockRestore());
  return reload;
}

describe("authentication dependency recovery", () => {
  test("a new tab does not silently import an old shared account", async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "legacy-teacher");
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    setActiveAuthToken(null);
    const me = spyOn(api, "me");
    restorers.push(() => me.mockRestore());
    render(<App />);
    expect(await screen.findByLabelText("用户名")).toBeTruthy();
    expect(me).not.toHaveBeenCalled();
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe("legacy-teacher");
  });

  test("course retry recovers a failed bootstrap without reauthentication or losing the session", async () => {
    const reload = retainedLogin();
    const releaseId = "a".repeat(32);
    const me = spyOn(api, "me").mockResolvedValue({ username: "retry-student", name: "学生", role: "student" });
    const meta = spyOn(api, "meta").mockRejectedValueOnce(new Error("课程服务繁忙"))
      .mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
    const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
      concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
    }] });
    const saved = emptySession();
    saved.steps["15"] = { data: { research_question: "服务恢复后保留的研究问题" } };
    const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: saved, updated_at: null, report: null,
      completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
    });
    restorers.push(...[me, meta, steps, session].map((mock) => () => mock.mockRestore()));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.getByDisplayValue("服务恢复后保留的研究问题")).toBeTruthy());
    expect(meta).toHaveBeenCalledTimes(2);
    expect(me).toHaveBeenCalledTimes(1);
    expect(session).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBe("valid-session");
    // Other tabs (including old clients using localStorage) cannot reload this work.
    localStorage.setItem(AUTH_TOKEN_KEY, "other-tab");
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_TOKEN_KEY, newValue: "other-tab" }));
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_TOKEN_KEY, newValue: null }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("服务恢复后保留的研究问题")).toBeTruthy();
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBe("valid-session");
  });

  test("a failed read of the saved record blocks the workspace until a retry reads it", async () => {
    const reload = retainedLogin();
    const releaseId = "b".repeat(32);
    const me = spyOn(api, "me").mockResolvedValue({ username: "retry-student", name: "学生", role: "student" });
    const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
    const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
      concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
    }] });
    const saved = emptySession();
    saved.steps["15"] = { data: { research_question: "服务器上的研究问题" } };
    const session = spyOn(api.classroom, "session").mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ release_id: releaseId, session: saved, updated_at: null, report: null,
        completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
      });
    restorers.push(...[me, meta, steps, session].map((mock) => () => mock.mockRestore()));
    render(<App />);
    const retry = await screen.findByRole("button", { name: "重试读取" });
    // No editable workspace while the record is unknown: typed text would be silently dropped.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("alert").textContent).not.toContain("Failed to fetch");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByDisplayValue("服务器上的研究问题")).toBeTruthy());
    expect(session).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  test("logging out offline shows the login form in place instead of reloading onto the browser's error page", async () => {
    const reload = retainedLogin();
    const releaseId = "c".repeat(32);
    const me = spyOn(api, "me").mockResolvedValue({ username: "offline-student", name: "学生", role: "student" });
    const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
    const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
      concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
    }] });
    const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: emptySession(), updated_at: null, report: null,
      completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    restorers.push(...[me, meta, steps, session].map((mock) => () => mock.mockRestore()), () => { delete (navigator as { onLine?: boolean }).onLine; });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    expect((await screen.findByText(/现在没有网络/)).getAttribute("role")).toBe("status");
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  test("a logout reaches the same account's other tabs, which log out too", async () => {
    retainedLogin();
    const releaseId = "c".repeat(32);
    const me = spyOn(api, "me").mockResolvedValue({ username: "shared-pc", name: "学生", role: "student" });
    const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
    const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
      concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
    }] });
    const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: emptySession(), updated_at: null, report: null,
      completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
    });
    // A stand-in for BroadcastChannel: what this tab posts, and a way to deliver another tab's message.
    const posted: unknown[] = [];
    const listeners = new Set<FakeChannel>();
    class FakeChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) { listeners.add(this); }
      postMessage(data: unknown) { posted.push(data); }
      close() { listeners.delete(this); }
    }
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    restorers.push(...[me, meta, steps, session].map((mock) => () => mock.mockRestore()), () => {
      delete (navigator as { onLine?: boolean }).onLine;
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    });
    render(<App />);
    await screen.findByRole("button", { name: "退出登录" });
    // Another account's logout is ignored; this account's logs this tab out.
    for (const channel of listeners) channel.onmessage?.({ data: { type: "logout", username: "someone-else" } } as MessageEvent);
    expect(screen.queryByLabelText("用户名")).toBeNull();
    for (const channel of [...listeners]) channel.onmessage?.({ data: { type: "logout", username: "shared-pc" } } as MessageEvent);
    expect(await screen.findByLabelText("用户名")).toBeTruthy();
    // A tab logged out by another one does not echo the logout back.
    expect(posted).toEqual([]);
  });

  test("clicking 退出登录 tells the other tabs which account logged out", async () => {
    retainedLogin();
    const releaseId = "c".repeat(32);
    const me = spyOn(api, "me").mockResolvedValue({ username: "shared-pc", name: "学生", role: "student" });
    const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
    const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
      n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
      concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
    }] });
    const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: emptySession(), updated_at: null, report: null,
      completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
    });
    const posted: unknown[] = [];
    class FakeChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {}
      postMessage(data: unknown) { posted.push(data); }
      close() {}
    }
    const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    restorers.push(...[me, meta, steps, session].map((mock) => () => mock.mockRestore()), () => {
      delete (navigator as { onLine?: boolean }).onLine;
      (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(posted).toEqual([{ type: "logout", username: "shared-pc" }]);
  });

  for (const status of [500, 503]) {
    test(`a ${status} during boot retains authentication and offers retry`, async () => {
      const reload = retainedLogin();
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "教学数据库暂时不可用" }), {
        status, headers: { "Content-Type": "application/json" },
      }));
      restorers.push(() => fetch.mockRestore());
      render(<App />);
      await waitFor(() => expect(screen.getByRole("button", { name: "重试连接" })).toBeTruthy());
      expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBe("valid-session");
      expect(reload).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("密码")).toBeNull();
    });
  }

  test("a genuine 401 still clears the expired authentication", async () => {
    const reload = retainedLogin();
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "令牌已过期" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    }));
    restorers.push(() => fetch.mockRestore());
    render(<App />);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });
});
