import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { emptySession, patchStep as patchStoredStep, readShared, readStep, writeShared } from "./session-store";
import type {
  ClassroomReport,
  CompletionSummary,
  ExperimentSession,
  ReportMutationResponse,
  SessionSaveResponse,
  SharedSessionKey,
} from "./types";

const SYNC_DEBOUNCE_MS = 800;
export type SessionStatus = "loading" | "ready" | "unavailable";

export interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  report: ClassroomReport | null;
  syncing: boolean;
  syncError: string | null;
  unsynced: boolean;
  completion: CompletionSummary | null;
  getStep: <T>(step: number) => T | undefined;
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  syncNow: () => Promise<void>;
  applyReportMutation: (response: ReportMutationResponse) => void;
}

interface SaveQueueCallbacks {
  onSaved: (response: SessionSaveResponse) => void;
  onError: (cause: unknown) => void;
  onSyncing: (value: boolean) => void;
  onUnsynced: (value: boolean) => void;
}

/** One mounted student's last-write-wins save queue. */
export class SessionSaveQueue {
  private pending: ExperimentSession | null = null;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly save: (session: ExperimentSession) => Promise<SessionSaveResponse>,
    private readonly callbacks: SaveQueueCallbacks,
  ) {}

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
          try {
            this.callbacks.onSaved(await this.save(next));
          } catch (cause) {
            // Edits made during this request are newer; otherwise retain this snapshot.
            this.pending ??= next;
            this.callbacks.onError(cause);
            throw cause;
          }
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

export function useSession(enabled: boolean): SessionApi {
  const [status, setStatus] = useState<SessionStatus>(enabled ? "loading" : "unavailable");
  const [session, setSession] = useState<ExperimentSession>(emptySession);
  const sessionRef = useRef(session);
  const [report, setReport] = useState<ClassroomReport | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const timer = useRef<number | null>(null);
  const queue = useRef<SessionSaveQueue | null>(null);
  if (queue.current === null) {
    queue.current = new SessionSaveQueue(
      (value) => api.classroom.saveSession({ session: value }),
      {
        onSaved: (response) => {
          setCompletion(response.completion);
          setSyncError(null);
        },
        onError: (cause) => setSyncError(cause instanceof Error ? cause.message : String(cause)),
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
        replace(response.session);
        setCompletion(response.completion);
        setReport(response.report);
        setSyncError(null);
        setStatus("ready");
      },
      (cause) => {
        if (!live) return;
        setSyncError(cause instanceof Error ? cause.message : String(cause));
        setStatus("unavailable");
      },
    );
    return () => { live = false; };
  }, [enabled, replace]);

  const drain = useCallback(async () => {
    await queue.current?.drain();
  }, []);

  const update = useCallback((apply: (value: ExperimentSession) => ExperimentSession) => {
    if (!enabled || status !== "ready") return;
    const next = apply(sessionRef.current);
    replace(next);
    queue.current?.enqueue(next);
    setSyncError(null);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void drain().catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  }, [drain, enabled, replace, status]);

  const syncNow = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (status !== "ready") throw new Error("当前无法连接教学服务，不能确认实验记录已保存");
    await drain();
  }, [drain, status]);

  const applyReportMutation = useCallback((response: ReportMutationResponse) => {
    setReport(response.report);
    setCompletion(response.completion);
  }, []);

  return {
    status, session, report, syncing, syncError, unsynced, completion,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    patchStep: useCallback(<T extends object,>(step: number, patch: Partial<T>) => update((value) => patchStoredStep(value, step, patch)), [update]),
    getShared: useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]),
    updateShared: useCallback(<T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared(value, key, apply)), [update]),
    syncNow,
    applyReportMutation,
  };
}
