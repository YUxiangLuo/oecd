import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "./api";
import { emptySession, patchStep } from "./session-store";
import type { ClassroomReport, ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import { keptEditsKey, SAVE_RETRY_DELAYS_MS, useSession } from "./use-session";

const RELEASE = "a".repeat(32);
const KEPT_EDITS_KEY = keptEditsKey("student", RELEASE);
const STAMP = "2026-09-10T00:00:00Z";
const NEWER = "2026-09-10T00:01:00Z";
const delays = [...SAVE_RETRY_DELAYS_MS];
function response(session: ExperimentSession = emptySession(), updated_at = STAMP): SessionResponse & SessionSaveResponse {
  return { session, updated_at, release_id: RELEASE, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_current: false, report_updated_at: null, report_gate: [], material_gate: [] };
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

test("material status ignores local browsing changes but stays pending when an in-flight material edit is reverted", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const first = deferred<SessionSaveResponse>();
  const second = deferred<SessionSaveResponse>();
  spyOn(api.classroom, "saveSession").mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  act(() => result.current.patchStep(7, { browse_selection: { first: "JPN" } }));
  expect(result.current.unsynced).toBe(false);
  expect(result.current.hasMaterialChanges(7)).toBe(false);
  let saving!: Promise<void>;
  act(() => {
    result.current.patchStep(7, { observations: [{ country: "JPN", value: 17 }] });
    saving = result.current.syncNow();
    result.current.patchStep(7, { observations: undefined });
  });
  expect(result.current.hasMaterialChanges(7)).toBe(true);
  expect(result.current.hasMaterialChanges(6)).toBe(false);
  await act(async () => { first.resolve(response(undefined, NEWER)); });
  expect(result.current.hasMaterialChanges(7)).toBe(true);
  await act(async () => { second.resolve(response(undefined, NEWER)); await saving; });
  expect(result.current.hasMaterialChanges(7)).toBe(false);
});

test("an unexpected revision pauses immediately without merging; recovery requires explicit confirmation", async () => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new ApiError(409, null, "conflict"));
  const confirm = spyOn(window, "confirm").mockReturnValue(false);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const otherKeys = [keptEditsKey("other", RELEASE), keptEditsKey("student", "b".repeat(32))];
  for (const key of otherKeys) sessionStorage.setItem(key, "unrelated draft");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(15, { research_question: "mine" });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.syncConflict).toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  act(() => result.current.patchStep(15, { research_question: "edited while paused" }));
  await act(async () => { await new Promise((done) => setTimeout(done, 950)); });
  expect(save).toHaveBeenCalledTimes(1); // No delayed overwrite after the error.
  expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("edited while paused");
  const draft = sessionStorage.getItem(KEPT_EDITS_KEY);
  expect(JSON.parse(draft!).session.steps["15"].data.research_question).toBe("edited while paused");
  await act(async () => { await result.current.syncNow().catch(() => {}); });
  expect(save).toHaveBeenCalledTimes(1); // Explicit retry cannot bypass the pause either.
  await act(async () => { await result.current.resolveSyncConflict(); });
  expect(confirm).toHaveBeenCalled();
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBe(draft);
  expect(reload).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => { await result.current.resolveSyncConflict(); });
  window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
  for (const key of otherKeys) expect(sessionStorage.getItem(key)).toBe("unrelated draft");
  expect(reload).toHaveBeenCalled();
});

test("an unexpected server revision preserves local material without overwriting the server", async () => {
  let server = response(emptySession());
  spyOn(api.classroom, "session").mockImplementation(async () => server);
  const save = spyOn(api.classroom, "saveSession").mockImplementation(async (body) => {
    if (body.base_updated_at !== server.updated_at) throw new ApiError(409, null, "conflict");
    return server = response(body.session, "2026-09-10T00:02:00Z");
  });
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const edited = (text: string) => patchStep(emptySession(), 15, { research_question: text });
  server = response(edited("theirs"), NEWER);
  await act(async () => {
    result.current.patchStep(15, { research_question: "mine" });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.syncConflict).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(server.session).toEqual(edited("theirs"));
  expect(result.current.session).toEqual(edited("mine"));
});

test("network failure retries automatically without a new edit or click", async () => {
  SAVE_RETRY_DELAYS_MS.splice(0, SAVE_RETRY_DELAYS_MS.length, 40);
  spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockImplementation(async ({ session }) => response(session, NEWER));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(15, { research_question: "latest" });
    await result.current.syncNow().catch(() => {});
  });
  expect(result.current.autoRetry).toBe(true);
  await waitFor(() => expect(result.current.unsynced).toBe(false));
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "latest" });
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

