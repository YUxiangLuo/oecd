/**
 * 步骤2-5 的交互式「计算方法演示」组件。
 *
 * DecompositionDemo(步骤2/3/4):用真实指标数据把总量拆成各分项,
 *   实时校验恒等式(加总 = 总出口 / 总增加值 / 总生产长度),每项可 hover 看含义。
 *   恒等式口径与后端引擎及公开文献一致:
 *     步骤2 总出口 = 五类 WWZ 聚合项 + OECD TLS 扩展项 taxsub
 *     步骤3 SVA = 纯国内 + 传统贸易 + 简单 GVC + 复杂 GVC(WWYZ 2017a)
 *     步骤4 PLv = 各段长度按对应增加值份额的加权平均(WWYZ 2017b;
 *           分项显示为"VA份额×段长度"的贡献值,贡献加总 = 总长度)
 * NetworkCentralityDemo(步骤5):在一个小网络上演示度/介数中心性怎么算出来。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LabeledControl, ScrollableRegion } from "./a11y";
import {
  buildDecompositionModel,
  decompositionDomainRows,
  decompositionRequestKey,
  directZeroTotalKind,
  explicitDemoCountry,
  finiteNumber,
  type DecompositionModel,
} from "./decomposition-model";
import { cjkJoin, cjkSpace, formatMetric, stripNegativeZero } from "./format";
import { api } from "./api";
import { AsyncStateMessage, type AsyncStatus, useAsync } from "./labs/shared";
import { userFacingRequestError } from "./user-facing-error";
import { countryLabel, sectorLabel } from "./viz";
import { COMPONENT_COLORS } from "./viz/shared";
import { signedDomain, signedStack } from "./viz/signed-layout";
import { PATH_UNDEFINED_LABEL } from "./viz/views/network-heat";
import type { IndustryPage, Meta } from "./types";
import { segmentIdentityNote } from "./production-length-notes";
import { NEGATIVE_VALUE_ADDED_CAUSE, NEGATIVE_VALUE_ADDED_NOTE } from "./value-added-notes";

type Row = Record<string, string | number | null>;
type DecompositionSideData = { countryRows: Row[]; page: IndustryPage };

type Part = {
  key: string;
  label: string;
  color: string;
  desc: string;
  /** Plain name for the formula line; without it the line shows the code (the label's first word). */
  short?: string;
  /** 加权模式:分项贡献 = row[key] × row[weightKey] / row[weightTotal](见步骤4) */
  weightKey?: string;
};
/** Steps 2–4: the decomposition demo's 国家整体／单个行业 and industry, saved as browsing state (not report material). */
export interface DecompositionView {
  level: "country" | "sector";
  industry: string;
}

type DecompCfg = {
  /** Heading of the hands-on card. */
  title: string;
  total: string;
  totalLabel: string;
  unit: "amount" | "number";
  parts: Part[];
  /** 加权模式的权重分母(如 SVA);设置后各分项按 VA 份额加权 */
  weightTotal?: string;
  /** `decimals`: the panel's amount precision ({@link panelAmountDecimals}), so a sum line reads like the table. */
  note?: (r: Row, values: number[], decimals?: number) => string;
  /** What a negative part means here (the table's default names net subsidies, which fits step 2's taxsub). */
  negativeNote?: string;
};

export const DECOMP: Record<number, DecompCfg> = {
  4: {
    title: "各分项的金额、占比与含义",
    total: "gross_exports",
    totalLabel: "总出口",
    unit: "amount",
    parts: [
      { key: "DVAex", label: "DVAex 国内增加值出口", color: COMPONENT_COLORS.DVAex, desc: "出口中由本国创造、在国外被最终使用的增加值。" },
      { key: "DVArt", label: "DVArt 返回国内的增加值", color: COMPONENT_COLORS.DVArt, desc: "随出口离境，经他国加工后返回本国并被最终使用的国内增加值。" },
      { key: "DDC", label: "DDC 国内重复计算", color: COMPONENT_COLORS.DDC, desc: "本国增加值在出口统计中被重复计入的部分（中间品多次跨境造成）。" },
      { key: "FVA", label: "FVA 外国增加值", color: COMPONENT_COLORS.FVA, desc: "出口中由其他国家创造的增加值（例如进口零部件的价值），不包括外国重复计算 FDC。" },
      { key: "FDC", label: "FDC 外国重复计算", color: COMPONENT_COLORS.FDC, desc: "外国增加值在出口统计中被重复计入的部分。" },
      { key: "taxsub", label: "taxsub 产品税减补贴", color: COMPONENT_COLORS.taxsub, desc: "出口中直接和间接包含的产品税减补贴（来自 ICIO 的 TLS 账户）。可为负，表示净补贴。" },
    ],
    note: (_r, values, decimals) =>
      `出口中的国内增加值合计（EXDVA）= DVAex + DVArt = ${sumText(values[0], values[1], decimals)}。` +
      `taxsub 是本系统另加的一项，不属于 WWZ 原方法。`,
  },
  5: {
    title: "各分项的金额、占比与含义",
    total: "SVA",
    totalLabel: "总增加值 SVA",
    unit: "amount",
    parts: [
      { key: "1_VA_D", label: "1_VA_D 纯国内增加值", short: "纯国内", color: COMPONENT_COLORS.domestic, desc: "增加值只服务本国最终需求，完全不跨境。" },
      { key: "2_VA_RT", label: "2_VA_RT 传统贸易增加值", short: "传统贸易", color: COMPONENT_COLORS.traditional, desc: "增加值随最终产品直接出口，只跨境一次。" },
      { key: "3a_VA_GVC_S", label: "3a_VA_GVC_S 简单 GVC 增加值", short: "简单 GVC", color: COMPONENT_COLORS.simpleGvc, desc: "增加值随中间品跨境一次后，在国外被最终使用。" },
      { key: "3b_VA_GVC_C", label: "3b_VA_GVC_C 复杂 GVC 增加值", short: "复杂 GVC", color: COMPONENT_COLORS.complexGvc, desc: "增加值至少两次跨越国境。" },
    ],
    negativeNote: "负值表示这部分增加值为负，不等于利润为负，所以其他分项的比重之和可能超过 100%。",
    // The backward decomposition (FGY, step 7) is introduced once, in the method section above.
    note: (_r, values, decimals) => `GVC 合计（3_VA_GVC）= 简单 GVC + 复杂 GVC = ${sumText(values[2], values[3], decimals)}。`,
  },
  6: {
    title: "各段对总长度的贡献",
    total: "PLv",
    totalLabel: "前向总生产长度 PLv",
    unit: "number",
    weightTotal: "SVA",
    parts: [
      { key: "PLv_D", label: "纯国内加权贡献", short: "纯国内", color: COMPONENT_COLORS.domestic, desc: "纯国内这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献。", weightKey: "1_VA_D" },
      { key: "PLv_RT", label: "传统贸易加权贡献", short: "传统贸易", color: COMPONENT_COLORS.traditional, desc: "传统贸易这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献。", weightKey: "2_VA_RT" },
      { key: "PLv_GVC", label: "GVC 加权贡献", short: "GVC", color: COMPONENT_COLORS.gvc, desc: "GVC 这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献；段长度和贡献不是同一个数。", weightKey: "3_VA_GVC" },
    ],
    note: (r) => `${segmentLengths(r)}（上表是这些长度乘以增加值份额后的贡献）。`,
  },
};

const FORWARD_SEGMENTS = [["PLv_D", "1_VA_D", "纯国内"], ["PLv_RT", "2_VA_RT", "传统贸易"], ["PLv_GVC", "3_VA_GVC", "GVC"]] as const;
const BACKWARD_SEGMENTS = [["PLy_D", "1_FGY_D", "纯国内"], ["PLy_RT", "2_FGY_RT", "传统贸易"], ["PLy_GVC", "3_FGY_GVC", "GVC"]] as const;

/** Step 4: segment lengths remain readable where SVA ≤ 0 blocks the displayed share-weighted split. */
export const hasForwardSegmentLength = (r: Row) => FORWARD_SEGMENTS.some(([lengthKey]) => finiteNumber(r[lengthKey]) != null);
const hasBackwardSegmentLength = (r: Row) => BACKWARD_SEGMENTS.some(([lengthKey]) => finiteNumber(r[lengthKey]) != null);

/** Step 4: "前向各段长度：纯国内 …、传统贸易 …、GVC …" (backward: "后向各段长度：…"). */
export function segmentLengths(r: Row, direction: "前向" | "后向" = "前向"): string {
  const keys = direction === "前向" ? FORWARD_SEGMENTS : BACKWARD_SEGMENTS;
  const segment = (lengthKey: string, weightKey: string) => {
    const length = finiteNumber(r[lengthKey]);
    if (length != null) return length.toFixed(3);
    return finiteNumber(r[weightKey]) === 0 ? "—（无此类活动）" : "—";
  };
  return `${direction}各段长度：${keys.map(([lengthKey, weightKey, name]) => `${name} ${segment(lengthKey, weightKey)}`).join("、")}`;
}

/** A negative part keeps its own colour (so parts stay distinguishable) striped with the negative red. */
export function negativeFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 5px, #e34948 5px 8px)`;
}

/** Decimals an amount is read to in steps 2–3 (table rows, the total, the sum line and formulas), so the shown
 * parts add up to the shown total within its last digit: three below 10, two below 1,000 ("15.40", not "15" next to
 * a total of "99.90"), one below 10,000 ("3,829.7") and whole millions from 10,000 up. A real but tiny flow reads
 * "<0.001" rather than "0". Lengths are read to three decimals; an exact zero is "0". Beside a share table this is
 * only where a panel starts: {@link panelAmountDecimals} adds decimals until every row checks by hand. */
