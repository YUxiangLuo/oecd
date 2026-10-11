import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api } from "./api";
import { emptySession, readShared, readStep } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import {
  KEPT_EDITS_KEY,
  SessionSaveQueue,
  clearKeptEdits,
  expiredLoginNotice,
  hasKeptEdits,
  keepEdits,
  mergeKeptEdits,
  patchSessionStep,
  readKeptEdits,
  updateSessionShared,
  useSession,
} from "./use-session";

afterEach(cleanup);

const RELEASE_A = "a".repeat(32);
const RELEASE_B = "b".repeat(32);

function response(session: ExperimentSession = emptySession()): SessionSaveResponse & Pick<SessionResponse, "release_id"> {
  return {
    session,
    release_id: RELEASE_A,
    updated_at: "2026-08-13T00:00:00Z",
    completion: { completed: [], completed_count: 0, total: 15, steps: [] },
    report_gate: [],
    material_gate: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("session conflict recovery", () => {
  test("stops an already scheduled autosave after 409 until the server version is loaded", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "session changed" }), {
      status: 409, headers: { "Content-Type": "application/json" },
    }));
    const conflict = await api.classroom.saveSession({ session: emptySession(), base_updated_at: null }).catch((error) => error);
    fetchMock.mockRestore();
    const latest = patchSessionStep(emptySession(), 15, { research_question: "server version" });
    // The page starts from an empty record; meanwhile another page saved the same field.
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null })
      .mockResolvedValue({ ...response(latest), report: null });
    const request = deferred<SessionSaveResponse>();
    const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => request.promise).mockRejectedValue(conflict);
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      let saving!: Promise<void>;
      act(() => {
        result.current.patchStep(15, { research_question: "first edit" });
        saving = result.current.syncNow();
      });
      act(() => result.current.patchStep(15, { research_question: "newer edit" }));
      await act(async () => {
        request.reject(conflict);
        await saving.catch(() => {});
      });
      expect(result.current.syncConflict).toBe(true);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("newer edit");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => { await result.current.resolveSyncConflict(); });
      expect(result.current.syncConflict).toBe(false);
      expect(result.current.unsynced).toBe(false);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("server version");
    } finally {
      get.mockRestore();
      save.mockRestore();
    }
  });
});

describe("edits kept after a conflict was resolved", () => {
  test("the kept copy's base is the server version the page loaded, so a later expired login restores the edit", async () => {
    const conflict = await (async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "session changed" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      }));
      try {
        return await api.classroom.saveSession({ session: emptySession(), base_updated_at: null }).catch((error) => error);
      } finally {
        fetchMock.mockRestore();
      }
    })();
    const first = patchSessionStep(emptySession(), 15, { research_question: "first committed" });
    const third = patchSessionStep(emptySession(), 15, { research_question: "third committed" });
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null })
      .mockResolvedValue({ ...response(third), report: null });
    const pending = deferred<SessionSaveResponse>();
    const save = spyOn(api.classroom, "saveSession")
      .mockResolvedValueOnce(response(first))
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(() => pending.promise);
    sessionStorage.clear();
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        result.current.patchStep(15, { research_question: "first committed" });
        await result.current.syncNow();
      });
      await act(async () => {
        result.current.patchStep(15, { research_question: "first stale again" });
        await result.current.syncNow().catch(() => {});
      });
      expect(result.current.syncConflict).toBe(true);
      await act(async () => { await result.current.resolveSyncConflict(); });
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("third committed");
      act(() => {
        result.current.patchStep(15, { research_question: "pending old account" });
        void result.current.syncNow().catch(() => {});
      });
      // The login expires while that save is on its way: the page keeps its edit for the next login.
      act(() => { expect(result.current.keepUnsavedEdits()).toBe(true); });
      const kept = readKeptEdits(sessionStorage, "student", RELEASE_A);
      expect(readStep<{ research_question: string }>(kept!.base, 15)?.research_question).toBe("third committed");
      expect(readStep<{ research_question: string }>(kept!.session, 15)?.research_question).toBe("pending old account");
      // Put back on the server's record, the edit survives (the server did not change that field since).
      const restored = mergeKeptEdits(third, kept!);
      expect(readStep<{ research_question: string }>(restored, 15)?.research_question).toBe("pending old account");
    } finally {
      pending.reject(new Error("test over"));
      sessionStorage.clear();
      get.mockRestore();
      save.mockRestore();
    }
  });
});

