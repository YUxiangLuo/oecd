import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "./api";
import { emptySession, patchStep } from "./session-store";
import type { ClassroomReport, ExperimentSession, ReportMutationResponse, SessionResponse, SessionSaveResponse } from "./types";
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

test.each(["submit", "generate-submit"] as const)("a delayed learning read cannot undo %s with the same session timestamp", async (operation) => {
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
    provenance: { session_version: "test", generated_at: NEWER, years: [2020], session_fingerprint: "test", runs: [], custom_results: [], review: { research_question: "", evidence_interpretation: "", limitations: "", evidence: [], results: [], custom_models: [] } },
  };
  spyOn(api.classroom, "generateReport").mockResolvedValue({ ...initial, report: { ...report, state: "draft", submitted_at: null }, report_current: true });
  spyOn(api.classroom, "submitReport").mockResolvedValue({ ...initial, report, report_current: true, completion: { completed: [15], completed_count: 1, total: 15, steps: [] } });
  await act(async () => { await result.current.runReport(operation); });
  await act(async () => { stale.resolve(initial); await refreshing; });
  expect(result.current.report).toEqual(report);
  expect(result.current.completion?.completed).toEqual([15]);
  expect(result.current.reportCurrent).toBe(true);
});

test("a generated report for another saved session is not accepted as current", async () => {
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
  const report: ClassroomReport = {
    state: "draft", markdown: "generated from the earlier record", score: null, feedback: "", graded_by: null,
    generated_at: NEWER, updated_at: NEWER, submitted_at: null, graded_at: null,
    provenance: { session_version: "test", generated_at: NEWER, years: [2020], session_fingerprint: "test", runs: [], custom_results: [], review: { research_question: "", evidence_interpretation: "", limitations: "", evidence: [], results: [], custom_models: [] } },
  };
  const generated = { ...initial, report, report_current: true };
  spyOn(api.classroom, "generateReport").mockResolvedValue(generated);
  const refresh = deferred<SessionResponse>();
  spyOn(api.classroom, "session").mockImplementation(() => refresh.promise);
  await act(async () => {
    result.current.patchStep(15, { research_question: "new edit" });
    await expect(result.current.runReport("generate")).rejects.toThrow("实验记录已变化");
  });
  expect(result.current.report).toBeNull();
  expect(result.current.reportCurrent).toBeNull();
  expect(result.current.completion).toEqual(saved.completion);
  expect(result.current.reportGate).toEqual(saved.report_gate);
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "new edit" });
  await act(async () => { refresh.resolve({ ...saved, report: null }); });
});

function reportResponse(state: ClassroomReport["state"], stamp = NEWER): ReportMutationResponse {
  return {
    ...response(), report_current: true,
    completion: { completed: [15], completed_count: 1, total: 15, steps: [] },
    report: { state, markdown: `# ${state} ${stamp}`, score: state === "graded" ? 93 : null,
      feedback: state === "graded" ? "证据链完整" : "", graded_by: state === "graded" ? "teacher" : null,
      generated_at: stamp, updated_at: stamp, submitted_at: state === "draft" ? null : stamp,
      graded_at: state === "graded" ? stamp : null,
      provenance: { session_version: "test", generated_at: stamp, years: [2020], session_fingerprint: "test", runs: [], custom_results: [], review: { research_question: "", evidence_interpretation: "", limitations: "", evidence: [], results: [], custom_models: [] } } },
  };
}

test("one-click finish waits for saved material, blocks overlapping operations, and exposes draft until submit acknowledgement", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const saving = deferred<SessionSaveResponse>();
  const generating = deferred<ReportMutationResponse>();
  const submitting = deferred<ReportMutationResponse>();
  let stored = emptySession();
  spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => {
    const acknowledgement = await saving.promise;
    stored = session;
    return acknowledgement;
  });
  const generate = spyOn(api.classroom, "generateReport").mockImplementation(() => {
    expect(stored.steps["15"].data).toEqual({ research_question: "saved before generation" });
    return generating.promise;
  });
  const submit = spyOn(api.classroom, "submitReport").mockImplementation(() => submitting.promise);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let operation!: Promise<ClassroomReport | undefined>;
  act(() => {
    result.current.patchStep(15, { research_question: "saved before generation" });
    operation = result.current.runReport("generate-submit");
  });
  expect(generate).not.toHaveBeenCalled();
  expect(result.current.reportOperation).toBe("generate-submit");
  await act(async () => { saving.resolve(response()); });
  await act(async () => {
    result.current.patchStep(15, { research_question: "must not replace the generating snapshot" });
    expect(await result.current.runReport("generate")).toBeUndefined();
  });
  expect(result.current.getStep<{ research_question: string }>(15)).toEqual({ research_question: "saved before generation" });
  expect(generate).toHaveBeenCalledTimes(1);
  const draft = reportResponse("draft");
  await act(async () => { generating.resolve(draft); });
  expect(result.current.report).toEqual(draft.report);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(result.current.reportOperation).toBe("generate-submit");
  const pending = reportResponse("pending", "2026-09-10T00:02:00Z");
  await act(async () => { submitting.resolve(pending); expect(await operation).toEqual(pending.report); });
  expect(result.current.report).toEqual(pending.report);
  expect(result.current.reportOperation).toBeNull();
});

