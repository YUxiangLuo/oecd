import { useRef, useState, type KeyboardEvent } from "react";
import { percentagePoints } from "../../format";
import type { TeachingCountriesResponse } from "../../types";
import { useMeasuredWidth } from "../../table-aids";
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

/** An amount in million USD (the ICIO unit) in 亿美元: no decimal from 100 up (248,900 → "2,489"), one decimal from 1
 * to 100 (300 → "3.0"), two significant digits below 1 (13 → "0.13"), and "0" for zero. */
export function yiUsd(millionUsd: number): string {
  const yi = millionUsd / 100;
  if (yi === 0) return "0 亿美元";
  const decimals = Math.abs(yi) >= 100 ? 0 : 1;
  const text = Math.abs(yi) >= 1
    ? yi.toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : String(Number(yi.toPrecision(2)));
  return `${text} 亿美元`;
}

/** A round threshold as set by the rule ("10 亿美元"), not as a reading. */
export function ruleYiUsd(millionUsd: number): string {
  const yi = millionUsd / 100;
  return Number.isInteger(yi) ? `${yi.toLocaleString("zh-CN")} 亿美元` : yiUsd(millionUsd);
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
  return `${ruleYear(rule)}对美货物贸易顺差${relation}${ruleYiUsd(rule.min_million_usd)}`;
}

/** The industry count as short readout lines that fit the 260 px readout: "被加税行业 41 个（样本内共 41 个）" (the
 * total is the country's industries in the regression sample, which can be fewer than 45), and for a taxed
 * country with industries that export nothing to the US, "其中 X > 0 40 个" and "其余 1 个 对美无出口：w = 0". */
export function countryIndustryLines(row: CountryRow): TipLine[] {
  const lines: TipLine[] = [["被加税行业", `${row.taxed ? row.industries : 0} 个（样本内共 ${row.industries} 个）`]];
  if (row.taxed && row.exposed_industries < row.industries) {
    lines.push(["其中 X > 0", `${row.exposed_industries} 个`]);
    lines.push([`其余 ${row.industries - row.exposed_industries} 个`, "对美无出口：w = 0"]);
  }
  return lines;
}

/** The hover and keyboard readout for one country (the aria label says the same in one sentence). */
export function countryTipLines(row: CountryRow, year: number, rule?: TeachingCountriesResponse["taxed_rule"]): TipLine[] {
  const balance = goodsBalance(row, rule);
  return [
    ["", countryLabel(row.country)],
    [`${year} 年各行业平均 X`, `${points(row.mean_exposure)} 个百分点`, row.taxed ? TAXED : UNTAXED],
    ...countryIndustryLines(row),
    ...(balance ? [balance as TipLine] : []),
  ];
}

/** About how tall the readout is (a 12px padding, about 19px a line), to place it above a focused item. */
export function focusTipHeight(lines: readonly TipLine[]): number {
  return 16 + lines.length * 19;
}

/**
 * Step 10's whole-sample view: every taxed country's mean tariff exposure X in the last year as one ranked column of
 * horizontal bars, highest first (one column, so the list never reads as two groups to compare); the untaxed
 * countries, all at X = 0, are one labelled slate group of codes below. The chart is about all countries only: the
 * student's example has its own section and trend below. Every bar and code is a keyboard stop (one tab stop,
 * arrows move) with the same readout as hover; a collapsed table lists all countries.
 */
