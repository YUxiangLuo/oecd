import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AUTO_RECORD_HOW, MATERIAL_CONFLICT_NOTE, MaterialCard } from "./material-card";
import { MATERIAL_LOCKED_NOTE, MATERIAL_RECHOSEN_NEXT } from "./step-task-card";
import { api, ApiError } from "./api";
import { emptySession, patchStep } from "./session-store";
import { useSession } from "./use-session";
import type { SessionResponse, SessionSaveResponse } from "./types";

afterEach(() => { cleanup(); mock.restore(); sessionStorage.clear(); });

test("a committed save with a lost response stays uncertain when retry conflicts and reading the newer version fails", async () => {
  let server: SessionResponse & SessionSaveResponse = {
    session: emptySession(), updated_at: "2026-09-10T00:00:00Z", release_id: "a".repeat(32), report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_gate: [], material_gate: [],
  };
  spyOn(api.classroom, "session").mockResolvedValueOnce(server).mockRejectedValue(new TypeError("read response lost"));
  spyOn(api.classroom, "saveSession").mockImplementation(async (body) => {
    if (body.base_updated_at !== server.updated_at) throw new ApiError(409, null, "conflict");
    server = { ...server, session: body.session, updated_at: "2026-09-10T00:01:00Z" };
    throw new TypeError("successful save response lost");
  });
  let session!: ReturnType<typeof useSession>;
  function StudentMaterial() {
    session = useSession(true, "student");
    return <MaterialCard state="recorded" summary="JPN 9.891%"
      pending={session.hasMaterialChanges(7)} syncError={session.hasMaterialChanges(7) ? session.saveError : null}
      syncConflict={session.syncConflict} />;
  }
  render(<StudentMaterial />);
  await waitFor(() => expect(session.status).toBe("ready"));
  const material = { observations: [{ country: "JPN", value: 9.891 }] };
  await act(async () => {
    session.patchStep(7, material);
    await session.syncNow().catch(() => {});
  });
  // An unexpected server revision preserves this material but changes an unrelated step.
  server = { ...server, session: patchStep(server.session, 15, { research_question: "newer server record" }), updated_at: "2026-09-10T00:02:00Z" };
  await act(async () => { await session.syncNow().catch(() => {}); });
  expect(server.session.steps["7"].data).toEqual(material);
  expect(session.syncConflict).toBe(true);
  expect(session.hasMaterialChanges(7)).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("当前材料尚未确认");
  expect(screen.getByRole("alert").textContent).not.toContain("本步材料没有保存");
});

