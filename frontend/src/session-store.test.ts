import { describe, expect, test } from "bun:test";
import { emptySession, isValidSession, patchStep, readShared, readStep, writeShared } from "./session-store";
import { SESSION_VERSION } from "./types";

describe("simple session store", () => {
  test("creates the fixed minimal contract", () => {
    expect(emptySession()).toEqual({ version: SESSION_VERSION, steps: {}, shared: {} });
  });

  test("patches fields without timestamps or merge metadata", () => {
    let session = patchStep(emptySession(), 4, { year: 2019, metric: "FVA" });
    session = patchStep(session, 4, { metric: "DVA", year: undefined });
    expect(readStep<Record<string, unknown>>(session, 4)).toEqual({ metric: "DVA" });
  });

  test("only accepts the one shared setting key", () => {
    const session = writeShared(emptySession(), "regression_settings", { trade: { method: "did" } });
    expect(readShared<Record<string, unknown>>(session, "regression_settings")).toEqual({ trade: { method: "did" } });
    expect(isValidSession(session)).toBe(true);
    expect(isValidSession({ ...session, shared: { regression_history: { data: {} } } })).toBe(false);
  });
});
