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

/** Local display preferences and unfinished model forms. Quiz results are server data. */
const VIEW_KEYS = new Set([
  "slice", "year", "country", "chart", "drill", "heat_sort", "heat_coverage",
  "browse_selection", "network_browse", "custom_draft",
]);
const materialOf = (data: Record<string, unknown>) => Object.fromEntries(
  Object.entries(data).filter(([key]) => !VIEW_KEYS.has(key) && key !== "quiz"),
);

/** Material sync excludes browsing settings and quiz answers, which have their own status.
 * Unlike report freshness, a changed material label is still a material edit that needs saving. */
export function sameMaterialContent(first: Record<string, unknown> = {}, second: Record<string, unknown> = {}): boolean {
  return sameJsonValue(materialOf(first), materialOf(second));
}

/** Separate local preferences from work; omit empty records so browsing cannot create a server edit. */
export function sessionData(session: ExperimentSession, local = false): ExperimentSession {
  const steps: ExperimentSession["steps"] = {};
  for (const [step, record] of Object.entries(session.steps)) {
    const fields = typeof record.data === "object" && record.data !== null ? record.data : {};
    const data = Object.fromEntries(Object.entries(fields)
      .filter(([key]) => VIEW_KEYS.has(key) === local));
    if (Object.keys(data).length) steps[step] = { data };
  }
  return { ...session, steps, shared: local ? {} : session.shared };
}

/** Restore local preferences without letting them replace saved evidence. */
export function withSessionViews(session: ExperimentSession, views: ExperimentSession): ExperimentSession {
  let result = session;
  for (const [step, record] of Object.entries(sessionData(views, true).steps)) {
    result = patchStep(result, Number(step), record.data as Record<string, unknown>);
  }
  return result;
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
