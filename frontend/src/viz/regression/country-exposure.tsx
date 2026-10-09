import { useRef, useState, type KeyboardEvent } from "react";
import { percentagePoints } from "../../format";
import type { TeachingCountriesResponse } from "../../types";
import { useHoverTip, type TipLine } from "../hover";
import { niceDomain } from "../nice-ticks";
import { countryLabel } from "../shared";
import { TAXED, UNTAXED, ZERO_LINE } from "./palette";

type CountryRow = TeachingCountriesResponse["countries"][number];

/** X in percentage points as step 10 prints it; an exact zero reads "0". */
const points = (share: number) => (share === 0 ? "0" : percentagePoints(share));

/** "44/44 个行业被加税", plus how many of a taxed country's industries have X > 0 when some export nothing to the US. */
export function countryIndustryNote(row: CountryRow): string {
  if (!row.taxed) return `0/${row.industries} 个行业被加税`;
  const base = `${row.industries}/${row.industries} 个行业被加税`;
  return row.exposed_industries < row.industries
    ? `${base}（${row.exposed_industries} 个 X > 0，其余对美无出口：w = 0）`
    : base;
}

/** An amount in million USD (the ICIO unit) in 亿美元: 1,000 → "10 亿美元", 248,900 → "2,489 亿美元". */
export function yiUsd(millionUsd: number): string {
  const yi = millionUsd / 100;
  const digits = Math.abs(yi) >= 100 ? 0 : Math.abs(yi) >= 1 || yi === 0 ? 1 : 2;
  return `${yi.toLocaleString("zh-CN", { maximumFractionDigits: digits })} 亿美元`;
}

/** The year the taxed rule reads the goods balance in, as a phrase ("2016 年"; "首年" from an older server). */
const ruleYear = (rule: TeachingCountriesResponse["taxed_rule"]) => (rule?.year ? `${rule.year} 年` : "首年");

/** A country's goods balance with the US in the rule's year, as ["2016 年对美货物顺差", "2,489 亿美元"] (or "逆差");
 * undefined when the server sent no balance. */
export function goodsBalance(row: Pick<CountryRow, "market_goods_surplus">, rule: TeachingCountriesResponse["taxed_rule"]): [string, string] | undefined {
  const surplus = row.market_goods_surplus;
  if (typeof surplus !== "number" || !Number.isFinite(surplus)) return undefined;
  return [`${ruleYear(rule)}对美货物${surplus < 0 ? "逆差" : "顺差"}`, yiUsd(Math.abs(surplus))];
}

/** "2016 年对美货物顺差 2,489 亿美元" (or "逆差 …"); undefined when the server sent no balance. */
export function goodsBalanceText(row: Pick<CountryRow, "market_goods_surplus">, rule: TeachingCountriesResponse["taxed_rule"]): string | undefined {
  return goodsBalance(row, rule)?.join(" ");
}

/** The data rule behind who is taxed, "2016 年对美货物贸易顺差 ≥ 10 亿美元"; undefined from an older server. */
export function taxedRuleText(rule: TeachingCountriesResponse["taxed_rule"], relation = " ≥ "): string | undefined {
  if (!rule || typeof rule.min_million_usd !== "number" || !Number.isFinite(rule.min_million_usd)) return undefined;
  return `${ruleYear(rule)}对美货物贸易顺差${relation}${yiUsd(rule.min_million_usd)}`;
}

/** The readout for one country, shared by hover, keyboard focus and the aria label. */
export function countryTipLines(row: CountryRow, year: number, rule?: TeachingCountriesResponse["taxed_rule"]): TipLine[] {
  const balance = goodsBalance(row, rule);
  return [
    ["", countryLabel(row.country)],
    [`${year} 年各行业平均 X`, `${points(row.mean_exposure)} 个百分点`, row.taxed ? TAXED : UNTAXED],
    ["行业", countryIndustryNote(row)],
    ...(balance ? [balance as TipLine] : []),
  ];
}

/** Taxed countries split into two side-by-side columns (left: ranks 1…half, right: the rest), highest first. */
export function splitColumns<T>(rows: readonly T[]): [T[], T[]] {
  const half = Math.ceil(rows.length / 2);
  return [rows.slice(0, half), rows.slice(half)];
}

/**
 * Step 10's whole-sample view: every taxed country's mean tariff exposure X in the last year, sorted from the
 * highest, as horizontal bars in two columns on one shared scale (so 44 named bars fit at 1024 px without rotated
 * labels); the untaxed countries, all at X = 0, are one labelled slate group of codes below. The example countries
 * (A, B) are marked. Every bar and code is a keyboard stop (one tab stop, arrows move) with the same readout as
 * hover; a collapsed table lists all countries.
 */
