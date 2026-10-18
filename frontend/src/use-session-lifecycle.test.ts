import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "./api";
import { emptySession, patchStep, sameSessionContent } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import { keptEditsKey, hasKeptEdits, useSession } from "./use-session";

const RELEASE = "a".repeat(32);
const KEPT_EDITS_KEY = keptEditsKey("student", RELEASE);
const STAMP = "2026-09-10T00:00:00Z";
const NEWER = "2026-09-10T00:01:00Z";
function response(session: ExperimentSession = emptySession(), updated_at = STAMP): SessionResponse & SessionSaveResponse {
  return { session, updated_at, release_id: RELEASE, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_updated_at: null, report_gate: [], material_gate: [] };
}
const edited = (text: string) => patchStep(emptySession(), 15, { research_question: text });
function draft(session = edited("draft"), extra: Record<string, unknown> = {}) {
  const value = { version: 4, username: "student", release_id: RELEASE, base_updated_at: STAMP, session, ...extra };
  sessionStorage.setItem(KEPT_EDITS_KEY, JSON.stringify(value));
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  cleanup(); mock.restore(); sessionStorage.clear();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

test("views and unfinished models survive refresh locally without being sent with work or quiz results", async () => {
  const initial = patchStep(emptySession(), 7, { browse_selection: { first: "CAN" }, observations: [17] });
  let server = response(initial);
  spyOn(api.classroom, "session").mockImplementation(async () => server);
  const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => server = response(session, NEWER));
  const first = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  act(() => {
    first.result.current.patchStep(7, { browse_selection: { first: "FIN" } });
    first.result.current.patchStep(11, { custom_draft: { baseline: "DVAex_share", spec: { lags: [0, 2] } } });
  });
  await act(async () => { await first.result.current.syncNow(); });
  expect(save).not.toHaveBeenCalled();
  expect(first.result.current.unsynced).toBe(false);
  first.unmount();
  const next = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(next.result.current.status).toBe("ready"));
  expect(next.result.current.getStep<Record<string, unknown>>(7)).toEqual({ browse_selection: { first: "FIN" }, observations: [17] });
  expect(next.result.current.getStep<Record<string, unknown>>(11)).toEqual({ custom_draft: { baseline: "DVAex_share", spec: { lags: [0, 2] } } });
  await act(async () => {
    next.result.current.patchStep(7, { observations: [23], quiz: { version: "v1", answers: { q: "a" } } });
    await next.result.current.syncNow();
  });
  expect(server.session.steps).toEqual({ "7": { data: { observations: [23], quiz: { version: "v1", answers: { q: "a" } } } } });
  expect(next.result.current.getStep<{ browse_selection: unknown }>(7)?.browse_selection).toEqual({ first: "FIN" });
  next.unmount();
  const other = renderHook(() => useSession(true, "other"));
  await waitFor(() => expect(other.result.current.status).toBe("ready"));
  expect(other.result.current.getStep(11)).toBeUndefined();
});

test("deleting a local setting stays deleted after refresh even when the old server record contains it", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response(patchStep(emptySession(), 11, { custom_draft: { baseline: "old" } })));
  const save = spyOn(api.classroom, "saveSession");
  const first = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  act(() => first.result.current.patchStep(11, { custom_draft: undefined }));
  first.unmount();
  const next = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(next.result.current.status).toBe("ready"));
  expect(next.result.current.getStep(11)).toBeUndefined();
  expect(save).not.toHaveBeenCalled();
});

test("local preference storage failure does not become a server save error", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const original = sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => original.getItem(key), removeItem: (key: string) => original.removeItem(key),
    setItem: (key: string, value: string) => {
      if (key.startsWith("gvcsim_views_v1:")) throw new Error("storage full");
      original.setItem(key, value);
    },
  } });
  try {
    await act(async () => {
      result.current.patchStep(15, { research_question: "saved work" });
      await result.current.syncNow();
    });
    expect(result.current.localViewWarning).toContain("不影响作业保存");
    expect(result.current.syncError).toBeNull();
    expect(result.current.unsynced).toBe(false);
    expect(result.current.getConfirmedStep<Record<string, unknown>>(15)).toEqual({ research_question: "saved work" });
  } finally { Object.defineProperty(globalThis, "sessionStorage", descriptor); }
});

