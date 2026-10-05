import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "./api";
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

const SYNC_DEBOUNCE_MS = 800;
export const AUTH_RECOVERY_KEY = "gvcsim_unsynced_session_recovery_v1";

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface AuthSessionRecovery {
  version: 2;
  username: string;
  release_id: string;
  session: ExperimentSession;
  base_updated_at: string | null;
}

export function saveAuthSessionRecovery(
  storage: RecoveryStorage,
  username: string,
  session: ExperimentSession,
  baseUpdatedAt: string | null,
  releaseId: string,
): boolean {
  if (!/^[0-9a-f]{32}$/.test(releaseId)) return false;
  const recovery: AuthSessionRecovery = {
    version: 2,
    username,
    release_id: releaseId,
    session,
    base_updated_at: baseUpdatedAt,
  };
  try {
    storage.setItem(AUTH_RECOVERY_KEY, JSON.stringify(recovery));
    return true;
  } catch {
    // Storage quota/privacy failures must never prevent fail-closed logout.
    return false;
  }
}

export function readAuthSessionRecovery(
  storage: RecoveryStorage,
  username: string,
  releaseId: string,
): AuthSessionRecovery | null {
  const raw = storage.getItem(AUTH_RECOVERY_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuthSessionRecovery>;
    if (
      value.version !== 2
      || value.username !== username
      || !/^[0-9a-f]{32}$/.test(releaseId)
      || value.release_id !== releaseId
      || !isValidSession(value.session)
      || (value.base_updated_at !== null && typeof value.base_updated_at !== "string")
    ) return null;
    return value as AuthSessionRecovery;
  } catch {
    return null;
  }
}

