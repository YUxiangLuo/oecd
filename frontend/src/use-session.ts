import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import {
  clearLocal,
  emptySession,
  loadLocal,
  mergeSessions,
  patchStep as patchStoredStep,
  type LocalSessionScope,
  readShared,
  readStep,
  reconcileOnLoad,
  saveLocal,
  writeShared,
} from "./session-store";
import type { CompletionSummary, ExperimentSession, SessionResponse, SharedSessionKey } from "./types";

const SYNC_DEBOUNCE_MS = 800;

export type SessionStatus = "loading" | "ready" | "unavailable";

interface SessionApi {
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

interface SessionIdentity {
  username: string;
  accountId?: string | number | null;
}

interface SessionContext {
  manifestId: string;
}

interface ScopedSessionWrite {
  scopeKey: string;
  generation: number;
  session: ExperimentSession;
}

interface ActiveDrain {
  scopeKey: string;
  generation: number;
  promise: Promise<void>;
}

function readPending(ref: { current: ScopedSessionWrite | null }): ScopedSessionWrite | null {
  return ref.current;
}

/** 本地实验数据严格按稳定账号 ID 与 manifest 隔离。 */
export function sessionScope(identity: SessionIdentity | null, context: SessionContext | null): LocalSessionScope | null {
  if (identity?.accountId == null || !context?.manifestId) return null;
  return { accountId: identity.accountId, manifestId: context.manifestId };
}

export function sessionScopeKey(scope: LocalSessionScope | null): string | null {
  return scope ? JSON.stringify([scope.accountId, scope.manifestId].map(String)) : null;
}

export function patchSessionStep<T extends object>(
  session: ExperimentSession,
  step: number,
  patch: Partial<T>,
): ExperimentSession {
  return patchStoredStep(session, step, patch);
}

export function updateSessionShared<T>(
  session: ExperimentSession,
  key: SharedSessionKey,
  apply: (current: T | undefined) => T,
): ExperimentSession {
  return writeShared(session, key, apply(readShared<T>(session, key)));
}

export function useSession(identity: SessionIdentity | null, context: SessionContext | null): SessionApi {
  const username = identity?.username ?? null;
  const manifestId = context?.manifestId ?? null;
  const scope = useMemo(
    () => sessionScope(identity, context),
    [identity?.accountId, context?.manifestId],
  );
  const scopeKey = sessionScopeKey(scope);
  const initialStatus: SessionStatus = scopeKey ? "loading" : "unavailable";
  const [status, setStatus] = useState<SessionStatus>(initialStatus);
  const statusRef = useRef<SessionStatus>(initialStatus);
  const [session, setSession] = useState<ExperimentSession>(() => emptySession(manifestId ?? ""));
  const sessionRef = useRef(session);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  const scopeKeyRef = useRef(scopeKey);
  const scopeGeneration = useRef(0);
  const pending = useRef<ScopedSessionWrite | null>(null);
  const activeDrain = useRef<ActiveDrain | null>(null);
  const resetInProgress = useRef(false);
  const drainRef = useRef<() => Promise<void>>(async () => {});

  const updateStatus = useCallback((next: SessionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const replaceSession = useCallback((next: ExperimentSession) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const tokenIsCurrent = useCallback(
    (key: string | null, generation: number) => scopeKeyRef.current === key && scopeGeneration.current === generation,
    [],
  );

  useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeGeneration.current += 1;
    scopeKeyRef.current = scopeKey;
    resetInProgress.current = false;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    activeDrain.current = null;
    revision.current = 0;
    replaceSession(emptySession(manifestId ?? ""));
    updateStatus(scopeKey ? "loading" : "unavailable");
    setCompletion(null);
    setSyncing(false);
    setSyncError(null);
    setUnsynced(false);
  }, [scopeKey, manifestId, replaceSession, updateStatus]);

  const drain = useCallback((): Promise<void> => {
    if (!scope || !scopeKey || scopeKeyRef.current !== scopeKey || resetInProgress.current) {
      return Promise.resolve();
    }
    const generation = scopeGeneration.current;
    const running = activeDrain.current;
    if (running?.scopeKey === scopeKey && running.generation === generation) return running.promise;
    const queued = pending.current;
    if (!queued || queued.scopeKey !== scopeKey || queued.generation !== generation) return Promise.resolve();

    const active = { scopeKey, generation } as ActiveDrain;
    activeDrain.current = active;
    active.promise = (async () => {
      if (tokenIsCurrent(scopeKey, generation)) setSyncing(true);
      try {
        while (tokenIsCurrent(scopeKey, generation)) {
          const next = pending.current;
          if (!next || next.scopeKey !== scopeKey || next.generation !== generation) break;
          pending.current = null;
          let saved: SessionResponse;
          try {
            saved = await api.classroom.saveSession({
              base_revision: revision.current,
              session: next.session,
            });
          } catch (cause) {
            if (!tokenIsCurrent(scopeKey, generation)) return;
            const latest = readPending(pending);
            if (!latest || latest.scopeKey !== scopeKey || latest.generation !== generation) pending.current = next;
            const error = cause instanceof Error ? cause : new Error(String(cause));
            setSyncError(error.message);
            setUnsynced(true);
            throw error;
          }

          if (!tokenIsCurrent(scopeKey, generation)) return;
          revision.current = saved.revision;
          setCompletion(saved.completion);
          setSyncError(null);
          if (saved.merged_from != null) {
            const latest = readPending(pending);
            const latestForScope = latest?.scopeKey === scopeKey && latest.generation === generation ? latest : null;
            const reconciled = latestForScope ? mergeSessions(saved.session, latestForScope.session) : saved.session;
            if (latestForScope) pending.current = { ...latestForScope, session: reconciled };
            replaceSession(reconciled);
            saveLocal(scope, reconciled);
          }
        }
      } finally {
        if (activeDrain.current === active) activeDrain.current = null;
        if (tokenIsCurrent(scopeKey, generation)) {
          const latest = pending.current;
          setSyncing(false);
          setUnsynced(Boolean(latest && latest.scopeKey === scopeKey && latest.generation === generation));
        }
      }
    })();
    return active.promise;
  }, [scope, scopeKey, replaceSession, tokenIsCurrent]);
  drainRef.current = drain;

  useEffect(() => {
    if (!username || !manifestId || !scope || !scopeKey) return;
    let live = true;
    const loadScopeKey = scopeKey;
    const loadGeneration = scopeGeneration.current;
    const loadIsCurrent = () => live && !resetInProgress.current && tokenIsCurrent(loadScopeKey, loadGeneration);
    updateStatus("loading");
    api.classroom.session().then(
      (remote) => {
        if (!loadIsCurrent()) return;
        const local = loadLocal(scope);
        const out = reconcileOnLoad(local, remote.session, manifestId);
        revision.current = remote.revision;
        replaceSession(out.session);
        setCompletion(remote.completion);
        saveLocal(scope, out.session);
        updateStatus("ready");
        if (out.needsPush) {
          pending.current = { scopeKey, generation: loadGeneration, session: out.session };
          setUnsynced(true);
          void drainRef.current().catch(() => {});
        }
      },
      () => {
        if (!loadIsCurrent()) return;
        const local = loadLocal(scope);
        replaceSession(local?.manifest_id === manifestId ? local : emptySession(manifestId));
        setCompletion(null);
        updateStatus("unavailable");
      },
    );
    return () => { live = false; };
  }, [username, manifestId, scope, scopeKey, replaceSession, reloadToken, tokenIsCurrent, updateStatus]);

  useLayoutEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    scopeGeneration.current += 1;
    pending.current = null;
    activeDrain.current = null;
  }, []);