export function amountDecimals(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude < 10 ? 3 : magnitude < 1_000 ? 2 : magnitude < 10_000 ? 1 : 0;
}

function amountText(value: number, decimals: number): string {
  return stripNegativeZero(value.toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
}

export function fmt(v: number, unit: "amount" | "number"): string {
  if (v === 0) return "0";
  if (unit === "number") return stripNegativeZero(v.toFixed(3));
  if (Math.abs(v) < 0.0005) return formatMetric(v, "amount");
  return amountText(v, amountDecimals(v));
}

/** The number a displayed amount stands for ("3,829.7" → 3829.7); "<0.001" keeps the value itself. */
function shownAmount(text: string, value: number): number {
  const shown = Number(text.replace(/,/g, ""));
  return Number.isFinite(shown) ? shown : value;
}

/** An amount at one panel's fixed number of decimals, so a column reads alike ("0.75549", "0.00015", "0.05979"). A
 * real amount below half the last digit reads "<0.00001" (never "0", which is an exact zero); rounding noise below
 * 1e-9 reads 0, as in formatMetric. */
export function amountAt(value: number, decimals: number): string {
  if (value === 0 || Math.abs(value) < 1e-9) return "0";
  const unit = 10 ** -decimals;
  if (Math.abs(value) < unit / 2) {
    const text = amountText(unit, decimals);
    return value > 0 ? `<${text}` : `>-${text}`;
  }
  return amountText(value, decimals);
}

/** "1,234.5" → 1234.5; "<0.001" → NaN. */
function parsedAmount(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/** A shown percentage as a number ("0.000%" and "0%" are both 0). */
function percentValue(text: string): number {
  return Number(text.replace("%", ""));
}

/** Whether a row as shown, divided by the total as shown, gives the row's shown percentage. A row below the last
 * digit ("<0.00001") cannot be divided by hand; it checks when its percentage reads 0.000%. */
function rowChecksByHand(value: number, total: number, decimals: number): boolean {
  const percent = percentValue(percentText((value / total) * 100));
  const shown = parsedAmount(amountAt(value, decimals));
  const shownTotal = parsedAmount(amountAt(total, decimals));
  if (Number.isNaN(shown)) return percent === 0;
  if (!(shownTotal > 0)) return false;
  return percentValue(percentText((shown / shownTotal) * 100)) === percent;
}

/** The significant digits a panel's total may be read to while decimals are added (1.3787566, 99.601800,
 * 1,260,798.1). Past that a row is left to the rounding note under the table rather than growing the column. */
const MAX_PANEL_DIGITS = 8;

/** Decimals for one steps 2–3 panel (the total line, every table row, the sum lines and the formula): each row's
 * shown amount ÷ the shown total gives the row's shown percentage, as the formula line does (BRN C10T12 2020:
 * "0.75549 / 1.37876 = 54.795%", not "0.755 / 1.379"). It starts at the total's usual precision (three significant
 * digits for a tiny total) and adds one decimal at a time. `checks` is false when {@link MAX_PANEL_DIGITS} is reached
 * first (about 0.4% of panels); the table then says so. A total of 0 or below has no shares: null (per-row
 * {@link fmt}). */
export function panelAmountDecimals(values: readonly number[], total: number): { decimals: number; checks: boolean } | null {
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const magnitude = Math.floor(Math.log10(total));
  const start = Math.max(amountDecimals(total), 2 - magnitude);
  const last = Math.max(start, MAX_PANEL_DIGITS - Math.max(1, magnitude + 1));
  for (let decimals = start; ; decimals += 1) {
    if (values.every((value) => rowChecksByHand(value, total, decimals))) return { decimals, checks: true };
    if (decimals >= last) return { decimals, checks: false };
  }
}

/** Decimals for a panel whose total is 0 or below (ISL C21 2017: SVA −10.54), which has no shares: one precision for
 * the total, every row, the sum line and the formula ("−10.104", "−0.058", not "−10.10" beside "−0.058"). It starts at
 * the larger of the total's and the parts' usual precision and adds decimals until the rows as shown add up to the
 * total as shown; `checks` is false when {@link MAX_PANEL_DIGITS} is reached first (the sum line then reads "≈").
 * Null when every part and the total are 0. */
export function signedPanelDecimals(values: readonly number[], total: number): { decimals: number; checks: boolean } | null {
  if (!Number.isFinite(total) || total > 0) return null;
  const largest = Math.max(Math.abs(total), ...values.map(Math.abs));
  if (!(largest > 0) || !Number.isFinite(largest)) return null;
  const magnitude = Math.floor(Math.log10(largest));
  const start = Math.max(amountDecimals(largest), ...values.filter((value) => value !== 0).map(amountDecimals));
  const last = Math.max(start, MAX_PANEL_DIGITS - Math.max(1, magnitude + 1));
  for (let decimals = start; ; decimals += 1) {
    if (displayedRowsAddUp(values, total, decimals)) return { decimals, checks: true };
    if (decimals >= last) return { decimals, checks: false };
  }
}

/** Under a table whose rows cannot all be checked by hand within {@link MAX_PANEL_DIGITS}. */
export const PANEL_ROUNDING_NOTE = "百分比按未四舍五入的金额计算，按表中显示值手算，末位可能有出入。";

/** An amount written into a formula line: the table's reading ({@link fmt}), except that a value below 0.1 keeps
 * three significant digits ("0.0118", "0.000249") so the substituted arithmetic still checks by hand. `extra`
 * decimals are added where a ratio needs them to reproduce its percentage ({@link ratioOperands}). */
export function formulaAmount(value: number, extra = 0): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 0.1) return extra ? amountText(value, amountDecimals(value) + extra) : fmt(value, "amount");
  const decimals = Math.min(20, Math.max(3, 2 - Math.floor(Math.log10(magnitude))) + extra);
  // Trailing zeros beyond the third decimal add nothing ("0.0001000" → "0.0001"; "0.060" stays).
  return stripNegativeZero(value.toFixed(decimals).replace(/(\.\d{3}\d*?)0+$/, "$1"));
}

/** A share's substituted formula: the shown numerator divided by the shown denominator gives the shown percentage
 * to its three decimals ("379.27 / 3,829.7 = 9.903%"). The operands start at the table's precision and take one
 * more decimal at a time only where that is not yet enough (a three-decimal percentage needs about six digits). */
export function ratioOperands(numerator: number, denominator: number, decimals?: number): { numerator: string; denominator: string; percent: string } {
  const percent = percentText((numerator / denominator) * 100);
  if (decimals != null) {
    // Beside a decomposition table: the operands read like its rows (the panel's decimals), with more only if needed.
    // A numerator below the last digit keeps its significant digits instead of "<0.00001".
    const at = (value: number, places: number) => {
      const text = amountAt(value, places);
      return Number.isNaN(parsedAmount(text)) ? formulaAmount(value) : text;
    };
    let operands = { numerator: at(numerator, decimals), denominator: at(denominator, decimals) };
    for (let places = decimals; places <= decimals + 6; places += 1) {
      operands = { numerator: at(numerator, places), denominator: at(denominator, places) };
      const shown = (shownAmount(operands.numerator, numerator) / shownAmount(operands.denominator, denominator)) * 100;
      if (percentText(shown) === percent) break;
    }
    return { ...operands, percent };
  }
  let operands = { numerator: formulaAmount(numerator), denominator: formulaAmount(denominator) };
  for (let extra = 0; extra <= 6; extra += 1) {
    operands = { numerator: formulaAmount(numerator, extra), denominator: formulaAmount(denominator, extra) };
    const shown = (shownAmount(operands.numerator, numerator) / shownAmount(operands.denominator, denominator)) * 100;
    if (percentText(shown) === percent) break;
  }
  return { ...operands, percent };
}

/** A two-part sum. Unless both parts read as whole millions, the parts are written out at the table's precision,
 * so the line adds up as shown: "= 2.477 + 0.867 = 3.344", "5,298.2 + 0.998 = 5,299.2", never "= 9" for
 * 5.4 + 3.3 nor "0.000" for two tiny non-zero parts. */
export function sumText(a: number, b: number, decimals?: number): string {
  if (decimals != null) {
    // At the panel's decimals, as in the table: "0.75549 + 0.00015 = 0.75564". When the shown parts do not add up
    // to the shown sum the line reads "≈"; a part below the last digit counts as 0 and is named.
    const parts = [amountAt(a, decimals), amountAt(b, decimals)];
    const sum = amountAt(a + b, decimals);
    const line = `${parts[0]} + ${parts[1]} = ${sum}`;
    const shownSum = parsedAmount(sum);
    if (Number.isNaN(shownSum)) return line;
    const shown = parts.map(parsedAmount);
    const added = shown.reduce((acc, value) => acc + (Number.isNaN(value) ? 0 : value), 0);
    const addsUp = Math.abs(added - shownSum) < 10 ** -decimals / 2;
    // About one panel in four rounds this way; "≈" says so without a sentence on every such line.
    if (!addsUp) return `${parts[0]} + ${parts[1]} ≈ ${sum}`;
    return shown.some(Number.isNaN) ? `${line}（不到 ${amountText(10 ** -decimals, decimals)} 的一项按 0 相加）` : line;
  }
  const whole = (v: number) => v === 0 || amountDecimals(v) === 0;
  if (whole(a) && whole(b)) return fmt(a + b, "amount");
  return `${formulaAmount(a)} + ${formulaAmount(b)} = ${formulaAmount(a + b)}`;
}

/** When the rows as displayed do not add up to the displayed sum within its last digit (each row is rounded on its
 * own), the sum line says what they add up to, so "✓ N 项相加" never contradicts the table above it. */
