import { beforeEach, describe, expect, test } from "bun:test";

// bun test 不带 DOM。这里只需要 Storage 的读写语义,用最小内存实现即可——
// 被测的是本模块的序列化与校验逻辑,不是浏览器的存储实现。
class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, String(v));
  removeItem = (k: string) => void this.map.delete(k);
  clear = () => this.map.clear();
}
(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

import {
  clearLocal,
  emptySession,
  isStale,
  isValidSession,
  loadLocal,
  localKey,
  makeRecord,
  mergeSessions,
  reconcileOnLoad,
  readShared,
  readStep,
  saveLocal,
  writeShared,
  writeStep,
} from "./session-store";
import { SESSION_VERSION, type ExperimentSession } from "./types";

const MID = "b08a35374d1021b0";
const OTHER = "deadbeefdeadbeef";

const session = (
  steps: ExperimentSession["steps"],
  manifestId = MID,
  shared: ExperimentSession["shared"] = {},
): ExperimentSession => ({
  version: SESSION_VERSION,
  manifest_id: manifestId,
  steps,
  shared,
});

describe("session-store", () => {
  beforeEach(() => localStorage.clear());

  test("round-trips through localStorage", () => {
    const s = writeStep(emptySession(MID), 4, { country: "CHN" });
    saveLocal("student", s);
    expect(loadLocal("student")).toEqual(s);
    clearLocal("student");
    expect(loadLocal("student")).toBeNull();
  });

  test("keeps sessions of different accounts apart", () => {
    saveLocal("alice", writeStep(emptySession(MID), 4, { country: "CHN" }));
    expect(loadLocal("bob")).toBeNull();
    expect(localKey("alice")).not.toBe(localKey("bob"));
  });

  test("discards corrupted or foreign local payloads instead of trusting them", () => {
    localStorage.setItem(localKey("student"), "{not json");
    expect(loadLocal("student")).toBeNull();
    localStorage.setItem(localKey("student"), JSON.stringify({ version: "old", manifest_id: MID, steps: {} }));
    expect(loadLocal("student")).toBeNull();
    localStorage.setItem(localKey("student"), JSON.stringify(session({ "99": makeRecord({}) })));
    expect(loadLocal("student")).toBeNull();
  });

  test("rejects records missing a timestamp", () => {
    expect(isValidSession({ version: SESSION_VERSION, manifest_id: MID, steps: { "4": { data: {} } } })).toBe(false);
  });

  test("read/write step state", () => {
    const s = writeStep(emptySession(MID), 12, { shock: "tariff" });
    expect(readStep<{ shock: string }>(s, 12)?.shock).toBe("tariff");
    expect(readStep(s, 4)).toBeUndefined();
  });

  test("merge keeps both sides when different steps changed", () => {
    const base = session({ "4": makeRecord({ country: "CHN" }, "2026-07-16T10:00:00.000Z") });
    const incoming = session({ "12": makeRecord({ shock: "tariff" }, "2026-07-16T10:05:00.000Z") });
    const merged = mergeSessions(base, incoming);
    expect(readStep<object>(merged, 4)).toEqual({ country: "CHN" });
    expect(readStep<object>(merged, 12)).toEqual({ shock: "tariff" });
  });

  test("merge prefers the newer record for the same step, in both directions", () => {
    const older = makeRecord({ v: "old" }, "2026-07-16T10:00:00.000Z");
    const newer = makeRecord({ v: "new" }, "2026-07-16T10:05:00.000Z");
    expect(readStep<object>(mergeSessions(session({ "4": older }), session({ "4": newer })), 4)).toEqual({ v: "new" });
    // 本次写入者不必然更新:它可能拿着很旧的状态。
    expect(readStep<object>(mergeSessions(session({ "4": newer }), session({ "4": older })), 4)).toEqual({ v: "new" });
  });

  test("isStale detects another artifact set", () => {
    expect(isStale(emptySession(MID), MID)).toBe(false);
    expect(isStale(emptySession(OTHER), MID)).toBe(true);
  });

  test("read/write shared state", () => {
    const s = writeShared(emptySession(MID), "regression_settings", { method: "DID" });
    expect(readShared<{ method: string }>(s, "regression_settings")?.method).toBe("DID");
    expect(readShared(s, "regression_history")).toBeUndefined();
  });

  test("merge applies the same newest-wins rule to shared state", () => {
    const base = session({}, MID, {
      regression_settings: makeRecord({ v: "old" }, "2026-07-16T10:00:00.000Z"),
      regression_history: makeRecord({ trade: [] }, "2026-07-16T10:00:00.000Z"),
    });
    const incoming = session({}, MID, {
      regression_settings: makeRecord({ v: "new" }, "2026-07-16T10:05:00.000Z"),
    });
    const merged = mergeSessions(base, incoming);
    expect(readShared<object>(merged, "regression_settings")).toEqual({ v: "new" });
    // 另一个共享键没有被本次写入带走。
    expect(readShared<object>(merged, "regression_history")).toEqual({ trade: [] });
  });

  test("rejects unknown shared keys instead of accepting arbitrary blobs", () => {
    const bad = { ...emptySession(MID), shared: { whatever: makeRecord({}) } };
    expect(isValidSession(bad)).toBe(false);
  });

  describe("reconcileOnLoad", () => {
    test("uses the server session when there is nothing local", () => {
      const server = session({ "4": makeRecord({ country: "CHN" }) });
      const out = reconcileOnLoad(null, server, MID);
      expect(out.session).toEqual(server);
      expect(out.needsPush).toBe(false);
    });

    test("merges local work that the server has not seen and pushes it", () => {
      const server = session({ "4": makeRecord({ country: "CHN" }, "2026-07-16T10:00:00.000Z") });
      const local = session({ "12": makeRecord({ shock: "tariff" }, "2026-07-16T10:05:00.000Z") });
      const out = reconcileOnLoad(local, server, MID);
      expect(readStep<object>(out.session, 4)).toEqual({ country: "CHN" });
      expect(readStep<object>(out.session, 12)).toEqual({ shock: "tariff" });
      expect(out.needsPush).toBe(true);
    });

    test("does not push when local adds nothing new", () => {
      const record = makeRecord({ country: "CHN" }, "2026-07-16T10:00:00.000Z");
      const out = reconcileOnLoad(session({ "4": record }), session({ "4": record }), MID);
      expect(out.needsPush).toBe(false);
    });

    test("drops local state produced by other artifacts rather than mixing it in", () => {
      const server = session({ "4": makeRecord({ country: "CHN" }) });
      const local = session({ "12": makeRecord({ shock: "旧产物" }) }, OTHER);
      const out = reconcileOnLoad(local, server, MID);
      expect(readStep(out.session, 12)).toBeUndefined();
      expect(out.discardedLocal).toBe(true);
    });

    test("drops a stale server session rather than serving it as current", () => {
      const server = session({ "4": makeRecord({ country: "CHN" }) }, OTHER);
      const out = reconcileOnLoad(null, server, MID);
      expect(out.session.steps).toEqual({});
      expect(out.session.manifest_id).toBe(MID);
      expect(out.discardedServer).toBe(true);
    });
  });
});
