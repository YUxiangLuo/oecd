import { useState } from "react";
import { LabeledControl } from "../../../a11y";
import { api } from "../../../api";
import type { Meta, NetworkData } from "../../../types";
import { countryLabel } from "../../../viz";
import { useHoverTip, type TipLine } from "../../../viz/hover";
import { CAT, REGION_OF, REGIONS, SEQ } from "../../../viz/shared";
import { thresholdedNetworkModel, type NetworkPartner } from "../../../viz/views/trade-network";
import { formatMetric } from "../../../format";
import { AsyncStateMessage, useAsync } from "../../shared";
import { IndicatorTrendChart } from "./indicator-charts";
import { Butterfly } from "./theme-charts";
import type { Row } from "./scaffold";

/* Step 9 贸易伙伴 view (design doc 4.6): the country-level trade network read three ways instead of as a
 * full node-link graph — an ego network of each selected economy's main partners, a partner table, and a
 * region-to-region flow matrix — plus the partner-concentration time series. Exploration only. */

const amount = (value: number) => formatMetric(value, "amount");
const TOP_PARTNERS = 8;

export interface PartnerYear { year: number; partners: Record<string, NetworkPartner[]>; edges: NetworkData["edges"] }

/** Every partner list for every selected economy in every year; edges are kept for the region matrix. */
export function partnerYears(byYear: { year: number; data: NetworkData }[]): PartnerYear[] {
  return byYear.map(({ year, data }) => {
    const model = thresholdedNetworkModel(data.edges, 0);
    return { year, partners: model.neighbors, edges: data.edges };
  });
}

/** Share of a country's partner flows (in + out) that its top-n partners carry. */
export function partnerConcentration(partners: NetworkPartner[] | undefined, top = 5): number | null {
  if (!partners?.length) return null;
  const total = partners.reduce((sum, partner) => sum + partner.total, 0);
  if (total <= 0) return null;
  return partners.slice(0, top).reduce((sum, partner) => sum + partner.total, 0) / total;
}

/** Region × region flow totals (seller rows, buyer columns), excluding ROW. */
export function regionMatrix(edges: NetworkData["edges"]): number[][] {
  const matrix = REGIONS.map(() => REGIONS.map(() => 0));
  for (const edge of edges) {
    const source = String(edge.source ?? ""), target = String(edge.target ?? "");
    const flow = edge.flow;
    if (!source || !target || source === "ROW" || target === "ROW" || typeof flow !== "number" || !Number.isFinite(flow) || flow <= 0) continue;
    matrix[REGION_OF[source] ?? 5][REGION_OF[target] ?? 5] += flow;
  }
  return matrix;
}

