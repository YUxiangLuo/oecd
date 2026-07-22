import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  clearLocal,
  emptySession,
  loadLocal,
  mergeSessions,
  patchStep as patchStoredStep,
  type LocalSessionScope,
  quarantineLegacy,
  readLegacyQuarantine,
  readShared,
  readStep,
  reconcileOnLoad,
  saveLocal,
  writeShared,
} from "./session-store";
import type { CompletionSummary, ExperimentSession, SessionResponse, SharedSessionKey } from "./types";

/** 同步到服务端的防抖窗口:学生连续调筛选时不必每次都写库。 */
const SYNC_DEBOUNCE_MS = 800;

export type SessionStatus = "loading" | "ready" | "unavailable";

interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  /** 会话由另一套数据产物生成:其中的结果已不对应当前产物。 */
  stale: boolean;
  /** 被隔离/丢弃的旧记录，仅供用户显式导出，不会进入当前 attempt。 */
  recovery: { source: string; data: unknown }[];
  /** 已截止作业仍可读取可信记录，但禁止任何写入或 reset。 */
  assignmentClosed: boolean;
  /** 已停用/归档课程中有 attempt 的作业，仅供追溯。 */
  assignmentHistorical: boolean;
  dueAt: string | null;
  /** 本地会话正在写入服务端。理解检查会绕过普通防抖并立即触发同步。 */
  syncing: boolean;
  /** 最近一次服务端同步失败；本地记录仍保留，可显式重试。 */
  syncError: string | null;
  /** 当前 scope 仍有未被服务端确认的本地改动（含排队中和在途写入）。 */
  unsynced: boolean;
  /**
   * 完成度。**始终来自服务端判定**,客户端不自行计算:
   * 完成的定义只能有一个来源,否则界面和教师统计迟早会各说各话。
   * 教学库不可用时为 null——此时诚实地不显示完成度,而不是猜一个。
   */
  completion: CompletionSummary | null;
  /** 读取某步的实验状态。 */
  getStep: <T>(step: number) => T | undefined;
  /** 在最新一步记录上原子合并字段，避免同一批 React effect 互相覆盖。 */
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  /** 读取跨步骤共享的实验状态。 */
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  /** 基于最新共享记录做函数式更新。 */
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  /** 发送并等待当前 scope 的全部待同步会话；失败时 reject，且本地记录仍保留。 */
  syncNow: () => Promise<void>;
  /** 丢弃本地与服务端会话(如产物换代后重新开始)。 */
  reset: () => Promise<void>;
  /** 重新从服务端装载会话与完成度。
   *  服务端也会写会话(如第 16 步生成报告后写入报告记录),
   *  那种改动客户端无从知晓,必须显式重取,否则完成度会停在旧值。 */
  reload: () => void;
}

/**
 * 实验会话:local-first 写入 + 防抖同步 PostgreSQL。
 *
 * 顺序很关键:先写内存与 localStorage(同步、必成功),再异步推服务端。
 * 这样“刷新后还在”不依赖网络是否成功,而服务端仍是跨设备/跨登录的真实来源。
 */
interface SessionIdentity {
  username: string;
  accountId?: string | number | null;
}

