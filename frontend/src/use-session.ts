import { useCallback, useEffect, useRef, useState } from "react";
import { api, AUTH_TOKEN_KEY, fitsKeepalive, getActiveAuthToken, isApiErrorStatus } from "./api";
import { emptySession, isValidSession, patchStep as patchStoredStep, readShared, readStep, sameJsonValue, sameSessionContent, writeShared } from "./session-store";
import type {
  ClassroomReport,
  CompletionSummary,
  ExperimentSession,
  ReportGateItem,
  ReportMutationResponse,
  SessionSaveResponse,
  SharedSessionKey,
} from "./types";

import { userFacingRequestError } from "./user-facing-error";
import { EDITED_DURING_RELOAD } from "./sync-problem";

const SYNC_DEBOUNCE_MS = 800;
/** This tab's copy of edits the server had not confirmed when the page was left. */
export const KEPT_EDITS_KEY = "gvcsim_kept_edits_v3";

type KeptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Edits the server had not confirmed when the page was left (refresh, navigation, expired login,
 * logout or password change). `base` is the last record the server confirmed, so the next load can
 * tell which steps were edited and put back only those, without asking the student.
 */
export interface KeptEdits {
  version: 3;
  username: string;
  release_id: string;
  base: ExperimentSession;
  session: ExperimentSession;
}

export function keepEdits(storage: KeptStorage, kept: Omit<KeptEdits, "version">): boolean {
  if (!/^[0-9a-f]{32}$/.test(kept.release_id)) return false;
  try {
    storage.setItem(KEPT_EDITS_KEY, JSON.stringify({ version: 3, ...kept }));
    return true;
  } catch {
    // Storage quota/privacy failures must never prevent fail-closed logout.
    return false;
  }
}

export function readKeptEdits(storage: KeptStorage, username: string, releaseId: string): KeptEdits | null {
  try {
    const value = JSON.parse(storage.getItem(KEPT_EDITS_KEY) ?? "null") as Partial<KeptEdits> | null;
    if (
      value?.version !== 3
      || value.username !== username
      || value.release_id !== releaseId
      || !isValidSession(value.base)
      || !isValidSession(value.session)
    ) return null;
    return value as KeptEdits;
  } catch {
    return null;
  }
}

/** Whether this tab holds edits kept on leaving (for any account; the next login restores its own). */
export function hasKeptEdits(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(KEPT_EDITS_KEY) !== null;
  } catch {
    return false;
  }
}

/** The login page's notice after an expired login; it says so when unsaved edits were kept in this tab. */
export function expiredLoginNotice(editsKept: boolean): string {
  return editsKept
    ? "登录已失效，请重新登录。未保存的修改已在本页保留，用同一账号重新登录后会自动恢复。"
    : "登录已失效，请重新登录。";
}

export function clearKeptEdits(storage: KeptStorage): void {
  storage.removeItem(KEPT_EDITS_KEY);
}

/**
 * Put this page's edits back on the server's current record. Each step (or shared entry) the copy
 * changed since its base is applied when the server did not change it too. When both changed it,
 * the two are combined only if they changed different fields; a field changed on both sides keeps
 * the server's whole step, since fields recorded together (e.g. a chart's countries and readings)
 * must not be mixed.
 */