test("typing writes a v4 draft immediately; navigation only prompts, then the ordinary debounce saves", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const leaving = new Event("beforeunload", { cancelable: true });
  act(() => {
    result.current.patchStep(15, { research_question: "draft" });
    expect(JSON.parse(sessionStorage.getItem(KEPT_EDITS_KEY)!)).toEqual({
      version: 4, username: "student", release_id: RELEASE, base_updated_at: STAMP, session: edited("draft"),
    });
    window.dispatchEvent(leaving);
    window.dispatchEvent(new Event("pagehide"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(leaving.defaultPrevented).toBe(true);
  expect(save).not.toHaveBeenCalled();
  await act(async () => { await new Promise((done) => setTimeout(done, 400)); });
  expect(save).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.unsynced).toBe(false));
  expect(save.mock.calls[0]).toEqual([{ session: edited("draft"), base_updated_at: STAMP }]);
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});

test("refresh restores an unsent same-version draft and clears it after confirmation", async () => {
  draft();
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.updatedAt).toBe(NEWER));
  expect(result.current.session).toEqual(edited("draft"));
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "draft" });
  expect(save).toHaveBeenCalledWith({ session: edited("draft"), base_updated_at: STAMP });
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
});

test("an unsent draft at a different revision is preserved and blocked, never merged", async () => {
  const kept = draft();
  spyOn(api.classroom, "session").mockResolvedValue(response(edited("server"), NEWER));
  const save = spyOn(api.classroom, "saveSession");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.syncConflict).toBe(true));
  expect(result.current.session).toEqual(kept.session);
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "server" });
  await act(async () => { await result.current.syncNow().catch(() => {}); });
  expect(save).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem(KEPT_EDITS_KEY)!)).toEqual(kept);
  act(() => result.current.patchStep(15, { research_question: "edited while blocked" }));
  expect(JSON.parse(sessionStorage.getItem(KEPT_EDITS_KEY)!).base_updated_at).toBe(STAMP);
});

test.each(["account", "release", "legacy", "malformed"])("ignores a %s draft without deleting or submitting it", async (kind) => {
  draft(edited("foreign"), kind === "account" ? { username: "other" }
    : kind === "release" ? { release_id: "b".repeat(32) }
    : kind === "legacy" ? { version: 3 } : { sent: { version: "forged" } });
  const kept = sessionStorage.getItem(KEPT_EDITS_KEY);
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.session).toEqual(emptySession());
  expect(save).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBe(kept);
});

// Model the server's idempotent PUT: identical content acknowledges its original
// timestamp even with an old base. A different writer remains a genuine 409.
test.each(["latest", "return to original", "other writer"])("refresh replays a lost response before %s", async (scenario) => {
  const sent = edited("sent");
  const latest = scenario === "return to original" ? emptySession() : edited("latest");
  draft(latest, { sent });
  let server = response(scenario === "other writer" ? edited("other") : sent, NEWER);
  const get = spyOn(api.classroom, "session").mockImplementation(async () => server);
  const submitted: Array<{ session: ExperimentSession; base_updated_at?: string | null }> = [];
  spyOn(api.classroom, "saveSession").mockImplementation(async (body) => {
    submitted.push(body);
    if (sameSessionContent(body.session, server.session)) return server;
    if (body.base_updated_at !== server.updated_at) throw new ApiError(409, null, "conflict");
    return server = response(body.session, "2026-09-10T00:02:00Z");
  });
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  if (scenario === "other writer") {
    await waitFor(() => expect(result.current.syncConflict).toBe(true));
    expect(server.session).toEqual(edited("other"));
    expect(result.current.session).toEqual(latest);
    expect(sessionStorage.getItem(KEPT_EDITS_KEY)).not.toBeNull();
    expect(submitted).toEqual([{ session: sent, base_updated_at: STAMP }]);
  } else {
    await waitFor(() => expect(result.current.unsynced).toBe(false));
    expect(submitted).toEqual([
      { session: sent, base_updated_at: STAMP }, { session: latest, base_updated_at: NEWER },
    ]);
    expect(server.session).toEqual(latest);
    expect(result.current.session).toEqual(latest);
    expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
  }
  expect(get).toHaveBeenCalledTimes(1);
});

