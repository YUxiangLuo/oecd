import { expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { api, AUTH_TOKEN_KEY, getActiveAuthToken, setActiveAuthToken } from "./api";
import { emptySession } from "./session-store";
import { AUTH_RECOVERY_KEY } from "./use-session";

test("self-service password change preserves the failed-save draft before logout", async () => {
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const active = getActiveAuthToken();
  const href = window.location.href;
  const recovery = sessionStorage.getItem(AUTH_RECOVERY_KEY);
  const intro = sessionStorage.getItem("gvcsim_show_intro");
  const releaseId = "a".repeat(32);
  sessionStorage.setItem(AUTH_TOKEN_KEY, "valid-session");
  setActiveAuthToken("valid-session");
  sessionStorage.removeItem(AUTH_RECOVERY_KEY);
  sessionStorage.removeItem("gvcsim_show_intro");
  window.history.replaceState(null, "", "/?step=15");
  const me = spyOn(api, "me").mockResolvedValue({ username: "draft-student", name: "学生", role: "student", account_id: 42 });
  const meta = spyOn(api, "meta").mockResolvedValue({ years: [2020], countries: ["CHN", "USA"], sectors: ["C26"], dataset: { years: [2020], release_id: releaseId } });
  const steps = spyOn(api, "steps").mockResolvedValue({ stages: { "5": "实验闭环" }, steps: [{
    n: 15, stage: 5, lab: "rep", status: "demo", title: "生成实验报告", goal: "汇总实验", tasks: ["记录", "比较", "报告"],
    concept: "实验", tip: "保存", deps: [], handoff: { input: "记录", action: "汇总", output: "报告" },
  }] });
  const session = spyOn(api.classroom, "session").mockResolvedValue({ release_id: releaseId, session: emptySession(), updated_at: null, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [],
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
    const draft = JSON.parse(sessionStorage.getItem(AUTH_RECOVERY_KEY)!);
    expect(draft.release_id).toBe(releaseId);
    expect(draft.username).toBe("draft-student");
    expect(draft.session.steps["15"].data.research_question).toBe("未保存的研究问题，改密后必须保留。");
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  } finally {
    cleanup();
    for (const mock of [reload, password, save, session, steps, meta, me]) mock.mockRestore();
    if (token == null) sessionStorage.removeItem(AUTH_TOKEN_KEY); else sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    setActiveAuthToken(active);
    if (recovery == null) sessionStorage.removeItem(AUTH_RECOVERY_KEY); else sessionStorage.setItem(AUTH_RECOVERY_KEY, recovery);
    if (intro == null) sessionStorage.removeItem("gvcsim_show_intro"); else sessionStorage.setItem("gvcsim_show_intro", intro);
    window.history.replaceState(null, "", href);
  }
});
