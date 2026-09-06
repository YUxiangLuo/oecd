import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api } from "./api";
import { emptySession, readShared, readStep } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import {
  AUTH_RECOVERY_KEY,
  SessionSaveQueue,
  clearAuthSessionRecovery,
  patchSessionStep,
  readAuthSessionRecovery,
  saveAuthSessionRecovery,
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
    const get = spyOn(api.classroom, "session").mockResolvedValue({ ...response(latest), report: null });
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

describe("session helpers", () => {
  test("stores an unsynced recovery only for the same reauthenticated account", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const draft = patchSessionStep(emptySession(), 15, { research_question: "未保存问题" });

    saveAuthSessionRecovery(storage, "student-a", draft, "2026-08-12T00:00:00Z", RELEASE_A);
    expect(readAuthSessionRecovery(storage, "student-a", RELEASE_A)).toEqual({
      version: 2,
      release_id: RELEASE_A,
      username: "student-a",
      session: draft,
      base_updated_at: "2026-08-12T00:00:00Z",
    });
    expect(readAuthSessionRecovery(storage, "student-b", RELEASE_A)).toBeNull();
    clearAuthSessionRecovery(storage);
    expect(values.has(AUTH_RECOVERY_KEY)).toBe(false);
  });

  test("a storage quota failure cannot block fail-closed authentication handling", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(saveAuthSessionRecovery(storage, "student", emptySession(), null, RELEASE_A)).toBe(false);
  });

  test("rejects malformed auth recovery instead of mounting it as a session", () => {
    const storage = {
      getItem: () => JSON.stringify({ version: 1, username: "student", session: { version: "forged" }, base_updated_at: null }),
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readAuthSessionRecovery(storage, "student", RELEASE_A)).toBeNull();
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


describe("release-bound recovery", () => {
  test("a never-saved draft cannot cross a data release but remains available on its original release", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const draft = patchSessionStep(emptySession(), 15, { research_question: "release A only" });
    expect(saveAuthSessionRecovery(storage, "student", draft, null, RELEASE_A)).toBe(true);
    expect(readAuthSessionRecovery(storage, "student", RELEASE_B)).toBeNull();
    expect(readAuthSessionRecovery(storage, "another", RELEASE_A)).toBeNull();
    expect(readAuthSessionRecovery(storage, "student", RELEASE_A)?.session).toEqual(draft);
    expect(readAuthSessionRecovery(storage, "student", RELEASE_A)?.base_updated_at).toBeNull();
  });

  test("legacy drafts without a verifiable release are never offered for restore", () => {
    const storage = {
      getItem: () => JSON.stringify({ version: 1, username: "student", session: emptySession(), base_updated_at: null }),
      setItem: () => {}, removeItem: () => {},
    };
    expect(readAuthSessionRecovery(storage, "student", RELEASE_A)).toBeNull();
  });
});

describe("workspace recovery integration", () => {
  for (const baseUpdatedAt of [null, "2026-09-07T00:00:00Z"]) {
    test(`a different release cannot restore a draft with base ${baseUpdatedAt}`, async () => {
      const draft = patchSessionStep(emptySession(), 15, { research_question: "old release evidence" });
      saveAuthSessionRecovery(sessionStorage, "student", draft, baseUpdatedAt, RELEASE_A);
      const get = spyOn(api.classroom, "session").mockResolvedValue({ ...response(), release_id: RELEASE_B, report: null });
      const save = spyOn(api.classroom, "saveSession").mockResolvedValue(response());
      try {
        const { result } = renderHook(() => useSession(true, "student"));
        await waitFor(() => expect(result.current.status).toBe("ready"));
        expect(result.current.authRecoveryAvailable).toBe(false);
        await act(async () => { await result.current.restoreAuthRecovery(); });
        expect(save).not.toHaveBeenCalled();
        expect(result.current.getStep(15)).toBeUndefined();
        expect(readAuthSessionRecovery(sessionStorage, "student", RELEASE_A)?.session).toEqual(draft);
      } finally {
        get.mockRestore();
        save.mockRestore();
        clearAuthSessionRecovery(sessionStorage);
      }
    });
  }
});

describe("edits during conflict reload", () => {
  test("a held reload does not discard edits made after the user requested it", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "conflict" }), { status: 409 }));
    const conflict = await api.classroom.saveSession({ session: emptySession(), base_updated_at: null }).catch(error => error);
    fetch.mockRestore();
    const reload = deferred<SessionResponse>();
    const latest = patchSessionStep(emptySession(), 15, { research_question: "server" });
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce({ ...response(), report: null }).mockImplementationOnce(() => reload.promise).mockResolvedValue({ ...response(latest), report: null });
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
      expect(get).toHaveBeenCalledTimes(2);
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("typed during reload");
      expect(result.current.syncConflict).toBe(true);
      expect(result.current.unsynced).toBe(true);
      expect(result.current.syncError).toContain("载入期间又有本地修改");
      await act(async () => { await result.current.resolveSyncConflict(); });
      expect(result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("server");
      expect(result.current.syncConflict).toBe(false);
    } finally { get.mockRestore(); save.mockRestore(); }
  });
});
