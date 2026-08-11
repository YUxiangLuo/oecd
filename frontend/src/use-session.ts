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
  reload: () => void;
}

interface SessionIdentity { username: string; accountId?: string | number | null }

interface SaveQueueCallbacks {
  onSaved: (response: SessionResponse) => void;
  onError: (cause: unknown) => void;
  onSyncing: (value: boolean) => void;
  onUnsynced: (value: boolean) => void;
}

interface SaveOperation {
  identity: string;
  promise: Promise<void>;
}

/** One last-write-wins save queue whose in-flight operation is scoped to an account. */
export class AccountSessionSaveQueue {
  private activeIdentity: string | null = null;
  private pending: ExperimentSession | null = null;
  private saving: SaveOperation | null = null;

  constructor(
    private readonly save: (session: ExperimentSession) => Promise<SessionResponse>,
    private readonly callbacks: SaveQueueCallbacks,
  ) {}

  activate(identity: string | null) {
    const identityChanged = this.activeIdentity !== identity;
    this.activeIdentity = identity;
    this.pending = null;
    if (identityChanged) {
      // The old request may still finish, but it no longer owns the active account's queue.
      this.saving = null;
      this.callbacks.onSyncing(false);
    }
    this.callbacks.onUnsynced(false);
  }

  enqueue(session: ExperimentSession) {
    if (this.activeIdentity === null) return;
    this.pending = session;
    this.callbacks.onUnsynced(true);
  }

  discardPending() {
    this.pending = null;
    this.callbacks.onUnsynced(false);
  }

  drain(requestedIdentity: string | null = this.activeIdentity): Promise<void> {
    if (requestedIdentity === null || this.activeIdentity !== requestedIdentity) return Promise.resolve();
    if (this.saving?.identity === requestedIdentity) return this.saving.promise;

    let run!: Promise<void>;
    run = (async () => {
      this.callbacks.onSyncing(true);
      try {
        while (this.pending && this.activeIdentity === requestedIdentity) {
          const next = this.pending;
          this.pending = null;
          try {
            const response = await this.save(next);
            if (this.activeIdentity !== requestedIdentity) return;
            this.callbacks.onSaved(response);
          } catch (cause) {
            if (this.activeIdentity !== requestedIdentity) return;
            this.pending ??= next;
            this.callbacks.onError(cause);
            throw cause;
          }
        }
      } finally {
        if (this.activeIdentity === requestedIdentity) {
          this.callbacks.onSyncing(false);
          this.callbacks.onUnsynced(Boolean(this.pending));
        }
        if (this.saving?.promise === run) this.saving = null;
      }
    })();
    this.saving = { identity: requestedIdentity, promise: run };
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
  const [reloadToken, setReloadToken] = useState(0);
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
    api.classroom.session().then(
      (response) => {
        if (activeIdentity.current !== requestedIdentity) return;
        replace(response.session);
        setCompletion(response.completion);
        setStatus("ready");
      },
      (cause) => {
        if (activeIdentity.current !== requestedIdentity) return;
        setSyncError(cause instanceof Error ? cause.message : String(cause));
        setStatus("unavailable");
      },
    );
  }, [identityKey, reloadToken, replace]);

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

  return {
    status, session, syncing, syncError, unsynced, completion,
    getStep: useCallback(<T,>(step: number) => readStep<T>(session, step), [session]),
    patchStep: useCallback(<T extends object,>(step: number, patch: Partial<T>) => update((value) => patchStoredStep(value, step, patch)), [update]),
    getShared: useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]),
    updateShared: useCallback(<T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared(value, key, apply)), [update]),
    syncNow, reset, reload: useCallback(() => setReloadToken((value) => value + 1), []),
  };
}
