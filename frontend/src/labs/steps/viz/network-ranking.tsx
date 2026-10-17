import { countryLabel, sectorLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { ScrollableRegion } from "../../../a11y";
import { indicatorNumber } from "./indicator-charts";
import { NO_OUTPUT, rankText } from "./indicator-model";
import type { Row } from "./scaffold";
import { PATH_UNDEFINED_LABEL, pathMetricUndefined } from "../../../viz/views/network-heat";
import { unitText } from "../../../format";

/** `undefinedAt[i]`: country i's value is not missing but undefined (an industry with no outgoing links). */
export interface NetworkRankRow { industry: string; values: (number | null)[]; undefinedAt?: boolean[] }

/** A reading that can be compared: finite and, for path metrics, defined (a node that reaches nothing is not 0). */
export const networkValue = (value: unknown, metric: string): number | null =>
  typeof value === "number" && Number.isFinite(value) && !pathMetricUndefined(metric, value) ? value : null;

/** Industries ordered by country A; the other countries are matched by industry (each still gets its global rank). */
export function networkRanking(rows: Row[], year: number, countries: string[], metric: string, limit: number): NetworkRankRow[] {
  return rows.filter((row) => row.year === year && row.country === countries[0] && networkValue(row[metric], metric) !== null)
    .sort((a, b) => (b[metric] as number) - (a[metric] as number) || String(a.industry).localeCompare(String(b.industry)))
    .slice(0, limit).map((row) => {
      const raw = countries.map((country) => rows.find((item) => item.year === year && item.country === country && item.industry === row.industry)?.[metric]);
      const undefinedAt = raw.map((value) => pathMetricUndefined(metric, value));
      return {
        industry: String(row.industry),
        values: raw.map((value) => networkValue(value, metric)),
        ...(undefinedAt.some(Boolean) ? { undefinedAt } : {}),
      };
    });
}

/** Each industry's global median across all economies, and every selected country's rank there. */
export type IndustryReference = ReadonlyMap<string, { median: number; n: number; ranks?: Record<string, number>; ties?: Record<string, number>; noOutput?: string[] }>;

export function NetworkRanking({ rows, countries, unit, onIndustry, reference = new Map() }: {
  rows: NetworkRankRow[]; countries: string[]; unit: string; onIndustry: (industry: string) => void;
  reference?: IndustryReference;
}) {
  const maximum = Math.max(
    0,
    ...rows.flatMap((row) => row.values.filter((value): value is number => value !== null)),
    ...rows.flatMap((row) => { const median = reference.get(row.industry)?.median; return median == null ? [] : [median]; }),
  );
  const scale = maximum || 1;
  const withReference = rows.some((row) => reference.has(row.industry));
  return <>
    <p className="muted">
      行业按 {countryLabel(countries[0])} 从高到低排列，所选国家使用同一组行业、同一顺序和从 0 开始的刻度。条长与数值成比例，单位：{unitText(unit)}。缺少或无法定义的数据留空，不当作 0。点击行业名查看历年变化。
      {withReference && "灰色竖线是该行业在全部经济体中的中位数；“全球第 N 位”是每个国家这一行业在全部经济体同一行业中的排名（从高到低）。"}
    </p>
    <ScrollableRegion label="行业排名条形图" className="bounded-data-table" style={{ padding: 12 }}>
      {rows.map((row, rank) => {
        const global = reference.get(row.industry);
        return <div key={row.industry} className="rank-row">
        {/* A link-style label: the boxed secondary button read as a text field. */}
        <button type="button" className="rank-industry" onClick={() => onIndustry(row.industry)} aria-label={`查看 ${sectorLabel(row.industry)} 的历年变化`}>
          {rank + 1}. {sectorLabel(row.industry)} →
        </button>
        <div>{row.values.map((value, index) => <div key={countries[index]} className="rank-bar">
          <span title={countryLabel(countries[index])} style={{ fontSize: 12 }}>{countryLabel(countries[index])}</span>
          <div style={{ position: "relative", borderLeft: "1px solid #bbc1ce", background: "#f5f6fa", height: 14 }} aria-hidden="true">
            {value !== null && <div style={{ width: `${value / scale * 100}%`, height: "100%", background: CAT[index], border: index ? "1px dashed #145840" : undefined }} />}
            {global && <span data-global-median style={{ position: "absolute", top: -3, bottom: -3, left: `${global.median / scale * 100}%`, borderLeft: "2px solid #6b7385" }} />}
          </div>
          {/* One line per country, level with its bar: the value, then its global rank. */}
          <span className="rank-value">
            <b>{value === null && row.undefinedAt?.[index] ? PATH_UNDEFINED_LABEL : indicatorNumber(value, unit)}</b>
            {(() => {
              const countryRank = global?.ranks?.[countries[index]];
              // LUX·A03 reads 0 because the industry produces nothing there: flagged, not ranked last.
              if (global?.noOutput?.includes(countries[index])) return <small>{NO_OUTPUT}</small>;
              if (!global || countryRank == null) return null;
              const text = rankText(countryRank, global.ties?.[countries[index]], global.n);
              return <small>{text ? `全球${text} / ${global.n}` : "全球数值都相同，不排名"}</small>;
            })()}
          </span>
        </div>)}</div>
        {global && <span className="sr-only">{sectorLabel(row.industry)} 全球中位数 {indicatorNumber(global.median, unit)}</span>}
      </div>;
      })}
    </ScrollableRegion>
  </>;
}