interface SessionContext {
  manifestId: string;
  courseRunId?: string | number | null;
  assignmentId?: string | number | null;
  attemptId?: string | number | null;
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

// Async code outside the current closure can enqueue while a request is in flight.
// Reading through a helper prevents TypeScript from incorrectly keeping the earlier
// `pending.current = null` narrowing across an `await`.
function readPending(ref: { current: ScopedSessionWrite | null }): ScopedSessionWrite | null {
  return ref.current;
}

/** Fail closed: username or manifest alone cannot prove which class run owns a cache. */
export function sessionScope(identity: SessionIdentity | null, context: SessionContext | null): LocalSessionScope | null {
  if (!identity?.accountId || !context?.courseRunId || !context?.assignmentId || !context?.attemptId || !context.manifestId) return null;
  return {
    accountId: identity.accountId,
    courseRunId: context.courseRunId,
    assignmentId: context.assignmentId,
    attemptId: context.attemptId,
    manifestId: context.manifestId,
  };
}

/** Stable identity for an account/course/assignment/attempt/artifact cache boundary. */
export function sessionScopeKey(scope: LocalSessionScope | null): string | null {
  return scope
    ? JSON.stringify([
      scope.accountId,
      scope.courseRunId,
      scope.assignmentId,
      scope.attemptId,
      scope.manifestId,
    ].map(String))
    : null;
}

/** read_only 可能是正常截止/历史查看；只有 stale/legacy/mismatch 才应隔离原 session。 */
export function remoteSessionUntrusted(remote: Pick<
  SessionResponse,
  "stale" | "legacy_unverified" | "read_only" | "assignment_closed" | "assignment_historical"
>): boolean {
  return Boolean(
    remote.stale
    || remote.legacy_unverified
    || (remote.read_only && !remote.assignment_closed && !remote.assignment_historical)
  );
}

/** Merge against the session passed by React's functional state update, not a render-time snapshot. */
export function patchSessionStep<T extends object>(
  session: ExperimentSession,
  step: number,
  patch: Partial<T>,
): ExperimentSession {
  return patchStoredStep(session, step, patch);
}

/** Apply shared-state updates against the newest functional state for the same reason. */
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
  const scope = sessionScope(identity, context);
  const scopeKey = sessionScopeKey(scope);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const statusRef = useRef<SessionStatus>("loading");
  const [session, setSession] = useState<ExperimentSession>(() => emptySession(manifestId ?? ""));
  const sessionRef = useRef(session);
  const [stale, setStale] = useState(false);
  const [recovery, setRecovery] = useState<{ source: string; data: unknown }[]>([]);
  const [assignmentClosed, setAssignmentClosed] = useState(false);
  const [assignmentHistorical, setAssignmentHistorical] = useState(false);
  const assignmentReadOnly = assignmentClosed || assignmentHistorical;
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  // 每个排队项和在途请求都绑定稳定 scope + 单调代次；同一 manifest 也不能跨
  // 账号/assignment/attempt 复用。scope 改变后旧响应只能自然结束，不能再改状态。
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

