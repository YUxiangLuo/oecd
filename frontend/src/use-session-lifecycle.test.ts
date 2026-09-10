import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api } from "./api";
import { emptySession } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import {
  AUTH_RECOVERY_KEY, clearAuthSessionRecovery, patchSessionStep,
  readAuthSessionRecovery, saveAuthSessionRecovery, updateSessionShared,
  useSession, type SessionApi,
} from "./use-session";

const RELEASE = "a".repeat(32);
const STAMP = "2026-09-10T00:00:00Z";
const NEWER = "2026-09-10T00:01:00Z";
function response(session: ExperimentSession = emptySession(), stamp = STAMP): SessionResponse & SessionSaveResponse {
  return { session, release_id: RELEASE, updated_at: stamp, report: null,
    completion: { completed: [], completed_count: 0, total: 15, steps: [] }, report_gate: [], material_gate: [] };
}
type Hook = { result: { current: SessionApi }; unmount: () => void };
async function finish(hook: Hook) {
  await act(async () => { await hook.result.current.syncNow().catch(() => {}); });
  hook.unmount();
}
afterEach(() => { cleanup(); clearAuthSessionRecovery(sessionStorage); });

describe("page lifecycle draft recovery", () => {
  test("beforeunload captures the latest edit even before React renders unsynced state", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => {
        hook.result.current.patchStep(15, { research_question: "just typed before reload" });
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      });
      expect(readAuthSessionRecovery(sessionStorage, "student", RELEASE)).toEqual({
        version: 2, username: "student", release_id: RELEASE, base_updated_at: STAMP,
        session: patchSessionStep(emptySession(), 15, { research_question: "just typed before reload" }),
      });
      expect(save).not.toHaveBeenCalled();
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a failed save survives pagehide and a remount, but is restored only by explicit choice", async () => {
    const server = patchSessionStep(emptySession(), 15, { research_question: "server baseline" });
    const draft = patchSessionStep(server, 15, { research_question: "offline latest" });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(server));
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new Error("offline"));
    const first = renderHook(() => useSession(true, "student"));
    let second: Hook | undefined;
    try {
      await waitFor(() => expect(first.result.current.status).toBe("ready"));
      await act(async () => {
        first.result.current.patchStep(15, { research_question: "offline latest" });
        await first.result.current.syncNow().catch(() => {});
      });
      act(() => { window.dispatchEvent(new Event("pagehide")); });
      expect(readAuthSessionRecovery(sessionStorage, "student", RELEASE)?.session).toEqual(draft);
      expect(readAuthSessionRecovery(sessionStorage, "other", RELEASE)).toBeNull();
      expect(readAuthSessionRecovery(sessionStorage, "student", "b".repeat(32))).toBeNull();
      first.unmount();
      save.mockImplementation(async ({ session }) => response(session, NEWER));
      second = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(second!.result.current.status).toBe("ready"));
      expect(second.result.current.authRecoveryAvailable).toBe(true);
      expect(second.result.current.session).toEqual(server);
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => { await second!.result.current.restoreAuthRecovery(); });
      expect(save).toHaveBeenLastCalledWith({ session: draft, base_updated_at: STAMP });
      expect(second.result.current.session).toEqual(draft);
      expect(second.result.current.authRecoveryAvailable).toBe(false);
      expect(sessionStorage.getItem(AUTH_RECOVERY_KEY)).toBeNull();
    } finally { first.unmount(); if (second) await finish(second); get.mockRestore(); save.mockRestore(); }
  });

  test("refresh recovery never silently rebases an old draft onto a newer server revision", async () => {
    const original = response();
    const get = spyOn(api.classroom, "session").mockResolvedValue(original);
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new Error("not committed"));
    const first = renderHook(() => useSession(true, "student"));
    let second: Hook | undefined;
    try {
      await waitFor(() => expect(first.result.current.status).toBe("ready"));
      await act(async () => {
        first.result.current.patchStep(15, { research_question: "older base" });
        await first.result.current.syncNow().catch(() => {});
        window.dispatchEvent(new Event("pagehide"));
      });
      first.unmount();
      get.mockResolvedValue(response(patchSessionStep(emptySession(), 15, { research_question: "another writer" }), NEWER));
      second = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(second!.result.current.status).toBe("ready"));
      expect(second.result.current.authRecoveryAvailable).toBe(true);
      await act(async () => { await second!.result.current.restoreAuthRecovery().catch(() => {}); });
      expect(save.mock.calls.at(-1)?.[0].base_updated_at).toBe(STAMP);
      expect(readAuthSessionRecovery(sessionStorage, "student", RELEASE)?.base_updated_at).toBe(STAMP);
    } finally { first.unmount(); if (second) await finish(second); get.mockRestore(); save.mockRestore(); }
  });

  test("even an identical reload snapshot cannot silently acknowledge recovery from an older revision", async () => {
    const draft = patchSessionStep(emptySession(), 15, { research_question: "possibly committed before disconnect" });
    saveAuthSessionRecovery(sessionStorage, "student", draft, STAMP, RELEASE);
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(draft, NEWER));
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new Error("conflict"));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => { await hook.result.current.restoreAuthRecovery().catch(() => {}); });
      expect(save).toHaveBeenCalledWith({ session: draft, base_updated_at: STAMP });
      expect(hook.result.current.authRecoveryAvailable).toBe(true);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("an in-flight save preserves its original base and the newer queued text", async () => {
    let resolve!: (value: SessionSaveResponse) => void;
    const pending = new Promise<SessionSaveResponse>((done) => { resolve = done; });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => pending)
      .mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    let saving: Promise<void> | undefined;
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => {
        hook.result.current.patchStep(15, { research_question: "in flight" });
        saving = hook.result.current.syncNow();
        hook.result.current.patchStep(15, { research_question: "newest" });
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      });
      const recovered = readAuthSessionRecovery(sessionStorage, "student", RELEASE);
      expect(recovered?.base_updated_at).toBe(STAMP);
      expect(recovered?.session).toEqual(patchSessionStep(emptySession(), 15, { research_question: "newest" }));
    } finally {
      resolve(response(patchSessionStep(emptySession(), 15, { research_question: "in flight" }), NEWER));
      await act(async () => { await saving; });
      await finish(hook); get.mockRestore(); save.mockRestore();
    }
  });

  test("clean navigation neither writes a recovery nor erases another account's draft", async () => {
    const foreign = patchSessionStep(emptySession(), 15, { research_question: "another account" });
    saveAuthSessionRecovery(sessionStorage, "other", foreign, null, RELEASE);
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockResolvedValue(response());
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => { window.dispatchEvent(new Event("beforeunload")); window.dispatchEvent(new Event("pagehide")); });
      expect(readAuthSessionRecovery(sessionStorage, "other", RELEASE)?.session).toEqual(foreign);
      expect(readAuthSessionRecovery(sessionStorage, "student", RELEASE)).toBeNull();
      expect(save).not.toHaveBeenCalled();
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("storage failure requests a native leave confirmation instead of silently losing the edit", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session));
    const original = sessionStorage;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
    let attempts = 0;
    // Happy DOM caches bound Storage methods, so spying on its prototype after
    // an earlier read does not intercept writes. Replace the global adapter.
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: (key: string) => original.getItem(key),
      removeItem: (key: string) => original.removeItem(key),
      setItem: () => { attempts += 1; throw new DOMException("quota", "QuotaExceededError"); },
    } });
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      const leaving = new Event("beforeunload", { cancelable: true });
      act(() => {
        hook.result.current.patchStep(15, { research_question: "cannot persist locally" });
        window.dispatchEvent(leaving);
      });
      expect(attempts).toBe(1);
      expect(leaving.defaultPrevented).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", descriptor);
      await finish(hook); get.mockRestore(); save.mockRestore();
    }
  });
});