for (const outcome of ["success", "error"] as const) {
  test(`material waits through debounce and an unresolved server save, then shows ${outcome}`, async () => {
    const response: SessionResponse & SessionSaveResponse = {
      session: emptySession(), updated_at: "2026-09-10T00:00:00Z", release_id: "a".repeat(32), report: null,
      completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_gate: [], material_gate: [],
    };
    spyOn(api.classroom, "session").mockResolvedValue(response);
    let resolve!: (value: SessionSaveResponse) => void;
    let reject!: (cause: Error) => void;
    const request = new Promise<SessionSaveResponse>((done, fail) => { resolve = done; reject = fail; });
    const save = spyOn(api.classroom, "saveSession").mockImplementation(() => request);
    let session!: ReturnType<typeof useSession>;
    function StudentMaterial() {
      session = useSession(true, "student");
      return <MaterialCard state={session.hasMaterialChanges(7) || session.getStep<{ observations?: unknown[] }>(7)?.observations?.length ? "recorded" : "missing"}
        summary="JPN 9.891%" how={AUTO_RECORD_HOW} pending={session.hasMaterialChanges(7)} syncing={session.syncing}
        syncError={session.hasMaterialChanges(7) ? session.saveError : null} syncConflict={session.syncConflict}
        onRetrySync={() => { void session.syncNow().catch(() => {}); }} />;
    }
    render(<StudentMaterial />);
    await waitFor(() => expect(session.status).toBe("ready"));
    act(() => session.patchStep(7, { observations: [{ country: "JPN", value: 9.891 }] }));
    const card = screen.getByRole("region", { name: "本步报告材料" });
    expect(save).not.toHaveBeenCalled();
    expect(card.querySelector(".material-chip")?.textContent).toBe("等待保存");
    expect(card.querySelector(".material-card-how")).toBeNull();
    let saving!: Promise<void>;
    act(() => { saving = session.syncNow().catch(() => {}); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(session.syncing).toBe(true);
    expect(card.querySelector(".material-chip")?.textContent).toBe("等待保存");
    expect(card.className).not.toContain("material-card--recorded");
    await act(async () => {
      if (outcome === "success") resolve({ ...response, updated_at: "2026-09-10T00:01:00Z" });
      else reject(new ApiError(400, null, "save refused"));
      await saving;
    });
    expect(card.querySelector(".material-chip")?.textContent).toBe(outcome === "success" ? "已记录" : "未保存");
    if (outcome === "success") {
      expect(card.querySelector(".material-card-how")?.textContent).toBe(AUTO_RECORD_HOW);
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      expect(screen.getByRole("alert").textContent).toContain("材料尚未确认保存成功");
      expect(screen.getByRole("button", { name: "重试同步" })).toBeTruthy();
      expect(card.querySelector(".material-card-how")).toBeNull();
    }
  });
}

test("pending material replaces the recorded action; unrelated syncing does not demote a saved card", () => {
  const props = { state: "recorded" as const, summary: "JPN 9.891%", how: AUTO_RECORD_HOW,
    check: { label: "核对已记录的读数 · 1 条", content: "JPN 9.891%" },
    action: { label: "已记录为本步报告材料", disabled: true } };
  const view = render(<MaterialCard {...props} pending syncing />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect((screen.getByRole("button", { name: "等待保存为本步报告材料" }) as HTMLButtonElement).disabled).toBe(true);
  expect(card.querySelector("summary")?.textContent).toBe("核对本步材料读数");
  view.rerender(<MaterialCard {...props} pending syncing syncError="offline" />);
  expect(card.querySelector(".material-chip")?.textContent).toBe("未保存");
  expect(screen.getByRole("alert").textContent).toContain("材料尚未确认保存成功");
  expect(screen.queryByRole("button", { name: "已记录为本步报告材料" })).toBeNull();
  expect(screen.getByRole("button", { name: "本步报告材料尚未确认保存" })).toBeTruthy();
  expect(card.querySelector("summary")?.textContent).toBe("核对本步材料读数");
  view.rerender(<MaterialCard {...props} pending syncing syncError="conflict" syncConflict />);
  expect(screen.getByRole("alert").textContent).toBe(MATERIAL_CONFLICT_NOTE);
  expect(screen.queryByRole("button", { name: "重试同步" })).toBeNull();
  expect(screen.queryByRole("button", { name: "已记录为本步报告材料" })).toBeNull();
  expect(screen.getByRole("button", { name: "本步报告材料尚未确认保存" })).toBeTruthy();
  expect(card.querySelector("summary")?.textContent).toBe("核对本步材料读数");
  view.rerender(<MaterialCard {...props} syncing />);
  expect(card.querySelector(".material-chip")?.textContent).toBe("已记录");
  expect(screen.getByRole("button", { name: "已记录为本步报告材料" })).toBeTruthy();
  expect(card.querySelector("summary")?.textContent).toBe(props.check.label);
});

test("the card names itself the same on every step, with a chip for its state and the one summary sentence", () => {
  render(<MaterialCard state="recorded" summary="2020 年 外国增加值项占比：CHN 中国 11.730%" how={AUTO_RECORD_HOW} />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.id).toBe("step-material-action");
  expect(card.className).toContain("material-card--recorded");
  expect(card.querySelector(".material-chip")?.textContent).toBe("已记录");
  expect(screen.getByRole("status").textContent).toBe("2020 年 外国增加值项占比：CHN 中国 11.730%");
  expect(card.querySelector(".material-card-how")?.textContent).toBe(AUTO_RECORD_HOW);
  expect(card.querySelector("button")).toBeNull();
  expect(card.querySelector("details")).toBeNull();
});

test("a step that records on request shows one button; locked and re-recorded states add their sentences; the check fold is the only one", () => {
  let clicks = 0;
  const view = render(<MaterialCard state="missing" summary="尚未记录" how="每步记一张图" action={{ label: "把这张图记为本步报告材料", onClick: () => { clicks += 1; } }} check={{ label: "核对已记录的读数 · 2 条", content: <table><tbody><tr><td>x</td></tr></tbody></table> }} />);
  expect(screen.getByRole("region", { name: "本步报告材料" }).querySelector(".material-chip")?.textContent).toBe("尚未记录");
  fireEvent.click(screen.getByRole("button", { name: "把这张图记为本步报告材料" }));
  expect(clicks).toBe(1);
  expect(document.activeElement).toBe(document.body);
  screen.getByRole("button", { name: "把这张图记为本步报告材料" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "把这张图记为本步报告材料" }));
  expect(clicks).toBe(2);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "本步报告材料" }));
  expect(screen.getByText("核对已记录的读数 · 2 条").tagName).toBe("SUMMARY");
  view.rerender(<MaterialCard state="recorded" summary="已记" locked rechosen action={{ label: "已记录为本步报告材料", disabled: true }} />);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "本步报告材料" }));
  const how = document.querySelector(".material-card-how")?.textContent ?? "";
  expect(how).toContain(MATERIAL_LOCKED_NOTE);
  expect(how).toContain(MATERIAL_RECHOSEN_NEXT);
  expect((screen.getByRole("button", { name: "已记录为本步报告材料" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<MaterialCard state="blocked" summary="这张图没有可记录的读数条目。" syncError="失败" onRetrySync={() => {}} />);
  expect(document.querySelector(".material-chip")?.textContent).toBe("暂不能记录");
  expect(screen.getByRole("alert").textContent).toContain("材料尚未确认保存成功");
  expect(screen.getByRole("button", { name: "重试同步" })).toBeTruthy();
});

test("an unsaved material is not called recorded; a conflict says where to act instead of offering a retry that cannot help", () => {
  let retries = 0;
  const view = render(<MaterialCard state="recorded" summary="JPN 9.891%" syncError="网络错误" onRetrySync={() => { retries += 1; }} />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.querySelector(".material-chip")?.textContent).toBe("未保存");
  fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
  expect(retries).toBe(1);
  view.rerender(<MaterialCard state="recorded" summary="JPN 9.891%" how="当前例子就是已记录的材料；换国家或行业后自动更新。" syncError="冲突" syncConflict onRetrySync={() => { retries += 1; }} />);
  expect(screen.getByRole("alert").textContent).toBe(MATERIAL_CONFLICT_NOTE);
  // Neither the "already recorded" line nor the recorded colour while it is not saved.
  expect(card.querySelector(".material-card-how")).toBeNull();
  expect(card.className).toContain("material-card--missing");
  expect(screen.queryByRole("button", { name: "重试同步" })).toBeNull();
  // Without an error for this step (another step's edit failed), the card reads as recorded.
  view.rerender(<MaterialCard state="recorded" summary="JPN 9.891%" how="当前例子就是已记录的材料；换国家或行业后自动更新。" syncError={null} />);
  expect(card.querySelector(".material-chip")?.textContent).toBe("已记录");
  expect(card.querySelector(".material-card-how")?.textContent).toContain("已记录的材料");
  expect(card.className).toContain("material-card--recorded");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a conflict caused by another save marks the card as waiting to sync, not as recorded", () => {
  render(<MaterialCard state="recorded" summary="JPN 9.891%" how="当前例子就是已记录的材料；换国家或行业后自动更新。" syncConflict />);
  const card = screen.getByRole("region", { name: "本步报告材料" });
  expect(card.querySelector(".material-chip")?.textContent).toBe("待同步");
  expect(card.className).toContain("material-card--missing");
  expect(card.querySelector(".material-card-how")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("保存已暂停，当前材料尚未确认");
});