describe("loading the server version without a conflict", () => {
  test("step 15's newer answers from another tab become the base, so an edit typed afterwards survives an expired login", async () => {
    const first = patchSessionStep(emptySession(), 15, { research_question: "first committed" });
    const third = patchSessionStep(emptySession(), 15, { research_question: "third committed" });
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null })
      .mockResolvedValue({ ...response(third), report: null });
    const pending = deferred<SessionSaveResponse>();
    const save = spyOn(api.classroom, "saveSession")
      .mockResolvedValueOnce(response(first))
      .mockImplementationOnce(() => pending.promise);
    sessionStorage.clear();
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        result.current.patchStep(15, { research_question: "first committed" });
        await result.current.syncNow();
      });
      // Another tab saved newer answers; this page has no conflict, it only learns of them (step 15's notice).
      let loaded = false;
      await act(async () => { loaded = await result.current.loadServerVersion(); });
      expect(loaded).toBe(true);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("third committed");
      expect(result.current.unsynced).toBe(false);
      expect(save).toHaveBeenCalledTimes(1);
      act(() => {
        result.current.patchStep(15, { research_question: "pending old account" });
        void result.current.syncNow().catch(() => {});
      });
      act(() => { expect(result.current.keepUnsavedEdits()).toBe(true); });
      const kept = readKeptEdits(sessionStorage, "student", RELEASE_A)!;
      expect(readStep<{ research_question: string }>(kept.base, 15)?.research_question).toBe("third committed");
      expect(readStep<{ research_question: string }>(mergeKeptEdits(third, kept), 15)?.research_question).toBe("pending old account");
    } finally {
      pending.reject(new Error("test over"));
      sessionStorage.clear();
      get.mockRestore();
      save.mockRestore();
    }
  });

  test("a failed load says it was the load that failed, not a save", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null })
      .mockRejectedValue(new Error("network down"));
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => { await result.current.loadServerVersion().catch(() => {}); });
      expect(result.current.syncError).toContain("载入服务器版本失败");
      expect(result.current.syncError).not.toContain("保存失败");
    } finally {
      get.mockRestore();
    }
  });

  test("waits for a save still on its way, so its answer cannot put an older record back as the base", async () => {
    const mine = patchSessionStep(emptySession(), 1, { year: 2020 });
    const server = patchSessionStep(mine, 15, { research_question: "other tab" });
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null })
      .mockResolvedValue({ ...response(server), report: null });
    const inFlight = deferred<SessionSaveResponse>();
    const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => inFlight.promise);
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      act(() => {
        result.current.patchStep(1, { year: 2020 });
        void result.current.syncNow().catch(() => {});
      });
      let loading!: Promise<boolean>;
      act(() => { loading = result.current.loadServerVersion(); });
      expect(get).toHaveBeenCalledTimes(1); // the first load only: the read waits for the save
      // A second press while this one runs does nothing, and says so.
      let again: boolean | undefined;
      await act(async () => { again = await result.current.loadServerVersion(); });
      expect(again).toBe(false);
      await act(async () => {
        inFlight.resolve(response(mine));
        await loading;
      });
      expect(get).toHaveBeenCalledTimes(2);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("other tab");
      expect(result.current.getStep<{ year: number }>(1)?.year).toBe(2020);
    } finally {
      get.mockRestore();
      save.mockRestore();
    }
  });
});

