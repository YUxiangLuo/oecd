import { SESSION_VERSION, type ExperimentSession, type SharedSessionKey } from "./types";

export function emptySession(): ExperimentSession {
  return { version: SESSION_VERSION, steps: {}, shared: {} };
}

export function isValidSession(value: unknown): value is ExperimentSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<ExperimentSession>;
  if (session.version !== SESSION_VERSION || typeof session.steps !== "object" || session.steps === null) return false;
  if (typeof session.shared !== "object" || session.shared === null) return false;
  const validRecord = (record: unknown) => typeof record === "object" && record !== null && "data" in record;
  return Object.entries(session.steps).every(([key, record]) => {
    const step = Number(key);
    return Number.isInteger(step) && step >= 1 && step <= 15 && validRecord(record);
  }) && Object.entries(session.shared).every(
    ([key, record]) => key === "regression_settings" && validRecord(record),
  );
}

/** Compare JSON-shaped snapshots without treating object-key order as an edit. */
export function sameJsonValue(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first) && Array.isArray(second)
      && first.length === second.length && first.every((value, index) => sameJsonValue(value, second[index]));
  }
  if (first === null || second === null || typeof first !== "object" || typeof second !== "object") return false;
  const left = first as Record<string, unknown>;
  const right = second as Record<string, unknown>;
  // JSON request serialization omits undefined object fields.
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]));
}

export function sameSessionContent(first: ExperimentSession, second: ExperimentSession): boolean {
  return sameJsonValue(first, second);
}

/** Browsing settings and quiz answers: not report material (quiz answers have their own status). */
const VIEW_KEYS = new Set([
  "slice", "year", "country", "chart", "drill", "heat_sort", "heat_coverage",
  "browse_selection", "network_browse", "custom_draft", "quiz",
]);
const materialOf = (data: Record<string, unknown>) => Object.fromEntries(
  Object.entries(data).filter(([key]) => !VIEW_KEYS.has(key)),
);

/** Material sync excludes browsing settings and quiz answers, which have their own status.
 * Unlike report freshness, a changed material label is still a material edit that needs saving. */
export function sameMaterialContent(first: Record<string, unknown> = {}, second: Record<string, unknown> = {}): boolean {
  return sameJsonValue(materialOf(first), materialOf(second));
}

const recordData = (record: { data: unknown } | undefined): Record<string, unknown> =>
  typeof record?.data === "object" && record.data !== null ? record.data as Record<string, unknown> : {};

/**
 * One record (a step, or a shared entry) merged from what this tab last saw (`base`), this tab's version (`local`)
 * and the server's (`remote`). A record's material is one unit: whichever side changed it wins, and both changing
 * it differently is a conflict (null). Browsing settings merge field by field; where both changed one, this tab's
 * wins (it is what the student is looking at).
 */
function mergeRecord(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> | null {
  const [b, l, r] = [materialOf(base), materialOf(local), materialOf(remote)];
  const localMaterial = !sameJsonValue(l, b), remoteMaterial = !sameJsonValue(r, b);
  if (localMaterial && remoteMaterial && !sameJsonValue(l, r)) return null;
  const merged: Record<string, unknown> = { ...(localMaterial ? l : r) };
  for (const key of VIEW_KEYS) {
    const value = !sameJsonValue(local[key], base[key]) ? local[key] : remote[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Two tabs (or devices) of one account saving around each other: the server's newer record and this tab's edits,
 * merged against the record this tab last saw. Edits to different steps, or browsing in one tab while working in
 * another, combine; null only when both changed the same material differently.
 */
export function mergeSessions(base: ExperimentSession, local: ExperimentSession, remote: ExperimentSession): ExperimentSession | null {
  const merge = (keys: string[], read: (session: ExperimentSession, key: string) => { data: unknown } | undefined) => {
    const out: Record<string, { data: Record<string, unknown> }> = {};
    for (const key of keys) {
      const [b, l, r] = [read(base, key), read(local, key), read(remote, key)];
      if (!l && !r) continue;
      const data = mergeRecord(recordData(b), recordData(l), recordData(r));
      if (data === null) return null;
      out[key] = { data };
    }
    return out;
  };
  const keysOf = (pick: (session: ExperimentSession) => object) => [...new Set([base, local, remote].flatMap((session) => Object.keys(pick(session))))];
  const steps = merge(keysOf((session) => session.steps), (session, key) => session.steps[key]);
  const shared = merge(keysOf((session) => session.shared), (session, key) => session.shared[key as SharedSessionKey]);
  if (!steps || !shared) return null;
  return { version: remote.version, steps, shared } as ExperimentSession;
}

export function readStep<T>(session: ExperimentSession, step: number): T | undefined {
  return session.steps[String(step)]?.data as T | undefined;
}

export function patchStep<T extends object>(session: ExperimentSession, step: number, patch: Partial<T>): ExperimentSession {
  const key = String(step);
  const current = session.steps[key]?.data;
  const data = typeof current === "object" && current !== null ? { ...current } as Record<string, unknown> : {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete data[field];
    else data[field] = value;
  }
  return { ...session, steps: { ...session.steps, [key]: { data } } };
}

export function readShared<T>(session: ExperimentSession, key: SharedSessionKey): T | undefined {
  return session.shared[key]?.data as T | undefined;
}

export function writeShared<T>(session: ExperimentSession, key: SharedSessionKey, data: T): ExperimentSession {
  return { ...session, shared: { ...session.shared, [key]: { data } } };
}