export function clearAuthSessionRecovery(storage: RecoveryStorage): void {
  storage.removeItem(AUTH_RECOVERY_KEY);
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
  authRecoveryAvailable: boolean;
  /** Steps whose locally kept content differs from the server copy (what “恢复” would bring back). */
  authRecoverySteps: number[];
  completion: CompletionSummary | null;
  /** Combined quiz and material gate used by report generation. */
  reportGate: ReportGateItem[] | null;
  /** Server-confirmed missing evidence/actions, independently of quizzes. */
  materialGate: ReportGateItem[] | null;
  /** Incremented when a server conflict deliberately replaces all local step state. */
  workspaceGeneration: number;
  getStep: <T>(step: number) => T | undefined;
  getConfirmedStep: <T>(step: number) => T | undefined;
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  syncNow: () => Promise<void>;
  stashAuthRecovery: (username: string) => boolean;
  restoreAuthRecovery: () => Promise<void>;
  discardAuthRecovery: () => void;
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
    // A revision alone does not acknowledge any snapshot. Explicit recovery
    // must still check its original base, even if a fresh GET looks identical.
    this.outcomeUncertain = true;
  }

  setConfirmedSession(session: ExperimentSession) {
    this.confirmed = session;
    this.outcomeUncertain = false;
  }

  getBaseUpdatedAt(): string | null {
    return this.baseUpdatedAt;
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
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const syncConflictRef = useRef(false);
  const resolvingConflictRef = useRef(false);
  const [unsynced, setUnsynced] = useState(false);
  const [authRecovery, setAuthRecovery] = useState<AuthSessionRecovery | null>(null);
  const authRecoveryRef = useRef<AuthSessionRecovery | null>(null);
  const timer = useRef<number | null>(null);
  const queue = useRef<SessionSaveQueue | null>(null);
  if (queue.current === null) {
    queue.current = new SessionSaveQueue(
      (value, baseUpdatedAt) => api.classroom.saveSession({
        session: value,
        base_updated_at: baseUpdatedAt,
      }),
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
          syncConflictRef.current = false;
          setSyncConflict(false);
        },
        onError: (cause) => {
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
        replace(response.session);
        setConfirmedSession(response.session);
        setUpdatedAt(response.updated_at ?? null);
        setCompletion(response.completion);
        setReportGate(response.report_gate);
        setMaterialGate(response.material_gate);
        setReport(response.report);
        setSyncError(null);
        syncConflictRef.current = false;
        setSyncConflict(false);
        const recovery = username ? readAuthSessionRecovery(sessionStorage, username, response.release_id) : null;
        authRecoveryRef.current = recovery;
        setAuthRecovery(recovery);
        setStatus("ready");
      },
      (cause) => {
        if (!live) return;
        setSyncError(userFacingRequestError(cause, "读取实验记录失败"));
        setStatus("unavailable");
      },
    );
    return () => { live = false; };
  }, [enabled, replace, username]);

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
    if (status !== "ready") throw new Error("当前无法连接教学服务，不能确认实验记录已保存");
    if (syncConflictRef.current) throw new Error("请先载入服务器版本，再重新操作本页更改");
    await drain();
  }, [drain, status]);

  const stashAuthRecovery = useCallback((accountUsername: string) => {
    if (!enabled || !queue.current?.hasUnsynced() || !releaseIdRef.current) return false;
    return saveAuthSessionRecovery(
      sessionStorage,
      accountUsername,
      sessionRef.current,
      queue.current?.getBaseUpdatedAt() ?? null,
      releaseIdRef.current,
    );
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !username) return;
    const preserveBeforeLeaving = (event: Event) => {
      if (!queue.current?.hasUnsynced()) return;
      const saved = stashAuthRecovery(username);
      if (!saved && event.type === "beforeunload") {
        // Quota/privacy failures must not turn a refresh into silent data loss.
        event.preventDefault();
        (event as BeforeUnloadEvent).returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preserveBeforeLeaving);
    window.addEventListener("pagehide", preserveBeforeLeaving);
    return () => {
      window.removeEventListener("beforeunload", preserveBeforeLeaving);
      window.removeEventListener("pagehide", preserveBeforeLeaving);
    };
  }, [enabled, username, stashAuthRecovery]);

  const restoreAuthRecovery = useCallback(async () => {
    const recovery = authRecoveryRef.current;
    if (!recovery || recovery.username !== username || recovery.release_id !== releaseIdRef.current) return;
    replace(recovery.session);
    setWorkspaceGeneration((value) => value + 1);
    queue.current?.setBaseUpdatedAt(recovery.base_updated_at);
    queue.current?.enqueue(recovery.session);
    try {
      await drain();
      clearAuthSessionRecovery(sessionStorage);
      authRecoveryRef.current = null;
      setAuthRecovery(null);
    } catch (cause) {
      setSyncError(userFacingRequestError(cause, "保存失败"));
      throw cause;
    }
  }, [drain, replace, username]);

  const discardAuthRecovery = useCallback(() => {
    clearAuthSessionRecovery(sessionStorage);
    authRecoveryRef.current = null;
    setAuthRecovery(null);
  }, []);

  const resolveSyncConflict = useCallback(async () => {
    if (!syncConflictRef.current || resolvingConflictRef.current) return;
    resolvingConflictRef.current = true;
    const localSnapshot = sessionRef.current;
    setSyncing(true);
    try {
      const response = await api.classroom.session();
      if (sessionRef.current !== localSnapshot) {
        setSyncError("载入期间又有本地修改，已保留这些内容。请确认后再次载入服务器版本。");
        return;
      }
      releaseIdRef.current = response.release_id;
      queue.current?.discardPending(response.updated_at ?? null);
      queue.current?.setConfirmedSession(response.session);
      replace(response.session);
      setConfirmedSession(response.session);
      setUpdatedAt(response.updated_at ?? null);
      setCompletion(response.completion);
      setReportGate(response.report_gate);
      setMaterialGate(response.material_gate);
      setReport(response.report);
      setSyncError(null);
      syncConflictRef.current = false;
      setSyncConflict(false);
      setWorkspaceGeneration((value) => value + 1);
      setStatus("ready");
    } catch (cause) {
      setSyncError(userFacingRequestError(cause, "保存失败"));
      throw cause;
    } finally {
      resolvingConflictRef.current = false;
      setSyncing(false);
    }
  }, [replace]);

  const applyReportMutation = useCallback((response: ReportMutationResponse) => {
    setReport(response.report);
    setCompletion(response.completion);
    setReportGate(response.report_gate);
    setMaterialGate(response.material_gate);
  }, []);

  const authRecoverySteps = authRecovery
    ? [...new Set([...Object.keys(authRecovery.session.steps), ...Object.keys(confirmedSession.steps)])]
      .filter((step) => !sameJsonValue(authRecovery.session.steps[step], confirmedSession.steps[step]))
      .map(Number)
      .sort((a, b) => a - b)
    : [];

  return {
    status, session, report, updatedAt, syncing, syncError, syncConflict, unsynced,
    // Even a copy identical in content must be resolved explicitly: it may rest on an older revision.
    authRecoveryAvailable: authRecovery !== null,
    authRecoverySteps,
    completion, reportGate, materialGate, workspaceGeneration,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    getConfirmedStep: useCallback(<T,>(step: number) => readStep<T>(confirmedSession, step), [confirmedSession]),
    patchStep: useCallback(<T extends object,>(step: number, patch: Partial<T>) => update((value) => patchStoredStep(value, step, patch)), [update]),
    getShared: useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]),
    updateShared: useCallback(<T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared(value, key, apply)), [update]),
    syncNow,
    stashAuthRecovery,
    restoreAuthRecovery,
    discardAuthRecovery,
    resolveSyncConflict,
    applyReportMutation,
  };
}