export function mergeKeptEdits(server: ExperimentSession, kept: Pick<KeptEdits, "base" | "session">): ExperimentSession {
  const changed = (from: Record<string, unknown>, to: Record<string, unknown>) =>
    [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((key) => !sameJsonValue(from[key], to[key]));
  const put = <T,>(out: Record<string, T>, key: string, value: T | undefined) => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  const data = (record: unknown) => ((record as { data?: Record<string, unknown> } | undefined)?.data ?? {});
  const merge = <T,>(current: Record<string, T>, base: Record<string, T>, local: Record<string, T>) => {
    const out = { ...current };
    for (const key of changed(base, local)) {
      if (sameJsonValue(current[key], base[key])) {
        put(out, key, local[key]);
        continue;
      }
      const mine = changed(data(base[key]), data(local[key]));
      const theirs = new Set(changed(data(base[key]), data(current[key])));
      if (current[key] === undefined || local[key] === undefined || mine.some((field) => theirs.has(field))) continue;
      const combined = { ...data(current[key]) };
      for (const field of mine) put(combined, field, data(local[key])[field]);
      out[key] = { ...current[key], data: combined };
    }
    return out;
  };
  return {
    ...server,
    steps: merge(server.steps, kept.base.steps, kept.session.steps),
    shared: merge(server.shared, kept.base.shared, kept.session.shared),
  };
}

export type SessionStatus = "loading" | "ready" | "unavailable";

export interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  report: ClassroomReport | null;
  updatedAt?: string | null;
  syncing: boolean;
  syncError: string | null;
  syncConflict: boolean;
  unsynced: boolean;
  completion: CompletionSummary | null;
  /** Combined quiz and material gate used by report generation. */
  reportGate: ReportGateItem[] | null;
  /** Server-confirmed missing evidence/actions, independently of quizzes. */
  materialGate: ReportGateItem[] | null;
  /** Incremented when a server conflict deliberately replaces all local step state. */
  workspaceGeneration: number;
  /** Incremented each time edits kept in this tab (an expired login, a logout offline) are put back after login. */
  restoredEdits?: number;
  getStep: <T>(step: number) => T | undefined;
  getConfirmedStep: <T>(step: number) => T | undefined;
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  syncNow: () => Promise<void>;
  /** Read the saved record again after the first read failed (status "unavailable"). */
  retryLoad: () => void;
  /** How many times the read has been retried in this page (shown after a failed retry). */
  loadAttempts: number;
  /** Keep unconfirmed edits in this tab before leaving on purpose (logout, expired login, password change); the next load puts them back. */
  keepUnsavedEdits: () => boolean;
  resolveSyncConflict: () => Promise<void>;
  applyReportMutation: (response: ReportMutationResponse) => void;
}

interface SaveQueueCallbacks {
  onSaved: (
    response: SessionSaveResponse,
    savedSnapshot: ExperimentSession,
    hasNewerPending: boolean,
  ) => void;
  onError: (cause: unknown) => void;
  onSyncing: (value: boolean) => void;
  onUnsynced: (value: boolean) => void;
}

/** One mounted student's serialized, optimistic-concurrency save queue. */
export class SessionSaveQueue {
  private pending: ExperimentSession | null = null;
  private saving: Promise<void> | null = null;
  private baseUpdatedAt: string | null = null;
  private confirmed: ExperimentSession | null = null;
  private outcomeUncertain = false;

  constructor(
    private readonly save: (
      session: ExperimentSession,
      baseUpdatedAt: string | null,
    ) => Promise<SessionSaveResponse>,
    private readonly callbacks: SaveQueueCallbacks,
  ) {}

  setBaseUpdatedAt(value: string | null) {
    this.baseUpdatedAt = value;
  }

  setConfirmedSession(session: ExperimentSession) {
    this.confirmed = session;
    this.outcomeUncertain = false;
  }

  /** The last snapshot the server confirmed. */
  getConfirmedSession(): ExperimentSession | null {
    return this.confirmed;
  }

  hasUnsynced(): boolean {
    return this.pending !== null || this.saving !== null;
  }

  discardPending(baseUpdatedAt: string | null) {
    this.pending = null;
    this.setBaseUpdatedAt(baseUpdatedAt);
    this.callbacks.onUnsynced(false);
  }

  enqueue(session: ExperimentSession) {
    this.pending = session;
    this.callbacks.onUnsynced(true);
  }

  drain(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.pending) {
      this.callbacks.onUnsynced(false);
      return Promise.resolve();
    }
    let run!: Promise<void>;
    run = (async () => {
      this.callbacks.onSyncing(true);
      try {
        while (this.pending) {
          const next = this.pending;
          this.pending = null;
          // Hydration can enqueue intermediate defaults and then return to the
          // acknowledged snapshot before the debounce fires. That is not a write.
          // After a failed response, however, the server may already have changed:
          // retain the original optimistic version and require a real retry.
          if (!this.outcomeUncertain && this.confirmed && sameSessionContent(next, this.confirmed)) continue;
          let response: SessionSaveResponse;
          this.outcomeUncertain = true;
          try {
            response = await this.save(next, this.baseUpdatedAt);
          } catch (cause) {
            // Edits made during this request are newer; otherwise retain this snapshot.
            this.pending ??= next;
            this.callbacks.onError(cause);
            throw cause;
          }
          this.baseUpdatedAt = response.updated_at;
          this.setConfirmedSession(response.session);
          this.callbacks.onSaved(response, next, this.pending !== null);
        }
      } finally {
        this.callbacks.onSyncing(false);
        this.callbacks.onUnsynced(Boolean(this.pending));
      }
    })().finally(() => {
      // Even a no-op drain or a synchronously thrown save must clear the promise
      // after it has actually been assigned to this.saving.
      if (this.saving === run) this.saving = null;
    });
    this.saving = run;
    return run;
  }
}