export function displayedSumNote(values: readonly number[], sum: number, panelDecimals?: number): string | null {
  if (panelDecimals != null) {
    // One precision for the whole panel; a row below the last digit ("<0.00001") adds as 0.
    const shownRows = values.map((value) => parsedAmount(amountAt(value, panelDecimals)));
    const added = shownRows.reduce((acc, value) => acc + (Number.isNaN(value) ? 0 : value), 0);
    const shownSum = parsedAmount(amountAt(sum, panelDecimals));
    // Within one last digit the line reads "≈" instead (see displayedRowsAddUp); only a larger gap gets the sentence.
    if (Number.isNaN(shownSum) || Math.abs(added - shownSum) <= 10 ** -panelDecimals * (1 + 1e-9)) return null;
    return `（上表各项按显示值相加为 ${amountText(added, panelDecimals)}，差别来自四舍五入）`;
  }
  const shown = values.map((value) => shownAmount(fmt(value, "amount"), value));
  const total = shown.reduce((acc, value) => acc + value, 0);
  const shownSum = shownAmount(fmt(sum, "amount"), sum);
  if (Math.abs(total - shownSum) <= 10 ** -amountDecimals(sum) * (1 + 1e-9)) return null;
  const decimals = Math.max(...values.map((value) => (value === 0 ? 0 : amountDecimals(value))));
  return `（上表各项按显示值相加为 ${amountText(total, decimals)}，差别来自四舍五入）`;
}

/** The rest of the "N 项相加" line: "= 28.85104，等于总出口", or with rounding "≈ 28.85104，与总出口一致（差别来自四舍五入）"
 * ("≈" and "等于" never share a line); `sumNote` is {@link displayedSumNote}, which then explains the rounding instead. */
export function sumLine(closes: boolean, addsUp: boolean, sum: string, totalLabel: string, sumNote: string | null): string {
  if (!closes) return `${addsUp ? "=" : "≈"} ${sum}，不等于${totalLabel}${sumNote ?? ""}`;
  if (addsUp) return `= ${sum}，等于${totalLabel}${sumNote ?? ""}`;
  return `≈ ${sum}，${cjkJoin(`与${totalLabel}`, "一致")}${sumNote ?? "（差别来自四舍五入）"}`;
}

/** Whether the rows as displayed add up exactly to the displayed sum; when not, the sum line reads "≈", as the
 * two-part lines do ("31.136 + 15.354 ≈ 46.489"). */
export function displayedRowsAddUp(values: readonly number[], sum: number, panelDecimals?: number): boolean {
  if (panelDecimals == null) return true;
  const added = values.map((value) => parsedAmount(amountAt(value, panelDecimals)))
    .reduce((acc, value) => acc + (Number.isNaN(value) ? 0 : value), 0);
  const shownSum = parsedAmount(amountAt(sum, panelDecimals));
  return Number.isNaN(shownSum) || Math.abs(added - shownSum) < 10 ** -panelDecimals / 2;
}

/** A share already in percent, to three decimals as everywhere else ("11.730%"), an exact zero too ("0.000%" next
 * to "100.000%", not "0%"). */
function percentText(percent: number): string {
  return `${stripNegativeZero(percent.toFixed(3))}%`;
}

/** The same digits as the decomposition table beside it; a tiny operand keeps three significant digits so the
 * substituted formula never reads "0 / 0". */
function disclosureAmount(value: number | null, decimals?: number): string {
  if (value == null) return "—";
  return decimals != null ? amountAt(value, decimals) : formulaAmount(value);
}

/** Lengths are read to three decimals everywhere (e.g. PLv = 2.216); a tiny signed value keeps its sign. */
function disclosureLength(value: number | null): string {
  if (value == null) return "—";
  return value !== 0 && Math.abs(value) < 0.001 ? value.toPrecision(1) : stripNegativeZero(value.toFixed(3));
}

function disclosureRatio(numerator: number | null, denominator: number | null): number | null {
  return numerator != null && denominator != null && denominator > 0
    ? numerator / denominator
    : null;
}

/** Why a share has no value: the reason the student can check against the total line above it. */
function disclosureRatioGap(numerator: number | null, denominator: number | null): string {
  if (numerator == null || denominator == null) return "—（缺数据，无法计算）";
  return denominator < 0 ? "—（总量为负，本页面不展示比重）" : "—（总量为 0，无法计算比重）";
}

/** `decimals`: beside a decomposition table, the panel's amount precision ({@link panelAmountDecimals}). */
export function IndicatorCalculationDisclosure({ step, row, decimals }: { step: number; row: Row; decimals?: number }) {
  if (step === 4 || step === 5) {
    const numeratorKey = step === 4 ? "FVA" : "3b_VA_GVC_C";
    const denominatorKey = step === 4 ? "gross_exports" : "SVA";
    const numerator = finiteNumber(row[numeratorKey]);
    const denominator = finiteNumber(row[denominatorKey]);
    const ratio = disclosureRatio(numerator, denominator);
    const operands = ratio != null ? ratioOperands(numerator!, denominator!, decimals) : null;
    const title = step === 4 ? "外国增加值项占比" : "复杂 GVC 生产份额";
    const denominatorLabel = step === 4 ? "总出口" : "总增加值 SVA";
    return (
      <section className="indicator-calculation-disclosure" aria-label={`${title}计算公式`}>
        <div className="icd-kicker">这个指标怎么算</div>
        <div className="icd-title">{title}</div>
        <div className="icd-formula">{title} = {numeratorKey} / {denominatorLabel}</div>
        <div className="icd-calc">
          {/* Without a share (a total of 0 or below) the operands still read as the table rows beside them. */}
          = {operands?.numerator ?? disclosureAmount(numerator, decimals)} / {operands?.denominator ?? disclosureAmount(denominator, decimals)} = <b>{operands?.percent ?? disclosureRatioGap(numerator, denominator)}</b>
        </div>
        {/* "-14.06 / -216.77 = —" (ITA C19 2020) looks computable: say why value added is negative and why no share. */}
        {step === 5 && denominator != null && denominator < 0 && <p>{NEGATIVE_VALUE_ADDED_NOTE}</p>}
        <p>{step === 4
          ? "FVA 不包括外国重复计算 FDC。分母是下面六项相加得到的总出口，所以这个比例和 OECD TiVA 公布的“出口中外国增加值占比”不完全相同。"
          : "复杂 GVC 只算至少跨境两次的增加值；这个份额反映生产活动的构成，不直接代表技术水平或收益。"}</p>
      </section>
    );
  }

  const forward = finiteNumber(row.PLv_GVC);
  const backward = finiteNumber(row.PLy_GVC);
  const position = forward != null && backward != null && Math.abs(backward) > 1e-12
    ? forward / backward
    : null;
  // A GVC segment with no value added (or final goods) in it has no length: no activity, not missing data —
  // the same reading as the segment list under the PLv identity.
  const noActivity = (forward == null && finiteNumber(row["3_VA_GVC"]) === 0)
    || (backward == null && finiteNumber(row["3_FGY_GVC"]) === 0);
  const positionGap = noActivity ? "—（无此类活动，无法计算）" : "—（缺数据，无法计算）";
  return (
    <section className="indicator-calculation-disclosure" aria-label="GVC 位置指数计算公式">
      <div className="icd-kicker">这个指标怎么算</div>
      <div className="icd-title">GVC 位置指数 GVCPs</div>
      <div className="icd-formula">GVCPs = PLv_GVC / PLy_GVC</div>
      <div className="icd-calc">
        = {disclosureLength(forward)} / {disclosureLength(backward)} = <b>{position == null ? positionGap : stripNegativeZero(position.toFixed(3))}</b>
      </div>
      <p>这里比较前向与后向的 GVC 段长度（分母就是“后向各段长度”里的 GVC 段）。上方 PLv 恒等式中的每一项是“增加值份额 × 段长度”的加权贡献，不是段长度本身。</p>
      <p>读法：GVCPs 大于 1 表示前向段更长，相对更靠上游（更靠近原料、零部件这一端）；小于 1 表示相对更靠下游。</p>
    </section>
  );
}

