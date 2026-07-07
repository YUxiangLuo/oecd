import { useEffect, useState } from "react";
import type { IndicatorSchema } from "../types";

export function fmtField(v: string | number | null, key: string, schema?: IndicatorSchema | null) {
  if (typeof v !== "number") return v ?? "—";
  const format = schema?.fields[key]?.format;
  if (format === "pct") return `${(v * 100).toFixed(2)}%`;
  if (format === "amount") return v.toFixed(2);
  return v.toFixed(3);
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
