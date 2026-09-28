import { useState } from "react";
import { IcioYearNote } from "./icio-year-note";
import { LabeledControl, ScrollableRegion } from "../../../a11y";
import { api } from "../../../api";
import type { IndicatorSchema, Meta } from "../../../types";
import { countryLabel, sectorLabel } from "../../../viz";
import { CAT } from "../../../viz/shared";
import { HEAT_EVIDENCE_METRIC } from "../../../viz/views/network-heat";
import { AsyncStateMessage, fmtDb, useAsync } from "../../shared";
import { currentReleaseId, type Row, type VizObservation } from "./scaffold";
import { ComparisonSummary } from "./indicator-charts";
import { defaultComparison } from "./indicator-model";
import { NetworkRanking, networkRanking } from "./network-ranking";

const COMMON_METRICS = ["weighted degree", "weighted indegree", "weighted outdegree", HEAT_EVIDENCE_METRIC];

export interface NetworkTrendPoint { country: string; year: number; value: number | null }

/** Missing observations remain gaps; neither zero-fill nor connect across them. */
export function networkTrendPoints(rows: Row[], years: number[], countries: string[], industry: string, metric: string = HEAT_EVIDENCE_METRIC): NetworkTrendPoint[] {
  return countries.flatMap((country) => [...years].sort((a, b) => a - b).map((year) => {
    const value = rows.find((row) => row.country === country && row.year === year && row.industry === industry)?.[metric];
    return { country, year, value: typeof value === "number" && Number.isFinite(value) ? value : null };
  }));
}

