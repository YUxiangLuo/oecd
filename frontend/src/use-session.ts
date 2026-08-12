import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { emptySession, patchStep as patchStoredStep, readShared, readStep, writeShared } from "./session-store";
import type { CompletionSummary, ExperimentSession, SessionResponse, SharedSessionKey } from "./types";

const SYNC_DEBOUNCE_MS = 800;
export type SessionStatus = "loading" | "ready" | "unavailable";

export interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  syncing: boolean;
  syncError: string | null;
  unsynced: boolean;
  completion: CompletionSummary | null;
  getStep: <T>(step: number) => T | undefined;
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  syncNow: () => Promise<void>;
  reset: () => Promise<void>;
  refreshCompletion: () => Promise<void>;
}

interface SessionIdentity { username: string; accountId?: string | number | null }

interface SaveQueueCallbacks {
  onSaved: (response: SessionResponse) => void;
  onError: (cause: unknown) => void;
  onSyncing: (value: boolean) => void;
  onUnsynced: (value: boolean) => void;
}

interface SaveOperation {
  epoch: number;
  promise: Promise<void>;
}

interface PendingSave {
  epoch: number;
  session: ExperimentSession;
}

/** Last-write-wins within one login cycle; writes for the same account stay serialized across cycles. */
export class AccountSessionSaveQueue {
  private activeIdentity: string | null = null;
  private activeEpoch = 0;
  private pending: PendingSave | null = null;
  private saving = new Map<string, SaveOperation>();

  constructor(
    private readonly save: (session: ExperimentSession) => Promise<SessionResponse>,
    private readonly callbacks: SaveQueueCallbacks,
  ) {}

  activate(identity: string | null) {
    const identityChanged = this.activeIdentity !== identity;
    this.activeIdentity = identity;
    if (identityChanged) {
      this.activeEpoch += 1;
      this.pending = null;
      this.callbacks.onSyncing(false);
      this.callbacks.onUnsynced(false);
    }
  }

  enqueue(session: ExperimentSession) {
    if (this.activeIdentity === null) return;
    this.pending = { epoch: this.activeEpoch, session };
    this.callbacks.onUnsynced(true);
  }

  discardPending() {
    this.pending = null;
    this.callbacks.onUnsynced(false);
  }

  /** Session restoration must observe any save started by an earlier login of this account. */
  waitForIdentity(identity: string): Promise<void> {
    return this.saving.get(identity)?.promise.catch(() => {}) ?? Promise.resolve();
  }

  drain(requestedIdentity: string | null = this.activeIdentity): Promise<void> {
    if (requestedIdentity === null || this.activeIdentity !== requestedIdentity) return Promise.resolve();
    const requestedEpoch = this.activeEpoch;
    const existing = this.saving.get(requestedIdentity);
    if (existing?.epoch === requestedEpoch) return existing.promise;
    if (existing) {
      // A -> logout -> A: do not let the new login's PUT overtake the old PUT.
      return existing.promise.catch(() => {}).then(() => this.drain(requestedIdentity));
    }
    if (this.pending === null) {
      this.callbacks.onUnsynced(false);
      return Promise.resolve();
    }

    let run!: Promise<void>;
    // 空队列 drain 已走上面的快速路径；有待保存内容时第一次 await 会让出执行权，
    // this.saving 会在请求完成前登记并由 finally 正常清理。
    run = (async () => {
      if (this.activeIdentity === requestedIdentity && this.activeEpoch === requestedEpoch) {
        this.callbacks.onSyncing(true);
      }
      try {
        while (
          this.pending?.epoch === requestedEpoch
          && this.activeIdentity === requestedIdentity
          && this.activeEpoch === requestedEpoch
        ) {
          const next = this.pending.session;
          this.pending = null;
          try {
            const response = await this.save(next);
            if (this.activeIdentity !== requestedIdentity || this.activeEpoch !== requestedEpoch) return;
            this.callbacks.onSaved(response);
          } catch (cause) {
            if (this.activeIdentity !== requestedIdentity || this.activeEpoch !== requestedEpoch) return;
            this.pending ??= { epoch: requestedEpoch, session: next };
            this.callbacks.onError(cause);
            throw cause;
          }
        }
      } finally {
        if (this.activeIdentity === requestedIdentity && this.activeEpoch === requestedEpoch) {
          this.callbacks.onSyncing(false);
          this.callbacks.onUnsynced(Boolean(this.pending));
        }
        if (this.saving.get(requestedIdentity)?.promise === run) this.saving.delete(requestedIdentity);
      }
    })();
    this.saving.set(requestedIdentity, { epoch: requestedEpoch, promise: run });
    return run;
  }
}

