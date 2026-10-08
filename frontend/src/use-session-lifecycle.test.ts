import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { api, ApiError } from "./api";
import { emptySession, readStep } from "./session-store";
import type { ExperimentSession, SessionResponse, SessionSaveResponse } from "./types";
import {
  KEPT_EDITS_KEY, clearKeptEdits, keepEdits, mergeKeptEdits, patchSessionStep,
  readKeptEdits, updateSessionShared,
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
afterEach(() => { cleanup(); clearKeptEdits(sessionStorage); });

describe("keeping and restoring unconfirmed edits", () => {
  test("beforeunload keeps the latest edit and the last confirmed record, even before React renders", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => {
        hook.result.current.patchStep(15, { research_question: "just typed before reload" });
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
      });
      expect(readKeptEdits(sessionStorage, "student", RELEASE)).toEqual({
        version: 3, username: "student", release_id: RELEASE, base: emptySession(),
        session: patchSessionStep(emptySession(), 15, { research_question: "just typed before reload" }),
      });
      expect(save).not.toHaveBeenCalled();
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a failed save survives pagehide and a remount and comes back without asking", async () => {
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
      expect(readKeptEdits(sessionStorage, "student", RELEASE)?.session).toEqual(draft);
      expect(readKeptEdits(sessionStorage, "other", RELEASE)).toBeNull();
      expect(readKeptEdits(sessionStorage, "student", "b".repeat(32))).toBeNull();
      first.unmount();
      save.mockImplementation(async ({ session }) => response(session, NEWER));
      second = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(second!.result.current.updatedAt).toBe(NEWER));
      // Saved against the server's current revision, not an old one: no conflict to resolve.
      expect(save).toHaveBeenLastCalledWith({ session: draft, base_updated_at: STAMP });
      expect(second.result.current.session).toEqual(draft);
      expect(second.result.current.unsynced).toBe(false);
      expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
    } finally { first.unmount(); if (second) await finish(second); get.mockRestore(); save.mockRestore(); }
  });

  test("edits that reached the server before the page was left are not saved again", async () => {
    const draft = patchSessionStep(emptySession(), 15, { research_question: "committed before the reload" });
    keepEdits(sessionStorage, { username: "student", release_id: RELEASE, base: emptySession(), session: draft });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(draft, NEWER));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      expect(hook.result.current.session).toEqual(draft);
      expect(save).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(KEPT_EDITS_KEY)).toBeNull();
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a step another tab changed since keeps the server version; the other kept steps come back", async () => {
    const base = patchSessionStep(patchSessionStep(emptySession(), 15, { research_question: "base" }), 6, { metric: "A" });
    const local = patchSessionStep(patchSessionStep(base, 15, { research_question: "this tab" }), 6, { metric: "B" });
    const server = patchSessionStep(base, 15, { research_question: "another tab" });
    keepEdits(sessionStorage, { username: "student", release_id: RELEASE, base, session: local });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(server, NEWER));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const merged = patchSessionStep(server, 6, { metric: "B" });
      expect(save).toHaveBeenCalledWith({ session: merged, base_updated_at: NEWER });
      expect(hook.result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("another tab");
      expect(hook.result.current.getStep<{ metric: string }>(6)?.metric).toBe("B");
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("an in-flight save keeps the base it started from and the newer queued text", async () => {
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
      const kept = readKeptEdits(sessionStorage, "student", RELEASE);
      expect(kept?.base).toEqual(emptySession());
      expect(kept?.session).toEqual(patchSessionStep(emptySession(), 15, { research_question: "newest" }));
    } finally {
      resolve(response(patchSessionStep(emptySession(), 15, { research_question: "in flight" }), NEWER));
      await act(async () => { await saving; });
      await finish(hook); get.mockRestore(); save.mockRestore();
    }
  });

  test("clean navigation neither keeps edits nor erases another account's copy", async () => {
    const foreign = patchSessionStep(emptySession(), 15, { research_question: "another account" });
    keepEdits(sessionStorage, { username: "other", release_id: RELEASE, base: emptySession(), session: foreign });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockResolvedValue(response());
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => { window.dispatchEvent(new Event("beforeunload")); window.dispatchEvent(new Event("pagehide")); });
      expect(readKeptEdits(sessionStorage, "other", RELEASE)?.session).toEqual(foreign);
      expect(readKeptEdits(sessionStorage, "student", RELEASE)).toBeNull();
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

describe("review findings", () => {
  const transition = (type: "pagehide" | "pageshow", persisted: boolean) => {
    const event = new Event(type);
    Object.defineProperty(event, "persisted", { value: persisted });
    return event;
  };

  test("a copy left by a page restored from the back/forward cache is dropped, so later changes stand", async () => {
    const server = patchSessionStep(emptySession(), 15, { research_question: "original" });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(server));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const first = renderHook(() => useSession(true, "student"));
    let second: Hook | undefined;
    try {
      await waitFor(() => expect(first.result.current.status).toBe("ready"));
      act(() => {
        first.result.current.patchStep(15, { research_question: "temporary" });
        window.dispatchEvent(transition("pagehide", true));
      });
      expect(readKeptEdits(sessionStorage, "student", RELEASE)).not.toBeNull();
      // Back from the cache: the same page goes on, and the student changes the text back.
      act(() => { window.dispatchEvent(transition("pageshow", true)); });
      expect(readKeptEdits(sessionStorage, "student", RELEASE)).toBeNull();
      await act(async () => {
        first.result.current.patchStep(15, { research_question: "original" });
        await first.result.current.syncNow();
      });
      first.unmount();
      second = renderHook(() => useSession(true, "student"));
      await waitFor(() => expect(second!.result.current.status).toBe("ready"));
      expect(second.result.current.getStep<{ research_question: string }>(15)?.research_question).toBe("original");
    } finally { first.unmount(); if (second) await finish(second); get.mockRestore(); save.mockRestore(); }
  });

  test("loading the newer record after a conflict keeps this page's edits the other page did not touch", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ detail: "conflict" }), { status: 409 }));
    const conflict = await api.classroom.saveSession({ session: emptySession(), base_updated_at: null }).catch((error) => error);
    fetchMock.mockRestore();
    const other = patchSessionStep(emptySession(), 15, { research_question: "other tab" });
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce(response()).mockResolvedValue(response(other, NEWER));
    const save = spyOn(api.classroom, "saveSession").mockRejectedValueOnce(conflict)
      .mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(2, { country: "FRA" });
        hook.result.current.patchStep(15, { limitations: "mine" });
        await hook.result.current.syncNow().catch(() => {});
      });
      expect(hook.result.current.syncConflict).toBe(true);
      await act(async () => { await hook.result.current.resolveSyncConflict(); });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      const merged = patchSessionStep(patchSessionStep(other, 2, { country: "FRA" }), 15, { limitations: "mine" });
      expect(save).toHaveBeenLastCalledWith({ session: merged, base_updated_at: NEWER });
      expect(hook.result.current.session).toEqual(merged);
      expect(hook.result.current.syncConflict).toBe(false);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("two pages changing different fields of one step are combined; any shared field keeps the server's step", () => {
    const base = patchSessionStep(emptySession(), 8, { compared: ["CHN", "USA"], observations: [1], indicator_selection: { view: "trend" } });
    // This page re-recorded the chart; the other page only changed the selection: not combinable.
    const local = patchSessionStep(base, 8, { compared: ["CHN", "DEU"], observations: [2], indicator_selection: { view: "comparison" } });
    const server = patchSessionStep(base, 8, { indicator_selection: { view: "composition" } });
    expect(mergeKeptEdits(server, { base, session: local })).toEqual(server);
    // Different text fields of step 15: both edits survive.
    const textBase = patchSessionStep(emptySession(), 15, { research_question: "q" });
    const textLocal = patchSessionStep(textBase, 15, { limitations: "mine" });
    const textServer = patchSessionStep(textBase, 15, { research_question: "other tab" });
    expect(readStep<Record<string, unknown>>(mergeKeptEdits(textServer, { base: textBase, session: textLocal }), 15)).toEqual({
      research_question: "other tab", limitations: "mine",
    });
  });
});

