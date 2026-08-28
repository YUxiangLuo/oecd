import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "./api";
import { emptySession, isValidSession, patchStep as patchStoredStep, readShared, readStep, writeShared } from "./session-store";
import type {
  ClassroomReport,
  CompletionSummary,
  ExperimentSession,
  ReportGateItem,
  ReportMutationResponse,
  SessionSaveResponse,
  SharedSessionKey,
} from "./types";

const SYNC_DEBOUNCE_MS = 800;
export const AUTH_RECOVERY_KEY = "gvcsim_unsynced_session_recovery_v1";

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface AuthSessionRecovery {
  version: 1;
  username: string;
  session: ExperimentSession;
  base_updated_at: string | null;
}

export function saveAuthSessionRecovery(
  storage: RecoveryStorage,
  username: string,
  session: ExperimentSession,
  baseUpdatedAt: string | null,
): boolean {
  const recovery: AuthSessionRecovery = {
    version: 1,
    username,
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
): AuthSessionRecovery | null {
  const raw = storage.getItem(AUTH_RECOVERY_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuthSessionRecovery>;
    if (
      value.version !== 1
      || value.username !== username
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
  syncing: boolean;
  syncError: string | null;
  syncConflict: boolean;
  unsynced: boolean;
  authRecoveryAvailable: boolean;
  completion: CompletionSummary | null;
  /** Server-confirmed missing materials for the step-16 report. */
  reportGate: ReportGateItem[] | null;
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

  getBaseUpdatedAt(): string | null {
    return this.baseUpdatedAt;
  }

  discardPending(baseUpdatedAt: string | null) {
    this.pending = null;
    this.baseUpdatedAt = baseUpdatedAt;
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
          let response: SessionSaveResponse;
          try {
            response = await this.save(next, this.baseUpdatedAt);
          } catch (cause) {
            // Edits made during this request are newer; otherwise retain this snapshot.
            this.pending ??= next;
            this.callbacks.onError(cause);
            throw cause;
          }
          this.baseUpdatedAt = response.updated_at;
          this.callbacks.onSaved(response, next, this.pending !== null);
        }
      } finally {
        this.callbacks.onSyncing(false);
        this.callbacks.onUnsynced(Boolean(this.pending));
        if (this.saving === run) this.saving = null;
      }
    })();
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
  const [confirmedSession, setConfirmedSession] = useState<ExperimentSession>(emptySession);
  const [report, setReport] = useState<ClassroomReport | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reportGate, setReportGate] = useState<ReportGateItem[] | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const syncConflictRef = useRef(false);
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
          if (!hasNewerPending && sessionRef.current === savedSnapshot) {
            sessionRef.current = response.session;
            setSession(response.session);
          }
          setCompletion(response.completion);
          setReportGate(response.report_gate);
          setSyncError(null);
          syncConflictRef.current = false;
          setSyncConflict(false);
        },
        onError: (cause) => {
          const conflict = isApiErrorStatus(cause, 409);
          syncConflictRef.current = conflict;
          setSyncError(cause instanceof Error ? cause.message : String(cause));
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
        queue.current?.setBaseUpdatedAt(response.updated_at ?? null);
        replace(response.session);
        setConfirmedSession(response.session);
        setCompletion(response.completion);
        setReportGate(response.report_gate);
        setReport(response.report);
        setSyncError(null);
        syncConflictRef.current = false;
        setSyncConflict(false);
        const recovery = username ? readAuthSessionRecovery(sessionStorage, username) : null;
        authRecoveryRef.current = recovery;
        setAuthRecovery(recovery);
        setStatus("ready");
      },
      (cause) => {
        if (!live) return;
        setSyncError(cause instanceof Error ? cause.message : String(cause));
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
    replace(next);
    queue.current?.enqueue(next);
    if (!syncConflictRef.current) setSyncError(null);
    if (timer.current != null) window.clearTimeout(timer.current);
    if (!syncConflictRef.current) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void drain().catch(() => {});
      }, SYNC_DEBOUNCE_MS);
    }
  }, [drain, enabled, replace, status]);

  const syncNow = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (status !== "ready") throw new Error("当前无法连接教学服务，不能确认实验记录已保存");
    if (syncConflict) throw new Error("请先载入服务器版本，再重新操作本页更改");
    await drain();
  }, [drain, status, syncConflict]);

  const stashAuthRecovery = useCallback((accountUsername: string) => {
    if (!enabled || !unsynced) return false;
    return saveAuthSessionRecovery(
      sessionStorage,
      accountUsername,
      sessionRef.current,
      queue.current?.getBaseUpdatedAt() ?? null,
    );
  }, [enabled, unsynced]);

  const restoreAuthRecovery = useCallback(async () => {
    const recovery = authRecoveryRef.current;
    if (!recovery || recovery.username !== username) return;
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
      setSyncError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [drain, replace, username]);

  const discardAuthRecovery = useCallback(() => {
    clearAuthSessionRecovery(sessionStorage);
    authRecoveryRef.current = null;
    setAuthRecovery(null);
  }, []);

  const resolveSyncConflict = useCallback(async () => {
    if (!syncConflict) return;
    setSyncing(true);
    try {
      const response = await api.classroom.session();
      queue.current?.discardPending(response.updated_at ?? null);
      replace(response.session);
      setConfirmedSession(response.session);
      setCompletion(response.completion);
      setReportGate(response.report_gate);
      setReport(response.report);
      setSyncError(null);
      syncConflictRef.current = false;
      setSyncConflict(false);
      setWorkspaceGeneration((value) => value + 1);
      setStatus("ready");
    } catch (cause) {
      setSyncError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSyncing(false);
    }
  }, [replace, syncConflict]);

  const applyReportMutation = useCallback((response: ReportMutationResponse) => {
    setReport(response.report);
    setCompletion(response.completion);
    setReportGate(response.report_gate);
  }, []);

  return {
    status, session, report, syncing, syncError, syncConflict, unsynced,
    authRecoveryAvailable: authRecovery !== null,
    completion, reportGate, workspaceGeneration,
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