test("refreshing teacher questions preserves unsaved experiment edits and rejects an older bank response", async () => {
  const initial = { ...response(), quiz_revision: 0, quizzes: {} };
  const get = spyOn(api.classroom, "session").mockResolvedValue(initial);
  const saving = deferred<SessionSaveResponse>();
  spyOn(api.classroom, "saveSession").mockImplementation(() => saving.promise);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let pending!: Promise<void>;
  act(() => {
    result.current.patchStep(15, { research_question: "尚未保存的研究问题" });
    pending = result.current.syncNow();
  });
  const quiz = { version: "quiz-step-2-r1", questions: [{ id: "tf", kind: "true_false" as const, prompt: "新题目", options: [{ id: "true", label: "正确" }, { id: "false", label: "错误" }] }] };
  get.mockResolvedValue({ ...initial, quiz_revision: 1, quizzes: { "2": quiz } });
  await act(async () => { await result.current.refreshLearning!(); });
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "尚未保存的研究问题" });
  expect(result.current.unsynced).toBe(true);
  expect(result.current.quizzes?.["2"]).toEqual(quiz);
  await act(async () => { saving.resolve({ ...initial, updated_at: NEWER }); await pending; });
  expect(result.current.quizzes?.["2"]).toEqual(quiz);
  expect(result.current.quiz_revision).toBe(1);
  expect(result.current.getConfirmedStep<{ research_question: string }>(15)).toEqual({ research_question: "尚未保存的研究问题" });
});

test("an unexpected server revision does not prevent question refresh or advance the local save base", async () => {
  const initial = { ...response(), quiz_revision: 0, quizzes: {}, report_current: false };
  const get = spyOn(api.classroom, "session").mockResolvedValue(initial);
  const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new ApiError(409, null, "conflict"));
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  act(() => result.current.patchStep(15, { research_question: "local draft" }));
  const quiz = { version: "v2", questions: [] };
  get.mockResolvedValue({ ...response(patchStep(emptySession(), 15, { research_question: "newer server record" }), NEWER),
    quiz_revision: 1, quizzes: { "3": quiz }, report_current: true,
    completion: { completed: [15], completed_count: 1, total: 15, steps: [] } });
  await act(async () => { await result.current.refreshLearning!(); });
  expect(result.current.quizzes?.["3"]).toEqual(quiz);
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "local draft" });
  expect(result.current.getConfirmedStep(15)).toBeUndefined();
  expect(result.current.completion?.completed).toEqual([]);
  expect(result.current.reportCurrent).toBe(false);
  await act(async () => { await result.current.syncNow().catch(() => {}); });
  expect(save.mock.calls[0][0].base_updated_at).toBe(STAMP);
  expect(result.current.syncConflict).toBe(true);
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "local draft" });
});

test("a metadata refresh overtaken by a save cannot roll back completion", async () => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  spyOn(api.classroom, "saveSession").mockResolvedValue({ ...response(undefined, NEWER), completion: { completed: [1], completed_count: 1, total: 15, steps: [] } });
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const stale = deferred<SessionResponse>();
  get.mockImplementation(() => stale.promise);
  const refreshing = result.current.refreshLearning!();
  await act(async () => {
    result.current.patchStep(1, { quiz: { version: "current", answers: { q: "a" } } });
    await result.current.syncNow();
  });
  await act(async () => { stale.resolve(response()); await refreshing; });
  expect(result.current.completion?.completed).toEqual([1]);
});

