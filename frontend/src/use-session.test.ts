import { describe, expect, test } from "bun:test";
import { emptySession, readShared, readStep } from "./session-store";
import {
  patchSessionStep,
  remoteSessionUntrusted,
  sessionScope,
  sessionScopeKey,
  updateSessionShared,
} from "./use-session";

describe("sessionScope", () => {
  test("requires stable account, course-run, assignment and manifest ids", () => {
    expect(sessionScope(
      { username: "student", accountId: 42 },
      { manifestId: "manifest", courseRunId: 8, assignmentId: 11, attemptId: 3 },
    )).toEqual({ accountId: 42, courseRunId: 8, assignmentId: 11, attemptId: 3, manifestId: "manifest" });
  });

  test("fails closed instead of caching under username-only fallbacks", () => {
    expect(sessionScope(
      { username: "student" },
      { manifestId: "manifest", courseRunId: 8, assignmentId: 11, attemptId: 3 },
    )).toBeNull();
    expect(sessionScope(
      { username: "student", accountId: 42 },
      { manifestId: "manifest" },
    )).toBeNull();
  });

  test("keys the retry queue by account and attempt boundaries", () => {
    const base = sessionScopeKey({
      accountId: 42,
      courseRunId: 8,
      assignmentId: 11,
      attemptId: 3,
      manifestId: "manifest",
    });

    expect(base).not.toBe(sessionScopeKey({
      accountId: 43,
      courseRunId: 8,
      assignmentId: 11,
      attemptId: 3,
      manifestId: "manifest",
    }));
    expect(base).not.toBe(sessionScopeKey({
      accountId: 42,
      courseRunId: 8,
      assignmentId: 11,
      attemptId: 4,
      manifestId: "manifest",
    }));
  });

  test("normalizes numeric API ids without weakening scope isolation", () => {
    expect(sessionScopeKey({
      accountId: 42,
      courseRunId: 8,
      assignmentId: 11,
      attemptId: 3,
      manifestId: "manifest",
    })).toBe(sessionScopeKey({
      accountId: "42",
      courseRunId: "8",
      assignmentId: "11",
      attemptId: "3",
      manifestId: "manifest",
    }));
    expect(sessionScopeKey(null)).toBeNull();
  });
});

describe("remote session trust", () => {
  test("keeps a trusted session readable when read_only only means the assignment is closed", () => {
    expect(remoteSessionUntrusted({ stale: false, legacy_unverified: false, read_only: true, assignment_closed: true })).toBe(false);
  });

  test("still isolates stale, legacy, and unexplained read-only records", () => {
    expect(remoteSessionUntrusted({ stale: true, assignment_closed: true })).toBe(true);
    expect(remoteSessionUntrusted({ stale: false, legacy_unverified: true, assignment_closed: false })).toBe(true);
    expect(remoteSessionUntrusted({ stale: false, read_only: true, assignment_closed: false })).toBe(true);
  });
});

describe("atomic session updates", () => {
  test("two same-tick style step patches keep fields from both producers", () => {
    let session = emptySession("manifest");
    session = patchSessionStep(session, 7, { chart: "quadrant", compared: ["CHN", "USA"] });
    session = patchSessionStep(session, 7, { metric: "FVA_share", observations: [1, 2] });

    expect(readStep(session, 7)).toMatchObject({
      chart: "quadrant",
      compared: ["CHN", "USA"],
      metric: "FVA_share",
      observations: [1, 2],
    });
  });

  test("functional shared updates compose on the latest record", () => {
    let session = emptySession("manifest");
    session = updateSessionShared<Record<string, number>>(session, "regression_history", (current) => ({
      ...(current ?? {}),
      trade: 1,
    }));
    session = updateSessionShared<Record<string, number>>(session, "regression_history", (current) => ({
      ...(current ?? {}),
      network: 2,
    }));

    expect(readShared<Record<string, number>>(session, "regression_history")).toEqual({ trade: 1, network: 2 });
  });
});
