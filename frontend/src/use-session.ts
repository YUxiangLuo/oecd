import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isApiErrorStatus, RequestTimeoutError } from "./api";
import { emptySession, isValidSession, sessionData, withSessionViews, patchStep as patchStoredStep, readStep, sameMaterialContent, sameSessionContent } from "./session-store";
import type { ClassroomReport, CompletionSummary, ExperimentSession, QuizLearningState, ReportGateItem, ReportMutationResponse, SessionSaveResponse } from "./types";
import { isNetworkFailure, userFacingRequestError } from "./user-facing-error";

const SYNC_DEBOUNCE_MS = 800;
const KEPT_EDITS_PREFIX = "gvcsim_kept_edits_v4:";
type KeptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function keptEditsKey(username: string, releaseId: string): string {
  return `${KEPT_EDITS_PREFIX}${encodeURIComponent(username)}:${releaseId}`;
}

/** One tab's latest draft and exact unacknowledged request. Never merged with another record. */
export interface KeptEdits {
  version: 4;
  username: string;
  release_id: string;
  base_updated_at: string | null;
  session: ExperimentSession;
  sent?: ExperimentSession;
}

export function keepEdits(storage: KeptStorage, kept: Omit<KeptEdits, "version">): boolean {
  if (!/^[0-9a-f]{32}$/.test(kept.release_id)) return false;
  try { storage.setItem(keptEditsKey(kept.username, kept.release_id), JSON.stringify({ version: 4, ...kept })); return true; }
  catch { return false; }
}

export function readKeptEdits(storage: KeptStorage, username: string, releaseId: string): KeptEdits | null {
  try {
    const value = JSON.parse(storage.getItem(keptEditsKey(username, releaseId)) ?? "null") as Partial<KeptEdits> | null;
    if (value?.version !== 4 || value.username !== username || value.release_id !== releaseId
      || !(value.base_updated_at === null || typeof value.base_updated_at === "string")
      || !isValidSession(value.session) || (value.sent !== undefined && !isValidSession(value.sent))) return null;
    return value as KeptEdits;
  } catch { return null; }
}

export function hasKeptEdits(storage: Pick<Storage, "key" | "length">, username: string | null | undefined): boolean {
  if (!username) return false;
  try {
    const prefix = keptEditsKey(username, "");
    for (let index = 0; index < storage.length; index++) {
      if (storage.key(index)?.startsWith(prefix)) return true;
    }
    return false;
  } catch { return false; }
}
export function clearKeptEdits(storage: KeptStorage, username: string, releaseId: string): void {
  storage.removeItem(keptEditsKey(username, releaseId));
}
export function expiredLoginNotice(editsKept: boolean): string {
  return editsKept
    ? "登录已失效，请重新登录。未保存的修改已在本页保留，用同一账号重新登录后会恢复并核对保存状态。"
    : "登录已失效，请重新登录。";
}

export type SessionStatus = "loading" | "ready" | "unavailable";
export const SAVE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
export function isTransientSaveFailure(cause: unknown): boolean {
  if (cause instanceof ApiError) return [408, 429, 500, 502, 503, 504].includes(cause.status);
  return cause instanceof RequestTimeoutError || isNetworkFailure(cause);
}

export interface SessionApi extends QuizLearningState {
  status: SessionStatus;
  session: ExperimentSession;
  report: ClassroomReport | null;
  updatedAt?: string | null;
  syncing: boolean;
  syncError: string | null;
  localViewWarning?: string | null;
  /** A failed save to the server only (syncError also reports a failed draft backup in this tab). */
  saveError: string | null;
  syncConflict: boolean;
  autoRetry?: boolean;
  unsynced: boolean;
  completion: CompletionSummary | null;
  reportCurrent: boolean | null;
  reportGate: ReportGateItem[] | null;
  materialGate: ReportGateItem[] | null;
  restoredEdits?: number;
  getStep: <T>(step: number) => T | undefined;
  getConfirmedStep: <T>(step: number) => T | undefined;
  hasMaterialChanges: (step: number) => boolean;
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  syncNow: () => Promise<void>;
  retryLoad: () => void;
  loadAttempts: number;
  keepUnsavedEdits: () => boolean;
  resolveSyncConflict: () => Promise<void>;
  applyReportMutation: (response: ReportMutationResponse) => void;
  refreshLearning?: () => Promise<void>;
}

