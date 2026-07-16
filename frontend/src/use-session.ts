import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  clearLocal,
  emptySession,
  loadLocal,
  readShared,
  readStep,
  reconcileOnLoad,
  saveLocal,
  writeShared,
  writeStep,
} from "./session-store";
import type { CompletionSummary, ExperimentSession, SharedSessionKey } from "./types";

/** 同步到服务端的防抖窗口:学生连续调筛选时不必每次都写库。 */
const SYNC_DEBOUNCE_MS = 800;

export type SessionStatus = "loading" | "ready" | "unavailable";

export interface SessionApi {
  status: SessionStatus;
  session: ExperimentSession;
  /** 会话由另一套数据产物生成:其中的结果已不对应当前产物。 */
  stale: boolean;
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
  /** 读取跨步骤共享的实验状态。 */
  getShared: <T>(key: SharedSessionKey) => T | undefined;
  /** 写入跨步骤共享的实验状态。 */
  setShared: <T>(key: SharedSessionKey, data: T) => void;
  /** 丢弃本地与服务端会话(如产物换代后重新开始)。 */
  reset: () => void;
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
export function useSession(username: string | null, manifestId: string | null): SessionApi {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<ExperimentSession>(() => emptySession(manifestId ?? ""));
  const [stale, setStale] = useState(false);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const revision = useRef(0);
  const timer = useRef<number | null>(null);
  // 记录待同步的会话,避免防抖回调闭包捕获过期的 state。
  const pending = useRef<ExperimentSession | null>(null);

  const push = useCallback(async (next: ExperimentSession, user: string) => {
    try {
      const saved = await api.classroom.saveSession({ base_revision: revision.current, session: next });
      revision.current = saved.revision;
      setCompletion(saved.completion);
      // 服务端做过合并(另一个标签页也写了),以合并结果为准。
      if (saved.merged_from != null) {
        setSession(saved.session);
        saveLocal(user, saved.session);
      }
    } catch {
      // 网络或教学库故障不打断实验:本地已保存,下次改动会重试同步。
    }
  }, []);

  // 登录后装载:服务端会话与本地会话按记录级时间戳合并。
  useEffect(() => {
    if (!username || !manifestId) return;
    let live = true;
    setStatus("loading");
    api.classroom.session().then(
      (remote) => {
        if (!live) return;
        const local = loadLocal(username);
        const out = reconcileOnLoad(local, remote.session, manifestId);
        revision.current = remote.revision;
        setSession(out.session);
        setStale(out.discardedServer || out.discardedLocal);
        setCompletion(remote.completion);
        saveLocal(username, out.session);
        setStatus("ready");
        if (out.needsPush) void push(out.session, username);
      },
      () => {
        if (!live) return;
        // 教学库不可用:退回纯本地会话,刷新仍能恢复,只是不跨设备。
        const local = loadLocal(username);
        const usable = local && local.manifest_id === manifestId ? local : emptySession(manifestId);
        setSession(usable);
        setCompletion(null); // 判定只在服务端;拿不到就不显示,不猜。
        setStatus("unavailable");
      },
    );
    return () => {
      live = false;
    };
  }, [username, manifestId, push, reloadToken]);

  // 卸载时清掉未触发的防抖定时器。
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  /** 写入 + 立即落本地 + 防抖同步服务端。setStep/setShared 共用。 */
  const update = useCallback(
    (apply: (session: ExperimentSession) => ExperimentSession) => {
      if (!username || !manifestId) return;
      setSession((prev) => {
        // 产物换代后不要往旧会话上继续追加,直接从空会话重建。
        const base = prev.manifest_id === manifestId ? prev : emptySession(manifestId);
        const next = apply(base);
        saveLocal(username, next); // 同步落盘:刷新后必定还在
        pending.current = next;
        return next;
      });
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const next = pending.current;
        pending.current = null;
        if (next) void push(next, username);
      }, SYNC_DEBOUNCE_MS);
    },
    [username, manifestId, push],
  );

  const setStep = useCallback(
    <T,>(step: number, data: T) => update((s) => writeStep(s, step, data)),
    [update],
  );
  const setShared = useCallback(
    <T,>(key: SharedSessionKey, data: T) => update((s) => writeShared(s, key, data)),
    [update],
  );

  const getStep = useCallback(<T,>(step: number) => readStep<T>(session, step), [session]);
  const getShared = useCallback(<T,>(key: SharedSessionKey) => readShared<T>(session, key), [session]);

  const reset = useCallback(() => {
    if (!username || !manifestId) return;
    const fresh = emptySession(manifestId);
    setSession(fresh);
    setStale(false);
    setCompletion(null);
    clearLocal(username);
    api.classroom.clearSession().catch(() => {});
    revision.current = 0;
  }, [username, manifestId]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { status, session, stale, completion, getStep, setStep, getShared, setShared, reset, reload };
}