describe("session helpers", () => {
  test("keeps edits only for the same account and data release", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const base = patchSessionStep(emptySession(), 15, { research_question: "已保存问题" });
    const draft = patchSessionStep(base, 15, { research_question: "未保存问题" });

    expect(keepEdits(storage, { username: "student-a", release_id: RELEASE_A, base, session: draft })).toBe(true);
    expect(readKeptEdits(storage, "student-a", RELEASE_A)).toEqual({
      version: 3, username: "student-a", release_id: RELEASE_A, base, session: draft,
    });
    expect(readKeptEdits(storage, "student-b", RELEASE_A)).toBeNull();
    expect(readKeptEdits(storage, "student-a", RELEASE_B)).toBeNull();
    clearKeptEdits(storage);
    expect(values.has(KEPT_EDITS_KEY)).toBe(false);
  });

  test("a storage quota failure cannot block fail-closed authentication handling", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(keepEdits(storage, { username: "student", release_id: RELEASE_A, base: emptySession(), session: emptySession() })).toBe(false);
  });

  test("rejects malformed or older copies instead of mounting them as a session", () => {
    for (const value of [
      { version: 3, username: "student", release_id: RELEASE_A, base: emptySession(), session: { version: "forged" } },
      { version: 2, username: "student", release_id: RELEASE_A, session: emptySession(), base_updated_at: null },
    ]) {
      const storage = { getItem: () => JSON.stringify(value), setItem: () => {}, removeItem: () => {} };
      expect(readKeptEdits(storage, "student", RELEASE_A)).toBeNull();
    }
  });

  test("puts back only what the copy changed since its base, unless the server changed it too", () => {
    let base = patchSessionStep(emptySession(), 2, { country: "CHN" });
    base = patchSessionStep(base, 6, { metric: "A" });
    base = patchSessionStep(base, 9, { year: 2020 });
    base = updateSessionShared(base, "regression_settings", () => ({ trade: 1 }));
    let local = patchSessionStep(base, 2, { country: "JPN" });      // edited here only
    local = patchSessionStep(local, 6, { metric: "B" });            // edited here and in another tab
    local = patchSessionStep(local, 15, { research_question: "new" }); // a step the base did not have
    local = updateSessionShared(local, "regression_settings", () => ({ trade: 2 }));
    let server = patchSessionStep(base, 6, { metric: "C" });
    server = patchSessionStep(server, 9, { year: 2016 });           // changed elsewhere, untouched here
    const merged = mergeKeptEdits(server, { base, session: local });
    expect(readStep<Record<string, unknown>>(merged, 2)).toEqual({ country: "JPN" });
    expect(readStep<Record<string, unknown>>(merged, 6)).toEqual({ metric: "C" });
    expect(readStep<Record<string, unknown>>(merged, 9)).toEqual({ year: 2016 });
    expect(readStep<Record<string, unknown>>(merged, 15)).toEqual({ research_question: "new" });
    expect(readShared<Record<string, number>>(merged, "regression_settings")).toEqual({ trade: 2 });
    // A step the copy removed is removed, when the server still has the base version.
    const removed = { ...local, steps: Object.fromEntries(Object.entries(local.steps).filter(([key]) => key !== "9")) };
    expect(readStep(mergeKeptEdits(base, { base, session: removed }), 9)).toBeUndefined();
  });

  test("composes step and shared patches", () => {
    let session = patchSessionStep(emptySession(), 7, { chart: "quadrant" });
    session = patchSessionStep(session, 7, { metric: "FVA_share" });
    session = updateSessionShared<Record<string, number>>(session, "regression_settings", () => ({ trade: 1 }));
    expect(readStep<Record<string, unknown>>(session, 7)).toEqual({ chart: "quadrant", metric: "FVA_share" });
    expect(readShared<Record<string, number>>(session, "regression_settings")).toEqual({ trade: 1 });
  });

  test("does not reconcile an earlier normalized response over a newer in-flight edit", async () => {
    const requests: ReturnType<typeof deferred<SessionSaveResponse>>[] = [];
    const submitted: Array<{ session: ExperimentSession; base: string | null }> = [];
    const first = patchSessionStep(emptySession(), 12, {
      research_question: "first",
      qualified_run: { identity: "rotated-signature" },
    });
    const latest = patchSessionStep(first, 12, {
      research_question: "latest",
      qualified_run: { identity: "new-signature" },
    });
    const normalizedFirst = patchSessionStep(emptySession(), 12, {
      research_question: "first",
      run: { identity: "rotated-signature" },
    });
    const normalizedLatest = patchSessionStep(emptySession(), 12, {
      research_question: "latest",
      run: { identity: "new-signature" },
    });
    let optimistic = first;
    let confirmed = emptySession();
    const acknowledgements: Array<{ saved: ExperimentSession; hasNewer: boolean }> = [];
    const queue = new SessionSaveQueue((session, base) => {
      submitted.push({ session, base });
      const request = deferred<SessionSaveResponse>();
      requests.push(request);
      return request.promise;
    }, {
      onSaved: (savedResponse, saved, hasNewer) => {
        confirmed = savedResponse.session;
        acknowledgements.push({ saved, hasNewer });
        if (!hasNewer && optimistic === saved) optimistic = savedResponse.session;
      },
      onError: () => {}, onSyncing: () => {}, onUnsynced: () => {},
    });

    queue.setBaseUpdatedAt("2026-08-12T00:00:00Z");
    queue.enqueue(first);
    const saving = queue.drain();
    optimistic = latest;
    queue.enqueue(latest);
    requests[0].resolve(response(normalizedFirst));
    await Promise.resolve();

    expect(optimistic).toBe(latest);
    expect(confirmed).toBe(normalizedFirst);
    expect(acknowledgements[0]).toEqual({ saved: first, hasNewer: true });
    expect(submitted).toEqual([
      { session: first, base: "2026-08-12T00:00:00Z" },
      { session: latest, base: "2026-08-13T00:00:00Z" },
    ]);

    requests[1].resolve(response(normalizedLatest));
    await saving;
    expect(acknowledgements[1]).toEqual({ saved: latest, hasNewer: false });
    expect(optimistic).toBe(normalizedLatest);
    expect(readStep<Record<string, unknown>>(optimistic, 12)).toEqual({
      research_question: "latest",
      run: { identity: "new-signature" },
    });
    // RegressionRunLab keys the preserved card from this exact field, so final
    // server normalization removes the card on reconciliation without a reload.
    expect(readStep<Record<string, unknown>>(optimistic, 12)?.qualified_run).toBeUndefined();
  });

  test("retains the newer pending edit when the in-flight request fails", async () => {
    const requests: ReturnType<typeof deferred<SessionSaveResponse>>[] = [];
    const values: string[] = [];
    const errors: unknown[] = [];
    const bases: Array<string | null> = [];
    const queue = new SessionSaveQueue((session, base) => {
      values.push(String(readStep<Record<string, unknown>>(session, 15)?.research_question));
      bases.push(base);
      const request = deferred<SessionSaveResponse>();
      requests.push(request);
      return request.promise;
    }, {
      onSaved: () => {}, onError: (cause) => errors.push(cause),
      onSyncing: () => {}, onUnsynced: () => {},
    });
    queue.setBaseUpdatedAt("2026-08-12T00:00:00Z");
    queue.enqueue(patchSessionStep(emptySession(), 15, { research_question: "first" }));
    const firstSave = queue.drain();
    const latest = patchSessionStep(emptySession(), 15, { research_question: "latest" });
    queue.enqueue(latest);
    requests[0].reject(new Error("offline"));
    await expect(firstSave).rejects.toThrow("offline");

    const retry = queue.drain();
    expect(values).toEqual(["first", "latest"]);
    expect(bases).toEqual(["2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z"]);
    requests[1].resolve(response(latest));
    await retry;
    expect(errors).toHaveLength(1);
  });
});