interface SaveQueueCallbacks {
  onSaved: (response: SessionSaveResponse, saved: ExperimentSession, hasNewer: boolean) => void;
  onError: (cause: unknown) => void;
  onSyncing: (value: boolean) => void;
  onUnsynced: (value: boolean) => void;
}

/** Exactly one request in flight. Resolve an uncertain request before sending newer edits. */
class SessionSaveQueue {
  private pending: ExperimentSession | null = null;
  private saving: Promise<void> | null = null;
  private baseUpdatedAt: string | null = null;
  private confirmed: ExperimentSession | null = null;
  private sent: ExperimentSession | null = null;
  private outcomeUncertain = false;
  private stopped = false;
  constructor(
    private readonly save: (session: ExperimentSession, base: string | null) => Promise<SessionSaveResponse>,
    private readonly callbacks: SaveQueueCallbacks,
  ) {}
  setBaseUpdatedAt(value: string | null) { this.baseUpdatedAt = value; }
  setConfirmedSession(session: ExperimentSession) { this.confirmed = session; this.sent = null; this.outcomeUncertain = false; }
  getSentSession() { return this.sent; }
  getBaseUpdatedAt() { return this.baseUpdatedAt; }
  stop() { this.stopped = true; }
  hasUnsynced() { return this.pending !== null || this.saving !== null; }
  restoreSent(session: ExperimentSession) { this.sent = session; this.outcomeUncertain = true; }
  enqueue(session: ExperimentSession) { this.pending = session; this.callbacks.onUnsynced(true); }
  drain(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.pending || this.stopped) return Promise.resolve();
    let run!: Promise<void>;
    run = (async () => {
      this.callbacks.onSyncing(true);
      try {
        while (this.pending && !this.stopped) {
          const next = this.outcomeUncertain && this.sent ? this.sent : this.pending;
          if (this.pending === next) this.pending = null;
          if (!this.outcomeUncertain && this.confirmed && sameSessionContent(next, this.confirmed)) continue;
          this.outcomeUncertain = true;
          this.sent = next;
          let response: SessionSaveResponse;
          try { response = await this.save(next, this.baseUpdatedAt); }
          catch (cause) {
            if (this.stopped) throw cause;
            if (cause instanceof ApiError && [400, 413, 422].includes(cause.status)) {
              this.sent = null;
              this.outcomeUncertain = false;
              // This snapshot was rejected, not committed. A correction typed while
              // waiting is a new save, even if its debounce already fired.
              if (this.pending && !sameSessionContent(this.pending, next)) continue;
            }
            this.pending ??= next;
            this.callbacks.onError(cause);
            throw cause;
          }
          if (this.stopped) return;
          this.baseUpdatedAt = response.updated_at;
          this.setConfirmedSession(next);
          this.callbacks.onSaved(response, next, this.pending !== null);
        }
      } finally {
        if (!this.stopped) {
          this.callbacks.onSyncing(false);
          this.callbacks.onUnsynced(Boolean(this.pending));
        }
      }
    })().finally(() => { if (this.saving === run) this.saving = null; });
    this.saving = run;
    return run;
  }
}

type SaveState = { phase: "saved" | "pending" | "saving" | "failed"; error: string | null; blocked: boolean };
const SAVED: SaveState = { phase: "saved", error: null, blocked: false };
const VERSION_ERROR = "保存状态异常，已暂停保存以保护作业。本页内容仍在，请先复制需要保留的内容，再重新载入。";