export function CountryExposureChart({ data, highlight = [] }: {
  data: TeachingCountriesResponse;
  /** The example countries in order (A, then B); either may be absent from the sample. */
  highlight?: readonly string[];
}) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [activeIndex, setActiveIndex] = useState(0);
  // The focused item draws its own ring (an SVG group shows no outline in every browser).
  const [focused, setFocused] = useState<number | null>(null);
  const nodeRefs = useRef<(Element & { focus: () => void } | null)[]>([]);
  const taxed = data.countries.filter((row) => row.taxed);
  const untaxed = data.countries.filter((row) => !row.taxed);
  // Keyboard order: the taxed bars as read (left column, then right), then the untaxed codes.
  const order = [...taxed, ...untaxed];
  const badge = (country: string) => (highlight[0] === country ? "A" : highlight[1] === country ? "B" : null);
  const [left, right] = splitColumns(taxed);
  const rows = Math.max(left.length, 1);

  const width = 700, gutter = 28, colW = (width - gutter) / 2;
  const labelW = 106, valueRoom = 42, rowH = 17, barH = 11, padT = 6, axisH = 34;
  const barW = colW - labelW - valueRoom;
  const height = padT + rows * rowH + axisH;
  const { hi, ticks } = niceDomain(0, Math.max(...taxed.map((row) => row.mean_exposure * 100), 1), 3);
  const scale = (pp: number) => (pp / hi) * barW;

  const focusAt = (index: number) => {
    setActiveIndex(index);
    nodeRefs.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(order.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    focusAt(next);
  };
  const rule = data.taxed_rule;
  const ruleText = taxedRuleText(rule);
  const balanceText = (row: CountryRow) => {
    const text = goodsBalanceText(row, rule);
    return text ? `，${text}` : "";
  };
  const itemProps = (row: CountryRow, index: number) => ({
    tabIndex: index === activeIndex ? 0 : -1,
    "aria-label": `${countryLabel(row.country)}${badge(row.country) ? `（例子 ${badge(row.country)}）` : ""}：${data.year} 年各行业平均 X = ${points(row.mean_exposure)} 个百分点，${countryIndustryNote(row)}${balanceText(row)}；方向键切换国家`,
    onMouseMove: (event: { clientX: number; clientY: number }) => show(event, countryTipLines(row, data.year, rule)),
    onMouseLeave: hide,
    onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index),
    onFocus: (event: { currentTarget: Element }) => {
      setActiveIndex(index);
      setFocused(index);
      showFor(event.currentTarget, countryTipLines(row, data.year, rule));
    },
    onBlur: () => { setFocused(null); hide(); },
  });

  const column = (items: CountryRow[], offsetX: number, startIndex: number) => items.map((row, i) => {
    const index = startIndex + i;
    const y = padT + i * rowH;
    const pp = row.mean_exposure * 100;
    const end = offsetX + labelW + scale(pp);
    const mark = badge(row.country);
    const label = countryLabel(row.country);
    return (
      <g key={row.country} data-country={row.country} data-highlight={mark ?? undefined}
        ref={(node) => { nodeRefs.current[index] = node; }}
        role="graphics-symbol" className="country-exposure-bar" {...itemProps(row, index)}>
        {/* The whole row is the hit target, wider than the bar. */}
        <rect x={offsetX} y={y} width={colW} height={rowH} rx={4}
          fill={mark ? "#fff1e3" : "transparent"} stroke={focused === index ? "#4b47e0" : "none"} strokeWidth={1.5} />
        {mark && <g aria-hidden="true">
          <circle cx={offsetX + 8} cy={y + rowH / 2} r={6.5} fill={ZERO_LINE} />
          <text x={offsetX + 8} y={y + rowH / 2 + 3.3} textAnchor="middle" fontSize={9} fontWeight={800} fill="#fff">{mark}</text>
        </g>}
        <text x={offsetX + labelW - 6} y={y + rowH / 2 + 3.8} textAnchor="end" fontSize={11}
          fontWeight={mark ? 800 : 500} fill={mark ? "#1b1f2b" : "#3a4050"}>{label}</text>
        <rect x={offsetX + labelW} y={y + (rowH - barH) / 2} width={Math.max(scale(pp), 1.5)} height={barH} rx={2}
          fill={TAXED} fillOpacity={mark || highlight.length === 0 ? 1 : 0.82}
          stroke={mark ? ZERO_LINE : "none"} strokeWidth={mark ? 1.2 : 0} />
        <text x={end + 4} y={y + rowH / 2 + 3.6} fontSize={10.5} fill="#3a4050" fontWeight={mark ? 800 : 400}
          style={{ fontVariantNumeric: "tabular-nums" }}>{points(row.mean_exposure)}</text>
      </g>
    );
  });

  const axis = (offsetX: number) => (
    <g aria-hidden="true">
      {ticks.map((tick) => {
        const x = offsetX + labelW + scale(tick);
        return <g key={tick}>
          <line x1={x} x2={x} y1={padT} y2={padT + rows * rowH} stroke={tick === 0 ? ZERO_LINE : "#eceef3"} strokeWidth={1} />
          <text x={x} y={padT + rows * rowH + 13} textAnchor="middle" fontSize={10} fill="#5f6677">{tick}</text>
        </g>;
      })}
    </g>
  );
  const top = taxed[0], bottom = taxed.at(-1);
  const summary = top && bottom
    ? `${taxed.length} 个被加税国家的关税暴露 X（${data.year} 年各行业平均，个百分点），从高到低：最高 ${countryLabel(top.country)} ${points(top.mean_exposure)}，最低 ${countryLabel(bottom.country)} ${points(bottom.mean_exposure)}；另有 ${untaxed.length} 国未被加税，X = 0`
    : `${untaxed.length} 国未被加税，X = 0`;
  const axisTitle = `${data.year} 年各行业平均 X（个百分点）`;
  const showBalance = data.countries.some((row) => goodsBalance(row, rule) !== undefined);

  return (
    <div ref={wrapRef} className="hover-wrap country-exposure">
      <div className="country-exposure-legend" aria-hidden="true">
        <span><i style={{ background: TAXED }} />被加税（{taxed.length} 国，按 X 从高到低）</span>
        <span><i className="line" style={{ background: UNTAXED }} />未被加税（{untaxed.length} 国，X = 0）</span>
        {highlight.length > 0 && <span><b className="country-exposure-badge">A</b>{highlight[1] ? <b className="country-exposure-badge">B</b> : null}你跟踪的例子</span>}
      </div>
      {taxed.length > 0 && (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}          style={{ display: "block", width: "100%", maxWidth: 820, height: "auto" }}>
          {axis(0)}
          {right.length > 0 && axis(colW + gutter)}
          {column(left, 0, 0)}
          {column(right, colW + gutter, left.length)}
          <text x={labelW + barW / 2} y={height - 4} textAnchor="middle" fontSize={10.5} fill="#5f6677">{axisTitle}</text>
          {right.length > 0 && <text x={colW + gutter + labelW + barW / 2} y={height - 4} textAnchor="middle" fontSize={10.5} fill="#5f6677">{axisTitle}</text>}
        </svg>
      )}
      {untaxed.length > 0 && (
        <div className="country-exposure-untaxed" role="group" aria-label={`${untaxed.length} 国未被加税，X = 0`}>
          <b><i style={{ background: UNTAXED }} aria-hidden="true" />{untaxed.length} 国未被加税（X = 0）</b>
          <span className="country-exposure-codes">
            {untaxed.map((row, i) => {
              const index = taxed.length + i;
              const mark = badge(row.country);
              return (
                <span key={row.country} data-country={row.country} data-highlight={mark ?? undefined}
                  ref={(node) => { nodeRefs.current[index] = node; }}
                  role="graphics-symbol" className={mark ? "selected" : undefined} {...itemProps(row, index)}>
                  {mark && <b className="country-exposure-badge" aria-hidden="true">{mark}</b>}{row.country}
                </span>
              );
            })}
          </span>
        </div>
      )}
      {ruleText && <p className="country-exposure-rule">被加税的规则来自 ICIO 数据：{ruleText}。</p>}
      <p className="country-exposure-note">
        {countryLabel(data.market)} 是加征关税的一方，不在样本中，图上没有它。悬停或用方向键查看每个国家{ruleText ? "的 X 与对美货物顺差" : ""}。
      </p>
      <details className="country-exposure-table">
        <summary>{data.countries.length} 国读数表</summary>
        <table className="data-table">
          <thead><tr><th>国家</th><th>是否被加税</th><th>{data.year} 年各行业平均 X（个百分点）</th><th>X &gt; 0 的行业</th>{showBalance && <th>{ruleYear(rule)}对美货物顺差（负数为逆差）</th>}</tr></thead>
          <tbody>{data.countries.map((row) => <tr key={row.country}>
            <td>{countryLabel(row.country)}</td><td>{row.taxed ? "被加税" : "未被加税"}</td>
            <td>{points(row.mean_exposure)}</td><td>{row.exposed_industries}/{row.industries}</td>
            {showBalance && <td>{typeof row.market_goods_surplus === "number" && Number.isFinite(row.market_goods_surplus) ? yiUsd(row.market_goods_surplus) : "—"}</td>}
          </tr>)}</tbody>
        </table>
      </details>
      {Tip}
    </div>
  );
}