describe("reconnecting", () => {
  test("a save that failed offline is retried when the browser comes back online", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new TypeError("Failed to fetch"));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(15, { research_question: "typed offline" });
        await hook.result.current.syncNow().catch(() => {});
      });
      expect(hook.result.current.unsynced).toBe(true);
      save.mockImplementation(async ({ session }) => response(session, NEWER));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await waitFor(() => expect(hook.result.current.unsynced).toBe(false));
      expect(hook.result.current.syncError).toBeNull();
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });
});

describe("saving when the tab is hidden or closed", () => {
  const setVisibility = (value: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => { delete (document as { visibilityState?: unknown }).visibilityState; });

  test("closing the tab right after typing sends the edit at once, with keepalive and the page's base", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => {
        hook.result.current.patchStep(15, { research_question: "typed just before closing" });
        window.dispatchEvent(new Event("pagehide"));
      });
      // Not after the 800 ms autosave delay: the page may be gone by then.
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]).toEqual([
        { session: patchSessionStep(emptySession(), 15, { research_question: "typed just before closing" }), base_updated_at: STAMP },
        { keepalive: true },
      ]);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a save sent when the tab was hidden moves the base on, so the next normal save does not conflict", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(15, { research_question: "before switching tabs" });
        setVisibility("hidden");
      });
      await waitFor(() => expect(hook.result.current.unsynced).toBe(false));
      expect(save.mock.calls[0]?.[0].base_updated_at).toBe(STAMP);
      expect(save.mock.calls[0]?.[1]).toEqual({ keepalive: true });
      await act(async () => {
        setVisibility("visible");
        hook.result.current.patchStep(15, { research_question: "back on the tab" });
        await hook.result.current.syncNow();
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1]).toEqual([
        { session: patchSessionStep(emptySession(), 15, { research_question: "back on the tab" }), base_updated_at: NEWER },
      ]);
      expect(hook.result.current.syncConflict).toBe(false);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("after a refresh, a 409 because the save sent on leaving already stored this content is not a conflict", async () => {
    const edited = patchSessionStep(emptySession(), 15, { research_question: "sent while leaving" });
    keepEdits(sessionStorage, { username: "student", release_id: RELEASE, base: emptySession(), session: edited });
    // The new page read the record just before the flush from the old page landed.
    const get = spyOn(api.classroom, "session")
      .mockResolvedValueOnce(response())
      .mockResolvedValue(response(edited, NEWER));
    const conflict = new ApiError(409, { message: "changed", code: "session_changed" }, "conflict");
    const save = spyOn(api.classroom, "saveSession").mockRejectedValueOnce(conflict)
      .mockImplementation(async ({ session }) => response(session, "2026-09-10T00:02:00Z"));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await waitFor(() => expect(hook.result.current.unsynced).toBe(false));
      expect(hook.result.current.syncConflict).toBe(false);
      expect(hook.result.current.syncError).toBeNull();
      expect(hook.result.current.updatedAt).toBe(NEWER);
      await act(async () => {
        hook.result.current.patchStep(15, { research_question: "next edit" });
        await hook.result.current.syncNow();
      });
      expect(save.mock.calls[1]?.[0].base_updated_at).toBe(NEWER);
    } finally { await finish(hook); get.mockRestore(); save.mockRestore(); }
  });

  test("a 409 for content the server does not hold is still a conflict", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValueOnce(response())
      .mockResolvedValue(response(patchSessionStep(emptySession(), 15, { research_question: "other tab" }), NEWER));
    const save = spyOn(api.classroom, "saveSession").mockRejectedValue(new ApiError(409, { message: "changed" }, "conflict"));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      await act(async () => {
        hook.result.current.patchStep(15, { research_question: "this tab" });
        await hook.result.current.syncNow().catch(() => {});
      });
      expect(hook.result.current.syncConflict).toBe(true);
    } finally { hook.unmount(); get.mockRestore(); save.mockRestore(); }
  });

  test("leaving asks first when the edit cannot be saved on the way out (offline or after a failed save)", async () => {
    const get = spyOn(api.classroom, "session").mockResolvedValue(response());
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
    const hook = renderHook(() => useSession(true, "student"));
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      act(() => { hook.result.current.patchStep(15, { research_question: "online edit" }); });
      // Online, nothing failed: the edit is sent on pagehide, no prompt.
      expect(leave()).toBe(false);
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
      expect(leave()).toBe(true);
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
      save.mockRejectedValue(new Error("教学服务暂时不可用"));
      await act(async () => { await hook.result.current.syncNow().catch(() => {}); });
      expect(leave()).toBe(true);
      // App keeps the edits on purpose before its own reload (logout, expired login): no prompt then.
      act(() => { expect(hook.result.current.keepUnsavedEdits()).toBe(true); });
      expect(leave()).toBe(false);
    } finally {
      if (online) Object.defineProperty(navigator, "onLine", online);
      else delete (navigator as { onLine?: unknown }).onLine;
      hook.unmount(); get.mockRestore(); save.mockRestore();
    }
  });

  test("a record too large for keepalive starts saving at once and asks before leaving", async () => {
    // A finished record (four regression runs, long analysis) can pass the 64 KiB keepalive limit.
    const large = patchSessionStep(emptySession(), 11, { notes: "长".repeat(22_000) });
    const get = spyOn(api.classroom, "session").mockResolvedValue(response(large));
    const save = spyOn(api.classroom, "saveSession").mockImplementation(async ({ session }) => response(session, NEWER));
    const hook = renderHook(() => useSession(true, "student"));
    try {
      await waitFor(() => expect(hook.result.current.status).toBe("ready"));
      const leaving = new Event("beforeunload", { cancelable: true });
      act(() => {
        hook.result.current.patchStep(15, { research_question: "typed on a large record" });
        window.dispatchEvent(leaving);
      });
      expect(leaving.defaultPrevented).toBe(true);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]).toHaveLength(1);
      await waitFor(() => expect(hook.result.current.unsynced).toBe(false));
    } finally { hook.unmount(); get.mockRestore(); save.mockRestore(); }
  });
});