  // 在浏览器可交互前切断旧 scope：清队列、清错误、重置 revision，并让所有旧
  // Promise 的后续回调因 generation 不匹配而静默失效。
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
    updateStatus("loading");
    setStale(false);
    setRecovery([]);
    setAssignmentClosed(false);
    setAssignmentHistorical(false);
    setDueAt(null);
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
              expected_assignment_id: scope.assignmentId,
              expected_attempt_id: scope.attemptId,
              session: next.session,
            });
          } catch (cause) {
            if (!tokenIsCurrent(scopeKey, generation)) return;
            // 新改动基于同一份最新本地会话，已经包含本次内容；否则把失败快照放回队列。
            const latest = readPending(pending);
            if (!latest || latest.scopeKey !== scopeKey || latest.generation !== generation) {
              pending.current = next;
            }
            const error = cause instanceof Error ? cause : new Error(String(cause));
            setSyncError(error.message);
            setUnsynced(true);
            throw error;
          }

          if (!tokenIsCurrent(scopeKey, generation)) return;
          revision.current = saved.revision;
          setCompletion(saved.completion);
          setSyncError(null);
          // 服务端做过合并(另一个标签页也写了),以合并结果为准；若本地又有新改动，
          // 把它逐字段叠在服务端结果上，再继续本轮 drain。
          if (saved.merged_from != null) {
            const latest = readPending(pending);
            const latestForScope = latest?.scopeKey === scopeKey && latest.generation === generation ? latest : null;
            const reconciled = latestForScope
              ? mergeSessions(saved.session, latestForScope.session)
              : saved.session;
            if (latestForScope) pending.current = { ...latestForScope, session: reconciled };
            replaceSession(reconciled);
            saveLocal(scope, reconciled);
          }
        }
      } finally {
        if (activeDrain.current === active) activeDrain.current = null;
        if (tokenIsCurrent(scopeKey, generation)) {
          const latest = pending.current;
          const stillUnsynced = Boolean(
            latest && latest.scopeKey === scopeKey && latest.generation === generation,
          );
          setSyncing(false);
          setUnsynced(stillUnsynced);
        }
      }
    })();
    return active.promise;
  }, [scopeKey, replaceSession, tokenIsCurrent]);
  drainRef.current = drain;

  // 登录后装载:服务端会话与本地会话按记录级/字段级时间戳合并。
  useEffect(() => {
    if (!username || !manifestId) return;
    let live = true;
    const loadScopeKey = scopeKey;
    const loadGeneration = scopeGeneration.current;
    const loadIsCurrent = () => live
      && !resetInProgress.current
      && tokenIsCurrent(loadScopeKey, loadGeneration);
    updateStatus("loading");
    setStale(false);
    setRecovery([]);
    setAssignmentClosed(false);
    setAssignmentHistorical(false);
    setDueAt(null);
    api.classroom.session().then(
      (remote) => {
        if (!loadIsCurrent()) return;
        const legacyQuarantined = quarantineLegacy(username);
        const legacy = legacyQuarantined ? readLegacyQuarantine(username) : null;
        const local = scope ? loadLocal(scope) : null;
        // 服务端比客户端更清楚记录是否来自 legacy/只读 attempt；即使其中的
        // manifest 字符串碰巧相同，也必须按不可信旧记录隔离。
        const remoteUntrusted = remoteSessionUntrusted(remote);
        const out = reconcileOnLoad(local, remote.session, manifestId, remoteUntrusted);
        const recoverable: { source: string; data: unknown }[] = [];
        if (legacy != null) recoverable.push({ source: "旧版用户名作用域本地记录", data: legacy });
        if (out.discardedLocal && local) recoverable.push({ source: "旧数据版本本地记录", data: local });
        if (out.discardedServer) recoverable.push({ source: "旧 attempt 服务端记录", data: remote.session });
        revision.current = remote.revision;
        replaceSession(out.session);
        setStale(remoteUntrusted || out.discardedServer || out.discardedLocal || legacyQuarantined);
        setRecovery(recoverable);
        setAssignmentClosed(Boolean(remote.assignment_closed));
        setAssignmentHistorical(Boolean(remote.assignment_historical));
        setDueAt(remote.due_at ?? null);
        setCompletion(remote.completion);
        if (scope) saveLocal(scope, out.session);
        updateStatus("ready");
        if (scopeKey && out.needsPush && !remoteUntrusted && !remote.read_only) {
          pending.current = { scopeKey, generation: loadGeneration, session: out.session };
          setUnsynced(true);
          void drainRef.current().catch(() => {});
        }
      },
      () => {
        if (!loadIsCurrent()) return;
        // 教学库不可用:退回纯本地会话,刷新仍能恢复,只是不跨设备。
        const legacyQuarantined = quarantineLegacy(username);
        const legacy = legacyQuarantined ? readLegacyQuarantine(username) : null;
        const local = scope ? loadLocal(scope) : null;
        const usable = local && local.manifest_id === manifestId ? local : emptySession(manifestId);
        replaceSession(usable);
        setStale(legacyQuarantined);
        setRecovery(legacy == null ? [] : [{ source: "旧版用户名作用域本地记录", data: legacy }]);
        setCompletion(null); // 判定只在服务端;拿不到就不显示,不猜。
        updateStatus("unavailable");
      },
    );
    return () => {
      live = false;
    };
  }, [username, manifestId, scopeKey, replaceSession, reloadToken, tokenIsCurrent, updateStatus]);

  // 卸载时清掉定时器并让在途回调失效；网络请求可以自然结束，但不能再改状态。
  // React Strict Mode 会在开发环境模拟一次 layout-effect 卸载/重挂载：只推进
  // generation，不清 scopeKeyRef，这样重挂载后的 load 能用新 generation 正常工作。
  useLayoutEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    scopeGeneration.current += 1;
    pending.current = null;
    activeDrain.current = null;
  }, []);

  /** 写入 + 立即落本地 + 防抖同步服务端。 */
  const update = useCallback(
    (apply: (session: ExperimentSession) => ExperimentSession) => {
      // 没有完整 assignment/attempt 作用域时拒绝写入。App 会同时锁住表单，
      // 这里是最后一道保护，避免界面误挂载时出现“看似保存、实际丢失”。
      if (
        !username
        || !manifestId
        || !scope
        || !scopeKey
        || scopeKeyRef.current !== scopeKey
        || assignmentReadOnly
        || resetInProgress.current
      ) return;
      const generation = scopeGeneration.current;
      // ref 在同一批 React 更新中也会立即推进，连续 patch 不会读到上一次 render 的旧值。
      const current = sessionRef.current;
      // 产物换代后不要往旧会话上继续追加,直接从空会话重建。
      const base = current.manifest_id === manifestId ? current : emptySession(manifestId);
      const next = apply(base);
      replaceSession(next);
      saveLocal(scope, next); // 仅稳定全作用域可用时落盘
      pending.current = { scopeKey, generation, session: next };
      setUnsynced(true);
      setSyncError(null);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void drainRef.current().catch(() => {});
      }, SYNC_DEBOUNCE_MS);
    },
    [username, manifestId, scopeKey, assignmentReadOnly, replaceSession],
  );

  const syncNow = useCallback((): Promise<void> => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    if (statusRef.current !== "ready") {
      return Promise.reject(new Error(
        statusRef.current === "loading"
          ? "实验记录仍在恢复，请稍候"
          : "当前无法连接教学服务，不能确认实验记录已保存",
      ));
    }
    return drainRef.current();
  }, []);

  const patchStep = useCallback(
    <T extends object,>(step: number, patch: Partial<T>) => update((s) => patchSessionStep<T>(s, step, patch)),
    [update],
  );
  const updateShared = useCallback(
    <T,>(key: SharedSessionKey, apply: (current: T | undefined) => T) =>
      update((s) => updateSessionShared<T>(s, key, apply)),
    [update],
  );

  const getStep = useCallback(<T,>(step: number) => readStep<T>(session, step), [session]);
  const getShared = useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]);

  const reset = useCallback(async () => {
    if (!username || !manifestId || !scope) throw new Error("当前没有可重置的学生作业上下文");
    if (assignmentReadOnly) throw new Error("作业为截止或历史只读状态；既有 attempt 不能重新开始");
    // 先让旧 scope 的在途请求自然结束，再让服务端创建新 attempt。否则一个已经
    // 发出的旧 PUT 可能在 reset 之后才抵达，并被服务端解析到新 attempt。
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
    if (scope) clearLocal(scope);
    try {
      await oldDrain?.catch(() => {});
      await api.classroom.clearSession({
        expected_assignment_id: scope.assignmentId,
        expected_attempt_id: scope.attemptId,
      });
      revision.current = 0;
      // App-level meta owns attempt_id; reload is the only atomic way to refresh
      // auth context + meta + session before accepting another local write.
      window.location.reload();
    } catch (cause) {
      resetInProgress.current = false;
      updateStatus("unavailable");
      setCompletion(null);
      throw cause;
    }
  }, [username, manifestId, scopeKey, assignmentReadOnly, updateStatus]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    status,
    session,
    stale,
    recovery,
    assignmentClosed,
    assignmentHistorical,
    dueAt,
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
