import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptySession, readShared, readStep } from "./session-store";
import type { SessionResponse } from "./types";
import { AccountSessionSaveQueue, patchSessionStep, updateSessionShared, useSession } from "./use-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("session hook helpers", () => {
  test("composes step patches in memory", () => {
    let session = patchSessionStep(emptySession(), 7, { chart: "quadrant" });
    session = patchSessionStep(session, 7, { metric: "FVA_share" });
    expect(readStep<Record<string, unknown>>(session, 7)).toEqual({ chart: "quadrant", metric: "FVA_share" });
  });

  test("composes shared regression settings", () => {
    let session = updateSessionShared<Record<string, number>>(emptySession(), "regression_settings", () => ({ trade: 1 }));
    session = updateSessionShared<Record<string, number>>(session, "regression_settings", (current) => ({ ...current, network: 2 }));
    expect(readShared<Record<string, number>>(session, "regression_settings")).toEqual({ trade: 1, network: 2 });
  });

  test("is unavailable without a stable account id", () => {
    function Probe() { return createElement("span", null, useSession({ username: "student" }).status); }
    expect(renderToStaticMarkup(createElement(Probe))).toContain("unavailable");
  });

  test("an old in-flight save cannot capture the new account queue", async () => {
    const saves: Array<ReturnType<typeof deferred<SessionResponse>>> = [];
    const savedVersions: string[] = [];
    let syncing = false;
    let unsynced = false;
    const queue = new AccountSessionSaveQueue(
      () => {
        const request = deferred<SessionResponse>();
        saves.push(request);
        return request.promise;
      },
      {
        onSaved: (response) => savedVersions.push(response.session.version),
        onError: () => {},
        onSyncing: (value) => { syncing = value; },
        onUnsynced: (value) => { unsynced = value; },
      },
    );

    queue.activate("student-a");
    queue.enqueue(emptySession());
    const oldSave = queue.drain("student-a");
    expect(saves).toHaveLength(1);

    queue.activate("student-b");
    queue.enqueue(emptySession());
    const newSave = queue.drain("student-b");
    expect(saves).toHaveLength(2);
    expect(syncing).toBe(true);
    expect(unsynced).toBe(true);

    saves[1].resolve({
      session: emptySession(),
      completion: { completed: [], completed_count: 0, total: 16, steps: [] },
      updated_at: null,
    });
    await newSave;
    expect(syncing).toBe(false);
    expect(unsynced).toBe(false);
    expect(savedVersions).toHaveLength(1);

    saves[0].resolve({
      session: emptySession(),
      completion: { completed: [], completed_count: 0, total: 16, steps: [] },
      updated_at: null,
    });
    await oldSave;
    expect(syncing).toBe(false);
    expect(savedVersions).toHaveLength(1);
  });

  test("reactivating an account serializes fresh work after its old in-flight save", async () => {
    const saves: Array<{ question: string; request: ReturnType<typeof deferred<SessionResponse>> }> = [];
    const accepted: string[] = [];
    const queue = new AccountSessionSaveQueue(
      (session) => {
        const request = deferred<SessionResponse>();
        saves.push({
          question: String(readStep<Record<string, unknown>>(session, 16)?.research_question),
          request,
        });
        return request.promise;
      },
      {
        onSaved: (response) => accepted.push(
          String(readStep<Record<string, unknown>>(response.session, 16)?.research_question),
        ),
        onError: () => {},
        onSyncing: () => {},
        onUnsynced: () => {},
      },
    );

    const oldSession = patchSessionStep(emptySession(), 16, { research_question: "old" });
    queue.activate("student-a");
    queue.enqueue(oldSession);
    const oldSave = queue.drain("student-a");

    queue.activate(null);
    queue.activate("student-a");
    const freshSession = patchSessionStep(emptySession(), 16, { research_question: "fresh" });
    queue.enqueue(freshSession);
    const freshSave = queue.drain("student-a");
    expect(saves.map((save) => save.question)).toEqual(["old"]);

    saves[0].request.resolve({
      session: oldSession,
      completion: { completed: [], completed_count: 0, total: 16, steps: [] },
      updated_at: null,
    });
    await oldSave;
    await Promise.resolve();
    expect(saves.map((save) => save.question)).toEqual(["old", "fresh"]);

    saves[1].request.resolve({
      session: freshSession,
      completion: { completed: [], completed_count: 0, total: 16, steps: [] },
      updated_at: null,
    });
    await freshSave;
    expect(accepted).toEqual(["fresh"]);
  });

  test("an empty drain cannot block a later save", async () => {
    const savedSteps: number[] = [];
    const queue = new AccountSessionSaveQueue(
      async (session) => {
        savedSteps.push(Object.keys(session.steps).length);
        return {
          session,
          completion: { completed: [], completed_count: 0, total: 16, steps: [] },
          updated_at: null,
        };
      },
      { onSaved: () => {}, onError: () => {}, onSyncing: () => {}, onUnsynced: () => {} },
    );

    queue.activate("student-a");
    await queue.drain("student-a"); // step 16 blur can flush an already empty queue
    queue.enqueue(patchSessionStep(emptySession(), 16, { research_question: "first" }));
    await queue.drain("student-a");
    await queue.drain("student-a"); // another empty blur after the first save
    queue.enqueue(patchSessionStep(emptySession(), 16, { evidence_interpretation: "second" }));
    await queue.drain("student-a");

    expect(savedSteps).toEqual([1, 1]);
  });

  test("reactivating the same account preserves and drains its pending edit", async () => {
    const savedQuestions: string[] = [];
    const queue = new AccountSessionSaveQueue(
      async (session) => {
        savedQuestions.push(String(readStep<Record<string, unknown>>(session, 16)?.research_question));
        return {
          session,
          completion: { completed: [], completed_count: 0, total: 16, steps: [] },
          updated_at: null,
        };
      },
      { onSaved: () => {}, onError: () => {}, onSyncing: () => {}, onUnsynced: () => {} },
    );

    queue.activate("student-a");
    queue.enqueue(patchSessionStep(emptySession(), 16, { research_question: "keep this edit" }));
    queue.activate("student-a");
    await queue.drain("student-a");

    expect(savedQuestions).toEqual(["keep this edit"]);
  });
});
