import { SESSION_VERSION, type ExperimentSession, type SessionRecord, type SharedSessionKey } from "./types";

const SHARED_KEYS: readonly SharedSessionKey[] = ["regression_settings", "regression_history"];

/** 实验会话的客户端存储:local-first + 与服务端按记录/字段时间戳合并。
 *
 * local-first 的理由:学生每改一个筛选就打一次网络请求既慢又脆弱,
 * 而“刷新后还在”必须是确定的。因此改动先落 localStorage(同步、必成功),
 * 再防抖同步到 PostgreSQL;网络失败不影响本地实验继续。
 *
 * 合并规则与服务端 gvcsim/session.py 完全一致:不同步骤保留双方，同一步骤逐字段合并。
 * 两边必须同规则,否则同一份并发写入在客户端与服务端会得到不同结果。
 */

const LOCAL_KEY_PREFIX = "gvcsim_session:v2:";
const LEGACY_KEY_PREFIX = "gvcsim_session:";
const QUARANTINE_KEY_PREFIX = "gvcsim_session:legacy-quarantine:";

export interface LocalSessionScope {
  accountId: string | number;
  courseRunId: string | number;
  assignmentId: string | number;
  attemptId: string | number;
  manifestId: string;
}

const keyPart = (value: string | number) => encodeURIComponent(String(value));
export const localKey = (scope: LocalSessionScope) => [
  LOCAL_KEY_PREFIX.slice(0, -1),
  keyPart(scope.accountId),
  keyPart(scope.courseRunId),
  keyPart(scope.assignmentId),
  keyPart(scope.attemptId),
  keyPart(scope.manifestId),
].join(":");

/**
 * Preserve a v1 username-only cache without trusting or uploading it. There is
 * no reliable way to prove which database/course produced that payload, even
 * when its manifest happens to match. The quarantined copy remains recoverable
 * for support, but never participates in reconciliation.
 */
export function quarantineLegacy(username: string): boolean {
  try {
    const legacyKey = `${LEGACY_KEY_PREFIX}${username}`;
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return false;
    const quarantineKey = `${QUARANTINE_KEY_PREFIX}${encodeURIComponent(username)}`;
    if (!localStorage.getItem(quarantineKey)) localStorage.setItem(quarantineKey, raw);
    localStorage.removeItem(legacyKey);
    return true;
  } catch {
    return false;
  }
}