export function NetworkTrend({ meta, schema, initialCountry, observations = [], syncing = false, syncError = null, onRetrySync, onRecord }: {
  meta: Meta;
  schema?: IndicatorSchema | null;
  initialCountry: string;
  observations?: VizObservation[];
  syncing?: boolean;
  syncError?: string | null;
  onRetrySync?: () => void;
  onRecord: (countries: string[], observations: VizObservation[]) => void;
}) {
  const countries = meta.countries.filter((country) => country !== "ROW");
  const years = [...meta.years].sort((a, b) => a - b);
  const restored = observations.filter((item) => (item.source === "explicit-network-trend" || item.source === "explicit-network-ranking") && item.release === currentReleaseId(meta));
  const restoredCountries = [...new Set(restored.map((item) => item.country))].filter((country) => countries.includes(country));
  const [defaultFirst, defaultSecond] = defaultComparison(countries, restoredCountries.length ? restoredCountries : [initialCountry]);
  const [first, setFirst] = useState(defaultFirst);
  const [second, setSecond] = useState(defaultSecond);
  const [industry, setIndustry] = useState(meta.sectors.includes(restored[0]?.industry ?? "") ? restored[0].industry! : meta.sectors.includes("C26") ? "C26" : meta.sectors[0] ?? "");
  const [metric, setMetric] = useState(restored[0]?.metric ?? "weighted degree");
  const [view, setView] = useState<"trend" | "ranking">(restored[0]?.source === "explicit-network-ranking" ? "ranking" : "trend");
  const [year, setYear] = useState(restored[0]?.source === "explicit-network-ranking" && years.includes(restored[0].year) ? restored[0].year : years.at(-1)!);
  const [limit, setLimit] = useState(new Set(restored.map((item) => item.industry)).size > 10 ? 200 : 10);
  const metrics = schema?.groups.find((group) => group.key === "network")?.fields ?? COMMON_METRICS;
  const label = schema?.fields[metric]?.label ?? (metric === "weighted degree" ? "加权总度（入+出；自环双计）" : metric);
  const unit = metric.startsWith("weighted ") ? "百万美元" : metric === HEAT_EVIDENCE_METRIC ? "未归一化介数" : ["degree", "indegree", "outdegree"].includes(metric) ? "连接数" : metric === "Eccentricity" ? "路径长度" : "无量纲";
  const selected = second && second !== first ? [first, second] : [first];
  const release = currentReleaseId(meta);
  const requestKey = `${release}:network-trend:${selected.join(",")}:${years.join(",")}`;
  const query = useAsync<Row[]>(async () => {
    const pages = await Promise.all(selected.flatMap((country) => years.map(async (year) => {
      const page = await api.industryIndicatorsAll(year, country);
      return page.rows.map((row) => ({ ...row, year }));
    })));
    return pages.flat();
  }, [requestKey], { requestKey, enabled: Boolean(first && release) });
  const points = networkTrendPoints(query.data ?? [], years, selected, industry, metric);
  const ranked = networkRanking(query.data ?? [], year, selected, metric, limit);
  const finite = points.filter((point) => point.value !== null);
  const commonYears = years.filter((candidate) =>
    selected.every((country) =>
      points.some((point) => point.country === country && point.year === candidate && point.value !== null),
    ),
  );
  const canRecord = query.status === "success" && selected.length === 2
    && (view === "trend" ? commonYears.length >= 2
      : ranked.some((row) => row.values.every((value) => value !== null)));
  const readings = view === "trend" ? finite.filter((point) => commonYears.includes(point.year)).map((point) => ({ ...point, industry }))
    : ranked.filter((row) => row.values.every((value) => value !== null))
      .flatMap((row) => row.values.map((value, index) => ({ country: selected[index], industry: row.industry, year, value: value! })));
  const pendingObservations: VizObservation[] = readings.map((point) => ({
      entity: `${point.country}·${point.industry}`, country: point.country, industry: point.industry,
      year: point.year, value: point.value!, metric, unit,
      release: release ?? undefined, scope: "country-industry", generation: query.generation,
      request_key: requestKey, source: view === "trend" ? "explicit-network-trend" : "explicit-network-ranking",
  }));
  const materialKey = (rows: VizObservation[]) => JSON.stringify(rows.map(({ country, industry, year, metric, value, unit, source, release }) => [country, industry, year, metric, value, unit, source, release]));
  const matchesSaved = canRecord && materialKey(pendingObservations) === materialKey(observations);
  const savedYears = [...new Set(observations.map((item) => item.year))].sort((a, b) => a - b);
  const savedCountries = [...new Set(observations.map((item) => item.country))];
  const savedIndustries = [...new Set(observations.map((item) => item.industry).filter(Boolean))];
  const record = () => {
    if (!canRecord || !release || matchesSaved) return;
    onRecord(selected, pendingObservations);
  };
  const max = (Math.max(0, ...finite.map((point) => point.value!)) || 1) * 1.1;
  const x = (year: number) => 95 + (year - years[0]) / Math.max(1, years.at(-1)! - years[0]) * 650;
  const y = (value: number) => 280 - value / max * 235;

  return <section className="reg-section-card" aria-label="行业网络指标趋势">
    <div className="controls" aria-label="行业图表视角">
      <button className={view === "trend" ? "primary" : "secondary"} aria-pressed={view === "trend"} onClick={() => setView("trend")}>比较变化</button>
      <button className={view === "ranking" ? "primary" : "secondary"} aria-pressed={view === "ranking"} onClick={() => setView("ranking")}>定位行业</button>
    </div>
    <div className="controls">
      <LabeledControl label="网络指标">{(id) => <select id={id} name="network-metric" value={metric} onChange={(event) => setMetric(event.target.value)}>
        <optgroup label="常用指标">{COMMON_METRICS.filter((key) => metrics.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
        <optgroup label="更多指标">{metrics.filter((key) => !COMMON_METRICS.includes(key)).map((key) => <option key={key} value={key}>{schema?.fields[key]?.label ?? key}</option>)}</optgroup>
      </select>}</LabeledControl>
      <LabeledControl label="国家 A">{(id) => <select id={id} name="network-country-a" value={first} onChange={(event) => {
        setFirst(event.target.value);
        if (event.target.value === second) setSecond("");
      }}>{countries.map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}</select>}</LabeledControl>
      <LabeledControl label="对比国家 B">{(id) => <select id={id} name="network-country-b" value={second} onChange={(event) => setSecond(event.target.value)}>
        <option value="">暂不对比（不能保存报告材料）</option>
        {countries.filter((country) => country !== first).map((country) => <option key={country} value={country}>{countryLabel(country)}</option>)}
      </select>}</LabeledControl>
      {view === "trend" ? <LabeledControl label="行业">{(id) => <select id={id} value={industry} onChange={(event) => setIndustry(event.target.value)}>
        {meta.sectors.map((sector) => <option key={sector} value={sector}>{sectorLabel(sector)}</option>)}
      </select>}</LabeledControl> : <>
        <LabeledControl label="排名年份">{(id) => <select id={id} value={year} onChange={(event) => setYear(Number(event.target.value))}>{years.map((value) => <option key={value} value={value}>{value}</option>)}</select>}</LabeledControl>
        <LabeledControl label="显示行业">{(id) => <select id={id} value={limit} onChange={(event) => setLimit(Number(event.target.value))}><option value={10}>Top 10</option><option value={200}>全部行业</option></select>}</LabeledControl>
      </>}
    </div>
    <p aria-label="当前比较口径"><strong>
      {selected.map(countryLabel).join("与")} · {view === "trend" ? sectorLabel(industry) : "行业排名"} · {view === "trend" ? `${years[0]}–${years.at(-1)}` : year} · {label}
    </strong></p>
    <p className="muted">单位：{unit}。缺失不补零；网络指标不等于经济重要性，不能直接推断因果。</p>
    {(view === "trend" ? years.includes(2020) : year === 2020) && <p className="reg-boundary">2020 年含疫情期及统计外推影响，不宜仅凭该年转折判断生产调整。详见下方“指标口径”。</p>}
    {query.status !== "success" ? <AsyncStateMessage status={query.status} error={query.error} loadingLabel="正在加载历年行业指标…" onRetry={query.retry} /> : <>
      {view === "ranking" ? ranked.length ? <NetworkRanking rows={ranked} countries={selected} unit={unit} onIndustry={(next) => { setIndustry(next); setView("trend"); }} /> : <p role="status">该年份没有可用的行业排名，请更换指标或国家。</p> : <>
      {finite.length ? <svg viewBox="0 0 800 335" role="img" aria-label={`${sectorLabel(industry)}历年${label}趋势，${selected.map(countryLabel).join("与")}；详细读数见下方表格`} style={{ width: "100%", display: "block" }}>
        <g aria-label="趋势图图例">
          {selected.map((country, index) => <g key={`legend-${country}`} transform={`translate(${470 + index * 145} 18)`}>
            <line x1={0} x2={24} y1={0} y2={0} stroke={CAT[index]} strokeWidth={2.5} strokeDasharray={index ? "7 4" : undefined} />
            {index ? <rect x={8} y={-4} width={8} height={8} fill={CAT[index]} /> : <circle cx={12} cy={0} r={4} fill={CAT[index]} />}
            <text x={31} y={4} fontSize={12} fill="#374151">{countryLabel(country)}</text>
          </g>)}
        </g>
        {[0, 1, 2, 3, 4].map((tick) => <g key={tick}>
          <line x1={95} x2={745} y1={y(max * tick / 4)} y2={y(max * tick / 4)} stroke="#e5e7ef" />
          <text x={85} y={y(max * tick / 4) + 4} textAnchor="end" fontSize={12} fill="#596173">{fmtDb(max * tick / 4)}</text>
        </g>)}
        <text x={95} y={20} fontSize={12} fill="#596173">{unit}</text>
        {years.map((year) => <text key={year} x={x(year)} y={307} textAnchor="middle" fontSize={13} fill="#596173">{year}</text>)}
        {selected.map((country, index) => {
          const series = points.filter((point) => point.country === country);
          return <g key={country}>
            {series.map((point, i) => {
              const previous = series[i - 1];
              return point.value === null ? null : <g key={point.year}>
                {previous?.value != null && <line data-series={country} x1={x(previous.year)} y1={y(previous.value)} x2={x(point.year)} y2={y(point.value)} stroke={CAT[index]} strokeWidth={2.5} strokeDasharray={index ? "7 4" : undefined} />}
                {index ? <rect x={x(point.year) - 4} y={y(point.value) - 4} width={8} height={8} fill={CAT[index]} /> : <circle cx={x(point.year)} cy={y(point.value)} r={4} fill={CAT[index]} />}
                <title>{countryLabel(country)} · {point.year}：{fmtDb(point.value)}</title>
              </g>;
            })}
          </g>;
        })}
      </svg> : <p role="status">该行业没有可用的指标观测，请更换行业、指标或国家。</p>}
      <ComparisonSummary readings={points} countries={selected} years={commonYears} unit={unit} />
      <details className="technical-details"><summary>查看趋势图逐年读数</summary>
        <ScrollableRegion className="table-wrap" label="行业趋势逐年读数"><table className="data-table">
          <thead><tr><th>年份</th>{selected.map((country) => <th key={country}>{countryLabel(country)}</th>)}</tr></thead>
          <tbody>{years.map((year) => <tr key={year}><td>{year}</td>{selected.map((country) => <td key={country}>{fmtDb(points.find((point) => point.year === year && point.country === country)?.value ?? null)}</td>)}</tr>)}</tbody>
        </table></ScrollableRegion>
      </details>
      </>}
    </>}
    <details className="technical-details"><summary>指标口径</summary>
      <p>{schema?.fields[metric]?.desc}</p>
      <p>两国使用同一指标、同一刻度。{view === "trend" ? "横轴为年份；缺失值留空，不跨缺失年份连线。" : "排名按国家 A 排序，不等于综合重要性。"}</p>
      <IcioYearNote years={view === "trend" ? years : [year]} />
      <p>与步骤 5 同源：每年在完整全球国家×行业中间品网络上计算，包含国内联系与正自环。加权流量使用当年价格；拓扑指标未做边阈值敏感性分析。</p>
    </details>
    <section className="qualified-run-card" aria-label="步骤9报告材料">
      <h3>报告材料 · 保存一份两国比较即可</h3>
      <p><b>本次准备保存：</b>{selected.map(countryLabel).join(" 与 ")} · {label}（{unit}）</p>
      <p>{view === "trend" ? `${sectorLabel(industry)} · ${years[0]}–${years.at(-1)} 年趋势` : `${year} 年行业排名 · ${limit === 10 ? "Top 10" : "全部行业"} · 按国家 A 排序`} · {query.status === "success" ? `${pendingObservations.length} 条有效读数` : "等待数据加载"}</p>
      <div className="controls"><button className="primary" disabled={!canRecord || matchesSaved || syncing} onClick={record}>{matchesSaved ? "当前比较已记录" : observations.length ? "更新报告材料" : "保存为报告材料"}</button></div>
      <p role="status">{!canRecord ? view === "trend" ? "尚不能保存：请选择两个不同国家，且两国至少有两个共同有效年份。" : "尚不能保存：请选择两个不同国家，且至少一个展示行业有两国有效读数。" : matchesSaved ? "当前图表与本步材料一致，无需重复记录。" : observations.length ? "当前图表尚未替换已有材料；点击更新后，以本次比较替换下面的记录。" : "点击保存，一次完成比较对象和指标读数的收集，不需要到明细表逐行操作。"}</p>
      {observations.length ? <details>
        <summary>核对已记录读数 · {observations.length} 条</summary>
        <p>{savedCountries.map(countryLabel).join(" 与 ")} · {schema?.fields[observations[0].metric ?? ""]?.label ?? observations[0].metric} · {observations[0].unit}</p>
        <p>{savedYears[0]}{savedYears.length > 1 ? `–${savedYears.at(-1)}` : ""} 年 · {savedIndustries.length === 1 ? sectorLabel(savedIndustries[0]!) : `${savedIndustries.length} 个行业`} · {observations.length} 条读数。浏览、排序和切换视角不会清空它。</p>
        <ScrollableRegion className="table-wrap bounded-data-table" label="已记录报告材料读数"><table className="data-table">
          <thead><tr><th>国家与行业</th><th>年份</th><th>数值</th></tr></thead>
          <tbody>{observations.map((item, index) => <tr key={index}><td>{countryLabel(item.country)} · {sectorLabel(item.industry ?? "")}</td><td>{item.year}</td><td>{fmtDb(item.value)}</td></tr>)}</tbody>
        </table></ScrollableRegion>
      </details> : <p>已有材料：尚未收集。</p>}
      {syncError ? <div role="alert">材料尚未成功同步，请重试。{onRetrySync && <button className="secondary" onClick={onRetrySync}>重试同步</button>}</div> : <p className="muted" role="status">{syncing ? "正在同步实验记录…" : "材料随本步实验记录自动同步；答题完成情况单独检查。"}</p>}
    </section>
  </section>;
}
