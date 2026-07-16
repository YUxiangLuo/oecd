import { SESSION_VERSION, type ExperimentSession, type SessionRecord, type SharedSessionKey } from "./types";

const SHARED_KEYS: readonly SharedSessionKey[] = ["regression_settings", "regression_history"];

/** 实验会话的客户端存储:local-first + 与服务端按记录级时间戳合并。
 *
 * local-first 的理由:学生每改一个筛选就打一次网络请求既慢又脆弱,
 * 而“刷新后还在”必须是确定的。因此改动先落 localStorage(同步、必成功),
 * 再防抖同步到 PostgreSQL;网络失败不影响本地实验继续。
 *
 * 合并规则与服务端 gvcsim/session.py 完全一致:按步骤取较新的记录。
 * 两边必须同规则,否则同一份并发写入在客户端与服务端会得到不同结果。
 */

const LOCAL_KEY_PREFIX = "gvcsim_session:";

export const localKey = (username: string) => `${LOCAL_KEY_PREFIX}${username}`;

export function emptySession(manifestId: string): ExperimentSession {
  return { version: SESSION_VERSION, manifest_id: manifestId, steps: {}, shared: {} };
}

export function makeRecord<T>(data: T, updatedAt?: string): SessionRecord<T> {
  return { data, updated_at: updatedAt ?? new Date().toISOString() };
}

/** 结构性校验:localStorage 可能被手改或残留旧版本,读到坏数据宁可丢弃。 */
export function isValidSession(value: unknown): value is ExperimentSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<ExperimentSession>;
  if (s.version !== SESSION_VERSION) return false;
  if (typeof s.manifest_id !== "string" || !s.manifest_id) return false;
  if (typeof s.steps !== "object" || s.steps === null) return false;
  if (typeof s.shared !== "object" || s.shared === null) return false;
  const validRecord = (record: unknown) =>
    typeof record === "object" && record !== null
    && "data" in record && typeof (record as SessionRecord).updated_at === "string";
  const stepsOk = Object.entries(s.steps).every(([key, record]) => {
    const n = Number(key);
    return Number.isInteger(n) && n >= 1 && n <= 16 && validRecord(record);
  });
  const sharedOk = Object.entries(s.shared).every(
    ([key, record]) => SHARED_KEYS.includes(key as SharedSessionKey) && validRecord(record),
  );
  return stepsOk && sharedOk;
}

export function loadLocal(username: string): ExperimentSession | null {
  try {
    const raw = localStorage.getItem(localKey(username));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLocal(username: string, session: ExperimentSession): void {
  try {
    localStorage.setItem(localKey(username), JSON.stringify(session));
  } catch {
    // 配额满或隐私模式:本地缓存失败不应打断实验,服务端仍是真实来源。
  }
}

export function clearLocal(username: string): void {
  try {
    localStorage.removeItem(localKey(username));
  } catch {
    /* 同上 */
  }
}

/** 按记录取较新的一份;时间戳相同则取 incoming。与服务端同规则。 */
function mergeSlot<T extends Record<string, SessionRecord | undefined>>(base: T, incoming: T): T {
  const out: Record<string, SessionRecord | undefined> = { ...base };
  for (const [key, record] of Object.entries(incoming)) {
    const current = out[key];
    if (record && (!current || record.updated_at >= current.updated_at)) out[key] = record;
  }
  return out as T;
}

export function mergeSessions(base: ExperimentSession, incoming: ExperimentSession): ExperimentSession {
  return {
    version: SESSION_VERSION,
    manifest_id: incoming.manifest_id,
    steps: mergeSlot(base.steps, incoming.steps),
    shared: mergeSlot(base.shared, incoming.shared),
  };
}

export function readStep<T>(session: ExperimentSession, step: number): T | undefined {
  return session.steps[String(step)]?.data as T | undefined;
}

export function writeStep<T>(session: ExperimentSession, step: number, data: T): ExperimentSession {
  return {
    ...session,
    steps: { ...session.steps, [String(step)]: makeRecord(data) },
  };
}

export function readShared<T>(session: ExperimentSession, key: SharedSessionKey): T | undefined {
  return session.shared[key]?.data as T | undefined;
}

export function writeShared<T>(session: ExperimentSession, key: SharedSessionKey, data: T): ExperimentSession {
  return {
    ...session,
    shared: { ...session.shared, [key]: makeRecord(data) },
  };
}

/** 会话是否由另一套数据产物生成(其中的结果已不对应当前产物)。 */
export function isStale(session: ExperimentSession, manifestId: string): boolean {
  return session.manifest_id !== manifestId;
}

/**
 * 决定登录时如何把本地会话与服务端会话合起来。
 *
 * 任一侧属于旧产物就整体丢弃该侧:混用两套产物的结果比丢掉实验更危险——
 * 学生会拿着一份看不出问题、却由不同数据算出来的记录继续往下做。
 */
export function reconcileOnLoad(
  local: ExperimentSession | null,
  server: ExperimentSession,
  manifestId: string,
): { session: ExperimentSession; needsPush: boolean; discardedLocal: boolean; discardedServer: boolean } {
  const serverStale = isStale(server, manifestId);
  const localStale = local != null && isStale(local, manifestId);
  const usableLocal = local && !localStale ? local : null;
  const usableServer = serverStale ? emptySession(manifestId) : server;

  if (!usableLocal) {
    return {
      session: usableServer,
      needsPush: serverStale && Object.keys(server.steps).length > 0,
      discardedLocal: localStale,
      discardedServer: serverStale,
    };
  }
  const merged = mergeSessions(usableServer, usableLocal);
  return {
    session: merged,
    // 本地有服务端没有的更新时才推送,避免每次登录都无谓写库。
    needsPush: JSON.stringify(merged) !== JSON.stringify(usableServer),
    discardedLocal: localStale,
    discardedServer: serverStale,
  };
}
