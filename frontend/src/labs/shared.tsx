import { useCallback, useEffect, useState } from "react";
import { LabeledControl } from "../a11y";
import { formatMetric, stripNegativeZero } from "../format";
import type { IndicatorSchema } from "../types";

export function fmtField(v: string | number | null, key: string, schema?: IndicatorSchema | null) {
  if (typeof v !== "number") return v ?? "—";
  return formatMetric(v, schema?.fields[key]?.format);
}

export function fieldLabel(key: string, schema?: IndicatorSchema | null) {
  return schema?.fields[key]?.label ?? key;
}

export const fmtDb = (v: string | number | null) => {
  if (typeof v !== "number") return v ?? "—";
  if (!Number.isFinite(v)) return "—";
  if (Object.is(v, -0) || v === 0) return "0";
  const magnitude = Math.abs(v);
  if (magnitude < 0.0001) {
    return v.toExponential(2).replace(/\.00e/, "e").replace(/(\.\d*[1-9])0+e/, "$1e").replace("e-", "e−").replace("e+", "e");
  }
  return stripNegativeZero(v.toLocaleString("zh-CN", {
    maximumFractionDigits: magnitude < 1 ? 4 : magnitude < 10 ? 3 : 2,
  }));
};

export type AsyncStatus = "idle" | "loading" | "success" | "error";

export type AsyncResult<T> = {
  data: T | null;
  error: string | null;
  status: AsyncStatus;
  retry: () => void;
  /** Stable caller-owned request key; null keeps the legacy useAsync behavior. */
  requestKey: string | null;
  /** Increments before every explicit retry so prior results become ineligible immediately. */
  generation: number;
};

export function asyncRequestIdentity(requestKey: string, generation: number): string {
  return `${requestKey}\u0000${generation}`;
}

/** Pure render-time guard used by useAsync and race-focused tests. */
export function currentAsyncSnapshot<T>({
  enabled,
  requestIdentity,
  settledIdentity,
  data,
  error,
  status,
}: {
  enabled: boolean;
  requestIdentity: string | null;
  settledIdentity: string | null;
  data: T | null;
  error: string | null;
  status: AsyncStatus;
}): Pick<AsyncResult<T>, "data" | "error" | "status"> {
  if (!enabled) return { data: null, error: null, status: "idle" };
  const current = requestIdentity === null || settledIdentity === requestIdentity;
  return current
    ? { data, error, status }
    : { data: null, error: null, status: "loading" };
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean; keepPreviousData?: boolean; requestKey?: string } = {},
): AsyncResult<T> {
  const enabled = options.enabled ?? true;
  const keepPreviousData = options.keepPreviousData ?? false;
  const requestKey = options.requestKey ?? null;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AsyncStatus>(enabled ? "loading" : "idle");
  const [revision, setRevision] = useState(0);
  const requestIdentity = requestKey === null ? null : asyncRequestIdentity(requestKey, revision);
  const [settledIdentity, setSettledIdentity] = useState<string | null>(requestIdentity);
  const retry = useCallback(() => {
    if (enabled) {
      setError(null);
      setStatus("loading");
    }
    setRevision((value) => value + 1);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setStatus("idle");
      setSettledIdentity(requestIdentity);
      return;
    }
    let live = true;
    // Request-keyed callers may never expose previous data as current evidence,
    // even if keepPreviousData was accidentally enabled.
    if (!keepPreviousData || requestIdentity !== null) setData(null);
    setError(null);
    setStatus("loading");
    setSettledIdentity(requestIdentity);
    fn().then(
      (d) => {
        if (!live) return;
        setData(d);
        setStatus("success");
        setSettledIdentity(requestIdentity);
      },
      (e) => {
        if (!live) return;
        setData(null);
        setError(String(e.message ?? e));
        setStatus("error");
        setSettledIdentity(requestIdentity);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, keepPreviousData, requestIdentity, revision]);
  const snapshot = currentAsyncSnapshot({
    enabled, requestIdentity, settledIdentity, data, error, status,
  });
  return { ...snapshot, retry, requestKey, generation: revision };
}

export function AsyncStateMessage({
  status,
  error,
  loadingLabel = "加载中…",
  onRetry,
}: {
  status: AsyncStatus;
  error: string | null;
  loadingLabel?: string;
  onRetry: () => void;
}) {
  if (status === "loading" || status === "idle") {
    return <p className="muted" role="status">{loadingLabel}</p>;
  }
  if (status !== "error") return null;
  return (
    <div className="error-box async-error" role="alert">
      <span>数据加载失败：{error ?? "未知错误"}</span>
      <button type="button" className="secondary" onClick={onRetry}>重试</button>
    </div>
  );
}

export function YearPicker({ years, year, onChange }: { years: number[]; year: number; onChange: (y: number) => void }) {
  return (
    <div className="controls">
      <LabeledControl label="年份">
        {(id) => (
          <select id={id} value={year} onChange={(e) => onChange(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
      </LabeledControl>
    </div>
  );
}

export const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** 统一分页器：支持首尾页、逐页与直接跳转，输入在失焦/回车时收敛到有效范围。 */
export function Pager({ page, pages, total, onChange }: {
  page: number;
  pages: number;
  total?: number;
  onChange: (page: number) => void;
}) {
  const safePages = Math.max(1, pages);
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isFinite(parsed) ? Math.min(safePages, Math.max(1, parsed)) : page;
    setDraft(String(next));
    if (next !== page) onChange(next);
  };
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onChange(1)} title="首页">« 首页</button>
      <button disabled={page <= 1} onClick={() => onChange(page - 1)}>← 上一页</button>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        第
        <input
          aria-label="跳转页码"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
              event.currentTarget.blur();
            }
          }}
          style={{ width: 48, textAlign: "center" }}
        />
        / {safePages} 页{total != null ? ` · 共 ${total} 条` : ""}
      </span>
      <button disabled={page >= safePages} onClick={() => onChange(page + 1)}>下一页 →</button>
      <button disabled={page >= safePages} onClick={() => onChange(safePages)} title="末页">末页 »</button>
    </div>
  );
}