  const update = useCallback((apply: (value: ExperimentSession) => ExperimentSession) => {
    if (!username || !manifestId || !scope || !scopeKey || scopeKeyRef.current !== scopeKey || resetInProgress.current) return;
    const generation = scopeGeneration.current;
    const base = sessionRef.current.manifest_id === manifestId ? sessionRef.current : emptySession(manifestId);
    const next = apply(base);
    replaceSession(next);
    saveLocal(scope, next);
    pending.current = { scopeKey, generation, session: next };
    setUnsynced(true);
    setSyncError(null);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void drainRef.current().catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  }, [username, manifestId, scope, scopeKey, replaceSession]);

  const syncNow = useCallback((): Promise<void> => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (statusRef.current !== "ready") {
      return Promise.reject(new Error(statusRef.current === "loading" ? "实验记录仍在恢复，请稍候" : "当前无法连接教学服务，不能确认实验记录已保存"));
    }
    return drainRef.current();
  }, []);

  const patchStep = useCallback(
    <T extends object,>(step: number, patch: Partial<T>) => update((value) => patchSessionStep<T>(value, step, patch)),
    [update],
  );
  const updateShared = useCallback(
    <T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) => update((value) => updateSessionShared<T>(value, key, apply)),
    [update],
  );
  const getStep = useCallback(<T,>(step: number) => readStep<T>(session, step), [session]);
  const getShared = useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]);

  const reset = useCallback(async () => {
    if (!username || !manifestId || !scope) throw new Error("当前没有可清空的实验工作区");
    resetInProgress.current = true;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const oldDrain = activeDrain.current?.promise;
    scopeGeneration.current += 1;
    pending.current = null;
    activeDrain.current = null;
    setUnsynced(false);
    setSyncing(false);
    setSyncError(null);
    try {
      await oldDrain?.catch(() => {});
      await api.classroom.resetWorkspace({ manifest_id: manifestId, confirmation: "清空当前实验" });
      clearLocal(scope);
      revision.current = 0;
      window.location.reload();
    } catch (cause) {
      resetInProgress.current = false;
      updateStatus("unavailable");
      setCompletion(null);
      throw cause;
    }
  }, [username, manifestId, scope, updateStatus]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  return {
    status,
    session,
    syncing,
    syncError,
    unsynced,
    completion,
    getStep,
    patchStep,
    getShared,
    updateShared,
    syncNow,
    reset,
    reload,
  };
}