/** 读取已隔离的 username-only 记录，仅用于让学生导出留档；绝不参与合并。 */
export function readLegacyQuarantine(username: string): unknown | null {
  try {
    const raw = localStorage.getItem(`${QUARANTINE_KEY_PREFIX}${encodeURIComponent(username)}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

export function emptySession(manifestId: string): ExperimentSession {
  return { version: SESSION_VERSION, manifest_id: manifestId, steps: {}, shared: {} };
}

export function makeRecord<T>(data: T, updatedAt?: string): SessionRecord<T> {
  const timestamp = updatedAt ?? new Date().toISOString();
  const fieldUpdatedAt = isFieldObject(data)
    ? Object.fromEntries(Object.keys(data).map((key) => [key, timestamp]))
    : {};
  return { data, updated_at: timestamp, field_updated_at: fieldUpdatedAt };
}

function isFieldObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const timestampValue = (value: string) => Date.parse(value);

/** 结构性校验:localStorage 可能被手改或残留旧版本,读到坏数据宁可丢弃。 */
export function isValidSession(value: unknown): value is ExperimentSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<ExperimentSession>;
  if (s.version !== SESSION_VERSION) return false;
  if (typeof s.manifest_id !== "string" || !s.manifest_id) return false;
  if (typeof s.steps !== "object" || s.steps === null) return false;
  if (typeof s.shared !== "object" || s.shared === null) return false;
  const validRecord = (record: unknown) => {
    if (typeof record !== "object" || record === null || !("data" in record)) return false;
    const candidate = record as SessionRecord;
    const recordTime = timestampValue(candidate.updated_at);
    if (typeof candidate.updated_at !== "string" || !Number.isFinite(recordTime)) return false;
    if (!isFieldObject(candidate.field_updated_at)) return false;
    if (!Object.values(candidate.field_updated_at).every(
      (value) => typeof value === "string" && Number.isFinite(timestampValue(value)) && timestampValue(value) <= recordTime,
    )) return false;
    if (isFieldObject(candidate.data)) {
      return Object.keys(candidate.data).every((key) => key in candidate.field_updated_at);
    }
    return Object.keys(candidate.field_updated_at).length === 0;
  };
  const stepsOk = Object.entries(s.steps).every(([key, record]) => {
    const n = Number(key);
    return Number.isInteger(n) && n >= 1 && n <= 16 && validRecord(record);
  });
  const sharedOk = Object.entries(s.shared).every(
    ([key, record]) => SHARED_KEYS.includes(key as SharedSessionKey) && validRecord(record),
  );
  return stepsOk && sharedOk;
}

export function loadLocal(scope: LocalSessionScope): ExperimentSession | null {
  try {
    const raw = localStorage.getItem(localKey(scope));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLocal(scope: LocalSessionScope, session: ExperimentSession): void {
  try {
    localStorage.setItem(localKey(scope), JSON.stringify(session));
  } catch {
    // 配额满或隐私模式:本地缓存失败不应打断实验,服务端仍是真实来源。
  }
}

export function clearLocal(scope: LocalSessionScope): void {
  try {
    localStorage.removeItem(localKey(scope));
  } catch {
    /* 同上 */
  }
}

/** 同一步骤对象逐字段合并；字段时间戳相同则取 incoming。与服务端同规则。 */
function mergeRecord(current: SessionRecord, incoming: SessionRecord): SessionRecord {
  if (!isFieldObject(current.data) || !isFieldObject(incoming.data)) {
    return timestampValue(incoming.updated_at) >= timestampValue(current.updated_at) ? incoming : current;
  }

  const data: Record<string, unknown> = {};
  const fieldUpdatedAt: Record<string, string> = {};
  const keys = new Set([
    ...Object.keys(current.field_updated_at),
    ...Object.keys(incoming.field_updated_at),
  ]);
  for (const key of keys) {
    const currentTime = current.field_updated_at[key];
    const incomingTime = incoming.field_updated_at[key];
    const useIncoming = incomingTime !== undefined
      && (currentTime === undefined || timestampValue(incomingTime) >= timestampValue(currentTime));
    const source = useIncoming ? incoming.data : current.data;
    const selectedTime = useIncoming ? incomingTime : currentTime;
    if (key in source) data[key] = source[key];
    // 映射中存在但 data 中不存在表示删除墓碑，防止另一标签页的旧值复活。
    if (selectedTime !== undefined) fieldUpdatedAt[key] = selectedTime;
  }

  const latest = timestampValue(incoming.updated_at) >= timestampValue(current.updated_at) ? incoming : current;
  return { data, updated_at: latest.updated_at, field_updated_at: fieldUpdatedAt };
}

function mergeSlot<T extends Record<string, SessionRecord | undefined>>(base: T, incoming: T): T {
  const out: Record<string, SessionRecord | undefined> = { ...base };
  for (const [key, record] of Object.entries(incoming)) {
    const current = out[key];
    if (record) out[key] = current ? mergeRecord(current, record) : record;
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

/** 只更新时间戳所对应的补丁字段，避免把同一记录里的陈旧字段伪装成新写入。 */
export function patchStep<T extends object>(
  session: ExperimentSession,
  step: number,
  patch: Partial<T>,
  updatedAt?: string,
): ExperimentSession {
  const key = String(step);
  const current = session.steps[key];
  if (!current || !isFieldObject(current.data)) {
    return {
      ...session,
      steps: { ...session.steps, [key]: makeRecord(patch, updatedAt) },
    };
  }

  const requestedTime = updatedAt ?? new Date().toISOString();
  const timestamp = timestampValue(requestedTime) >= timestampValue(current.updated_at)
    ? requestedTime
    : current.updated_at;
  const data = { ...current.data };
  const fieldUpdatedAt = { ...current.field_updated_at };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete data[field];
    else data[field] = value;
    fieldUpdatedAt[field] = timestamp;
  }
  return {
    ...session,
    steps: {
      ...session.steps,
      [key]: { data, updated_at: timestamp, field_updated_at: fieldUpdatedAt },
    },
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
  serverUntrusted = false,
): { session: ExperimentSession; needsPush: boolean; discardedLocal: boolean; discardedServer: boolean } {
  const serverInvalid = !isValidSession(server);
  const serverStale = serverUntrusted || serverInvalid || isStale(server, manifestId);
  const localStale = local != null && isStale(local, manifestId);
  const usableLocal = local && !localStale ? local : null;
  const usableServer = serverStale ? emptySession(manifestId) : server;

  if (!usableLocal) {
    return {
      session: usableServer,
      // Never turn an old/foreign session into a v5 write implicitly. The first
      // explicit student edit will create a fresh scoped v5 session instead.
      needsPush: false,
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
