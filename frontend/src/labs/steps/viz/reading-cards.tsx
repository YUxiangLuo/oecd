import type { ReactNode } from "react";
import { countryLabel, sectorLabel } from "../../../viz";
import { finiteValue, NO_RANK, NO_RANK_NOTE, rankText, type IndicatorTopic, type YearDistribution } from "./indicator-model";
import { indicatorNumber } from "./indicator-charts";
import type { Row } from "./scaffold";

/* Reading cards (design doc 4.5): every view ends with the same three-sentence frame under its chart:
 * the observed country → its place among all economies → the gap to each comparison country.
 * The trend view keeps its own TrendSummary; these cover the other views. */

export interface ReadingCard {
  eyebrow: string;
  big: ReactNode;
  small?: ReactNode;
}

export function ReadingCards({ label, cards }: { label: string; cards: ReadingCard[] }) {
  if (!cards.length) return null;
  return (
    <div className="comparison-summary" role="group" aria-label={label}>
      {cards.map((card, index) => (
        <div key={index}>
          <span>{card.eyebrow}</span>
          <b>{card.big}</b>
          {card.small && <small>{card.small}</small>}
        </div>
      ))}
    </div>
  );
}

/** "比它高 3.2 个百分点" / "与它持平"; shares are read in percentage points. */
export function gapReading(first: number, other: number, unit: string): string {
  const difference = first - other;
  if (difference === 0) return "与它持平";
  const magnitude = Math.abs(difference) * (unit === "%" ? 100 : 1);
  const digits = unit === "百万美元" && magnitude >= 1 ? 0 : 3;
  const text = magnitude.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  if (text === "0") return "与它基本持平";
  const suffix = unit === "%" ? " 个百分点" : unit === "无量纲" ? "" : ` ${unit}`;
  return `比它${difference > 0 ? "高" : "低"} ${text}${suffix}`;
}

const valueOf = (rows: Row[], country: string, year: number, metric: string, industry = "") => {
  const value = rows.find(
    (row) => row.country === country && row.year === year && String(row.industry ?? "") === industry,
  )?.[metric];
  return finiteValue(value) ? value : null;
};

/** 国家对比 view: the observed country's reading and rank, the global median, the gap to each comparison. */
export function comparisonCards({ rows, countries, metric, label, unit, year, industry, distribution }: {
  rows: Row[]; countries: string[]; metric: string; label: string; unit: string; year: number;
  industry: string; distribution?: YearDistribution;
}): ReadingCard[] {
  const [first, ...others] = countries;
  const own = valueOf(rows, first, year, metric, industry);
  if (own === null) return [{ eyebrow: `${countryLabel(first)} · ${year}`, big: "缺失", small: `${label}在该年没有有效读数（缺失不补零）` }];
  const cards: ReadingCard[] = [{
    eyebrow: `${countryLabel(first)} · ${year}${industry ? ` · ${sectorLabel(industry)}` : ""}`,
    big: indicatorNumber(own, unit),
    small: label,
  }];
  if (distribution) {
    const rank = distribution.ranks[first];
    const text = rank == null ? null : rankText(rank, distribution.ties?.[first], distribution.n);
    cards.push({
      eyebrow: "在全部经济体中（从高到低）",
      big: rank == null ? "未参与排名" : text ?? NO_RANK,
      small: rank == null ? "该国当年没有国家整体读数" : text ? `共 ${distribution.n} 个经济体；排名只表示相对高低` : NO_RANK_NOTE,
    });
    cards.push({
      eyebrow: `全球中位数 · ${year}`,
      big: indicatorNumber(distribution.median, unit),
      small: `${countryLabel(first)} ${gapReading(own, distribution.median, unit).replace("它", "中位数")}`,
    });
  }
  for (const other of others) {
    const value = valueOf(rows, other, year, metric, industry);
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)}`,
      big: value === null ? "对比国家缺失" : `${year} 年 ${countryLabel(first)} ${gapReading(own, value, unit)}`,
      small: value === null ? "该国在该年没有有效读数" : `${countryLabel(other)} ${indicatorNumber(value, unit)}；差距不代表因果关系`,
    });
  }
  return cards;
}

/** Composition views: the observed country's largest part and its focus part, and the focus-part gap to each comparison. */
export function compositionCards({ rows, countries, topic, year, industry }: {
  rows: Row[]; countries: string[]; topic: IndicatorTopic; year: number; industry: string;
}): ReadingCard[] {
  const composition = topic.composition;
  if (!composition) return [];
  const [first, ...others] = countries;
  const share = (country: string, key: string) => {
    const total = valueOf(rows, country, year, composition.total, industry);
    const part = valueOf(rows, country, year, key, industry);
    return total !== null && total > 0 && part !== null ? part / total : null;
  };
  const segments = composition.segments;
  const focus = composition.focus ?? segments[segments.length - 1].key;
  const focusName = segments.find((segment) => segment.key === focus)?.name ?? focus;
  const ownShares = segments.map((segment) => ({ segment, share: share(first, segment.key) }));
  if (ownShares.some((item) => item.share === null)) {
    return [{ eyebrow: `${countryLabel(first)} · ${year}`, big: "构成不完整", small: "分项或总量缺失，暂不能读出构成（缺失不补零）" }];
  }
  const largest = ownShares.reduce((best, item) => (item.share! > best.share! ? item : best));
  const ownFocus = share(first, focus)!;
  const cards: ReadingCard[] = [
    {
      eyebrow: `${countryLabel(first)} · ${year} · 最大分项`,
      big: `${largest.segment.name} ${indicatorNumber(largest.share!, "%")}`,
      small: `占${topic.metrics.find((item) => item.key === composition.total)?.label ?? "总量"}的比重`,
    },
    {
      eyebrow: `${countryLabel(first)} · ${focusName}`,
      big: indicatorNumber(ownFocus, "%"),
      small: "本步重点分项占总量的比重",
    },
  ];
  for (const other of others) {
    const value = share(other, focus);
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)} · ${focusName}`,
      big: value === null ? "对比国家构成不完整" : `${countryLabel(first)} ${gapReading(ownFocus, value, "%")}`,
      small: value === null ? "该国分项或总量缺失" : `${countryLabel(other)} ${indicatorNumber(value, "%")}；比较的是份额，不是金额`,
    });
  }
  return cards;
}