function EgoNetwork({ country, partners, colorIndex, scaleMax }: { country: string; partners: NetworkPartner[]; colorIndex: number; scaleMax: number }) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const top = partners.filter((partner) => partner.c !== "ROW").slice(0, TOP_PARTNERS).sort((a, b) => (REGION_OF[a.c] ?? 5) - (REGION_OF[b.c] ?? 5) || b.total - a.total);
  const W = 420, H = 320, cx = W / 2, cy = H / 2 + 6, R = 118;
  const width = (value: number) => 1 + (value / (scaleMax || 1)) * 9;
  const linesFor = (partner: NetworkPartner): TipLine[] => [
    ["", `${countryLabel(country)} ↔ ${countryLabel(partner.c)} · ${REGIONS[REGION_OF[partner.c] ?? 5]}`],
    [`${countryLabel(country)} 卖给它（流出）`, amount(partner.outflow), CAT[0]],
    [`${countryLabel(country)} 从它买入（流入）`, amount(partner.inflow), CAT[1]],
    ["双向合计", amount(partner.total)],
  ];
  if (!top.length) return <p role="status">{countryLabel(country)} 在该年没有贸易伙伴数据。</p>;
  return (
    <div ref={wrapRef} className="hover-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${countryLabel(country)}的前 ${top.length} 个贸易伙伴自我中心图；线宽表示双向流量，箭头指向买方`} style={{ width: "100%", display: "block" }}>
        <defs>
          <marker id={`ego-out-${country}`} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" viewBox="0 0 10 8">
            <path d="M0,0 L10,4 L0,8 z" fill={CAT[0]} />
          </marker>
          <marker id={`ego-in-${country}`} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto" viewBox="0 0 10 8">
            <path d="M0,0 L10,4 L0,8 z" fill={CAT[1]} />
          </marker>
        </defs>
        <text x={12} y={16} fontSize={11} fill="#596173">线宽 = 双向流量；蓝箭头 = {country} 卖出，绿箭头 = {country} 买入；伙伴按地理区域分组</text>
        {top.map((partner, index) => {
          const angle = -Math.PI / 2 + (index / top.length) * Math.PI * 2;
          const x = cx + Math.cos(angle) * R, y = cy + Math.sin(angle) * R;
          // Two offset strokes: outflow from the centre, inflow towards it.
          const nx = -Math.sin(angle) * 5, ny = Math.cos(angle) * 5;
          const trim = 24;
          const sx = cx + Math.cos(angle) * trim, sy = cy + Math.sin(angle) * trim;
          const ex = x - Math.cos(angle) * trim, ey = y - Math.sin(angle) * trim;
          return (
            <g key={partner.c} data-partner={partner.c}
              role="graphics-symbol" tabIndex={0}
              aria-label={`伙伴 ${countryLabel(partner.c)}：流出 ${amount(partner.outflow)}，流入 ${amount(partner.inflow)}`}
              onMouseMove={(event) => show(event, linesFor(partner))}
              onMouseLeave={hide}
              onFocus={(event) => showFor(event.currentTarget, linesFor(partner))}
              onBlur={hide}
              style={{ cursor: "pointer" }}>
              <line x1={sx + nx} y1={sy + ny} x2={ex + nx} y2={ey + ny} stroke={CAT[0]} strokeWidth={width(partner.outflow)} strokeOpacity={0.8} markerEnd={`url(#ego-out-${country})`} />
              <line x1={ex - nx} y1={ey - ny} x2={sx - nx} y2={sy - ny} stroke={CAT[1]} strokeWidth={width(partner.inflow)} strokeOpacity={0.8} markerEnd={`url(#ego-in-${country})`} />
              <circle cx={x} cy={y} r={17} fill="#fff" stroke={CAT[(REGION_OF[partner.c] ?? 5)]} strokeWidth={2} />
              <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1b1f2b">{partner.c}</text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r={24} fill={CAT[colorIndex]} />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">{country}</text>
      </svg>
      {Tip}
    </div>
  );
}

function RegionMatrix({ matrix, year }: { matrix: number[][]; year: number }) {
  const max = Math.max(1, ...matrix.flat());
  return (
    <table className="region-matrix data-table" aria-describedby="region-matrix-note">
      <caption style={{ textAlign: "left", padding: "6px 0", color: "#3a4050" }}>{year} 年区域间贸易流（行为卖方区域，列为买方区域；百万美元，不含 ROW）</caption>
      <thead>
        <tr><th scope="col">卖方 ＼ 买方</th>{REGIONS.map((region) => <th key={region} scope="col">{region}</th>)}</tr>
      </thead>
      <tbody>
        {matrix.map((row, i) => (
          <tr key={REGIONS[i]}>
            <th scope="row">{REGIONS[i]}</th>
            {row.map((value, j) => {
              const index = Math.max(0, Math.min(SEQ.length - 1, Math.floor((value / max) * SEQ.length)));
              return (
                <td key={REGIONS[j]} style={{ background: SEQ[index], color: index >= 4 ? "#fff" : "#1b1f2b", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: i === j ? 700 : 400 }}
                  title={`${REGIONS[i]} → ${REGIONS[j]}：${amount(value)}`}>
                  {amount(value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TradePartners({ meta, countries, year, onYear }: {
  meta: Meta;
  countries: string[];
  year: number;
  onYear: (year: number) => void;
}) {
  const years = [...meta.years].sort((a, b) => a - b);
  const query = useAsync(
    async () => partnerYears(await Promise.all(years.map(async (value) => ({ year: value, data: await api.network(value) })))),
    [years.join(",")],
  );
  const [limit, setLimit] = useState<10 | 200>(10);
  if (query.status !== "success" || !query.data) {
    return <AsyncStateMessage status={query.status} error={query.error} loadingLabel="加载各年贸易网络…" onRetry={query.retry} />;
  }
  const current = query.data.find((item) => item.year === year) ?? query.data[query.data.length - 1];
  const scaleMax = Math.max(1, ...countries.flatMap((country) => (current.partners[country] ?? []).slice(0, TOP_PARTNERS).flatMap((partner) => [partner.inflow, partner.outflow])));
  const concentrationRows: Row[] = countries.flatMap((country) =>
    query.data!.map((item) => ({ country, year: item.year, concentration: partnerConcentration(item.partners[country]) })),
  );
  return (
    <div>
      <div className="controls">
        <LabeledControl label="贸易伙伴年份">
          {(id) => (
            <select id={id} value={year} onChange={(event) => onYear(Number(event.target.value))}>
              {years.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          )}
        </LabeledControl>
        <LabeledControl label="伙伴榜范围">
          {(id) => (
            <select id={id} value={limit} onChange={(event) => setLimit(Number(event.target.value) as 10 | 200)}>
              <option value={10}>前 10 个伙伴</option>
              <option value={200}>全部伙伴</option>
            </select>
          )}
        </LabeledControl>
      </div>
      <p className="muted" id="region-matrix-note">
        国家级贸易网络接近完全图：几乎每两个经济体之间都有贸易，所以介数这类不看流量的中心性在国家层面没有区分度；本步的网络指标因此在国家×行业网络上计算。这里只看三样可读的信息：主要伙伴、买卖方向、区域内与区域间的流向。
      </p>
      <div className="comparison-facets">
        {countries.map((country, index) => {
          const partners = current.partners[country] ?? [];
          return (
            <section key={country} className="comparison-facet">
              <h4>{countryLabel(country)} · {current.year} · 主要贸易伙伴</h4>
              <EgoNetwork country={country} partners={partners} colorIndex={index} scaleMax={scaleMax} />
              <Butterfly
                title={`${countryLabel(country)} 伙伴榜`}
                unit="百万美元"
                leftLabel="从它买入（进口来源）"
                rightLabel="卖给它（出口去向）"
                rows={partners.filter((partner) => partner.c !== "ROW").slice(0, limit).map((partner) => ({ key: partner.c, label: countryLabel(partner.c), left: partner.inflow, right: partner.outflow }))}
              />
            </section>
          );
        })}
      </div>
      <h4>伙伴集中度 · 前 5 个伙伴占该国全部双向流量的比重</h4>
      <IndicatorTrendChart
        rows={concentrationRows}
        countries={countries}
        years={years}
        metric="concentration"
        label="前 5 伙伴集中度"
        unit="%"
        mode="context"
      />
      <RegionMatrix matrix={regionMatrix(current.edges)} year={current.year} />
    </div>
  );
}
