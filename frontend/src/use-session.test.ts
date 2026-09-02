import { describe, expect, test } from "bun:test";
import { emptySession, readShared, readStep } from "./session-store";
import type { ExperimentSession, SessionSaveResponse } from "./types";
import {
  AUTH_RECOVERY_KEY,
  SessionSaveQueue,
  clearAuthSessionRecovery,
  patchSessionStep,
  readAuthSessionRecovery,
  saveAuthSessionRecovery,
  updateSessionShared,
} from "./use-session";

function response(session: ExperimentSession = emptySession()): SessionSaveResponse {
  return {
    session,
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

describe("session helpers", () => {
  test("stores an unsynced recovery only for the same reauthenticated account", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const draft = patchSessionStep(emptySession(), 15, { research_question: "未保存问题" });

    saveAuthSessionRecovery(storage, "student-a", draft, "2026-08-12T00:00:00Z");
    expect(readAuthSessionRecovery(storage, "student-a")).toEqual({
      version: 1,
      username: "student-a",
      session: draft,
      base_updated_at: "2026-08-12T00:00:00Z",
    });
    expect(readAuthSessionRecovery(storage, "student-b")).toBeNull();
    clearAuthSessionRecovery(storage);
    expect(values.has(AUTH_RECOVERY_KEY)).toBe(false);
  });

  test("a storage quota failure cannot block fail-closed authentication handling", () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(saveAuthSessionRecovery(storage, "student", emptySession(), null)).toBe(false);
  });

  test("rejects malformed auth recovery instead of mounting it as a session", () => {
    const storage = {
      getItem: () => JSON.stringify({ version: 1, username: "student", session: { version: "forged" }, base_updated_at: null }),
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readAuthSessionRecovery(storage, "student")).toBeNull();
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
