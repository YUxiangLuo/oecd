import { describe, expect, test } from "bun:test";
import type { Meta } from "./types";
import { beginAccountMetaLoad } from "./account-meta";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const meta = (attemptId: number): Meta => ({
  years: [2020],
  countries: ["CHN"],
  sectors: ["D01T02"],
  assignment_id: 7,
  attempt_id: attemptId,
});

describe("account-scoped meta loading", () => {
  test("a late response from the previous account cannot overwrite the new account", async () => {
    const oldRequest = deferred<Meta>();
    const newRequest = deferred<Meta>();
    const applied: Meta[] = [];

    const cancelOld = beginAccountMetaLoad(() => oldRequest.promise, (value) => applied.push(value));
    cancelOld();
    beginAccountMetaLoad(() => newRequest.promise, (value) => applied.push(value));

    newRequest.resolve(meta(22));
    await newRequest.promise;
    oldRequest.resolve(meta(11));
    await oldRequest.promise;

    expect(applied.map((value) => value.attempt_id)).toEqual([22]);
  });

  test("a cancelled request failure cannot replace the current account with empty meta", async () => {
    const oldRequest = deferred<Meta>();
    const applied: Meta[] = [];
    const cancelOld = beginAccountMetaLoad(() => oldRequest.promise, (value) => applied.push(value));

    cancelOld();
    oldRequest.reject(new Error("old account failed"));
    await oldRequest.promise.catch(() => {});

    expect(applied).toEqual([]);
  });
});