export function patchSessionStep<T extends object>(session: ExperimentSession, step: number, patch: Partial<T>) {
  return patchStoredStep(session, step, patch);
}

export function updateSessionShared<T>(session: ExperimentSession, key: SharedSessionKey, apply: (current: T | undefined) => T) {
  return writeShared(session, key, apply(readShared<T>(session, key)));
}

export function useSession(enabled: boolean, username?: string): SessionApi {
  const [status, setStatus] = useState<SessionStatus>(enabled ? "loading" : "unavailable");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [session, setSession] = useState<ExperimentSession>(emptySession);
  const sessionRef = useRef(session);
  const releaseIdRef = useRef<string | null>(null);
  const [confirmedSession, setConfirmedSession] = useState<ExperimentSession>(emptySession);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [report, setReport] = useState<ClassroomReport | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reportGate, setReportGate] = useState<ReportGateItem[] | null>(null);
  const [materialGate, setMaterialGate] = useState<ReportGateItem[] | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [restoredEdits, setRestoredEdits] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const syncConflictRef = useRef(false);
  const resolvingConflictRef = useRef(false);
  const [unsynced, setUnsynced] = useState(false);
  const timer = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  // The page is being left (pagehide until it is shown again): saves are sent so that they outlive it.
  const leavingRef = useRef(false);
  // The last save failed (offline, server error): a save sent while leaving cannot be counted on.
  const saveFailedRef = useRef(false);
  // App keeps the edits on purpose before its own reload (logout, expired login): no leave prompt then.
  const leavingOnPurposeRef = useRef(false);
  const queue = useRef<SessionSaveQueue | null>(null);
  if (queue.current === null) {
    queue.current = new SessionSaveQueue(
      async (value, baseUpdatedAt) => {
        const body = { session: value, base_updated_at: baseUpdatedAt };
        // While the tab is hidden or closing, the same request (same token, body and base) goes with keepalive,
        // so closing the tab right after typing still saves the edit.
        const outlivePage = leavingRef.current || (typeof document !== "undefined" && document.visibilityState === "hidden");
        try {
          return await (outlivePage ? api.classroom.saveSession(body, { keepalive: true }) : api.classroom.saveSession(body));
        } catch (cause) {
          if (!isApiErrorStatus(cause, 409)) throw cause;
          // The record changed since this page's base. When it already holds exactly this content (the save
          // sent while the previous page was being left landed first, or a response was lost), that is this
          // save, not a conflict: carry on from the server's version.
          const latest = await api.classroom.session().catch(() => null);
          if (latest?.updated_at && latest.release_id === releaseIdRef.current && sameSessionContent(latest.session, value)) {
            return {
              session: latest.session,
              updated_at: latest.updated_at,
              completion: latest.completion,
              report_gate: latest.report_gate,
              material_gate: latest.material_gate,
            };
          }
          throw cause;
        }
      },
      {
        onSaved: (response, savedSnapshot, hasNewerPending) => {
          // Track every acknowledged snapshot, but only reconcile the optimistic
          // workspace when this response is still the latest queued edit.
          setConfirmedSession(response.session);
          setUpdatedAt(response.updated_at ?? null);
          if (!hasNewerPending && sessionRef.current === savedSnapshot) {
            sessionRef.current = response.session;
            setSession(response.session);
          }
          setCompletion(response.completion);
          setReportGate(response.report_gate);
          setMaterialGate(response.material_gate);
          setSyncError(null);
          saveFailedRef.current = false;
          syncConflictRef.current = false;
          setSyncConflict(false);
        },
        onError: (cause) => {
          saveFailedRef.current = true;
          const conflict = isApiErrorStatus(cause, 409);
          syncConflictRef.current = conflict;
          if (conflict && timer.current != null) {
            window.clearTimeout(timer.current);
            timer.current = null;
          }
          setSyncError(userFacingRequestError(cause, "保存失败"));
          setSyncConflict(conflict);
        },
        onSyncing: setSyncing,
        onUnsynced: setUnsynced,
      },
    );
  }

  const replace = useCallback((value: ExperimentSession) => {
    sessionRef.current = value;
    setSession(value);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setStatus("loading");
    api.classroom.session().then(
      (response) => {
        if (!live) return;
        releaseIdRef.current = response.release_id;
        queue.current?.setBaseUpdatedAt(response.updated_at ?? null);
        queue.current?.setConfirmedSession(response.session);
        // Edits kept when this tab was last left go back on top of the server's record, step by step.
        const kept = username ? readKeptEdits(sessionStorage, username, response.release_id) : null;
        if (kept) clearKeptEdits(sessionStorage);
        const restored = kept ? mergeKeptEdits(response.session, kept) : response.session;
        replace(restored);
        setConfirmedSession(response.session);
        setUpdatedAt(response.updated_at ?? null);
        setCompletion(response.completion);
        setReportGate(response.report_gate);
        setMaterialGate(response.material_gate);
        setReport(response.report);
        setSyncError(null);
        saveFailedRef.current = false;
        leavingOnPurposeRef.current = false;
        syncConflictRef.current = false;
        setSyncConflict(false);
        setStatus("ready");
        if (!sameSessionContent(restored, response.session)) {
          setRestoredEdits((value) => value + 1);
          queue.current?.enqueue(restored);
          void queue.current?.drain().catch(() => {});
        }
      },
      (cause) => {
        if (!live) return;
        setSyncError(userFacingRequestError(cause, "读取实验记录失败"));
        setStatus("unavailable");
      },
    );
    return () => { live = false; };
  }, [enabled, loadAttempt, replace, username]);

  const drain = useCallback(async () => {
    await queue.current?.drain();
  }, []);

  const update = useCallback((apply: (value: ExperimentSession) => ExperimentSession) => {
    if (!enabled || status !== "ready") return;
    const next = apply(sessionRef.current);
    if (sameSessionContent(next, sessionRef.current)) return;
    replace(next);
    queue.current?.enqueue(next);
    if (!syncConflictRef.current) setSyncError(null);
    if (timer.current != null) window.clearTimeout(timer.current);
    if (!syncConflictRef.current) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (!syncConflictRef.current) void drain().catch(() => {});
      }, SYNC_DEBOUNCE_MS);
    }
  }, [drain, enabled, replace, status]);

  const syncNow = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (status !== "ready") throw new Error("暂时连不上服务器，实验记录可能还没保存。请稍后再试。");
    if (syncConflictRef.current) throw new Error("你的账号在别处保存了更新的记录，请先点“载入服务器版本”。");
    await drain();
  }, [drain, status]);

  const keepCopy = useCallback(() => {
    if (!enabled || !username || !queue.current?.hasUnsynced() || !releaseIdRef.current) return false;
    return keepEdits(sessionStorage, {
      username,
      release_id: releaseIdRef.current,
      base: queue.current.getConfirmedSession() ?? emptySession(),
      session: sessionRef.current,
    });
  }, [enabled, username]);

  const keepUnsavedEdits = useCallback(() => {
    const kept = keepCopy();
    // App reloads right after keeping the edits on purpose; the kept copy restores them, so no prompt.
    if (kept) leavingOnPurposeRef.current = true;
    return kept;
  }, [keepCopy]);

  useEffect(() => {
    if (!enabled || !username) return;
    // Send unsaved edits now, without waiting for the autosave delay: the tab is being hidden or closed.
    const flushBeforeLeaving = () => {
      if (!queue.current?.hasUnsynced() || syncConflictRef.current || statusRef.current !== "ready") return;
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      void queue.current.drain().catch(() => {});
    };
    // Whether a save sent now is likely to go through: online, the last save did not fail, no conflict.
    const canSaveNow = () => navigator.onLine !== false
      && !saveFailedRef.current
      && !syncConflictRef.current
      && statusRef.current === "ready";
    const preserveBeforeLeaving = (event: Event) => {
      if (!queue.current?.hasUnsynced()) return;
      // A refresh puts the kept copy back; a closed tab loses it (sessionStorage belongs to the tab).
      const saved = keepCopy();
      if (event.type === "pagehide") {
        leavingRef.current = true;
        flushBeforeLeaving();
        return;
      }
      // beforeunload: ask before leaving when the edits can neither be kept here (storage failure) nor be
      // saved on the way out (offline, a failed save, a conflict, or a record too large to be sent with
      // keepalive, which a finished record with a long analysis can be).
      const canSave = canSaveNow();
      const fits = fitsKeepalive({ session: sessionRef.current, base_updated_at: null });
      // Too large for keepalive: start the normal save now, so it is already on its way while the browser asks.
      if (canSave && !fits) flushBeforeLeaving();
      if (!saved || (!leavingOnPurposeRef.current && !(canSave && fits))) {
        event.preventDefault();
        (event as BeforeUnloadEvent).returnValue = "";
      }
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") flushBeforeLeaving();
      else leavingRef.current = false;
    };
    // Back from the back/forward cache: this same page still holds the edits and saves them itself.
    // The copy kept on leaving would otherwise put them back later, even after they were changed again.
    const forgetAfterReturn = (event: Event) => {
      leavingRef.current = false;
      const release = releaseIdRef.current;
      // A page restored from the back/forward cache keeps its edits in memory, so the kept copy is dropped —
      // unless the tab has logged out meanwhile: App then reloads to the login page and the next login in
      // this tab needs the kept copy.
      const stillSignedIn = sessionStorage.getItem(AUTH_TOKEN_KEY) === getActiveAuthToken();
      if ((event as PageTransitionEvent).persisted && stillSignedIn && release && readKeptEdits(sessionStorage, username, release)) {
        clearKeptEdits(sessionStorage);
      }
    };
    window.addEventListener("beforeunload", preserveBeforeLeaving);
    window.addEventListener("pagehide", preserveBeforeLeaving);
    window.addEventListener("pageshow", forgetAfterReturn);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("beforeunload", preserveBeforeLeaving);
      window.removeEventListener("pagehide", preserveBeforeLeaving);
      window.removeEventListener("pageshow", forgetAfterReturn);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [enabled, username, keepCopy]);

  // An unreadable record is read again as soon as the browser reports the network back.
  useEffect(() => {
    if (!enabled || status !== "unavailable") return;
    const online = () => setLoadAttempt((value) => value + 1);
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [enabled, status]);

  // A failed save waits for the next edit or a click on 重试保存; when the browser reports the network back,
  // retry on its own (never through a conflict, which needs the student's decision).
  useEffect(() => {
    if (!enabled || status !== "ready" || !unsynced) return;
    const online = () => {
      if (!syncConflictRef.current) void drain().catch(() => {});
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [drain, enabled, status, unsynced]);

  const resolveSyncConflict = useCallback(async () => {
    if (!syncConflictRef.current || resolvingConflictRef.current) return;
    resolvingConflictRef.current = true;
    const localSnapshot = sessionRef.current;
    let toSave: ExperimentSession | null = null;
    setSyncing(true);
    try {
      const response = await api.classroom.session();
      if (sessionRef.current !== localSnapshot) {
        setSyncError(EDITED_DURING_RELOAD);
        return;
      }
      // Keep this page's edits the other page did not touch: the same rule as edits kept on leaving.
      const sameRelease = response.release_id === releaseIdRef.current;
      const base = queue.current?.getConfirmedSession() ?? emptySession();
      const merged = sameRelease ? mergeKeptEdits(response.session, { base, session: localSnapshot }) : response.session;
      releaseIdRef.current = response.release_id;
      queue.current?.discardPending(response.updated_at ?? null);
      queue.current?.setConfirmedSession(response.session);
      replace(merged);
      setConfirmedSession(response.session);
      setUpdatedAt(response.updated_at ?? null);
      setCompletion(response.completion);
      setReportGate(response.report_gate);
      setMaterialGate(response.material_gate);
      setReport(response.report);
      setSyncError(null);
      saveFailedRef.current = false;
      syncConflictRef.current = false;
      setSyncConflict(false);
      setWorkspaceGeneration((value) => value + 1);
      setStatus("ready");
      if (!sameSessionContent(merged, response.session)) toSave = merged;
    } catch (cause) {
      setSyncError(userFacingRequestError(cause, "保存失败"));
      throw cause;
    } finally {
      resolvingConflictRef.current = false;
      setSyncing(false);
    }
    if (toSave) {
      queue.current?.enqueue(toSave);
      await queue.current?.drain().catch(() => {});
    }
  }, [replace]);

  const applyReportMutation = useCallback((response: ReportMutationResponse) => {
    setReport(response.report);
    setCompletion(response.completion);
    setReportGate(response.report_gate);
    setMaterialGate(response.material_gate);
  }, []);

  return {
    status, session, report, updatedAt, syncing, syncError, syncConflict, unsynced,
    completion, reportGate, materialGate, workspaceGeneration, restoredEdits,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    getConfirmedStep: useCallback(<T,>(step: number) => readStep<T>(confirmedSession, step), [confirmedSession]),
    patchStep: useCallback(<T extends object,>(step: number, patch: Partial<T>) => update((value) => patchStoredStep(value, step, patch)), [update]),
    getShared: useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]),
    updateShared: useCallback(<T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared(value, key, apply)), [update]),
    syncNow,
    retryLoad: useCallback(() => setLoadAttempt((value) => value + 1), []),
    loadAttempts: loadAttempt,
    keepUnsavedEdits,
    resolveSyncConflict,
    applyReportMutation,
  };
}
