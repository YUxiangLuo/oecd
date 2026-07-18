import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  clearLocal,
  emptySession,
  loadLocal,
  type LocalSessionScope,
  quarantineLegacy,
  readLegacyQuarantine,
  readShared,
  readStep,
  reconcileOnLoad,
  saveLocal,
  writeShared,
  writeStep,
} from "./session-store";
import type { CompletionSummary, ExperimentSession, SessionResponse, SharedSessionKey } from "./types";

/** 同步到服务端的防抖窗口:学生连续调筛选时不必每次都写库。 */
const SYNC_DEBOUNCE_MS = 800;

export type SessionStatus = "loading" | "ready" | "unavailable";

export interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  /** 会话由另一套数据产物生成:其中的结果已不对应当前产物。 */
  stale: boolean;
  /** 被隔离/丢弃的旧记录，仅供用户显式导出，不会进入当前 attempt。 */
  recovery: { source: string; data: unknown }[];
  /** 已截止作业仍可读取可信记录，但禁止任何写入或 reset。 */
  assignmentClosed: boolean;
  dueAt: string | null;
  /**
   * 完成度。**始终来自服务端判定**,客户端不自行计算:
   * 完成的定义只能有一个来源,否则界面和教师统计迟早会各说各话。
   * 教学库不可用时为 null——此时诚实地不显示完成度,而不是猜一个。
   */
  completion: CompletionSummary | null;
  /** 读取某步的实验状态。 */
  getStep: <T>(step: number) => T | undefined;
  /** 写入某步的实验状态(先落本地,再防抖同步)。 */
  setStep: <T>(step: number, data: T) => void;
  /** 在最新一步记录上原子合并字段，避免同一批 React effect 互相覆盖。 */
  patchStep: <T extends object>(step: number, patch: Partial<T>) => void;
  /** 读取跨步骤共享的实验状态。 */
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  /** 写入跨步骤共享的实验状态。 */
  setShared: <T>(key: SharedSessionKey, data: T) => void;
  /** 基于最新共享记录做函数式更新。 */
  updateShared: <T>(key: SharedSessionKey, apply: (current: T | undefined) => T) => void;
  /** 丢弃本地与服务端会话(如产物换代后重新开始)。 */
  reset: () => Promise<void>;
  /** 重新从服务端装载会话与完成度。
   *  服务端也会写会话(如第 16 步生成报告后写入报告证据),
   *  那种改动客户端无从知晓,必须显式重取,否则完成度会停在旧值。 */
  reload: () => void;
}

/**
 * 实验会话:local-first 写入 + 防抖同步 PostgreSQL。
 *
 * 顺序很关键:先写内存与 localStorage(同步、必成功),再异步推服务端。
 * 这样“刷新后还在”不依赖网络是否成功,而服务端仍是跨设备/跨登录的真实来源。
 */
export interface SessionIdentity {
  username: string;
  accountId?: string | number | null;
}