test("enabling an initially disabled hook still clears its successfully saved draft", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
  const { result, rerender } = renderHook(({ enabled }) => useSession(enabled, enabled ? "student" : undefined), { initialProps: { enabled: false } });
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => { result.current.patchStep(15, { research_question: "draft" }); await result.current.syncNow(); });
  expect(result.current.unsynced).toBe(false);
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
});

test.each(["unmount", "account switch"])("an old in-flight request cannot send queued edits after %s", async (transition) => {
  spyOn(api.classroom, "session").mockResolvedValueOnce(response()).mockResolvedValue(response(edited("new account"), NEWER));
  const pending = deferred<SessionSaveResponse>();
  const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => pending.promise)
    .mockImplementation(async ({ session }) => response(session, NEWER));
  const hook = renderHook(({ username }) => useSession(true, username), { initialProps: { username: "student" } });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  let saving!: Promise<void>;
  act(() => {
    hook.result.current.patchStep(15, { research_question: "old sent" });
    saving = hook.result.current.syncNow().catch(() => {});
    hook.result.current.patchStep(15, { research_question: "old queued" });
  });
  if (transition === "unmount") hook.unmount();
  else {
    hook.rerender({ username: "other" });
    await waitFor(() => expect(hook.result.current.session).toEqual(edited("new account")));
    draft(edited("new draft"), { username: "other", base_updated_at: NEWER });
  }
  const kept = sessionStorage.getItem(KEPT_EDITS_KEY);
  await act(async () => { pending.resolve(response(edited("old sent"), STAMP)); await saving; });
  expect(save.mock.calls.map(([body]) => body.session)).toEqual([edited("old sent")]);
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBe(kept);
  if (transition === "account switch") {
    expect(hook.result.current.session).toEqual(edited("new account"));
    expect(hook.result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "new account" });
    expect(hook.result.current.updatedAt).toBe(NEWER);
  }
});

test.each(["account", "release"])("another %s saving must not erase an offline draft", async (scope) => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new TypeError("Failed to fetch"));
  const first = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  await act(async () => {
    first.result.current.patchStep(15, { research_question: "offline private draft" });
    await first.result.current.syncNow().catch(() => {});
  });
  expect(hasKeptEdits(sessionStorage, "student")).toBe(true);
  expect(hasKeptEdits(sessionStorage, "other")).toBe(false);
  expect(hasKeptEdits(sessionStorage, null)).toBe(false);
  first.unmount();
  const otherRelease = scope === "release" ? "b".repeat(32) : RELEASE;
  get.mockResolvedValue({ ...response(), release_id: otherRelease });
  save.mockImplementation(async ({ session }) => response(session, NEWER));
  const other = renderHook(() => useSession(true, scope === "account" ? "other" : "student"));
  await waitFor(() => expect(other.result.current.status).toBe("ready"));
  expect(other.result.current.getStep(15)).toBeUndefined();
  // Step 1 automatically records an observation on first entry, without manual typing.
  await act(async () => {
    other.result.current.patchStep(1, { observation: { year: 2020, value: 17 } });
    await other.result.current.syncNow();
  });
  other.unmount();
  get.mockResolvedValue(response());
  const returning = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(returning.result.current.status).toBe("ready"));
  await waitFor(() => expect(returning.result.current.unsynced).toBe(false));
  expect(returning.result.current.getConfirmedStep<{ research_question: string }>(15)?.research_question)
    .toBe("offline private draft");
});

test("storage failure does not block editing or server save and still prompts before leaving", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
  const original = sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => original.getItem(key), removeItem: (key: string) => original.removeItem(key),
    setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
  } });
  try {
    const { result } = renderHook(() => useSession(true, "student"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const leaving = new Event("beforeunload", { cancelable: true });
    act(() => { result.current.patchStep(15, { research_question: "draft" }); window.dispatchEvent(leaving); });
    expect(result.current.session).toEqual(edited("draft"));
    expect(result.current.syncError).not.toBeNull();
    expect(leaving.defaultPrevented).toBe(true);
    await act(async () => { await result.current.syncNow(); });
    expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "draft" });
    expect(result.current.unsynced).toBe(false);
  } finally { Object.defineProperty(globalThis, "sessionStorage", descriptor); }
});