const side = (value: number, median: number, high: string, low: string) =>
  value === median ? "等于中位数" : value > median ? high : low;

/** 定位图: where each selected country sits relative to the two medians of the shown economies. */
export function positioningCards({ reference, countries, xKey, yKey, xLabel, yLabel, xFormat, yFormat }: {
  reference: Row[]; countries: string[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  xFormat: "pct" | "number"; yFormat: "pct" | "number";
}): ReadingCard[] {
  const points = reference
    .filter((row) => finiteValue(row[xKey]) && finiteValue(row[yKey]))
    .map((row) => ({ country: String(row.country), x: row[xKey] as number, y: row[yKey] as number }));
  if (points.length < 2) return [];
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const xMedian = median(points.map((point) => point.x));
  const yMedian = median(points.map((point) => point.y));
  const unitOf = (format: string) => (format === "pct" ? "%" : "无量纲");
  return countries.map((country, index) => {
    const point = points.find((item) => item.country === country);
    if (!point) return { eyebrow: countryLabel(country), big: "不在图上", small: "该国缺少其中一项指标的读数" };
    return {
      eyebrow: `${index ? "对比国家 " : ""}${countryLabel(country)}`,
      big: `${xLabel}${side(point.x, xMedian, "高于", "低于")}中位数，${yLabel}${side(point.y, yMedian, "高于", "低于")}中位数`,
      small: `${indicatorNumber(point.x, unitOf(xFormat))} × ${indicatorNumber(point.y, unitOf(yFormat))}；中位数按图上 ${points.length} 个经济体计算`,
    };
  });
}

/** 定位行业: the observed country's top industry and, per comparison country, the industry with the widest gap. */
export function industryCards({ groups, countries, label, unit }: {
  groups: { key: string; label: string; values: (number | null)[] }[]; countries: string[]; label: string; unit: string;
}): ReadingCard[] {
  const [first, ...others] = countries;
  const own = groups.filter((group) => group.values[0] !== null);
  if (!own.length) return [];
  const top = own.reduce((best, group) => (group.values[0]! > best.values[0]! ? group : best));
  const cards: ReadingCard[] = [{
    eyebrow: `${countryLabel(first)} · ${label}最高的行业`,
    big: top.label,
    small: `${indicatorNumber(top.values[0], unit)}；按 ${countryLabel(first)} 降序，只在显示的行业中比较`,
  }];
  others.forEach((other, offset) => {
    const index = offset + 1;
    const paired = own.filter((group) => group.values[index] !== null);
    if (!paired.length) {
      cards.push({ eyebrow: `与对比国家 ${countryLabel(other)}`, big: "没有可配对的行业", small: "该国在显示的行业中没有有效读数" });
      return;
    }
    const widest = paired.reduce((best, group) =>
      Math.abs(group.values[0]! - group.values[index]!) > Math.abs(best.values[0]! - best.values[index]!) ? group : best,
    );
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)} · 差距最大的行业`,
      big: widest.label,
      small: `${countryLabel(first)} ${gapReading(widest.values[0]!, widest.values[index]!, unit)}（${indicatorNumber(widest.values[0], unit)} 对 ${indicatorNumber(widest.values[index], unit)}）`,
    });
  });
  return cards;
}
