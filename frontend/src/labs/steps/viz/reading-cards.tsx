import type { ReactNode } from "react";
import { cjkJoin } from "../../../format";
import { countryLabel, medianSkipReason, sectorLabel } from "../../../viz";
import { finiteValue, NO_RANK, NO_RANK_NOTE, rankText, type CompositionSpec, type YearDistribution } from "./indicator-model";
import { fixedIndicatorNumber, textNumber } from "./indicator-charts";
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
  // Amounts read whole from 10 up; below 10 three decimals, as in the cards ("比它高 3.832 百万美元", not "4").
  const digits = unit === "百万美元" && magnitude >= 10 ? 0 : 3;
  const text = magnitude.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
export function comparisonCards({ rows, countries, metric, label, unit, year, industry, distribution, reasonFor }: {
  rows: Row[]; countries: string[]; metric: string; label: string; unit: string; year: number;
  industry: string; distribution?: YearDistribution;
  /** Why a share cannot be computed for a country (its exports are 0), when that is the reason it is empty. */
  reasonFor?: (country: string) => string | null;
}): ReadingCard[] {
  const [first, ...others] = countries;
  const own = valueOf(rows, first, year, metric, industry);
  const ownReason = own === null ? reasonFor?.(first) : null;
  if (own === null) return [ownReason
    ? { eyebrow: `${countryLabel(first)} · ${year}${industry ? ` · ${sectorLabel(industry)}` : ""}`, big: "无法计算", small: `${label}：${ownReason}` }
    : { eyebrow: `${countryLabel(first)} · ${year}`, big: "缺失", small: `${label}在该年没有有效读数（缺少的数据留空，不当作 0）` }];
  const cards: ReadingCard[] = [{
    eyebrow: `${countryLabel(first)} · ${year}${industry ? ` · ${sectorLabel(industry)}` : ""}`,
    big: textNumber(own, unit),
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
      big: textNumber(distribution.median, unit),
      small: `${countryLabel(first)} ${gapReading(own, distribution.median, unit).replace("它", "中位数")}`,
    });
  }
  for (const other of others) {
    const value = valueOf(rows, other, year, metric, industry);
    const reason = value === null ? reasonFor?.(other) : null;
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)}`,
      big: value === null ? (reason ? "对比国家无法计算" : "对比国家缺失") : `${year} 年 ${countryLabel(first)} ${gapReading(own, value, unit)}`,
      small: value === null ? reason ?? "该国在该年没有有效读数" : `${countryLabel(other)} ${textNumber(value, unit)}；差距不代表因果关系`,
    });
  }
  return cards;
}

/** Composition views: the observed country's largest part and its focus part, and the focus-part gap to each comparison. */
export function compositionCards({ rows, countries, composition, totalLabel, year, industry, amountShown = false }: {
  rows: Row[]; countries: string[]; composition: CompositionSpec; totalLabel: string; year: number; industry: string;
  /** The bars already show amounts: a negative total does not send the student to the 金额 view they are in. */
  amountShown?: boolean;
}): ReadingCard[] {
  const [first, ...others] = countries;
  const share = (country: string, key: string) => {
    const total = valueOf(rows, country, year, composition.total, industry);
    const part = valueOf(rows, country, year, key, industry);
    return total !== null && total > 0 && part !== null ? part / total : null;
  };
  const segments = composition.segments;
  const focus = composition.focus ?? segments[segments.length - 1].key;
  const focusName = segments.find((segment) => segment.key === focus)?.name ?? focus;
  // The cards show the focus part's share, so they carry the indicator's name, not the part's.
  const focusLabel = composition.focusLabel ?? focusName;
  const ownShares = segments.map((segment) => ({ segment, share: share(first, segment.key) }));
  // A total of zero (an industry that does not export at all) or below (negative value added) is not missing
  // data: the shares are undefined, and the card says why.
  const totalCard = (country: string, comparison: boolean): ReadingCard | null => {
    const total = valueOf(rows, country, year, composition.total, industry);
    const prefix = comparison ? `与对比国家 ${countryLabel(country)} · ${focusLabel}` : `${countryLabel(country)} · ${year}`;
    if (total === 0) return { eyebrow: prefix, big: `${comparison ? `${countryLabel(country)} ` : ""}${totalLabel}为 0`, small: "没有可分解的总量，构成份额无定义；可换一个行业或国家" };
    if (total !== null && total < 0) return { eyebrow: prefix, big: `${comparison ? `${countryLabel(country)} ` : ""}${totalLabel}为负`, small: `总量为负（${textNumber(total, "百万美元")} 百万美元），无法算比重${amountShown ? "" : "；切到“金额”可看各分项"}` };
    return null;
  };
  if (ownShares.some((item) => item.share === null)) {
    return [totalCard(first, false)
      ?? { eyebrow: `${countryLabel(first)} · ${year}`, big: "构成不完整", small: "分项或总量缺失，暂不能读出构成（缺少的数据留空，不当作 0）" }];
  }
  const largest = ownShares.reduce((best, item) => (item.share! > best.share! ? item : best));
  const ownFocus = share(first, focus)!;
  const cards: ReadingCard[] = [
    {
      eyebrow: `${countryLabel(first)} · ${year} · 最大分项`,
      big: `${largest.segment.name} ${textNumber(largest.share!, "%")}`,
      small: `占${totalLabel}的比重`,
    },
    {
      eyebrow: `${countryLabel(first)} · ${focusLabel}`,
      big: textNumber(ownFocus, "%"),
      small: `${cjkJoin(focusName, "占")}${totalLabel}的比重`,
    },
  ];
  for (const other of others) {
    const value = share(other, focus);
    const undefinedTotal = value === null ? totalCard(other, true) : null;
    if (undefinedTotal) {
      cards.push(undefinedTotal);
      continue;
    }
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)} · ${focusLabel}`,
      big: value === null ? "对比国家构成不完整" : `${countryLabel(first)} ${gapReading(ownFocus, value, "%")}`,
      small: value === null ? "该国分项或总量缺失" : `${countryLabel(other)} ${fixedIndicatorNumber(value, "%")}；比较的是份额，不是金额`,
    });
  }
  return cards;
}