export function DecompositionDetailTable({
  caption,
  parts,
  values,
  shares,
  unit,
  unavailable = false,
  hover = null,
  onHover,
  negativeNote = "负值表示抵减项（例如净补贴），所以其他分项的比重之和可能超过 100%。",
  decimals,
  roundingNote = false,
  shareUnavailableText = "—（无法计算）",
}: {
  caption: string;
  parts: readonly Part[];
  values: readonly (number | null)[];
  shares: readonly (number | null)[] | null;
  unit: "amount" | "number";
  unavailable?: boolean;
  hover?: string | null;
  onHover?: (key: string | null) => void;
  /** What a negative part means in this decomposition; only shown beside shares it explains. */
  negativeNote?: string;
  /** One amount precision for the whole column ({@link panelAmountDecimals}); without it each row uses {@link fmt}. */
  decimals?: number;
  /** Some row's shown amount ÷ the shown total does not give its shown percentage: say so under the table. */
  roundingNote?: boolean;
  shareUnavailableText?: string;
}) {
  // The note explains shares summing past 100%; with no shares (e.g. a negative total) the reason line says why.
  const hasNegative = !unavailable
    && Boolean(shares?.some((share) => share != null))
    && values.some((value) => value != null && value < 0);
  return (
    <>
    <table className="decomp-table">
      <caption className="sr-only">{caption}</caption>
      {/* Visible column names: a value and a share side by side are otherwise unlabelled. */}
      <thead className="decomp-table-head">
        <tr>
          <th scope="col">分项</th>
          <th scope="col">数值</th>
          <th scope="col">占总量比重</th>
          <th scope="col">含义</th>
        </tr>
      </thead>
      <tbody>{parts.map((part, index) => {
        const value = values[index] ?? null;
        const share = shares?.[index] ?? null;
        return (
          <tr
            key={part.key}
            className={!unavailable && hover === part.key ? "on" : ""}
            onMouseEnter={onHover ? () => onHover(part.key) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
          >
            <th scope="row" className="dt-name">
              <span className="dt-swatch" style={{ background: value != null && value < 0 ? negativeFill(part.color) : part.color }} />
              {part.label}
            </th>
            <td className="dt-val">{value == null ? "—" : decimals != null && unit === "amount" ? amountAt(value, decimals) : fmt(value, unit)}</td>
            <td className="dt-share">{unavailable ? "—" : share == null ? shareUnavailableText : percentText(share)}</td>
            <td className="dt-desc">{part.desc}</td>
          </tr>
        );
      })}</tbody>
    </table>
    {hasNegative && <p className="decomp-table-note">{negativeNote}</p>}
    {roundingNote && <p className="decomp-table-note">{PANEL_ROUNDING_NOTE}</p>}
    </>
  );
}

export const PLY_DECOMP: DecompCfg = {
  title: "后向总生产长度 PLy",
  total: "PLy",
  totalLabel: "后向总生产长度 PLy",
  unit: "number",
  weightTotal: "FGY",
  parts: [
    { key: "PLy_D", label: "纯国内段", color: COMPONENT_COLORS.domestic, desc: "按 1_FGY_D / FGY 加权。", weightKey: "1_FGY_D" },
    { key: "PLy_RT", label: "传统贸易段", color: COMPONENT_COLORS.traditional, desc: "按 2_FGY_RT / FGY 加权。", weightKey: "2_FGY_RT" },
    { key: "PLy_GVC", label: "GVC 段", color: COMPONENT_COLORS.gvc, desc: "按 3_FGY_GVC / FGY 加权。", weightKey: "3_FGY_GVC" },
  ],
};

/** Steps 2–5: why the country lists have no ROW (step 5's table says it beside “全部”). */
export const ROW_AGGREGATE = "世界其他地区（ROW，是一个汇总项，不能单独选）";

/** Step 2: an industry that produces (SVA ≠ 0) but exports nothing has every export part 0 (CHN·E). */
export const NO_EXPORTS_NOTE = "该行业这一年没有出口，出口分解各项为 0";

/** `noExports`: step 2's total is 0 because the industry does not export, although it has activity. */
export function zeroTotalDecompositionHint(model: DecompositionModel, totalLabel: string, noExports = false): string | null {
  const kind = directZeroTotalKind(model);
  if (kind === "all-zero") {
    return noExports ? `${NO_EXPORTS_NOTE}，无法算比重；请换一个行业。` : "所有分项都是 0，这一年可能没有相关活动，请换一个行业。";
  }
  if (kind === "signed-offset") {
    return `${cjkJoin(totalLabel, "为 0：")}正负分项相互抵消，无法算比重。`;
  }
  if (kind === "nonclosing") {
    return `${cjkJoin(totalLabel, "为 0，")}但各分项之和不等于 0，无法算比重。`;
  }
  return null;
}

export function decompositionModelReason(model: DecompositionModel, weightLabel?: string, noExports = false): string {
  const weight = weightLabel ?? "权重";
  if (model.reason === "zero-weight-denominator") {
    return cjkJoin(weight, "为 0（没有这类活动），无法计算加权长度。");
  }
  if (model.reason === "negative-weight-denominator") {
    return cjkJoin(weight, "小于 0，有符号加权贡献仍可计算，但本页面不展示该加权分解。");
  }
  if (model.reason === "missing-fields") {
    return `分解数据不完整${model.missingFields.length ? `（缺 ${model.missingFields.join("、")}）` : ""}，暂时无法拆分。`;
  }
  if (model.reason === "nonfinite-calculation") return "数据不完整，暂时无法拆分。";
  if (model.reason === "zero-total") {
    const kind = directZeroTotalKind(model);
    if (kind === "all-zero") {
      return noExports ? `${NO_EXPORTS_NOTE}；无法算比重。` : "所有分项都是 0，这一年可能没有相关活动；无法算比重。";
    }
    if (kind === "signed-offset") {
      return "总量为 0：正负分项相互抵消，无法算比重。";
    }
    if (kind === "nonclosing") {
      return "总量为 0，但各分项之和不等于 0，无法算比重。";
    }
    return "总量为 0，无法算比重。";
  }
  return "总量为负，有符号比率仍可计算，但本页面不展示比重。";
}

/** Distinguish undefined zero-denominator contributions from intentionally hidden signed contributions. */
export function unavailableDashNote(model: DecompositionModel): string {
  if (model.reason === "negative-weight-denominator") return "“—”表示本页面不展示负分母下的加权贡献（不是无法计算或缺少数据），不按 0 计算。";
  return model.reason === "zero-weight-denominator"
    ? "“—”表示这一项无法计算（不是缺少数据），不按 0 计算。"
    : "“—”表示没有数据，不按 0 计算。";
}

/** A negative nonzero weight leaves both total and signed contributions defined; only display is suppressed. */
export function unavailableTotalNote(model: DecompositionModel, cfg: Pick<DecompCfg, "totalLabel" | "unit" | "weightTotal">): string | null {
  if (model.reason !== "negative-weight-denominator" || model.total == null || !cfg.weightTotal) return null;
  return `${cfg.totalLabel} = ${fmt(model.total, cfg.unit)} 仍有定义：总长度由投入产出关系直接算出；按 ${cfg.weightTotal} 非零负分母计算的有符号加权贡献也有定义，本页面仅不展示该按段分解。`;
}

/** Only missing data can change later ("暂时无法拆分"); a weight of 0 or below (LUX B09: FGY = 0, no final goods) is
 * structural, so its heading reads plain 无法拆分. */
function missingDataReason(model: DecompositionModel): boolean {
  return model.reason === "missing-fields" || model.reason === "nonfinite-calculation";
}

function MiniBackwardBar({ row, countryLevel = false }: { row: Row; countryLevel?: boolean }) {
  const model = buildDecompositionModel(row, PLY_DECOMP);
  const position = finiteNumber(row.GVCPs);
  if (model.status !== "valid" || !model.values || model.total == null || model.sum == null || model.error == null) {
    return (
      <div className="decomp-unavailable" role="status" style={{ marginTop: 14 }}>
        <b>后向 PLy · {model.reason === "negative-weight-denominator" ? "不展示加权分解" : missingDataReason(model) ? "暂时无法拆分" : "无法拆分"}</b>
        <div>{decompositionModelReason(model, "FGY")}</div>
        <div>PLy = {model.total == null ? "—（无法计算）" : fmt(model.total, "number")}；GVCPs = {position?.toFixed(3) ?? "—（无法计算）"}</div>
        <div>{PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} style={{ marginRight: 10 }}>
            {part.label}贡献：{model.contributions[index] == null ? "—" : fmt(model.contributions[index]!, "number")}
          </span>
        ))}</div>
      </div>
    );
  }
  const domain = signedDomain([model.values], true, [model.total]);
  const layout = signedStack(model.values, domain, true, model.total);
  // Lengths are shown to three decimals, as in the forward table above.
  const shownAddsUp = displayedRowsAddUp(model.values, model.sum, 3);
  const identityNote = segmentIdentityNote(row, countryLevel);
  return (
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "#f8f9fc" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11.5, marginBottom: 7 }}>
        <b>后向总生产长度 PLy（从最终产品端回溯）</b>
        <span>{fmt(model.total, "number")}</span>
      </div>
      <div style={{ position: "relative", height: 12, background: "#eceef4", borderRadius: 5, overflow: "hidden" }}>
        {domain.negative > 0 && <span aria-hidden="true" style={{ position: "absolute", zIndex: 3, left: `${layout.zeroPct}%`, top: 0, bottom: 0, borderLeft: "2px solid #4b5263" }} />}
        {PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} title={`${part.label}贡献：${fmt(model.values![index], "number")}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${layout.segments[index].leftPct}%`, width: `${layout.segments[index].widthPct}%`, background: layout.segments[index].negative ? negativeFill(part.color) : part.color }} />
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        {PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} style={{ marginRight: 10 }}>
            <span className="dt-swatch" aria-hidden="true" style={{ background: model.values![index] < 0 ? negativeFill(part.color) : part.color }} />
            {part.label}贡献：{fmt(model.values![index], "number")}
          </span>
        ))}
      </div>
      {hasBackwardSegmentLength(row) && <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{segmentLengths(row, "后向")}（上面是这些长度乘以最终产品份额后的贡献）。</div>}
      {/* Equal lengths that would read as an error are explained: forward and backward at country level, the two
          backward segments for one industry (identities, as step 8 says). */}
      {identityNote && <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>{identityNote}</div>}
      {domain.negative > 0 && <p className="decomp-table-note">负贡献为抵减项，用斜纹表示并位于零轴左侧；正贡献位于右侧，各段按带符号数值相加得到 PLy，不是都为正的份额。</p>}
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        {/* Name what the sum is checked against: the PLy computed directly, shown at the right of the heading. As in
            the forward line, "=" only when the three contributions as shown add up to the shown sum (CHN 2018:
            1.813 + 0.181 + 0.512 reads ≈ 2.505). */}
        各段（最终产品中的份额 × 段长度）之和 {shownAddsUp ? "=" : "≈"} {fmt(model.sum, "number")}；{model.error < 1e-6
          ? shownAddsUp
            ? `等于直接算出的后向总生产长度 PLy（${fmt(model.total, "number")}），即 PLy 是三段长度按最终产品份额的加权平均`
            : `与直接算出的后向总生产长度 PLy（${fmt(model.total, "number")}）一致${displayedSumNote(model.values, model.sum, 3)?.replace("上表", "上面") ?? "（差别来自四舍五入）"}，即 PLy 是三段长度按最终产品份额的加权平均`
          : `与直接算出的后向总生产长度 PLy（${fmt(model.total, "number")}）相差 ${model.error.toPrecision(2)}`}。
      </div>
    </div>
  );
}