describe("kept edits across data releases", () => {
  test("a copy from another data release is never applied", async () => {
    const draft = patchSessionStep(emptySession(), 15, { research_question: "old release evidence" });
    keepEdits(sessionStorage, { username: "student", release_id: RELEASE_A, base: emptySession(), session: draft });
    const get = spyOn(api.classroom, "session").mockResolvedValue({ ...response(), release_id: RELEASE_B, report: null });
    const save = spyOn(api.classroom, "saveSession").mockResolvedValue(response());
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(save).not.toHaveBeenCalled();
      expect(result.current.getStep(15)).toBeUndefined();
      expect(readKeptEdits(sessionStorage, "student", RELEASE_A)?.session).toEqual(draft);
    } finally {
      get.mockRestore();
      save.mockRestore();
      clearKeptEdits(sessionStorage);
    }
  });
});

describe("edits during conflict reload", () => {
  test("a held reload does not discard edits made after the user requested it", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "conflict" }), { status: 409 }));
    const conflict = await api.classroom.saveSession({ session: emptySession(), base_updated_at: null }).catch(error => error);
    fetch.mockRestore();
    const reload = deferred<SessionResponse>();
    const latest = patchSessionStep(emptySession(), 15, { research_question: "server" });
    // Reads: the first load; the check after the 409 (the server holds other content, so it stays a conflict);
    // the held reload; then the latest record.
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null }).mockResolvedValueOnce({ ...response(latest), report: null }).mockImplementationOnce(() => reload.promise).mockResolvedValue({ ...response(latest), report: null });
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(conflict);
    try {
      const { result } = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        result.current.patchStep(15, { research_question: "stale" });
        await result.current.syncNow().catch(() => {});
      });
      let loading!: Promise<void>;
      act(() => { loading = result.current.resolveSyncConflict(); });
      act(() => result.current.patchStep(15, { research_question: "typed during reload" }));
      await act(async () => {
        await result.current.resolveSyncConflict(); // duplicate clicks do not create another reload
        reload.resolve({ ...response(latest), report: null });
        await loading;
      });
      expect(get).toHaveBeenCalledTimes(3);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("typed during reload");
      expect(result.current.syncConflict).toBe(true);
      expect(result.current.unsynced).toBe(true);
      expect(result.current.syncError).toContain("载入时你又改了内容");
      await act(async () => { await result.current.resolveSyncConflict(); });
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("server");
      expect(result.current.syncConflict).toBe(false);
    } finally { get.mockRestore(); save.mockRestore(); }
  });
});

describe("the expired-login notice", () => {
  test("says unsaved edits are kept when this tab holds them", () => {
    const storage = new Map<string, string>();
    const adapter = { getItem: (key: string) => storage.get(key) ?? null };
    expect(hasKeptEdits(adapter)).toBe(false);
    expect(expiredLoginNotice(false)).toBe("登录已失效，请重新登录。");
    storage.set(KEPT_EDITS_KEY, "{}");
    expect(hasKeptEdits(adapter)).toBe(true);
    expect(expiredLoginNotice(true)).toContain("未保存的修改已在本页保留");
    expect(hasKeptEdits({ getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});
