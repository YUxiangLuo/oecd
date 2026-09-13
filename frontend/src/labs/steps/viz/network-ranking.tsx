import { countryLabel, sectorLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { ScrollableRegion } from "../../../a11y";
import { fmtDb } from "../../shared";
import type { Row } from "./scaffold";

export interface NetworkRankRow { industry: string; values: (number | null)[] }

/** Rank only country A; B is matched by industry, never independently ranked. */
export function networkRanking(rows: Row[], year: number, countries: string[], metric: string, limit: number): NetworkRankRow[] {
  return rows.filter((row) => row.year === year && row.country === countries[0]
    && typeof row[metric] === "number" && Number.isFinite(row[metric]))
    .sort((a, b) => (b[metric] as number) - (a[metric] as number) || String(a.industry).localeCompare(String(b.industry)))
    .slice(0, limit).map((row) => ({
      industry: String(row.industry),
      values: countries.map((country) => {
        const value = rows.find((item) => item.year === year && item.country === country && item.industry === row.industry)?.[metric];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      }),
    }));
}

export function NetworkRanking({ rows, countries, unit, onIndustry }: {
  rows: NetworkRankRow[]; countries: string[]; unit: string; onIndustry: (industry: string) => void;
}) {
  const maximum = Math.max(0, ...rows.flatMap((row) => row.values.filter((value): value is number => value !== null)));
  const scale = maximum || 1;
  return <>
    <p className="muted">按国家 A 降序，两国使用同一组行业、同一顺序和零起点刻度。条长与数值成比例，单位：{unit}。缺失值不补零。点击行业查看历年变化。</p>
    <ScrollableRegion label="行业排名条形图" className="bounded-data-table" style={{ padding: 12 }}>
      {rows.map((row, rank) => <div key={row.industry} style={{ display: "grid", gridTemplateColumns: "minmax(140px, 28%) minmax(0, 1fr)", gap: 12, padding: "10px 0", borderBottom: "1px solid #e7e9ef" }}>
        <button className="secondary" style={{ textAlign: "left", alignSelf: "center" }} onClick={() => onIndustry(row.industry)} aria-label={`查看${sectorLabel(row.industry)}历年变化`}>
          {rank + 1}. {sectorLabel(row.industry)} →
        </button>
        <div>{row.values.map((value, index) => <div key={countries[index]} style={{ display: "grid", gridTemplateColumns: "42px minmax(0, 1fr) 110px", alignItems: "center", gap: 8, minHeight: 26 }}>
          <span title={countryLabel(countries[index])} style={{ fontSize: 12 }}>{countries[index]}</span>
          <div style={{ borderLeft: "1px solid #bbc1ce", background: "#f5f6fa", height: 14 }} aria-hidden="true">
            {value !== null && <div style={{ width: `${value / scale * 100}%`, height: "100%", background: CAT[index], border: index ? "1px dashed #145840" : undefined }} />}
          </div>
          <span style={{ textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{value === null ? "缺失" : fmtDb(value)}</span>
        </div>)}</div>
      </div>)}
    </ScrollableRegion>
  </>;
}