export function patchSessionStep<T extends object>(session: ExperimentSession, step: number, patch: Partial<T>) {
  return patchStoredStep(session, step, patch);
}

export function updateSessionShared<T>(session: ExperimentSession, key: SharedSessionKey, apply: (current: T | undefined) => T) {
  return writeShared(session, key, apply(readShared<T>(session, key)));
}

export function useSession(identity: SessionIdentity | null): SessionApi {
  const identityKey = identity?.accountId != null ? String(identity.accountId) : null;
  const [status, setStatus] = useState<SessionStatus>(identityKey ? "loading" : "unavailable");
  const [session, setSession] = useState<ExperimentSession>(emptySession);
  const sessionRef = useRef(session);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const timer = useRef<number | null>(null);
  const activeIdentity = useRef(identityKey);
  const saveQueue = useRef<AccountSessionSaveQueue | null>(null);
  if (saveQueue.current === null) {
    saveQueue.current = new AccountSessionSaveQueue(
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
    activeIdentity.current = identityKey;
    saveQueue.current?.activate(identityKey);
    if (timer.current != null) window.clearTimeout(timer.current);
    replace(emptySession());
    setCompletion(null);
    setSyncError(null);
    setUnsynced(false);
    setStatus(identityKey ? "loading" : "unavailable");
    if (!identityKey) return;
    const requestedIdentity = identityKey;
    let live = true;
    void (async () => {
      await saveQueue.current?.waitForIdentity(requestedIdentity);
      if (!live || activeIdentity.current !== requestedIdentity) return;
      try {
        const response = await api.classroom.session();
        if (!live || activeIdentity.current !== requestedIdentity) return;
        replace(response.session);
        setCompletion(response.completion);
        setStatus("ready");
      } catch (cause) {
        if (!live || activeIdentity.current !== requestedIdentity) return;
        setSyncError(cause instanceof Error ? cause.message : String(cause));
        setStatus("unavailable");
      }
    })();
    return () => { live = false; };
  }, [identityKey, replace]);

  const drain = useCallback(async () => {
    if (!identityKey || activeIdentity.current !== identityKey) return;
    await saveQueue.current?.drain(identityKey);
  }, [identityKey]);

  const update = useCallback((apply: (value: ExperimentSession) => ExperimentSession) => {
    if (!identityKey || status !== "ready") return;
    const next = apply(sessionRef.current);
    replace(next);
    saveQueue.current?.enqueue(next);
    setSyncError(null);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void drain().catch(() => {}); }, SYNC_DEBOUNCE_MS);
  }, [drain, identityKey, replace, status]);

  const syncNow = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (status !== "ready") throw new Error("当前无法连接教学服务，不能确认实验记录已保存");
    await drain();
  }, [drain, status]);

  const reset = useCallback(async () => {
    if (!identityKey) throw new Error("当前没有可清空的实验工作区");
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    await drain().catch(() => {});
    saveQueue.current?.discardPending();
    await api.classroom.resetWorkspace({ confirmation: "清空当前实验" });
    replace(emptySession());
    window.location.reload();
  }, [drain, identityKey, replace]);

  const refreshCompletion = useCallback(async () => {
    if (!identityKey || activeIdentity.current !== identityKey) return;
    // 服务端生成报告只会改变完成度，不改写学生 session。先保存最新编辑，
    // 再只刷新 completion，避免用服务端旧快照覆盖浏览器内的新内容。
    await drain();
    const response = await api.classroom.session();
    if (activeIdentity.current !== identityKey) return;
    setCompletion(response.completion);
    setSyncError(null);
  }, [drain, identityKey]);

  return {
    status, session, syncing, syncError, unsynced, completion,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    patchStep: useCallback(<T extends object,>(step: number, patch: Partial<T>) => update((value) => patchStoredStep(value, step, patch)), [update]),
    getShared: useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]),
    updateShared: useCallback(<T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared(value, key, apply)), [update]),
    syncNow, reset, refreshCompletion,
  };
}