export interface SessionContext {
  manifestId: string;
  courseRunId?: string | number | null;
  assignmentId?: string | number | null;
  attemptId?: string | number | null;
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

/** read_only 可能只是正常截止；只有 stale/legacy/mismatch 才应隔离原 session。 */
export function remoteSessionUntrusted(remote: Pick<SessionResponse, "stale" | "legacy_unverified" | "read_only" | "assignment_closed">): boolean {
  return Boolean(remote.stale || remote.legacy_unverified || (remote.read_only && !remote.assignment_closed));
}

/** Merge against the session passed by React's functional state update, not a render-time snapshot. */
export function patchSessionStep<T extends object>(
  session: ExperimentSession,
  step: number,
  patch: Partial<T>,
): ExperimentSession {
  const current = readStep<T>(session, step);
  return writeStep(session, step, { ...(current ?? {} as T), ...patch });
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
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<ExperimentSession>(() => emptySession(manifestId ?? ""));
  const [stale, setStale] = useState(false);
  const [recovery, setRecovery] = useState<{ source: string; data: unknown }[]>([]);
  const [assignmentClosed, setAssignmentClosed] = useState(false);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  // 记录待同步的会话,避免防抖回调闭包捕获过期的 state。
  const pending = useRef<ExperimentSession | null>(null);

  const push = useCallback(async (next: ExperimentSession) => {
    if (!scope) return;
    try {
      const saved = await api.classroom.saveSession({ base_revision: revision.current, session: next });
      revision.current = saved.revision;
      setCompletion(saved.completion);
      // 服务端做过合并(另一个标签页也写了),以合并结果为准。
      if (saved.merged_from != null) {
        setSession(saved.session);
        if (scope) saveLocal(scope, saved.session);
      }
    } catch {
      // 网络或教学库故障不打断实验:本地已保存,下次改动会重试同步。
    }
  }, [scope?.accountId, scope?.courseRunId, scope?.assignmentId, scope?.attemptId, scope?.manifestId]);

  // 登录后装载:服务端会话与本地会话按记录级时间戳合并。
  useEffect(() => {
    if (!username || !manifestId) return;
    let live = true;
    setStatus("loading");
    setStale(false);
    setRecovery([]);
    setAssignmentClosed(false);
    setDueAt(null);
    api.classroom.session().then(
      (remote) => {
        if (!live) return;
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
        setSession(out.session);
        setStale(remoteUntrusted || out.discardedServer || out.discardedLocal || legacyQuarantined);
        setRecovery(recoverable);
        setAssignmentClosed(Boolean(remote.assignment_closed));
        setDueAt(remote.due_at ?? null);
        setCompletion(remote.completion);
        if (scope) saveLocal(scope, out.session);
        setStatus("ready");
        if (out.needsPush && !remoteUntrusted && !remote.read_only) void push(out.session);
      },
      () => {
        if (!live) return;
        // 教学库不可用:退回纯本地会话,刷新仍能恢复,只是不跨设备。
        const legacyQuarantined = quarantineLegacy(username);
        const legacy = legacyQuarantined ? readLegacyQuarantine(username) : null;
        const local = scope ? loadLocal(scope) : null;
        const usable = local && local.manifest_id === manifestId ? local : emptySession(manifestId);
        setSession(usable);
        setStale(legacyQuarantined);
        setRecovery(legacy == null ? [] : [{ source: "旧版用户名作用域本地记录", data: legacy }]);
        setCompletion(null); // 判定只在服务端;拿不到就不显示,不猜。
        setStatus("unavailable");
      },
    );
    return () => {
      live = false;
    };
  }, [username, manifestId, scope?.accountId, scope?.courseRunId, scope?.assignmentId, scope?.attemptId, scope?.manifestId, push, reloadToken]);

  // 卸载时清掉未触发的防抖定时器。
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  /** 写入 + 立即落本地 + 防抖同步服务端。setStep/setShared 共用。 */
  const update = useCallback(
    (apply: (session: ExperimentSession) => ExperimentSession) => {
      // 没有完整 assignment/attempt 作用域时拒绝写入。App 会同时锁住表单，
      // 这里是最后一道保护，避免界面误挂载时出现“看似保存、实际丢失”。
      if (!username || !manifestId || !scope || assignmentClosed) return;
      setSession((prev) => {
        // 产物换代后不要往旧会话上继续追加,直接从空会话重建。
        const base = prev.manifest_id === manifestId ? prev : emptySession(manifestId);
        const next = apply(base);
        if (scope) saveLocal(scope, next); // 仅稳定全作用域可用时落盘
        pending.current = next;
        return next;
      });
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const next = pending.current;
        pending.current = null;
        if (next) void push(next);
      }, SYNC_DEBOUNCE_MS);
    },
    [username, manifestId, scope?.accountId, scope?.courseRunId, scope?.assignmentId, scope?.attemptId, scope?.manifestId, assignmentClosed, push],
  );

  const setStep = useCallback(
    <T,>(step: number, data: T) => update((s) => writeStep(s, step, data)),
    [update],
  );
  const patchStep = useCallback(
    <T extends object,>(step: number, patch: Partial<T>) => update((s) => patchSessionStep<T>(s, step, patch)),
    [update],
  );
  const setShared = useCallback(
    <T,>(key: SharedSessionKey, data: T) => update((s) => writeShared(s, key, data)),
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
    if (!username || !manifestId) throw new Error("当前没有可重置的学生作业上下文");
    if (assignmentClosed) throw new Error("作业已截止；既有 attempt 只读且不能重新开始");
    // The server creates a new attempt. Never write a fresh session under the
    // old attempt key while that transition is in flight.
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (scope) clearLocal(scope);
    try {
      await api.classroom.clearSession();
      revision.current = 0;
      // App-level meta owns attempt_id; reload is the only atomic way to refresh
      // auth context + meta + session before accepting another local write.
      window.location.reload();
    } catch (cause) {
      setStatus("unavailable");
      setCompletion(null);
      throw cause;
    }
  }, [username, manifestId, scope?.accountId, scope?.courseRunId, scope?.assignmentId, scope?.attemptId, scope?.manifestId, assignmentClosed]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    status,
    session,
    stale,
    recovery,
    assignmentClosed,
    dueAt,
    completion,
    getStep,
    setStep,
    patchStep,
    getShared,
    setShared,
    updateShared,
    reset,
    reload,
  };
}