test("failed flush prevents generation and keeps the existing graded report", async () => {
  const graded = reportResponse("graded");
  spyOn(api.classroom, "session").mockResolvedValue({ ...response(), ...graded });
  spyOn(api.classroom, "saveSession").mockRejectedValue(new ApiError(422, null, "invalid"));
  const generate = spyOn(api.classroom, "generateReport");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => {
    result.current.patchStep(15, { research_question: "invalid" });
    await expect(result.current.runReport("generate-submit", graded.report.updated_at)).rejects.toThrow();
  });
  expect(generate).not.toHaveBeenCalled();
  expect(result.current.report).toEqual(graded.report);
  expect(result.current.unsynced).toBe(true);
  expect(result.current.reportOperation).toBeNull();
});

test("submit failure preserves generated draft; retry submits it without regenerating", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const draft = reportResponse("draft"); const pending = reportResponse("pending");
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(draft);
  spyOn(api.classroom, "submitReport").mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(pending);
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => { await expect(result.current.runReport("generate-submit")).rejects.toThrow("草稿"); });
  expect(result.current.report).toEqual(draft.report);
  expect(result.current.reportCurrent).toBe(true);
  expect(result.current.reportOperation).toBeNull();
  await act(async () => { expect(await result.current.runReport("submit")).toEqual(pending.report); });
  expect(result.current.report?.state).toBe("pending");
  expect(generate).toHaveBeenCalledTimes(1);
});

test("regenerating an already submitted report accepts server resubmission without submitting twice", async () => {
  const pending = reportResponse("pending");
  spyOn(api.classroom, "session").mockResolvedValue({ ...response(), ...pending });
  const generated = reportResponse("pending", "2026-09-10T00:02:00Z");
  const generate = spyOn(api.classroom, "generateReport").mockResolvedValue(generated);
  const submit = spyOn(api.classroom, "submitReport");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => { await result.current.runReport("generate-submit", pending.report.updated_at); });
  expect(result.current.report).toEqual(generated.report);
  expect(generate).toHaveBeenCalledWith(pending.report.updated_at);
  expect(submit).not.toHaveBeenCalled();
});

test.each(["graded", "pending"] as const)("409 refreshes %s report and all learning metadata without retrying generation or overwriting answers", async (state) => {
  const initial = reportResponse(state === "graded" ? "pending" : "draft", STAMP);
  const local = patchStep(emptySession(), 15, { research_question: "我的研究问题" });
  const get = spyOn(api.classroom, "session").mockResolvedValue({ ...response(local), ...initial, session: local });
  const generate = spyOn(api.classroom, "generateReport").mockRejectedValue(new ApiError(409, "报告已更新", "Conflict"));
  const submit = spyOn(api.classroom, "submitReport");
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const latest = { ...response(), ...reportResponse(state), quiz_revision: 7, quizzes: { "2": { version: "new", questions: [] } }, report_gate: [{ step: 2, title: "新题", missing: ["完成理解题"] }] };
  get.mockResolvedValue(latest);
  await act(async () => { await expect(result.current.runReport("generate-submit")).rejects.toThrow(state === "graded" ? "老师刚刚评阅" : "已在别处提交"); });
  expect(result.current.report).toEqual(latest.report);
  expect(result.current.quizzes).toEqual(latest.quizzes);
  expect(result.current.reportGate).toEqual(latest.report_gate);
  expect(result.current.completion).toEqual(latest.completion);
  expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("我的研究问题");
  expect(generate).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
});

