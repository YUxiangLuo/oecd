import { describe, expect, test } from "bun:test";
import { emptySession, readShared, readStep } from "./session-store";
import type { SessionSaveResponse } from "./types";
import { SessionSaveQueue, patchSessionStep, updateSessionShared } from "./use-session";

function response(): SessionSaveResponse {
  return { updated_at: "2026-08-13T00:00:00Z", completion: { completed: [], completed_count: 0, total: 16, steps: [] } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("session helpers", () => {
  test("composes step and shared patches", () => {
    let session = patchSessionStep(emptySession(), 7, { chart: "quadrant" });
    session = patchSessionStep(session, 7, { metric: "FVA_share" });
    session = updateSessionShared<Record<string, number>>(session, "regression_settings", () => ({ trade: 1 }));
    expect(readStep<Record<string, unknown>>(session, 7)).toEqual({ chart: "quadrant", metric: "FVA_share" });
    expect(readShared<Record<string, number>>(session, "regression_settings")).toEqual({ trade: 1 });
  });

  test("coalesces edits made during one in-flight save", async () => {
    const requests: ReturnType<typeof deferred<SessionSaveResponse>>[] = [];
    const values: string[] = [];
    const queue = new SessionSaveQueue((session) => {
      values.push(String(readStep<Record<string, unknown>>(session, 16)?.research_question));
      const request = deferred<SessionSaveResponse>();
      requests.push(request);
      return request.promise;
    }, { onSaved: () => {}, onError: () => {}, onSyncing: () => {}, onUnsynced: () => {} });
    queue.enqueue(patchSessionStep(emptySession(), 16, { research_question: "first" }));
    const saving = queue.drain();
    queue.enqueue(patchSessionStep(emptySession(), 16, { research_question: "second" }));
    queue.enqueue(patchSessionStep(emptySession(), 16, { research_question: "latest" }));
    requests[0].resolve(response());
    await Promise.resolve();
    expect(values).toEqual(["first", "latest"]);
    requests[1].resolve(response());
    await saving;
  });

  test("retains a failed snapshot for explicit retry", async () => {
    let attempts = 0;
    const queue = new SessionSaveQueue(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return response();
    }, { onSaved: () => {}, onError: () => {}, onSyncing: () => {}, onUnsynced: () => {} });
    queue.enqueue(emptySession());
    await expect(queue.drain()).rejects.toThrow("offline");
    await queue.drain();
    expect(attempts).toBe(2);
  });
});