export function useSession(enabled: boolean, username?: string): SessionApi {
  const [status, setStatus] = useState<SessionStatus>(enabled ? "loading" : "unavailable");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [session, setSession] = useState<ExperimentSession>(emptySession);
  const sessionRef = useRef(session);
  const releaseId = useRef<string | null>(null);
  const [confirmed, setConfirmed] = useState<ExperimentSession>(emptySession);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [report, setReport] = useState<ClassroomReport | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reportCurrent, setReportCurrent] = useState<boolean | null>(null);
  const [reportGate, setReportGate] = useState<ReportGateItem[] | null>(null);
  const [materialGate, setMaterialGate] = useState<ReportGateItem[] | null>(null);
  const [restoredEdits, setRestoredEdits] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>(SAVED);
  const blocked = useRef(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [viewStorageFailed, setViewStorageFailed] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const retries = useRef(0);
  const timer = useRef<number | null>(null);
  const leavingOnPurpose = useRef(false);
  const mounted = useRef(true);
  const queue = useRef<SessionSaveQueue | null>(null);
  const [quizState, setQuizState] = useState<QuizLearningState>({});
  const quizRevision = useRef(-1);
  const currentQuizzes = useRef<QuizLearningState["quizzes"]>(undefined);
  const reportMutation = useRef(0);
  const viewKey = () => `gvcsim_views_v1:${encodeURIComponent(username ?? "")}:${releaseId.current}`;

  const persistDraft = useCallback(() => {
    if (!enabled || !username || !releaseId.current || !queue.current) return false;
    const ok = keepEdits(sessionStorage, {
      username, release_id: releaseId.current, base_updated_at: queue.current.getBaseUpdatedAt(),
      session: sessionData(sessionRef.current), sent: queue.current.getSentSession() ?? undefined,
    });
    if (mounted.current) setStorageFailed(!ok);
    return ok;
  }, [enabled, username]);
  // The queue outlives individual renders, but uses the current account's draft writer.
  const persistRef = useRef(persistDraft);
  persistRef.current = persistDraft;
  const applyQuizState = (response: QuizLearningState) => {
    // A delayed save response must not revive a quiz version already replaced by the teacher.
    if (response.quiz_revision !== undefined && response.quiz_revision < quizRevision.current) return false;
    if (response.quiz_revision !== undefined) quizRevision.current = response.quiz_revision;
    currentQuizzes.current = response.quizzes;
    setQuizState({ quiz_revision: response.quiz_revision, quizzes: response.quizzes });
    return true;
  };
  const applyLearningState = (response: Pick<SessionSaveResponse, "completion" | "report_current" | "report_gate" | "material_gate" | "quiz_revision" | "quizzes">) => {
    if (!applyQuizState(response)) return;
    setCompletion(response.completion);
    setReportCurrent(response.report_current);
    setReportGate(response.report_gate);
    setMaterialGate(response.material_gate);
  };
  const createQueue = () => new SessionSaveQueue(
    (value, base) => {
      persistRef.current();
      return api.classroom.saveSession({ session: value, base_updated_at: base });
    },
    {
      onSaved: (response, snapshot, newer) => {
        if (!mounted.current) return;
        setConfirmed(snapshot);
        setUpdatedAt(response.updated_at);
        applyLearningState(response);
        setSaveState({ ...SAVED, phase: newer ? "saving" : "saved" });
        retries.current = 0;
        setRetryAt(null);
        // This writes the latest draft with the acknowledged version, not the older sent snapshot.
        persistRef.current();
      },
      onError: (cause) => {
        if (!mounted.current) return;
        blocked.current = isApiErrorStatus(cause, 409);
        if (timer.current !== null) window.clearTimeout(timer.current);
        setSaveState({ phase: "failed", error: blocked.current ? VERSION_ERROR : userFacingRequestError(cause, "保存失败"), blocked: blocked.current });
        const retry = isTransientSaveFailure(cause);
        setRetryAt(retry ? Date.now() + SAVE_RETRY_DELAYS_MS[Math.min(retries.current++, SAVE_RETRY_DELAYS_MS.length - 1)] : null);
        persistRef.current();
      },
      onSyncing: (value) => {
        if (value && mounted.current) setSaveState({ phase: "saving", error: null, blocked: false });
      },
      onUnsynced: (value) => {
        if (!mounted.current) return;
        if (!value) {
          setSaveState(SAVED);
          try {
            if (username && releaseId.current) clearKeptEdits(sessionStorage, username, releaseId.current);
            setStorageFailed(false);
          } catch { setStorageFailed(true); }
        } else setSaveState((old) => old.phase === "saved" ? { ...old, phase: "pending" } : old);
      },
    },
  );

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current !== null) window.clearTimeout(timer.current); };
  }, []);

  useEffect(() => {
    setStatus(enabled ? "loading" : "unavailable");
    setSaveState(SAVED);
    setRetryAt(null);
    retries.current = 0;
    leavingOnPurpose.current = false;
    releaseId.current = null;
    quizRevision.current = -1;
    currentQuizzes.current = undefined;
    setQuizState({});
  }, [enabled, username]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ownedQueue = createQueue();
    queue.current = ownedQueue;
    api.classroom.session().then((response) => {
      if (!live) return;
      releaseId.current = response.release_id;
      queue.current!.setBaseUpdatedAt(response.updated_at ?? null);
      queue.current!.setConfirmedSession(response.session);
      setConfirmed(response.session);
      setUpdatedAt(response.updated_at ?? null);
      setReport(response.report);
      applyLearningState(response);
      const kept = username ? readKeptEdits(sessionStorage, username, response.release_id) : null;
      const dirty = kept && (!sameSessionContent(sessionData(kept.session), sessionData(response.session)) || kept.sent);
      let restored = withSessionViews(dirty ? kept.session : response.session, kept?.session ?? response.session);
      try {
        const views: unknown = JSON.parse(sessionStorage.getItem(viewKey()) ?? "null");
        if (isValidSession(views)) restored = withSessionViews(sessionData(restored), views);
        sessionStorage.setItem(viewKey(), JSON.stringify(sessionData(restored, true)));
        setViewStorageFailed(false);
      } catch { setViewStorageFailed(true); }
      sessionRef.current = restored;
      setSession(sessionRef.current);
      setSaveState(SAVED);
      blocked.current = false;
      setStatus("ready");
      if (dirty) {
        setRestoredEdits((n) => n + 1);
        queue.current!.enqueue(sessionData(kept.session));
        queue.current!.setBaseUpdatedAt(kept.base_updated_at);
        if (kept.sent) {
          queue.current!.restoreSent(kept.sent);
        } else if (kept.base_updated_at !== (response.updated_at ?? null)) {
          blocked.current = true;
          setSaveState({ phase: "failed", error: VERSION_ERROR, blocked: true });
          return;
        }
        void queue.current!.drain().catch(() => {});
      } else if (kept) {
        try { clearKeptEdits(sessionStorage, kept.username, kept.release_id); }
        catch { setStorageFailed(true); }
      }
    }, (cause) => {
      if (!live) return;
      setSaveState({ phase: "failed", error: userFacingRequestError(cause, "读取实验记录失败"), blocked: false });
      setStatus("unavailable");
    });
    return () => {
      live = false;
      ownedQueue.stop();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [enabled, username, loadAttempt]);

  const syncNow = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (status !== "ready") throw new Error("暂时无法读取实验记录，请稍后重试。");
    if (blocked.current) throw new Error(VERSION_ERROR);
    await queue.current!.drain();
  }, [status]);

  const refreshLearning = useCallback(async () => {
    if (!enabled || status !== "ready") return;
    const ownedQueue = queue.current;
    const reportVersion = reportMutation.current;
    const response = await api.classroom.session();
    if (!mounted.current || queue.current !== ownedQueue || reportMutation.current !== reportVersion) return;
    // Refresh only metadata for the acknowledged snapshot, never overwrite local edits or
    // allow a read overtaken by a save to restore outdated completion/report gates.
    if ((response.updated_at ?? null) !== ownedQueue?.getBaseUpdatedAt()) {
      // The teacher's question bank is independent of the student's saved snapshot.
      applyQuizState(response);
      return;
    }
    applyLearningState(response);
  }, [enabled, status, username]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshLearning().catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [refreshLearning]);

  const patchStep = useCallback(<T extends object,>(step: number, patch: Partial<T>) => {
    if (!enabled || status !== "ready") return;
    // A grading callback survives step navigation. Compare against the live bank here,
    // not the old QuizPanel's frozen props, before it can replace a newer saved answer.
    if ("quiz" in patch && currentQuizzes.current
      && (patch.quiz as { version?: string } | undefined)?.version !== currentQuizzes.current[String(step)]?.version) return;
    const next = patchStoredStep(sessionRef.current, step, patch);
    if (sameSessionContent(next, sessionRef.current)) return;
    const workChanged = !sameSessionContent(sessionData(next), sessionData(sessionRef.current));
    try {
      sessionStorage.setItem(viewKey(), JSON.stringify(sessionData(next, true)));
      setViewStorageFailed(false);
    } catch { setViewStorageFailed(true); }
    sessionRef.current = next;
    setSession(next);
    if (!workChanged) return;
    queue.current!.enqueue(sessionData(next));
    persistDraft();
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (!blocked.current) timer.current = window.setTimeout(() => { void syncNow().catch(() => {}); }, SYNC_DEBOUNCE_MS);
  }, [enabled, status, persistDraft, syncNow]);

  useEffect(() => {
    if (!enabled) return;
    const unreadable = status === "unavailable";
    const retry = () => {
      if (unreadable) setLoadAttempt((n) => n + 1);
      else if (retryAt !== null && !blocked.current) { setRetryAt(null); void syncNow().catch(() => {}); }
    };
    const delay = unreadable ? SAVE_RETRY_DELAYS_MS[Math.min(loadAttempt, SAVE_RETRY_DELAYS_MS.length - 1)]
      : retryAt !== null ? Math.max(0, retryAt - Date.now()) : null;
    const id = delay === null ? null : window.setTimeout(retry, delay);
    window.addEventListener("online", retry);
    return () => { if (id !== null) window.clearTimeout(id); window.removeEventListener("online", retry); };
  }, [enabled, status, loadAttempt, retryAt, syncNow]);

  const keepUnsavedEdits = useCallback(() => {
    if (!queue.current?.hasUnsynced()) return false;
    const kept = persistDraft();
    leavingOnPurpose.current = kept;
    return kept;
  }, [persistDraft]);

  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (!enabled || leavingOnPurpose.current) return;
      if (!queue.current?.hasUnsynced()) return;
      persistDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [enabled, persistDraft]);

  const resolveSyncConflict = useCallback(async () => {
    if (!blocked.current || !window.confirm("重新载入会清除本页待保存草稿。请先复制需要保留的内容，确认重新载入？")) return;
    if (username && releaseId.current) clearKeptEdits(sessionStorage, username, releaseId.current);
    leavingOnPurpose.current = true;
    // Exceptional recovery only; never overwrite server data automatically.
    window.location.reload();
  }, [username]);

  return {
    status, session, report, updatedAt, completion, reportCurrent, reportGate, materialGate, restoredEdits, ...quizState, refreshLearning,
    syncing: saveState.phase === "saving", unsynced: saveState.phase !== "saved" && status === "ready",
    syncError: saveState.error ?? (storageFailed ? "本标签页草稿备份失败，刷新前请等待服务器保存成功。" : null),
    localViewWarning: viewStorageFailed ? "本地浏览设置未能备份，刷新后可能需要重新选择；不影响作业保存。" : null,
    saveError: saveState.error,
    syncConflict: saveState.blocked, autoRetry: retryAt !== null,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    getConfirmedStep: useCallback(<T,>(step: number) => readStep<T>(confirmed, step), [confirmed]),
    hasMaterialChanges: (step) => {
      const saved = readStep<Record<string, unknown>>(confirmed, step);
      const sent = queue.current?.getSentSession();
      // Reverting a material edit while its request is in flight still needs a confirming save.
      return !sameMaterialContent(readStep(session, step), saved)
        || Boolean(sent && !sameMaterialContent(readStep(sent, step), saved));
    },
    patchStep, syncNow, keepUnsavedEdits, resolveSyncConflict,
    retryLoad: useCallback(() => setLoadAttempt((n) => n + 1), []), loadAttempts: loadAttempt,
    applyReportMutation: useCallback((response: ReportMutationResponse) => {
      reportMutation.current++;
      setReport(response.report);
      applyLearningState(response);
    }, []),
  };
}