test("concurrent explicit, learning and focus refreshes share a request and preserve local edits", async () => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const reading = deferred<SessionResponse>(); get.mockImplementation(() => reading.promise);
  let first!: ReturnType<typeof result.current.refreshReport>;
  let second!: ReturnType<typeof result.current.refreshReport>;
  let learning!: Promise<void>;
  act(() => {
    result.current.patchStep(15, { research_question: "local" });
    first = result.current.refreshReport(); second = result.current.refreshReport();
    learning = result.current.refreshLearning!(); window.dispatchEvent(new Event("focus"));
  });
  expect(first).toBe(second);
  expect(get).toHaveBeenCalledTimes(2);
  const latest = { ...response(), ...reportResponse("graded") };
  await act(async () => { reading.resolve(latest); expect(await first).toEqual(latest.report); await learning; });
  expect(result.current.report).toEqual(latest.report);
  expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("local");
  expect(result.current.unsynced).toBe(true);
});

test("save validity bound to another report version leaves old body unverified until refresh recovers it", async () => {
  const old = reportResponse("draft", STAMP);
  const get = spyOn(api.classroom, "session").mockResolvedValue({ ...response(), ...old });
  const { result } = renderHook(() => useSession(true, "student"));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const newer = reportResponse("pending");
  const stale = deferred<SessionResponse>();
  const reading = deferred<SessionResponse>();
  get.mockImplementationOnce(() => stale.promise).mockImplementation(() => reading.promise);
  const oldRead = result.current.refreshReport();
  spyOn(api.classroom, "saveSession").mockResolvedValue({ ...response(undefined, NEWER), report_current: true, report_updated_at: newer.report.updated_at });
  await act(async () => { result.current.patchStep(15, { research_question: "changed" }); await result.current.syncNow(); });
  expect(result.current.report).toEqual(old.report);
  expect(result.current.reportCurrent).toBeNull();
  const latest = { ...response(undefined, NEWER), ...newer, updated_at: NEWER };
  await act(async () => { reading.resolve(latest); });
  expect(result.current.report).toEqual(newer.report);
  expect(result.current.reportCurrent).toBe(true);
  await act(async () => { stale.resolve({ ...response(), ...old }); await oldRead; });
  expect(result.current.report).toEqual(newer.report);
  expect(result.current.reportCurrent).toBe(true);
});

test.each(["refresh", "generate"] as const)("old %s response and retained actions are ignored after account/queue replacement", async (path) => {
  const get = spyOn(api.classroom, "session").mockResolvedValue(response());
  const { result, rerender } = renderHook(({ username }) => useSession(true, username), { initialProps: { username: "student" } });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  const stale = deferred<SessionResponse & ReportMutationResponse>();
  if (path === "refresh") get.mockImplementationOnce(() => stale.promise);
  else spyOn(api.classroom, "generateReport").mockImplementationOnce(() => stale.promise);
  const oldRun = result.current.runReport;
  let pending!: Promise<ClassroomReport | null | undefined>;
  await act(async () => { pending = path === "refresh" ? result.current.refreshReport() : result.current.runReport("generate"); });
  const other = { ...response(), ...reportResponse("graded", "2026-09-10T00:03:00Z") };
  get.mockResolvedValue(other);
  rerender({ username: "other" });
  await waitFor(() => expect(result.current.report).toEqual(other.report));
  await act(async () => { stale.resolve({ ...response(), ...reportResponse("draft") }); expect(await pending).toBeUndefined(); });
  expect(result.current.report).toEqual(other.report);
  expect(result.current.reportOperation).toBeNull();
  await act(async () => { expect(await oldRun("generate")).toBeUndefined(); });
  expect(result.current.report).toEqual(other.report);
});

test("logging out invalidates an in-flight report without waiting for another account to load", async () => {
  spyOn(api.classroom, "session").mockResolvedValue(response());
  const generated = deferred<ReportMutationResponse>();
  spyOn(api.classroom, "generateReport").mockImplementation(() => generated.promise);
  const { result, rerender } = renderHook(({ enabled }) => useSession(enabled, "student"), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let pending!: Promise<ClassroomReport | undefined>;
  await act(async () => { pending = result.current.runReport("generate"); });
  rerender({ enabled: false });
  await act(async () => { generated.resolve(reportResponse("draft")); expect(await pending).toBeUndefined(); });
  expect(result.current.report).toBeNull();
  expect(result.current.reportOperation).toBeNull();
});