export function DecompositionRequestMessage({
  label,
  status,
  error,
  empty,
  onRetry,
}: {
  label: string;
  status: AsyncStatus;
  error: string | null;
  empty: boolean;
  onRetry: () => void;
}) {
  if (status === "loading" || status === "idle") {
    return (
      <AsyncStateMessage
        status={status}
        error={null}
        loadingLabel={`正在加载${cjkJoin(label, "的分解数据…")}`}
        onRetry={onRetry}
      />
    );
  }
  if (status === "error") {
    return (
      <AsyncStateMessage
        status="error"
        error={userFacingRequestError(error, cjkJoin(label, "的分解加载失败"))}
        onRetry={onRetry}
      />
    );
  }
  if (empty) {
    return <p className="muted async-empty" role="status">当前国家和年份没有可用的分解数据。</p>;
  }
  return null;
}

export function DecompositionDemo({
  step,
  meta,
  primaryYear,
  primaryCountry,
  onPrimaryChange,
  initialView,
  onViewChange,
}: {
  step: number;
  meta: Meta;
  /** The table may browse globally; the single-entity demo requires an explicit valid country. */
  primaryYear: number;
  primaryCountry: string | null;
  onPrimaryChange?: (year: number, country: string) => void;
  /** 国家整体／单个行业 and the industry the student left the demo on, so coming back keeps them. */
  initialView?: DecompositionView;
  onViewChange?: (view: DecompositionView) => void;
}) {
  const cfg = DECOMP[step];
  // Country level first: the same figures the report material records; industries are one click away.
  const [gran, setGranState] = useState<"country" | "sector">(initialView?.level === "sector" ? "sector" : "country");
  const year = meta.years.includes(primaryYear) ? primaryYear : meta.years.at(-1)!;
  const country = explicitDemoCountry(meta.countries, primaryCountry) ?? "";
  const [selectedSector, setSectorState] = useState(typeof initialView?.industry === "string" ? initialView.industry : "");
  // A saved view that arrives after the first render (the step's record loads later) is applied once, unless the
  // student has already changed the level or industry here.
  const viewTouched = useRef(false);
  const viewApplied = useRef(initialView != null);
  useEffect(() => {
    if (viewApplied.current || viewTouched.current || initialView == null) return;
    viewApplied.current = true;
    if (initialView.level === "sector") setGranState("sector");
    if (typeof initialView.industry === "string") setSectorState(initialView.industry);
  }, [initialView]);
  const setGran = (level: "country" | "sector") => {
    viewTouched.current = true;
    setGranState(level);
    // The industry on screen (the first one until the student picks another).
    onViewChange?.({ level, industry: sector });
  };
  const setSector = (industry: string) => {
    viewTouched.current = true;
    setSectorState(industry);
    onViewChange?.({ level: gran, industry });
  };
  const [hover, setHover] = useState<string | null>(null);

  const demoAvailable = country !== "";
  const requestKey = decompositionRequestKey(year, country);
  const query = useAsync<DecompositionSideData>(
    async () => {
      const [countryRows, pageResult] = await Promise.all([
        api.countryIndicatorsForCountry(year, country),
        api.industryIndicatorsAll(year, country),
      ]);
      return { countryRows, page: pageResult };
    },
    [requestKey],
    { enabled: demoAvailable, requestKey },
  );
  const countryRows = query.status === "success" ? query.data?.countryRows ?? null : null;
  const page = query.status === "success" ? query.data?.page ?? null : null;

  const sectors = (page?.rows ?? []).map((row) => String(row.industry));
  const sector = sectors.includes(selectedSector) ? selectedSector : sectors[0] ?? "";
  const row = gran === "country"
    ? countryRows?.find((item) => item.country === country)
    : page?.rows.find((item) => item.industry === sector);
  const domainRows = decompositionDomainRows([row], cfg);
  const domain = signedDomain(
    domainRows.map((item) => item.values),
    true,
    domainRows.map((item) => item.total),
  );

  // A plain name for what is shown.
  const shownLabel = gran === "country" ? "所选国家" : "所选行业";
  const levelLabel = gran === "sector" ? sectorLabel(sector) : "国家整体";

  const entityPicker = (
    <div className="demo-controls" style={{ marginBottom: 10 }} role="group" aria-label={shownLabel}>
      <b aria-hidden="true">{shownLabel}</b>
      <LabeledControl label="国家">
        {(id) => (
          <select id={id} value={country} onChange={(event) => onPrimaryChange?.(year, event.target.value)}>
            {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
          </select>
        )}
      </LabeledControl>
      {gran === "sector" && <>
        <LabeledControl label="行业">
          {(id) => (
            <select id={id} value={sector} onChange={(event) => setSector(event.target.value)}>
              {sectors.map((code) => <option key={code} value={code}>{sectorLabel(code)}</option>)}
            </select>
          )}
        </LabeledControl>
      </>}
      {/* After the selects, so it does not split 国家 from 行业. */}
      {!meta.countries.includes("ROW") && <span className="muted demo-row-note" style={{ fontSize: 12 }}>国家列表不含{ROW_AGGREGATE}。</span>}
    </div>
  );

  const panel = () => {
    if (query.status !== "success" || !row) {
      return (
        <div style={{ minWidth: 0 }}>
          {entityPicker}
          <DecompositionRequestMessage
            label={shownLabel}
            status={query.status}
            error={query.error}
            empty={query.status === "success" && !row}
            onRetry={query.retry}
          />
        </div>
      );
    }
    const model = buildDecompositionModel(row, cfg);
    const countryTotal = (page?.rows ?? []).reduce<number | null>((acc, item) => {
      if (acc == null) return null;
      const value = finiteNumber(item[cfg.total]);
      if (value == null) return acc;
      return finiteNumber(acc + Math.abs(value));
    }, 0);
    // Step 2: exports of 0 with value added is an industry that does not export, not one without activity.
    const sva = finiteNumber(row.SVA);
    const noExports = cfg.total === "gross_exports" && sva != null && sva !== 0;
    const zeroTotalHint = zeroTotalDecompositionHint(model, cfg.totalLabel, noExports);
    // A negative total is not "too small": the identity line already explains it (总量为负，无法算比重).
    const negligible = model.total != null && gran === "sector" && (
      model.total === 0 || (model.total > 0 && countryTotal != null && countryTotal > 0 && model.total / countryTotal < 1e-4)
    );

    if (!model.values || model.total == null || model.sum == null || model.error == null) {
      return (
        <div style={{ minWidth: 0 }}>
          {entityPicker}
          <div className="decomp-total-line">
            {cfg.totalLabel} = <b>{model.total == null ? "—（未定义）" : fmt(model.total, cfg.unit)}</b>
            {cfg.unit === "amount" && model.total != null && <span className="muted">（百万美元）</span>}
          </div>
          {step !== 6 && <IndicatorCalculationDisclosure step={step} row={row} />}
          <div className="decomp-unavailable" role="status">
            <b>当前分解不可用</b>
            <div>{decompositionModelReason(model, cfg.weightTotal, noExports)}</div>
            {model.reason === "negative-weight-denominator" && cfg.weightTotal === "SVA" && <div>{NEGATIVE_VALUE_ADDED_CAUSE}</div>}
            {unavailableTotalNote(model, cfg) && <div>{unavailableTotalNote(model, cfg)}</div>}
            <div>{unavailableDashNote(model)}</div>
          </div>
          <DecompositionDetailTable
            caption={`${shownLabel}：${year} 年 ${countryLabel(country)} · ${levelLabel} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
            parts={cfg.parts}
            values={model.contributions}
            shares={null}
            unit={cfg.unit}
            unavailable
            negativeNote={cfg.negativeNote}
          />
          {/* The segment lengths come straight from the input-output relations and need no share (ITA·C19 2020). */}
          {step === 6 && hasForwardSegmentLength(row) && (
            <div className="decomp-note">{segmentLengths(row)}（段长度不需要份额，仍可读）。</div>
          )}
          {step === 6 && <MiniBackwardBar row={row} countryLevel={gran === "country"} />}
          {step === 6 && <IndicatorCalculationDisclosure step={step} row={row} />}
        </div>
      );
    }

    const usesLocalRawDomain = model.total === 0;
    const panelDomain = usesLocalRawDomain ? signedDomain([model.values]) : domain;
    const layout = signedStack(
      model.values,
      panelDomain,
      !usesLocalRawDomain,
      usesLocalRawDomain ? undefined : model.total,
    );
    const sharesAvailable = model.shares != null;
    // One amount precision for the total line, the table, the sum lines and the formula, so every share in the table
    // checks by hand from the amounts beside it.
    // A total of 0 or below has no shares; its rows still read at one precision that adds up as shown.
    const precision = cfg.unit !== "amount" ? null
      : model.total > 0 ? panelAmountDecimals(model.values, model.total) : signedPanelDecimals(model.values, model.total);
    const amount = (value: number) => (precision ? amountAt(value, precision.decimals) : fmt(value, cfg.unit));
    // The decimals the rows are shown at (lengths in step 4: three), so the sum line reads "≈" whenever the shown
    // rows do not add up to the shown sum, as in steps 2–3.
    const shownDecimals = precision ? precision.decimals : cfg.unit === "number" ? 3 : undefined;
    return (
      <div style={{ minWidth: 0 }}>
        {entityPicker}
        <div className="decomp-total-line">
          {cfg.totalLabel} = <b>{amount(model.total)}</b>{cfg.unit === "amount" && <span className="muted">（百万美元）</span>}
        </div>
        {/* Step 4's GVCPs is another indicator (forward over backward GVC length): it follows both bars below, not
            between the PLv heading and the PLv bar it does not decompose. */}
        {step !== 6 && <IndicatorCalculationDisclosure step={step} row={row} decimals={precision?.decimals} />}
        {/* All parts 0: nothing to stack, so no empty grey bar (the line below says why). A total of 0 or below has
            no proportions either: a full-width bar would read as 100% (ISL C21 2017). */}
        {model.total > 0 && model.values.some((value) => value !== 0) && <div className="decomp-bar" style={{ position: "relative", display: "block", overflow: "hidden" }}>
          {panelDomain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 3, left: `${layout.zeroPct}%`, top: -2, bottom: -2, borderLeft: "2px solid #4b5263" }} />}
          {cfg.parts.map((part, index) => {
            const value = model.values![index];
            const share = model.shares?.[index];
            const segment = layout.segments[index];
            const shareText = share == null ? "无法算比重" : `占总量比重 ${percentText(share)}`;
            return <span key={part.key}
              className={`decomp-seg${hover && hover !== part.key ? " dim" : ""}`}
              style={{ position: "absolute", top: 0, bottom: 0, left: `${segment.leftPct}%`, width: `${segment.widthPct}%`, background: segment.negative ? negativeFill(part.color) : part.color }}
              onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}
              title={`${part.label} · 当前值 ${amount(value)} · ${shareText}${segment.negative ? "（负值，位于零轴左侧）" : ""}`} />;
          })}
        </div>}
        {model.closure != null ? (
          <div className={`decomp-identity ${model.closure ? "ok" : "bad"}`}>
            {model.closure ? "✓" : "✗"} {cfg.parts.length} 项相加 {sumLine(model.closure, displayedRowsAddUp(model.values, model.sum, shownDecimals), amount(model.sum), cfg.totalLabel, displayedSumNote(model.values, model.sum, shownDecimals))}{model.error < 1e-6 ? "" : `（差 ${model.error.toPrecision(2)}）`}
          </div>
        ) : negligible && zeroTotalHint ? null : (
          // A zero total is explained once, by the specific hint below.
          <div className="decomp-identity neutral" role="status">
            ℹ {decompositionModelReason(model, cfg.weightTotal, noExports)}
            {/* As the "✓ N 项相加" line: "=" only when the rows as shown add up to the shown sum. */}
            {model.amountCloses != null && ` ${cfg.parts.length} 项金额相加 ${sumLine(model.amountCloses, displayedRowsAddUp(model.values, model.sum, shownDecimals), amount(model.sum), "总量", displayedSumNote(model.values, model.sum, shownDecimals))}。`}
          </div>
        )}
        {negligible && <div className="decomp-identity neutral decomp-hint" role="note">ℹ {countryLabel(country)} · {sectorLabel(sector)}：{
          zeroTotalHint ?? "这个行业的数值太小（不到本国各行业合计的 0.01%），建议换一个行业。"
        }</div>}
        <DecompositionDetailTable
          caption={`${shownLabel}：${year} 年 ${countryLabel(country)} · ${levelLabel} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
          parts={cfg.parts}
          values={model.values}
          shares={model.shares}
          unit={cfg.unit}
          hover={hover}
          onHover={setHover}
          negativeNote={cfg.negativeNote}
          decimals={precision?.decimals}
          roundingNote={model.total > 0 && precision?.checks === false}
          shareUnavailableText={model.total < 0 ? "—（总量为负，本页面不展示比重）" : undefined}
        />
        {cfg.note && sharesAvailable && <div className="decomp-note">{cfg.note(row, model.values, precision?.decimals)}</div>}
        {step === 6 && <MiniBackwardBar row={row} countryLevel={gran === "country"} />}
        {step === 6 && <IndicatorCalculationDisclosure step={step} row={row} />}
      </div>
    );
  };

  if (!demoAvailable) {
    return (
      <div className="demo-card">
        <div className="demo-title">请先选择国家</div>
        <div className="decomp-unavailable" role="status">
          <b>还没有选择具体国家。</b>
          <LabeledControl label="选择国家">
            {(id) => (
              <select id={id} value="" onChange={(event) => onPrimaryChange?.(year, event.target.value)}>
                <option value="" disabled>请选择</option>
                {meta.countries.map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
              </select>
            )}
          </LabeledControl>
        </div>
      </div>
    );
  }

  return (
    <div className="demo-card">
      <div className="demo-title">{cfg.title}</div>
      <div className="demo-controls">
        {/* The default first: the country as a whole is what the report material records. */}
        <div className="pill-group" role="group" aria-label="分析层级">
          <button type="button" className={gran === "country" ? "on" : ""} aria-pressed={gran === "country"} onClick={() => setGran("country")}>国家整体</button>
          <button type="button" className={gran === "sector" ? "on" : ""} aria-pressed={gran === "sector"} onClick={() => setGran("sector")}>单个行业</button>
        </div>
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year} onChange={(event) => {
              onPrimaryChange?.(Number(event.target.value), country);
            }}>{meta.years.map((value) => <option key={value}>{value}</option>)}</select>
          )}
        </LabeledControl>
      </div>
      <p className="muted" role="note">单个行业仅供查看；本步报告材料记录所选国家同一年的国家整体指标。</p>
      <div className="decomp-formula">
        <span className="df-total">{cfg.totalLabel}</span><span className="df-eq">=</span>
        {cfg.parts.map((part, index) => (
          <span key={part.key}>
            {index > 0 && <span className="df-plus">+</span>}
            <span
              className={`df-term${hover === part.key ? " on" : ""}`}
              style={hover === part.key ? { color: part.color, borderColor: part.color } : undefined}
              onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}
            >{cfg.weightTotal && part.short
                ? `${cjkSpace(part.short, "份额")} × ${cjkSpace(part.short, "段长度")}`
                : part.short ?? part.label.split(" ")[0]}</span>
          </span>
        ))}
      </div>
      {panel()}
    </div>
  );
}