test("an old step's saved callback cannot overwrite answers after the teacher changes its version", async () => {
  const initial = { ...response(), quiz_revision: 0, quizzes: { "1": { version: "v1", questions: [] } } };
  const get = spyOn(api.classroom, "session").mockResolvedValue(initial);
  let stored = emptySession();
  const updated = { ...initial, quiz_revision: 1, quizzes: { "1": { version: "v2", questions: [] } } };
  spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => {
    stored = session;
    return { ...updated, updated_at: NEWER };
  });
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // This is the callback retained by a QuizPanel after navigating away and unmounting it.
  const oldSave = result.current.patchStep;
  const oldQuiz = { version: "v1", answers: { q: "a" } };
  await act(async () => { oldSave(1, { quiz: oldQuiz }); await result.current.syncNow(); });
  expect(stored.steps["1"].data).toEqual({ quiz: oldQuiz }); // Same-version late success is still accepted.
  get.mockResolvedValue({ ...updated, updated_at: NEWER });
  await act(async () => { await result.current.refreshLearning!(); });
  const newQuiz = { version: "v2", answers: { q: "b" } };
  await act(async () => { result.current.patchStep(1, { quiz: newQuiz }); await result.current.syncNow(); });
  await act(async () => { oldSave(1, { quiz: oldQuiz }); await result.current.syncNow(); });
  expect(stored.steps["1"].data).toEqual({ quiz: newQuiz });
  expect(result.current.getStep<{ quiz: unknown }>(1)?.quiz).toEqual(newQuiz);
});

test("a delayed learning read cannot undo report submission with the same session timestamp", async () => {
  const initial = { ...response(), quiz_revision: 0, quizzes: {}, report_current: false };
  const get = spyOn(api.classroom, "session").mockResolvedValue(initial);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const stale = deferred<SessionResponse>();
  get.mockImplementation(() => stale.promise);
  const refreshing = result.current.refreshLearning!();
  const report: ClassroomReport = {
    state: "pending", markdown: "submitted", score: null, feedback: "", graded_by: null,
    generated_at: NEWER, updated_at: NEWER, submitted_at: NEWER, graded_at: null,
    provenance: { session_version: "test", generated_at: NEWER, years: [2020], session_fingerprint: "test", runs: [], custom_results: [] },
  };
  act(() => result.current.applyReportMutation({ ...initial, report, report_current: true, completion: { completed: [15], completed_count: 1, total: 15, steps: [] } }));
  await act(async () => { stale.resolve(initial); await refreshing; });
  expect(result.current.report).toEqual(report);
  expect(result.current.completion?.completed).toEqual([15]);
  expect(result.current.reportCurrent).toBe(true);
});

test.each([false, true])("report metadata applies only to its saved session (newer save: %s)", async (newerSave) => {
  const initial = response();
  spyOn(api.classroom, "session").mockResolvedValue(initial);
  const saved = {
    ...response(undefined, NEWER),
    completion: { completed: [1], completed_count: 1, total: 15, steps: [] },
    report_gate: [{ step: 15, title: "你的分析", missing: ["填写研究问题"] }],
  };
  spyOn(api.classroom, "saveSession").mockResolvedValue(saved);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  // A report step can unmount while its request retains this callback.
  const changed = result.current.applyReportMutation;
  const report: ClassroomReport = {
    state: "draft", markdown: "generated from the earlier record", score: null, feedback: "", graded_by: null,
    generated_at: NEWER, updated_at: NEWER, submitted_at: null, graded_at: null,
    provenance: { session_version: "test", generated_at: NEWER, years: [2020], session_fingerprint: "test", runs: [], custom_results: [] },
  };
  const generated = { ...initial, report, report_current: true };
  if (newerSave) {
    await act(async () => {
      result.current.patchStep(15, { research_question: "new edit" });
      await result.current.syncNow();
    });
  }
  act(() => changed(generated));
  expect(result.current.report).toEqual(report);
  expect(result.current.reportCurrent).toBe(!newerSave);
  expect(result.current.completion).toEqual(newerSave ? saved.completion : generated.completion);
  expect(result.current.reportGate).toEqual(newerSave ? saved.report_gate : generated.report_gate);
  if (newerSave) expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "new edit" });
});