describe("no-op session patches", () => {
  test("equivalent nested objects, missing undefined fields and shared settings do not submit a revision", async () => {
    let initial = patchSessionStep(emptySession(), 8, { filters: { countries: ["CHN", "CIV"], year: 2020 } });
    initial = updateSessionShared(initial, "regression_settings", () => ({ method: "twfe_intensity", controls: [] }));
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(initial));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(8, { filters: { year: 2020, countries: ["CHN", "CIV"], omitted: undefined } });
        hook.result.current.patchStep(8, { absent: undefined });
        hook.result.current.updateShared("regression_settings", () => ({ controls: [], method: "twfe_intensity" }));
        await hook.result.current.syncNow();
      });
      expect(save).not.toHaveBeenCalled();
      expect(hook.result.current.session).toBe(initial);
      expect(hook.result.current.updatedAt).toBe(STAMP);
      expect(hook.result.current.unsynced).toBe(false);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("transient hydration changes that return to the confirmed snapshot do not write", async () => {
    const initial = patchSessionStep(emptySession(), 8, { year: 2020 });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(initial));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(8, { year: 2016 });
        hook.result.current.patchStep(8, { year: 2020 });
        await hook.result.current.syncNow();
      });
      expect(save).not.toHaveBeenCalled();
      expect(hook.result.current.unsynced).toBe(false);
      await act(async () => { hook.result.current.patchStep(8, { year: 2019 }); await hook.result.current.syncNow(); });
      expect(save).toHaveBeenCalledTimes(1);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("an ambiguous failed save cannot be deduplicated when the user returns to the old snapshot", async () => {
    const initial = patchSessionStep(emptySession(), 15, { research_question: "original" });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(initial));
    const save = spyOn(api.classroom, "saveSession").mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => { hook.result.current.patchStep(15, { research_question: "possibly committed" }); await hook.result.current.syncNow().catch(() => {}); });
      await act(async () => { hook.result.current.patchStep(15, { research_question: "original" }); await hook.result.current.syncNow(); });
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith({ session: initial, base_updated_at: STAMP });
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a synchronous save exception does not leave the queue permanently locked", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementationOnce(() => { throw new Error("serialization failed"); })
      .mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => { hook.result.current.patchStep(15, { research_question: "retry me" }); await hook.result.current.syncNow().catch(() => {}); });
      await act(async () => { await hook.result.current.syncNow(); });
      expect(save).toHaveBeenCalledTimes(2);
      expect(hook.result.current.unsynced).toBe(false);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("an actual ordered selection change is still saved", async () => {
    const initial = patchSessionStep(emptySession(), 8, { countries: ["CHN", "CIV"] });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(initial));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => { hook.result.current.patchStep(8, { countries: ["CIV", "CHN"] }); await hook.result.current.syncNow(); });
      expect(save).toHaveBeenCalledTimes(1);
      expect(hook.result.current.updatedAt).toBe(NEWER);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });
});