/* ============================ 步骤5:网络中心性演示 ============================ */

type Node = { id: string; x: number; y: number; label: string };
export type NetworkDemoMode = "degree" | "betweenness" | "closeness";

const NETWORK_DEMO_MODE_LABELS: Record<NetworkDemoMode, string> = {
  degree: "度",
  betweenness: "介数",
  closeness: "接近中心性",
};

const NET_NODES: Node[] = [
  { id: "USA", x: 95, y: 85, label: "美" },
  { id: "MEX", x: 95, y: 235, label: "墨" },
  { id: "DEU", x: 255, y: 160, label: "德" },
  { id: "CHN", x: 415, y: 80, label: "中" },
  { id: "JPN", x: 415, y: 235, label: "日" },
  { id: "KOR", x: 545, y: 150, label: "韩" },
  { id: "VNM", x: 545, y: 290, label: "越" },
];
const NET_EDGES: [string, string][] = [
  ["USA", "DEU"], ["MEX", "DEU"], ["USA", "MEX"],
  ["DEU", "CHN"], ["DEU", "JPN"],
  ["CHN", "KOR"], ["JPN", "KOR"], ["JPN", "VNM"], ["KOR", "VNM"],
];

const ekey = (a: string, b: string) => `${a}→${b}`;

/** Step 6 uses a single roving focus stop; directional navigation wraps and jumps to bounds. */
export function nextNetworkDemoNode(
  nodes: readonly string[],
  current: string,
  key: string,
): string | null {
  if (!nodes.length) return null;
  const currentIndex = Math.max(0, nodes.indexOf(current));
  if (key === "Home") return nodes[0];
  if (key === "End") return nodes.at(-1) ?? null;
  if (key === "ArrowRight" || key === "ArrowDown") return nodes[(currentIndex + 1) % nodes.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return nodes[(currentIndex - 1 + nodes.length) % nodes.length];
  return null;
}

/** Roving focus movement only moves focus; explicit activation changes selection. */
export function networkDemoKeyTransition(
  nodes: readonly string[],
  state: { focused: string; selected: string },
  key: string,
): { focused: string; selected: string } {
  if (key === "Enter" || key === " ") return { focused: state.focused, selected: state.focused };
  const next = nextNetworkDemoNode(nodes, state.focused, key);
  return next ? { focused: next, selected: state.selected } : state;
}

export type TeachingNetworkEdge = {
  direction: "入边" | "出边";
  neighbor: string;
  from: string;
  to: string;
  weight: number;
};

export function teachingNetworkEdgesForNode(nodeId: string): TeachingNetworkEdge[] {
  return NET_EDGES.reduce<TeachingNetworkEdge[]>((edges, [from, to]) => {
    if (to === nodeId) edges.push({ direction: "入边", neighbor: from, from, to, weight: 1 });
    if (from === nodeId) edges.push({ direction: "出边", neighbor: to, from, to, weight: 1 });
    return edges;
  }, []);
}

function computeCentrality() {
  const ids = NET_NODES.map((n) => n.id);
  const out: Record<string, string[]> = {};
  const incoming: Record<string, string[]> = {};
  ids.forEach((i) => { out[i] = []; incoming[i] = []; });
  NET_EDGES.forEach(([a, b]) => { out[a].push(b); incoming[b].push(a); });

  // 每个源点 BFS:dist、sigma(最短路条数)、preds
  const dist: Record<string, Record<string, number>> = {};
  const sigma: Record<string, Record<string, number>> = {};
  const preds: Record<string, Record<string, string[]>> = {};
  ids.forEach((s) => {
    const d: Record<string, number> = {}, sg: Record<string, number> = {}, pr: Record<string, string[]> = {};
    ids.forEach((i) => { d[i] = Infinity; sg[i] = 0; pr[i] = []; });
    d[s] = 0; sg[s] = 1;
    const q = [s];
    while (q.length) {
      const v = q.shift()!;
      for (const w of out[v]) {
        if (d[w] === Infinity) { d[w] = d[v] + 1; q.push(w); }
        if (d[w] === d[v] + 1) { sg[w] += sg[v]; pr[w].push(v); }
      }
    }
    dist[s] = d; sigma[s] = sg; preds[s] = pr;
  });

  // Brandes 累积介数中心性：有向、无权，累积 σ_st(v)/σ_st，未按节点对数归一化。
  const bet: Record<string, number> = {};
  ids.forEach((i) => (bet[i] = 0));
  ids.forEach((s) => {
    const stack: string[] = [];
    const order = ids
      .filter((i) => dist[s][i] < Infinity)
      .sort((a, b) => dist[s][a] - dist[s][b]);
    order.forEach((v) => stack.push(v));
    const delta: Record<string, number> = {};
    ids.forEach((i) => (delta[i] = 0));
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of preds[s][w]) {
        delta[v] += (sigma[s][v] / sigma[s][w]) * (1 + delta[w]);
      }
      if (w !== s) bet[w] += delta[w];
    }
  });
  const deg: Record<string, number> = {};
  const indeg: Record<string, number> = {};
  const outdeg: Record<string, number> = {};
  ids.forEach((i) => {
    indeg[i] = incoming[i].length;
    outdeg[i] = out[i].length;
    deg[i] = indeg[i] + outdeg[i];
  });
  const closeness: Record<string, number> = {};
  ids.forEach((i) => {
    const reachable = ids.filter((target) => target !== i && Number.isFinite(dist[i][target]));
    const distanceSum = reachable.reduce((sum, target) => sum + dist[i][target], 0);
    closeness[i] = distanceSum ? reachable.length / distanceSum : 0;
  });

  return { out, incoming, dist, sigma, preds, deg, indeg, outdeg, bet, closeness };
}

