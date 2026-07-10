import { useEffect, useState } from "react";
import { formatMetric } from "../format";
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
  return v.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 });
};

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    fn().then(
      (d) => live && setData(d),
      (e) => live && setError(String(e.message ?? e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

export function YearPicker({ years, year, onChange }: { years: number[]; year: number; onChange: (y: number) => void }) {
  return (
    <div className="controls">
      <label>年份</label>
      <select value={year} onChange={(e) => onChange(Number(e.target.value))}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
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
