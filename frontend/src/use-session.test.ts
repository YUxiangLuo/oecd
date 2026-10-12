import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "./api";
import { emptySession, patchStep } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import { KEPT_EDITS_KEY, SAVE_RETRY_DELAYS_MS, useSession } from "./use-session";

const RELEASE = "a".repeat(32);
const STAMP = "2026-09-10T00:00:00Z";
const NEWER = "2026-09-10T00:01:00Z";
const delays = [...SAVE_RETRY_DELAYS_MS];
function response(session: ExperimentSession = emptySession(), updated_at = STAMP): SessionResponse & SessionSaveResponse {
  return { session, updated_at, release_id: RELEASE, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  cleanup(); mock.restore(); sessionStorage.clear();
  SAVE_RETRY_DELAYS_MS.splice(0, SAVE_RETRY_DELAYS_MS.length, ...delays);
});

test("acknowledging an older save confirms it without replacing newer optimistic edits", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const first = deferred<SessionSaveResponse>();
  const second = deferred<SessionSaveResponse>();
  const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let saving!: Promise<void>;
  act(() => {
    result.current.patchStep(15, { research_question: "first" });
    saving = result.current.syncNow();
    result.current.patchStep(15, { research_question: "latest" });
  });
  expect(JSON.parse(sessionStorage.getItem(KEPT_EDITS_KEY)!)).toEqual({
    version: 4, username: "student", release_id: RELEASE, base_updated_at: STAMP,
    sent: patchStep(emptySession(), 15, { research_question: "first" }),
    session: patchStep(emptySession(), 15, { research_question: "latest" }),
  });
  await act(async () => { first.resolve(response(undefined, NEWER)); });
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "first" });
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "latest" });
  expect(result.current.unsynced).toBe(true);
  expect(result.current.syncing).toBe(true);
  expect(save.mock.calls[1]?.[0].base_updated_at).toBe(NEWER);
  await act(async () => { second.resolve(response(undefined, NEWER)); await saving; });
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "latest" });
  expect(result.current.unsynced).toBe(false);
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
});

test("409 stops saves without fetching or merging; cancel preserves the draft, confirm clears and reloads", async () => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new ApiError(409, null, "conflict"));
  const confirm = spyOn(window, "confirm").mockReturnValue(false);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(15, { research_question: "mine" });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.syncConflict).toBe(true);
  act(() => result.current.patchStep(2, { country: "FRA" }));
  await act(async () => { await new Promise((done) => setTimeout(done, 950)); });
  expect(get).toHaveBeenCalledTimes(1); // No conflict reconciliation GET.
  expect(save).toHaveBeenCalledTimes(1); // No delayed overwrite after conflict.
  const draft = sessionStorage.getItem(KEPT_EDITS_KEY);
  await act(async () => { await result.current.resolveSyncConflict(); });
  expect(confirm).toHaveBeenCalled();
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBe(draft);
  expect(reload).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => { await result.current.resolveSyncConflict(); });
  window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
  expect(reload).toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});

test("network failure retries automatically without a new edit or click", async () => {
  SAVE_RETRY_DELAYS_MS.splice(0, SAVE_RETRY_DELAYS_MS.length, 40);
  spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(1, { year: 2020 });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.autoRetry).toBe(true);
  await waitFor(() => expect(result.current.unsynced).toBe(false));
  expect(result.current.getConfirmedStep<{ year: number }>(1)).toEqual({ year: 2020 });
  expect(result.current.syncError).toBeNull();
});

test.each([50, 950])("correction while a rejected request is in flight saves automatically (response after %sms)", async (delay) => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  let reject!: (cause: unknown) => void;
  const save = spyOn(api.classroom, "saveSession")
    .mockImplementationOnce(() => new Promise<SessionSaveResponse>((_resolve, fail) => { reject = fail; }))
    .mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let saving!: Promise<void>;
  act(() => {
    result.current.patchStep(15, { research_question: "invalid" });
    saving = result.current.syncNow().catch(() => {});
    result.current.patchStep(15, { research_question: "corrected" });
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, delay));
    reject(new ApiError(422, null, "invalid"));
    await saving;
  });
  await waitFor(() => expect(result.current.unsynced).toBe(false));
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)?.research_question).toBe("corrected");
  expect(save.mock.calls.map(([body]) => body.session.steps["15"].data)).toEqual([
    { research_question: "invalid" }, { research_question: "corrected" },
  ]);
});

test("422 can be corrected without replaying the rejected content", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockRejectedValueOnce(new ApiError(422, null, "invalid"))
    .mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(15, { research_question: "invalid" });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.autoRetry).toBe(false);
  await act(async () => {
    result.current.patchStep(15, { research_question: "corrected" });
    await result.current.syncNow();
  });
  expect(save.mock.calls.slice(1).map(([body]) => body.session.steps["15"])).toEqual([
    patchStep(emptySession(), 15, { research_question: "corrected" }).steps["15"],
  ]);
  expect(result.current.unsynced).toBe(false);
  expect(result.current.syncError).toBeNull();
});

test("failed initial load reports a read failure and retries automatically", async () => {
  SAVE_RETRY_DELAYS_MS.splice(0, SAVE_RETRY_DELAYS_MS.length, 150);
  spyOn(api.classroom, "session").mockRejectedValueOnce(new ApiError(502, null, "unavailable"))
    .mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("unavailable"));
  expect(result.current.syncError).toContain("读取");
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(save).not.toHaveBeenCalled();
});

test("returning to the confirmed value before sending makes no server revision and clears the draft", async () => {
  const initial = patchStep(emptySession(), 1, { year: 2020 });
  spyOn(api.classroom, "session").mockResolvedValue(response(initial));
  const save = spyOn(api.classroom, "saveSession");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(1, { year: 2016 });
    result.current.patchStep(1, { year: 2020 });
    await result.current.syncNow();
  });
  expect(save).not.toHaveBeenCalled();
  expect(result.current.unsynced).toBe(false);
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
});