export function CountryExposureChart({ data }: { data: TeachingCountriesResponse }) {
  const { wrapRef, Tip, show, showFor, hide } = useHoverTip();
  const [activeIndex, setActiveIndex] = useState(0);
  // The focused item draws its own ring (an SVG group shows no outline in every browser).
  const [focused, setFocused] = useState<number | null>(null);
  const nodeRefs = useRef<(Element & { focus: () => void } | null)[]>([]);
  const taxed = data.countries.filter((row) => row.taxed);
  const untaxed = data.countries.filter((row) => !row.taxed);
  // Keyboard order: the taxed bars from the top, then the untaxed codes.
  const order = [...taxed, ...untaxed];
  const rows = Math.max(taxed.length, 1);

  // Drawn at the card's width (600–1,100 units at 1:1), so the bars fill a wide card at the same text size.
  const [measure, measured] = useMeasuredWidth<HTMLDivElement>();
  const width = measured > 0 ? Math.round(Math.min(1100, Math.max(600, measured))) : 600;
  const labelW = 110, valueRoom = 44, rowH = 15, barH = 10, padT = 6, axisH = 34;
  const barW = width - labelW - valueRoom;
  const height = padT + rows * rowH + axisH;
  const { hi, ticks } = niceDomain(0, Math.max(...taxed.map((row) => row.mean_exposure * 100), 1), 4);
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
  // A full sentence under the chart: in words, as the scenario line says it (the tile keeps the compact "≥").
  const ruleText = taxedRuleText(rule, "达到或超过 ");
  const balanceText = (row: CountryRow) => {
    const text = goodsBalanceText(row, rule);
    return text ? `，${text}` : "";
  };
  // The keyboard readout sits under an item in the upper half of the chart and above one in the lower half, so it
  // never covers the rule line and the table summary under the chart (it did for the last rows and the codes).
  const focusTip = (element: Element, lines: TipLine[]) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (wrap && wrap.height > 0 && rect.top < wrap.top + wrap.height / 2) {
      showFor(element, lines);
      return;
    }
    show({ clientX: rect.left + rect.width / 2, clientY: rect.top - focusTipHeight(lines) - 16 }, lines);
  };
  const itemProps = (row: CountryRow, index: number) => ({
    tabIndex: index === activeIndex ? 0 : -1,
    "aria-label": `${countryLabel(row.country)}：${data.year} 年各行业平均 X = ${points(row.mean_exposure)} 个百分点，${countryIndustryNote(row)}${balanceText(row)}；方向键切换国家`,
    onMouseMove: (event: { clientX: number; clientY: number }) => show(event, countryTipLines(row, data.year, rule)),
    onMouseLeave: hide,
    onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index),
    onFocus: (event: { currentTarget: Element }) => {
      setActiveIndex(index);
      setFocused(index);
      focusTip(event.currentTarget, countryTipLines(row, data.year, rule));
    },
    onBlur: () => { setFocused(null); hide(); },
  });

  const bars = taxed.map((row, index) => {
    const y = padT + index * rowH;
    const pp = row.mean_exposure * 100;
    return (
      <g key={row.country} data-country={row.country}
        ref={(node) => { nodeRefs.current[index] = node; }}
        role="graphics-symbol" className="country-exposure-bar" {...itemProps(row, index)}>
        {/* The whole row is the hit target, wider than the bar. */}
        <rect x={0} y={y} width={width} height={rowH} rx={4}
          fill="transparent" stroke={focused === index ? "#4b47e0" : "none"} strokeWidth={1.5} />
        <text x={labelW - 6} y={y + rowH / 2 + 3.8} textAnchor="end" fontSize={11} fontWeight={500} fill="#3a4050">{countryLabel(row.country)}</text>
        <rect x={labelW} y={y + (rowH - barH) / 2} width={Math.max(scale(pp), 1.5)} height={barH} rx={2} fill={TAXED} />
        <text x={labelW + scale(pp) + 4} y={y + rowH / 2 + 3.6} fontSize={10.5} fill="#3a4050"
          style={{ fontVariantNumeric: "tabular-nums" }}>{points(row.mean_exposure)}</text>
      </g>
    );
  });

  const axis = (
    <g aria-hidden="true">
      {ticks.map((tick) => {
        const x = labelW + scale(tick);
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
        <span><i className="line" style={{ background: UNTAXED }} />未被加税（{untaxed.length} 国，X = 0，列在图下）</span>
      </div>
      {taxed.length > 0 && (
        <div ref={measure}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} style={{ display: "block", width: "100%", maxWidth: width, height: "auto" }}>
          {axis}
          {bars}
          <text x={labelW + barW / 2} y={height - 4} textAnchor="middle" fontSize={10.5} fill="#5f6677">{axisTitle}</text>
        </svg>
        </div>
      )}
      {untaxed.length > 0 && (
        <div className="country-exposure-untaxed" role="group" aria-label={`${untaxed.length} 国未被加税，X = 0`}>
          <b><i style={{ background: UNTAXED }} aria-hidden="true" />{untaxed.length} 国未被加税（X = 0）</b>
          <span className="country-exposure-codes">
            {untaxed.map((row, i) => {
              const index = taxed.length + i;
              return (
                <span key={row.country} data-country={row.country}
                  ref={(node) => { nodeRefs.current[index] = node; }}
                  role="graphics-symbol" {...itemProps(row, index)}>
                  {row.country}
                </span>
              );
            })}
          </span>
        </div>
      )}
      {/* The rule and the imposer are stated once, in the policy line above the chart. */}
      <p className="country-exposure-note">悬停或用方向键查看每个国家的 X{ruleText ? " 与对美货物顺差" : ""}。</p>
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