/** A stable numerical seam for tests; rendering and keyboard behavior must not alter the algorithms. */
export function teachingNetworkCentralitySnapshot() {
  const result = computeCentrality();
  return {
    degree: { ...result.deg },
    betweenness: { ...result.bet },
    closeness: { ...result.closeness },
  };
}

function networkDemoMetricValue(
  nodeId: string,
  mode: NetworkDemoMode,
  centrality: ReturnType<typeof computeCentrality>,
): number {
  if (mode === "degree") return centrality.deg[nodeId];
  if (mode === "betweenness") return centrality.bet[nodeId];
  return centrality.closeness[nodeId];
}

function networkDemoMetricText(value: number, mode: NetworkDemoMode): string {
  // Path counts are whole numbers in this small network; only closeness is a ratio.
  if (mode === "closeness" && value === 0) return PATH_UNDEFINED_LABEL;
  return mode === "closeness" ? value.toFixed(3) : String(Number(value.toFixed(3)));
}

export function networkDemoNodeAccessibleName(
  node: Pick<Node, "id" | "label">,
  mode: NetworkDemoMode,
  value: number,
  selected: boolean,
): string {
  return `${node.label}（${node.id}），${NETWORK_DEMO_MODE_LABELS[mode]} ${networkDemoMetricText(value, mode)}，${selected ? "已选择" : "未选择"}`;
}

function shortestPath(from: string, to: string, C: ReturnType<typeof computeCentrality>): string[] {
  const path = [to];
  let current = to;
  while (current !== from) {
    const previous = C.preds[from][current][0];
    if (previous == null) return [];
    path.push(previous);
    current = previous;
  }
  return path.reverse();
}

