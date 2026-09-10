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
function sameJsonValue(first: unknown, second: unknown): boolean {
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