/** "高于" / "低于" / "等于"; the card appends "中位数". */
const side = (value: number, median: number) =>
  value === median ? "等于" : value > median ? "高于" : "低于";

/** 定位图: where each selected country sits relative to the two medians of the shown economies. */
export function positioningCards({ reference, countries, xKey, yKey, xLabel, yLabel, xFormat, yFormat, xScale = "linear", reasonFor }: {
  reference: Row[]; countries: string[]; xKey: string; yKey: string; xLabel: string; yLabel: string;
  xFormat: "pct" | "number" | "amount"; yFormat: "pct" | "number" | "amount";
  /** A log x axis leaves out economies whose x is 0 or below, as the scatter does. */
  xScale?: "linear" | "log";
  /** Why a country has no point when a share cannot be computed (its exports are 0). */
  reasonFor?: (country: string) => string | null;
}): ReadingCard[] {
  const all = reference
    .filter((row) => finiteValue(row[xKey]) && finiteValue(row[yKey]))
    .map((row) => ({ country: String(row.country), x: row[xKey] as number, y: row[yKey] as number }));
  const points = xScale === "log" ? all.filter((point) => point.x > 0) : all;
  const unitOf = (format: string) => (format === "pct" ? "%" : format === "amount" ? "百万美元" : "无量纲");
  const absent = (country: string): ReadingCard => {
    const reason = reasonFor?.(country);
    const zeroOnLog = all.some((point) => point.country === country && point.x <= 0);
    return {
      eyebrow: countryLabel(country),
      big: "不在图上",
      small: reason ? `${reason}（不是缺少数据）` : zeroOnLog ? `${xLabel}为 0 或负，无法在对数横轴上显示` : "该国缺少其中一项指标的读数",
    };
  };
  // With only a few economies on the chart a median says nothing (one of two points is always "above"), nor
  // when they all sit in one place; the scatter leaves its medians out by the same rule.
  const skipMedian = medianSkipReason(points, "经济体");
  if (skipMedian !== null) {
    return countries.map((country, index) => {
      const point = points.find((item) => item.country === country);
      if (!point) return absent(country);
      return {
        eyebrow: `${index ? "对比国家 " : ""}${countryLabel(country)}`,
        big: `横轴 ${textNumber(point.x, unitOf(xFormat))}，纵轴 ${textNumber(point.y, unitOf(yFormat))}`,
        small: `${skipMedian}，不比较中位数`,
      };
    });
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const xMedian = median(points.map((point) => point.x));
  const yMedian = median(points.map((point) => point.y));
  return countries.map((country, index) => {
    const point = points.find((item) => item.country === country);
    if (!point) return absent(country);
    return {
      eyebrow: `${index ? "对比国家 " : ""}${countryLabel(country)}`,
      big: `${xLabel}${side(point.x, xMedian)}中位数，${yLabel}${side(point.y, yMedian)}中位数`,
      small: `横轴 ${textNumber(point.x, unitOf(xFormat))}，纵轴 ${textNumber(point.y, unitOf(yFormat))}；中位数按图上 ${points.length} 个经济体计算`,
    };
  });
}

/** 段长度对照: which segment and side is longer for the observed economy; GVC-segment gap per comparison. */
export function segmentCards({ rows, countries, year, industry, segments, reasonFor }: {
  rows: Row[]; countries: string[]; year: number; industry: string;
  segments: { key: string; label: string; forward: string; backward: string }[];
  /** Why a length is empty when it is undefined (the segment has no activity), as a whole clause. */
  reasonFor?: (country: string, key: string) => string | null;
}): ReadingCard[] {
  const unit = "长度单位";
  const [first, ...others] = countries;
  const read = (country: string, key: string) => valueOf(rows, country, year, key, industry);
  const own = segments.map((segment) => ({ segment, forward: read(first, segment.forward), backward: read(first, segment.backward) }));
  if (own.every((item) => item.forward === null && item.backward === null)) return [];
  const longest = own.filter((item) => item.forward !== null || item.backward !== null)
    .reduce((best, item) => (Math.max(item.forward ?? -Infinity, item.backward ?? -Infinity) > Math.max(best.forward ?? -Infinity, best.backward ?? -Infinity) ? item : best));
  const longestSide = (longest.forward ?? -Infinity) >= (longest.backward ?? -Infinity) ? "前向" : "后向";
  const gvc = own.find((item) => item.segment.key === "gvc") ?? own[own.length - 1];
  // An empty GVC length with its reason when it is undefined (no GVC production), so it is not called missing.
  const gvcGap = gvc.forward === null || gvc.backward === null
    ? [gvc.forward === null ? gvc.segment.forward : null, gvc.backward === null ? gvc.segment.backward : null]
        .filter((key): key is string => key !== null)
        .map((key) => ({ key, reason: reasonFor?.(first, key) ?? null }))
    : null;
  const cards: ReadingCard[] = [
    {
      eyebrow: `${countryLabel(first)} · ${year} · 最长的一段`,
      big: `${longest.segment.label} · ${longestSide}`,
      small: `${textNumber(longestSide === "前向" ? longest.forward : longest.backward, unit)}；三段长度不能相加，总长度是三段按增加值份额加权的平均`,
    },
    {
      eyebrow: `${countryLabel(first)} · ${gvc.segment.label} · 前向对后向`,
      big: gvcGap ? (gvcGap.every((item) => item.reason) ? "无法计算" : "缺失") : gvc.forward! > gvc.backward! ? "前向更长（更偏上游）" : gvc.forward! < gvc.backward! ? "后向更长（更偏下游）" : "前后向相等",
      small: gvcGap ? gvcGap.map((item) => item.reason ?? "缺失留空").join("；") : `${textNumber(gvc.forward, unit)} 对 ${textNumber(gvc.backward, unit)}`,
    },
  ];
  for (const other of others) {
    const value = read(other, gvc.segment.forward);
    const reason = value === null ? reasonFor?.(other, gvc.segment.forward) ?? null : null;
    const ownReason = gvc.forward === null ? reasonFor?.(first, gvc.segment.forward) ?? null : null;
    cards.push({
      eyebrow: `与对比国家 ${countryLabel(other)} · ${gvc.segment.label}前向`,
      big: value === null ? (reason ? "对比国家无法计算" : "对比国家缺失")
        : gvc.forward === null ? (ownReason ? `${countryLabel(first)} 无法计算` : `${countryLabel(first)} 缺失`)
        : `${countryLabel(first)} ${gapReading(gvc.forward, value, unit)}`,
      small: value === null ? reason ?? "该国在该年没有有效读数" : gvc.forward === null ? ownReason ?? "该国在该年没有有效读数" : `${countryLabel(other)} ${textNumber(value, unit)}；差距不代表因果关系`,
    });
  }
  return cards;
}

/** A level reading with its unit spelled out ("33,672 百万美元"); shares already carry "%". */
const amountWithUnit = (value: number, unit: string) =>
  unit === "%" || !unit ? textNumber(value, unit) : `${textNumber(value, unit)} ${unit}`;

/** 行业排名: the observed country's top industry and, per comparison country, the industry with the widest gap. */
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
    small: `${amountWithUnit(top.values[0]!, unit)}；按 ${countryLabel(first)} 降序，只在显示的行业中比较`,
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
      small: `${countryLabel(first)} ${gapReading(widest.values[0]!, widest.values[index]!, unit)}（${amountWithUnit(widest.values[0]!, unit)} 对 ${amountWithUnit(widest.values[index]!, unit)}）`,
    });
  });
  return cards;
}