export function ClosenessPathTable({
  source,
  paths,
}: {
  source: string;
  paths: readonly { target: string; distance: number; path: readonly string[] }[];
}) {
  const sortedPaths = [...paths].sort((a, b) => a.distance - b.distance || a.target.localeCompare(b.target));
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <caption className="sr-only">从节点 {source} 出发的最短路线明细</caption>
      <thead>
        <tr>
          <th scope="col" style={{ textAlign: "left" }}>目标</th>
          <th scope="col">距离</th>
          <th scope="col" style={{ textAlign: "left" }}>一条最短路线</th>
        </tr>
      </thead>
      <tbody>{sortedPaths.map((item) => (
        <tr key={item.target}>
          <th scope="row" style={{ textAlign: "left" }}>{item.target}</th>
          <td style={{ textAlign: "center" }}>{Number.isFinite(item.distance) ? item.distance : "不可达"}</td>
          <td>{item.path.length ? item.path.join(" → ") : "—"}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** One (s, t) pair whose shortest routes pass through a node: `through` of the `total` shortest routes do, so the
 * pair adds through / total to the node's betweenness. */
export type BetweennessPair = { source: string; target: string; distance: number; through: number; total: number };

function betweennessPairsFrom(v: string, C: ReturnType<typeof computeCentrality>): BetweennessPair[] {
  const ids = NET_NODES.map((n) => n.id);
  const pairs: BetweennessPair[] = [];
  for (const s of ids) for (const t of ids) {
    if (s === t || s === v || t === v || !Number.isFinite(C.dist[s][t])) continue;
    if (C.dist[s][v] + C.dist[v][t] !== C.dist[s][t]) continue;
    pairs.push({ source: s, target: t, distance: C.dist[s][t], through: C.sigma[s][v] * C.sigma[v][t], total: C.sigma[s][t] });
  }
  return pairs;
}

/** The per-pair contributions behind a node's betweenness in the teaching network; they add up to its value. */
export function teachingBetweennessPairs(nodeId: string): BetweennessPair[] {
  return betweennessPairsFrom(nodeId, computeCentrality());
}

/** The example pair for the highlight: one where every shortest route passes the node when there is one (so
 * "要经过" is true), otherwise one where only some do; the longest such pair first. */
export function betweennessExamplePair(pairs: readonly BetweennessPair[]): BetweennessPair | null {
  let best: BetweennessPair | null = null;
  for (const pair of pairs) {
    const all = pair.through === pair.total;
    const bestAll = best != null && best.through === best.total;
    if (best == null || (all && !bestAll) || (all === bestAll && pair.distance > best.distance)) best = pair;
  }
  return best;
}

// 重建一条经过 v 的最短路径（s → … → v → … → t），用于高亮演示
function samplePathThrough(v: string, pair: BetweennessPair | null, C: ReturnType<typeof computeCentrality>): string[] {
  if (!pair) return [];
  // 回溯 to<-…<-from 的一条最短路径
  const half = (from: string, to: string): string[] | null => {
    const path: string[] = [to];
    let cur = to;
    while (cur !== from) {
      const p = C.preds[from][cur][0];
      if (p === undefined) return null;
      path.push(p); cur = p;
    }
    return path.reverse();
  };
  const p1 = half(pair.source, v), p2 = half(v, pair.target);
  return p1 && p2 ? [...p1, ...p2.slice(1)] : [];
}

/** A pair's share as written in the breakdown: "1", or "1/2 = 0.5". */
function pairShareText(pair: BetweennessPair): string {
  if (pair.through === pair.total) return "1";
  return `${pair.through}/${pair.total} = ${Number((pair.through / pair.total).toFixed(3))}`;
}

/** The highlighted example in words: "要经过" only when every shortest route of the pair passes the node. */
export function betweennessExampleSentence(pair: BetweennessPair, node: string): string {
  const route = `${pair.source} → ${pair.target}`;
  if (pair.through === pair.total) {
    return pair.total === 1
      ? `例如 ${route} 只有一条最短路线，它要经过 ${node}（已高亮），这一对计 1。`
      : `例如 ${route} 的 ${pair.total} 条最短路线都要经过 ${node}（已高亮），这一对计 1。`;
  }
  return `例如 ${route} 有 ${pair.total} 条最短路线，其中 ${pair.through} 条经过 ${node}（已高亮），这一对计 ${pairShareText(pair)}。`;
}

export function BetweennessPairTable({ node, pairs }: { node: string; pairs: readonly BetweennessPair[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <caption className="sr-only">节点 {node} 的介数：每一对起点和终点计入的份额</caption>
      <thead>
        <tr>
          <th scope="col" style={{ textAlign: "left" }}>起点 → 终点</th>
          <th scope="col">最短路线条数</th>
          <th scope="col">其中经过 {node}</th>
          <th scope="col">计入</th>
        </tr>
      </thead>
      <tbody>{pairs.map((pair) => (
        <tr key={`${pair.source}-${pair.target}`}>
          <th scope="row" style={{ textAlign: "left" }}>{pair.source} → {pair.target}</th>
          <td style={{ textAlign: "center" }}>{pair.total}</td>
          <td style={{ textAlign: "center" }}>{pair.through}</td>
          <td style={{ textAlign: "center" }}>{pairShareText(pair)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function NetworkCentralityDemo() {
  const C = useMemo(computeCentrality, []);
  const [mode, setMode] = useState<NetworkDemoMode>("degree");
  const [sel, setSel] = useState<string>("DEU");
  const [focusedNode, setFocusedNode] = useState<string>("DEU");
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const instructionId = `network-demo-instruction-${useId().replaceAll(":", "")}`;
  const nodeIds = NET_NODES.map((node) => node.id);

  const focusNode = (nodeId: string) => {
    setFocusedNode(nodeId);
    const focus = () => nodeRefs.current.get(nodeId)?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else globalThis.setTimeout(focus, 0);
  };

  const betweennessPairs = betweennessPairsFrom(sel, C);
  const examplePair = betweennessExamplePair(betweennessPairs);
  const pathNodes = mode === "betweenness" ? samplePathThrough(sel, examplePair, C) : [];
  const pathEdges = new Set<string>();
  for (let i = 0; i + 1 < pathNodes.length; i++) pathEdges.add(ekey(pathNodes[i], pathNodes[i + 1]));
  const distancePaths = NET_NODES.filter((node) => node.id !== sel).map((node) => ({
    target: node.id,
    distance: C.dist[sel][node.id],
    path: shortestPath(sel, node.id, C),
  }));
  if (mode === "closeness") distancePaths.forEach(({ path }) => {
    for (let i = 0; i + 1 < path.length; i++) pathEdges.add(ekey(path[i], path[i + 1]));
  });
  const neighbors = new Set([...C.out[sel], ...C.incoming[sel]]);

  const edgeActive = (a: string, b: string) =>
    mode === "degree"
      ? a === sel || b === sel
      : pathEdges.has(ekey(a, b));

  const selNode = NET_NODES.find((n) => n.id === sel)!;
  const reachablePaths = distancePaths.filter((item) => Number.isFinite(item.distance));
  const distanceSum = reachablePaths.reduce((sum, item) => sum + item.distance, 0);
  const visualMax = Math.max(...NET_NODES.map((node) => networkDemoMetricValue(node.id, mode, C)), 1e-9);
  const nodeRadius = (nodeId: string) => 18 + (networkDemoMetricValue(nodeId, mode, C) / visualMax) * 20;
  const selectedValue = networkDemoMetricValue(sel, mode, C);
  const selectedEdges = teachingNetworkEdgesForNode(sel);

  return (
    <div className="demo-card">
      <div className="demo-title">演示 · 中心性的计算方法</div>
      <div className="demo-controls">
        <div className="pill-group" role="group" aria-label="选择中心性指标">
          {(["degree", "betweenness", "closeness"] as NetworkDemoMode[]).map((metric) => (
            <button
              key={metric}
              type="button"
              className={mode === metric ? "on" : ""}
              aria-pressed={mode === metric}
              aria-label={`查看${NETWORK_DEMO_MODE_LABELS[metric]}的算法`}
              onClick={() => setMode(metric)}
            >
              {NETWORK_DEMO_MODE_LABELS[metric]}
            </button>
          ))}
        </div>
        <span className="muted" id={instructionId}>
          选择节点后可查看它的指标值与相关边。
          {/* Node radius follows the current measure in every mode (round 21: 接近中心性 resized nodes unexplained). */}
          圆的大小表示各节点的{NETWORK_DEMO_MODE_LABELS[mode]}，数值越大，圆越大。
        </span>
      </div>

      <div className="net-demo-wrap">
        <svg
          viewBox="0 0 620 340"
          className="net-demo-svg"
          role="group"
          aria-label="七节点有向中心性演示网络"
          aria-describedby={instructionId}
        >
          <defs>
            <marker id="net-demo-arrow" markerWidth="8" markerHeight="8" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L0,6 L8,3 z" fill="context-stroke" />
            </marker>
          </defs>
          {NET_EDGES.map(([a, b]) => {
            const na = NET_NODES.find((n) => n.id === a)!;
            const nb = NET_NODES.find((n) => n.id === b)!;
            const active = edgeActive(a, b);
            const length = Math.hypot(nb.x - na.x, nb.y - na.y) || 1;
            const ux = (nb.x - na.x) / length;
            const uy = (nb.y - na.y) / length;
            // Anchor the marker at its tip and leave room outside each node's current radius and border.
            const startOffset = nodeRadius(a) + 4;
            const endOffset = nodeRadius(b) + 4;
            return (
              <line
                key={ekey(a, b)}
                x1={na.x + ux * startOffset} y1={na.y + uy * startOffset}
                x2={nb.x - ux * endOffset} y2={nb.y - uy * endOffset}
                stroke={active ? "#4b47e0" : "#d8dbe6"}
                strokeWidth={active ? 3.5 : 1.5}
                markerEnd="url(#net-demo-arrow)"
              />
            );
          })}
          {NET_NODES.map((n) => {
            const isSel = n.id === sel;
            const isNeighbor = mode === "degree" && neighbors.has(n.id);
            const onPath = mode !== "degree" && (mode === "closeness" || pathNodes.includes(n.id));
            const val = networkDemoMetricValue(n.id, mode, C);
            const r = nodeRadius(n.id);
            const accessibleName = networkDemoNodeAccessibleName(n, mode, val, isSel);
            return (
              <g
                key={n.id}
                ref={(element) => {
                  if (element) nodeRefs.current.set(n.id, element);
                  else nodeRefs.current.delete(n.id);
                }}
                className="net-demo-node"
                role="button"
                tabIndex={focusedNode === n.id ? 0 : -1}
                aria-pressed={isSel}
                aria-label={accessibleName}
                onFocus={() => setFocusedNode(n.id)}
                onClick={() => {
                  setSel(n.id);
                  setFocusedNode(n.id);
                }}
                onKeyDown={(event) => {
                  const activation = event.key === "Enter" || event.key === " ";
                  const focusTarget = nextNetworkDemoNode(nodeIds, n.id, event.key);
                  if (!activation && !focusTarget) return;
                  event.preventDefault();
                  const next = networkDemoKeyTransition(
                    nodeIds,
                    { focused: n.id, selected: sel },
                    event.key,
                  );
                  if (next.selected !== sel) setSel(next.selected);
                  if (next.focused !== n.id) focusNode(next.focused);
                }}
                style={{ cursor: "pointer" }}
              >
                <title>{accessibleName}</title>
                <circle
                  cx={n.x} cy={n.y} r={r}
                  fill={isSel ? "#4b47e0" : onPath ? "#7a6bff" : isNeighbor ? "#c9c4f7" : "#eef0f5"}
                  stroke={isSel ? "#2c2a6b" : "#c3c8d4"} strokeWidth={isSel ? 2.5 : 1}
                />
                <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="13" fontWeight="700"
                  fill={isSel || onPath ? "#fff" : "#3a4050"}>{n.label}</text>
              </g>
            );
          })}
        </svg>

        <div className="net-demo-panel">
          <div className="ndp-live" role="status" aria-live="polite" aria-atomic="true">
            已选择节点 <b>{selNode.label}</b>（{sel}）；{NETWORK_DEMO_MODE_LABELS[mode]} = <b>{networkDemoMetricText(selectedValue, mode)}</b>
          </div>
          <div className="ndp-node">节点 <b>{selNode.label}</b>（{sel}）</div>
          {mode === "degree" ? (
            <>
              <div className="ndp-formula">度 = 入度 + 出度（原始边数）</div>
              <div className="ndp-calc">
                = {C.indeg[sel]} + {C.outdeg[sel]} = <b>{C.deg[sel]}</b>
              </div>
              <p className="ndp-note">
                高亮的是全部入边和出边。（真实数据里还有自环，即行业卖给自己的部分，它在入度和出度中各计一次。）
              </p>
            </>
          ) : mode === "betweenness" ? (
            <>
              <div className="ndp-formula">介数 = Σ σₛₜ(v) / σₛₜ（σₛₜ：s 到 t 的最短路线条数；σₛₜ(v)：其中经过 v 的条数）</div>
              <div className="ndp-calc">
                = {betweennessPairs.length > 1 && betweennessPairs.length <= 8
                  ? <>{betweennessPairs.map((pair) => pairShareText(pair).split(" = ").at(-1)).join(" + ")} = </>
                  : betweennessPairs.length > 8 ? <>下表 {betweennessPairs.length} 对之和 = </> : null}
                <b>{networkDemoMetricText(C.bet[sel], "betweenness")}</b>
              </div>
              <p className="ndp-note">
                {examplePair && pathNodes.length >= 3
                  ? <>{betweennessExampleSentence(examplePair, sel)}经过它的最短路线越多，介数越高；但这不说明它是经济瓶颈。</>
                  : C.bet[sel] === 0
                    ? <>{selNode.label}（{sel}）不在其他节点之间的任何最短路线上，介数为 0。</>
                    : <>{selNode.label}（{sel}）很少落在其他节点之间的最短路线上，介数低。</>}
              </p>
              {betweennessPairs.length > 0 && (
                <ScrollableRegion
                  label={`节点 ${sel} 的介数按节点对拆开的明细，可滚动`}
                  style={{ maxHeight: 150, overflow: "auto", marginBottom: 10 }}
                >
                  <BetweennessPairTable node={sel} pairs={betweennessPairs} />
                </ScrollableRegion>
              )}
            </>
          ) : (
            <>
              <div className="ndp-formula">接近中心性 = 沿出边可达节点数 / 最短距离和</div>
              <div className="ndp-calc">
                {reachablePaths.length > 0
                  ? <>= {reachablePaths.length} / {distanceSum} = <b>{C.closeness[sel].toFixed(3)}</b></>
                  : <>沿出边无法到达其他节点，接近中心性无法定义。</>}
              </div>
              <p className="ndp-note">高亮的是从 {sel} 沿箭头出发的最短路线；无法到达的节点不计入分子和分母。</p>
              <ScrollableRegion
                label={`从节点 ${sel} 出发的最短路线明细，可滚动`}
                style={{ maxHeight: 150, overflow: "auto", marginBottom: 10 }}
              >
                <ClosenessPathTable source={sel} paths={distancePaths} />
              </ScrollableRegion>
            </>
          )}
          <ScrollableRegion
            className="ndp-edges"
            label={`节点 ${sel} 的全部直接入边与出边`}
          >
            <table className="data-table net-demo-edge-table">
              <caption>节点 {sel} 的全部直接入边与出边；演示网络每条边权重均为 1</caption>
              <thead>
                <tr><th scope="col">方向</th><th scope="col">相邻节点</th><th scope="col">有向边</th></tr>
              </thead>
              <tbody>
                {selectedEdges.map((edge) => (
                  <tr key={`${edge.direction}-${edge.from}-${edge.to}`}>
                    <td>{edge.direction}</td>
                    <th scope="row">{edge.neighbor}</th>
                    <td>{edge.from} → {edge.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableRegion>
          <div className="ndp-disclaim">
            这是一个 7 节点的有向演示网络。真实数据保留全部正流量和自环（行业卖给自己的部分），在完整的全球“国家×行业”生产网络上用同样的方法计算。
          </div>
        </div>
      </div>
    </div>
  );
}
