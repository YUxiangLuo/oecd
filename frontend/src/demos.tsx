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
import { useId, useMemo, useRef, useState } from "react";
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
import { signedDomain, signedStack } from "./viz/signed-layout";
import type { IndustryPage, Meta } from "./types";

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
type DecompCfg = {
  /** Heading of the hands-on card. */
  title: string;
  total: string;
  totalLabel: string;
  unit: "amount" | "number";
  parts: Part[];
  /** 加权模式的权重分母(如 SVA);设置后各分项按 VA 份额加权 */
  weightTotal?: string;
  note?: (r: Row, values: number[]) => string;
  /** What a negative part means here (the table's default names net subsidies, which fits step 2's taxsub). */
  negativeNote?: string;
};

const DECOMP: Record<number, DecompCfg> = {
  4: {
    title: "各分项的金额、占比与含义",
    total: "gross_exports",
    totalLabel: "总出口",
    unit: "amount",
    parts: [
      { key: "DVAex", label: "DVAex 国内增加值出口", color: "#4b47e0", desc: "出口中由本国创造、在国外被最终使用的增加值。" },
      { key: "DVArt", label: "DVArt 返回国内的增加值", color: "#7a6bff", desc: "先随出口离境、绕一圈又回到本国被最终使用的国内增加值。" },
      { key: "DDC", label: "DDC 国内重复计算", color: "#b6b1f2", desc: "本国增加值在出口统计中被重复计入的部分（中间品多次跨境造成）。" },
      { key: "FVA", label: "FVA 外国增加值", color: "#159a86", desc: "出口中由其他国家创造的增加值（例如进口零部件的价值），不包括外国重复计算 FDC。" },
      { key: "FDC", label: "FDC 外国重复计算", color: "#e0982a", desc: "外国增加值在出口统计中被重复计入的部分。" },
      { key: "taxsub", label: "taxsub 产品税减补贴", color: "#98a0b3", desc: "出口中直接和间接包含的产品税减补贴（来自 ICIO 的 TLS 账户）。可为负，表示净补贴。" },
    ],
    note: (_r, values) =>
      `出口中的国内增加值合计（EXDVA）= DVAex + DVArt = ${sumText(values[0], values[1])}。` +
      `taxsub 是本系统另加的一项，不属于 WWZ 原方法。`,
  },
  5: {
    title: "各分项的金额、占比与含义",
    total: "SVA",
    totalLabel: "总增加值 SVA",
    unit: "amount",
    parts: [
      { key: "1_VA_D", label: "1_VA_D 纯国内增加值", short: "纯国内", color: "#4b47e0", desc: "增加值只服务本国最终需求，完全不跨境。" },
      { key: "2_VA_RT", label: "2_VA_RT 传统贸易增加值", short: "传统贸易", color: "#159a86", desc: "增加值随最终产品直接出口，只跨境一次。" },
      { key: "3a_VA_GVC_S", label: "3a_VA_GVC_S 简单 GVC 增加值", short: "简单 GVC", color: "#e0982a", desc: "增加值随中间品跨境一次后，在国外被最终使用。" },
      { key: "3b_VA_GVC_C", label: "3b_VA_GVC_C 复杂 GVC 增加值", short: "复杂 GVC", color: "#f4693b", desc: "增加值至少两次跨越国境。" },
    ],
    negativeNote: "负值表示这部分增加值为负（例如行业亏损），所以其他分项的比重之和可能超过 100%。",
    note: (_r, values) =>
      `GVC 合计（3_VA_GVC）= 简单 GVC + 复杂 GVC = ${sumText(values[2], values[3])}。` +
      `也可以反过来，从最终产品在哪国完成来拆分（后向分解，代码 FGY），在步骤 7 选带“（后向）”的指标查看。`,
  },
  6: {
    title: "各段对总长度的贡献",
    total: "PLv",
    totalLabel: "前向总生产长度 PLv",
    unit: "number",
    weightTotal: "SVA",
    parts: [
      { key: "PLv_D", label: "纯国内加权贡献", short: "纯国内", color: "#4b47e0", desc: "纯国内这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献。", weightKey: "1_VA_D" },
      { key: "PLv_RT", label: "传统贸易加权贡献", short: "传统贸易", color: "#159a86", desc: "传统贸易这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献。", weightKey: "2_VA_RT" },
      { key: "PLv_GVC", label: "GVC 加权贡献", short: "GVC", color: "#f4693b", desc: "GVC 这一段的长度 × 它的增加值份额，就是这一段对总长度的贡献；段长度和贡献不是同一个数。", weightKey: "3_VA_GVC" },
    ],
    note: (r) => {
      const segment = (lengthKey: string, weightKey: string) => {
        const length = finiteNumber(r[lengthKey]);
        if (length != null) return length.toFixed(3);
        return finiteNumber(r[weightKey]) === 0 ? "—（无此类活动）" : "—";
      };
      return `各段长度：纯国内 ${segment("PLv_D", "1_VA_D")}、传统贸易 ${segment("PLv_RT", "2_VA_RT")}、GVC ${segment("PLv_GVC", "3_VA_GVC")}` +
        `（上表是这些长度乘以增加值份额后的贡献）。`;
    },
  },
};

/** A negative part keeps its own colour (so parts stay distinguishable) striped with the negative red. */
export function negativeFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 5px, #e34948 5px 8px)`;
}

/** Decimals an amount is read to in steps 2–3 (table rows, the total, the sum line and formulas), so the shown
 * parts add up to the shown total within its last digit: three below 10, two below 1,000 ("15.40", not "15" next to
 * a total of "99.90"), one below 10,000 ("3,829.7") and whole millions from 10,000 up. A real but tiny flow reads
 * "<0.001" rather than "0". Lengths are read to three decimals; an exact zero is "0". */
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
export function ratioOperands(numerator: number, denominator: number): { numerator: string; denominator: string; percent: string } {
  const percent = percentText((numerator / denominator) * 100);
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
export function sumText(a: number, b: number): string {
  const whole = (v: number) => v === 0 || amountDecimals(v) === 0;
  if (whole(a) && whole(b)) return fmt(a + b, "amount");
  return `${formulaAmount(a)} + ${formulaAmount(b)} = ${formulaAmount(a + b)}`;
}

/** When the rows as displayed do not add up to the displayed sum within its last digit (each row is rounded on its
 * own), the sum line says what they add up to, so "✓ N 项相加" never contradicts the table above it. */
export function displayedSumNote(values: readonly number[], sum: number): string | null {
  const shown = values.map((value) => shownAmount(fmt(value, "amount"), value));
  const total = shown.reduce((acc, value) => acc + value, 0);
  const shownSum = shownAmount(fmt(sum, "amount"), sum);
  if (Math.abs(total - shownSum) <= 10 ** -amountDecimals(sum) * (1 + 1e-9)) return null;
  const decimals = Math.max(...values.map((value) => (value === 0 ? 0 : amountDecimals(value))));
  return `（上表各项按显示值相加为 ${amountText(total, decimals)}，差别来自四舍五入）`;
}

/** A share already in percent, to three decimals as everywhere else ("11.730%"); an exact zero is "0%". */
function percentText(percent: number): string {
  return percent === 0 ? "0%" : `${stripNegativeZero(percent.toFixed(3))}%`;
}

/** The same digits as the decomposition table beside it; a tiny operand keeps three significant digits so the
 * substituted formula never reads "0 / 0". */
function disclosureAmount(value: number | null): string {
  return value == null ? "—" : formulaAmount(value);
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
  return denominator < 0 ? "—（总量为负，无法计算比重）" : "—（总量为 0，无法计算比重）";
}

export function IndicatorCalculationDisclosure({ step, row }: { step: number; row: Row }) {
  if (step === 4 || step === 5) {
    const numeratorKey = step === 4 ? "FVA" : "3b_VA_GVC_C";
    const denominatorKey = step === 4 ? "gross_exports" : "SVA";
    const numerator = finiteNumber(row[numeratorKey]);
    const denominator = finiteNumber(row[denominatorKey]);
    const ratio = disclosureRatio(numerator, denominator);
    const operands = ratio != null ? ratioOperands(numerator!, denominator!) : null;
    const title = step === 4 ? "外国增加值项占比" : "复杂 GVC 生产份额";
    const denominatorLabel = step === 4 ? "总出口" : "总增加值 SVA";
    return (
      <section className="indicator-calculation-disclosure" aria-label={`${title}计算公示`}>
        <div className="icd-kicker">这个指标怎么算</div>
        <div className="icd-title">{title}</div>
        <div className="icd-formula">{title} = {numeratorKey} / {denominatorLabel}</div>
        <div className="icd-calc">
          = {operands?.numerator ?? disclosureAmount(numerator)} / {operands?.denominator ?? disclosureAmount(denominator)} = <b>{operands?.percent ?? disclosureRatioGap(numerator, denominator)}</b>
        </div>
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
    <section className="indicator-calculation-disclosure" aria-label="GVC 位置指数计算公示">
      <div className="icd-kicker">这个指标怎么算</div>
      <div className="icd-title">GVC 位置指数 GVCPs</div>
      <div className="icd-formula">GVCPs = PLv_GVC / PLy_GVC</div>
      <div className="icd-calc">
        = {disclosureLength(forward)} / {disclosureLength(backward)} = <b>{position == null ? positionGap : stripNegativeZero(position.toFixed(3))}</b>
      </div>
      <p>这里比较前向与后向的 GVC 段长度。上方 PLv 恒等式中的每一项是“增加值份额 × 段长度”的加权贡献，不是段长度本身。</p>
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
  compact = false,
  negativeNote = "负值表示抵减项（例如净补贴），所以其他分项的比重之和可能超过 100%。",
}: {
  caption: string;
  parts: readonly Part[];
  values: readonly (number | null)[];
  shares: readonly (number | null)[] | null;
  unit: "amount" | "number";
  unavailable?: boolean;
  hover?: string | null;
  onHover?: (key: string | null) => void;
  /** Side by side: the meaning goes under the name instead of a squeezed fourth column. */
  compact?: boolean;
  /** What a negative part means in this decomposition; only shown beside shares it explains. */
  negativeNote?: string;
}) {
  // The note explains shares summing past 100%; with no shares (e.g. a negative total) the reason line says why.
  const hasNegative = !unavailable
    && Boolean(shares?.some((share) => share != null))
    && values.some((value) => value != null && value < 0);
  return (
    <>
    <table className={`decomp-table${compact ? " decomp-table--compact" : ""}`}>
      <caption className="sr-only">{caption}</caption>
      {/* Visible column names: a value and a share side by side are otherwise unlabelled. */}
      <thead className="decomp-table-head">
        <tr>
          <th scope="col">分项</th>
          <th scope="col">数值</th>
          <th scope="col">占总量比重</th>
          {!compact && <th scope="col">含义</th>}
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
              {compact && <span className="dt-desc dt-desc--below">{part.desc}</span>}
            </th>
            <td className="dt-val">{value == null ? "—" : fmt(value, unit)}</td>
            <td className="dt-share">{unavailable ? "—" : share == null ? "—（无法计算）" : percentText(share)}</td>
            {!compact && <td className="dt-desc">{part.desc}</td>}
          </tr>
        );
      })}</tbody>
    </table>
    {hasNegative && <p className="decomp-table-note">{negativeNote}</p>}
    </>
  );
}

const PLY_DECOMP: DecompCfg = {
  title: "后向总生产长度 PLy",
  total: "PLy",
  totalLabel: "后向总生产长度 PLy",
  unit: "number",
  weightTotal: "FGY",
  parts: [
    { key: "PLy_D", label: "纯国内段", color: "#4b47e0", desc: "按 1_FGY_D / FGY 加权。", weightKey: "1_FGY_D" },
    { key: "PLy_RT", label: "传统贸易段", color: "#159a86", desc: "按 2_FGY_RT / FGY 加权。", weightKey: "2_FGY_RT" },
    { key: "PLy_GVC", label: "GVC 段", color: "#f4693b", desc: "按 3_FGY_GVC / FGY 加权。", weightKey: "3_FGY_GVC" },
  ],
};

export function zeroTotalDecompositionHint(model: DecompositionModel, totalLabel: string): string | null {
  const kind = directZeroTotalKind(model);
  if (kind === "all-zero") {
    return "所有分项都是 0，这一年可能没有相关活动，请换一个行业。";
  }
  if (kind === "signed-offset") {
    return `${cjkJoin(totalLabel, "为 0：")}正负分项相互抵消，无法算比重。`;
  }
  if (kind === "nonclosing") {
    return `${cjkJoin(totalLabel, "为 0，")}但各分项加起来不等于 0，无法算比重。`;
  }
  return null;
}

export function decompositionModelReason(model: DecompositionModel, weightLabel?: string): string {
  const weight = weightLabel ?? "权重";
  if (model.reason === "zero-weight-denominator") {
    return cjkJoin(weight, "为 0（没有这类活动），无法算加权长度。");
  }
  if (model.reason === "negative-weight-denominator") {
    return cjkJoin(weight, "小于 0，无法按份额加权平均。");
  }
  if (model.reason === "missing-fields") {
    return `分解数据不完整${model.missingFields.length ? `（缺 ${model.missingFields.join("、")}）` : ""}，暂时无法拆分。`;
  }
  if (model.reason === "nonfinite-calculation") return "数据不完整，暂时无法拆分。";
  if (model.reason === "zero-total") {
    const kind = directZeroTotalKind(model);
    if (kind === "all-zero") {
      return "所有分项都是 0，这一年可能没有相关活动；无法算比重。";
    }
    if (kind === "signed-offset") {
      return "总量为 0：正负分项相互抵消，无法算比重。";
    }
    if (kind === "nonclosing") {
      return "总量为 0，但各分项加起来不等于 0，无法算比重。";
    }
    return "总量为 0，无法算比重。";
  }
  return "总量为负，无法算比重。";
}

/** A weight of 0 or below makes the weighted parts undefined, not missing: the "—" line says which. */
export function unavailableDashNote(model: DecompositionModel): string {
  return model.reason === "zero-weight-denominator" || model.reason === "negative-weight-denominator"
    ? "“—”表示这一项无法计算（不是缺少数据），不按 0 计算。"
    : "“—”表示没有数据，不按 0 计算。";
}

/** A total that is still defined while its share-weighted split is not (MLT H51 2020: SVA -1.268, PLv 2.131):
 * the headline length comes straight from the input–output relations; only the weighted parts need SVA > 0. */
export function unavailableTotalNote(model: DecompositionModel, cfg: Pick<DecompCfg, "totalLabel" | "unit" | "weightTotal">): string | null {
  if (model.reason !== "negative-weight-denominator" || model.total == null || !cfg.weightTotal) return null;
  return `${cfg.totalLabel} = ${fmt(model.total, cfg.unit)} 仍有定义：总长度由投入产出关系直接算出，不需要份额；无法计算的只是按 ${cfg.weightTotal} 份额加权的各段贡献，所以这里只是拆不开。`;
}

/** Only missing data can change later ("暂时无法拆分"); a weight of 0 or below (LUX B09: FGY = 0, no final goods) is
 * structural, so its heading reads plain 无法拆分. */
function missingDataReason(model: DecompositionModel): boolean {
  return model.reason === "missing-fields" || model.reason === "nonfinite-calculation";
}

function MiniBackwardBar({ row }: { row: Row }) {
  const model = buildDecompositionModel(row, PLY_DECOMP);
  const position = finiteNumber(row.GVCPs);
  if (model.status !== "valid" || !model.values || model.total == null || model.sum == null || model.error == null) {
    return (
      <div className="decomp-unavailable" role="status" style={{ marginTop: 14 }}>
        <b>后向 PLy · {missingDataReason(model) ? "暂时无法拆分" : "无法拆分"}</b>
        <div>{decompositionModelReason(model, "FGY")}</div>
        <div>PLy = {model.total == null ? "—（无法计算）" : fmt(model.total, "number")}；GVCPs = {position?.toFixed(3) ?? "—（无法计算）"}</div>
        <div>{PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} style={{ marginRight: 10 }}>
            {part.label}：{model.contributions[index] == null ? "—" : fmt(model.contributions[index]!, "number")}
          </span>
        ))}</div>
      </div>
    );
  }
  const domain = signedDomain([model.values], true, [model.total]);
  const layout = signedStack(model.values, domain, true, model.total);
  return (
    <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "#f8f9fc" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11.5, marginBottom: 7 }}>
        <b>后向总生产长度 PLy（从最终产品往回数）</b>
        <span>{fmt(model.total, "number")}</span>
      </div>
      <div style={{ position: "relative", height: 12, background: "#eceef4", borderRadius: 5, overflow: "hidden" }}>
        {PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} title={`${part.label}：${fmt(model.values![index], "number")}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${layout.segments[index].leftPct}%`, width: `${layout.segments[index].widthPct}%`, background: layout.segments[index].negative ? negativeFill(part.color) : part.color }} />
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        PLy = 各段（最终产品中的份额 × 段长度）之和 = {fmt(model.sum, "number")}；{model.error < 1e-6 ? "与总量一致" : `与总量相差 ${model.error.toPrecision(2)}`}。
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
  secondaryCountry,
  onSecondaryChange,
}: {
  step: number;
  meta: Meta;
  /** The table may browse globally; the single-entity demo requires an explicit valid country. */
  primaryYear: number;
  primaryCountry: string | null;
  onPrimaryChange?: (year: number, country: string) => void;
  /** Object B when comparing; pass it to keep B in step with the report-material comparison country. */
  secondaryCountry?: string;
  onSecondaryChange?: (country: string) => void;
}) {
  const cfg = DECOMP[step];
  const defaultA = meta.countries.includes("CHN") ? "CHN" : meta.countries[0] ?? "";
  const defaultB = meta.countries.includes("USA") ? "USA" : meta.countries[1] ?? defaultA;
  // Country level first: the same figures the report material records; industries are one click away.
  const [gran, setGran] = useState<"country" | "sector">("country");
  const year = meta.years.includes(primaryYear) ? primaryYear : meta.years.at(-1)!;
  const [compare, setCompare] = useState(false);
  const countryA = explicitDemoCountry(meta.countries, primaryCountry) ?? "";
  const [localB, setLocalB] = useState(defaultB);
  // At country–industry level B may be A's own country, to compare two of its industries. That choice stays
  // in this view: the report material's comparison country (secondaryCountry) must differ from A. The chosen
  // country is stored itself, so changing A afterwards leaves B where the student put it.
  const [viewOnlyB, setViewOnlyB] = useState<string | null>(null);
  const countryB = viewOnlyB && gran === "sector" ? viewOnlyB : secondaryCountry ?? localB;
  const setCountryB = (value: string) => {
    if (value === countryA) {
      setViewOnlyB(value);
      return;
    }
    setViewOnlyB(null);
    (onSecondaryChange ?? setLocalB)(value);
  };
  const [sectorA, setSectorA] = useState("");
  const [sectorB, setSectorB] = useState("");
  const [hover, setHover] = useState<string | null>(null);

  const demoAvailable = countryA !== "";
  const requestKeyA = decompositionRequestKey(year, countryA);
  const requestKeyB = decompositionRequestKey(year, countryB);
  const loadSide = async (requestYear: number, requestCountry: string): Promise<DecompositionSideData> => {
    const [countryRows, pageResult] = await Promise.all([
      api.countryIndicatorsForCountry(requestYear, requestCountry),
      api.industryIndicatorsAll(requestYear, requestCountry),
    ]);
    return { countryRows, page: pageResult };
  };
  const sideAQuery = useAsync<DecompositionSideData>(
    () => loadSide(year, countryA),
    [requestKeyA],
    { enabled: demoAvailable, requestKey: requestKeyA },
  );
  const sideBQuery = useAsync<DecompositionSideData>(
    () => loadSide(year, countryB),
    [requestKeyB],
    { enabled: demoAvailable && compare, requestKey: requestKeyB },
  );
  const countryRowsA = sideAQuery.status === "success" ? sideAQuery.data?.countryRows ?? null : null;
  const countryRowsB = sideBQuery.status === "success" ? sideBQuery.data?.countryRows ?? null : null;
  const pageA = sideAQuery.status === "success" ? sideAQuery.data?.page ?? null : null;
  const pageB = sideBQuery.status === "success" ? sideBQuery.data?.page ?? null : null;

  const sectorsA = (pageA?.rows ?? []).map((row) => String(row.industry));
  const effSectorA = sectorsA.includes(sectorA) ? sectorA : sectorsA[0] ?? "";
  // Within one country, B offers A's other industries only: the same country and industry on both sides would
  // show two identical panels. As at country level, moving A onto B's choice moves B to the next industry.
  const sectorsB = (pageB?.rows ?? [])
    .map((row) => String(row.industry))
    .filter((code) => !(gran === "sector" && countryB === countryA && code === effSectorA));
  const effSectorB = sectorsB.includes(sectorB) ? sectorB : sectorsB[0] ?? "";
  const rowA = gran === "country"
    ? countryRowsA?.find((row) => row.country === countryA)
    : pageA?.rows.find((row) => row.industry === effSectorA);
  const rowB = gran === "country"
    ? countryRowsB?.find((row) => row.country === countryB)
    : pageB?.rows.find((row) => row.industry === effSectorB);
  const panelRows = [rowA, ...(compare ? [rowB] : [])];
  const domainRows = decompositionDomainRows(panelRows, cfg);
  const domain = signedDomain(
    domainRows.map((item) => item.values),
    true,
    domainRows.map((item) => item.total),
  );

  // Plain names for the two sides: what is shown, or which column when two are side by side.
  const sideLabel = (side: "A" | "B") => compare
    ? side === "A" ? "左栏" : "右栏"
    : gran === "country" ? "所选国家" : "所选行业";
  const levelLabel = (sector: string) => gran === "sector" ? sectorLabel(sector) : "国家整体";

  const entityPicker = (side: "A" | "B") => {
    const country = side === "A" ? countryA : countryB;
    const sector = side === "A" ? effSectorA : effSectorB;
    const setSector = side === "A" ? setSectorA : setSectorB;
    const sectors = side === "A" ? sectorsA : sectorsB;
    return (
      <div className="demo-controls" style={{ marginBottom: 10 }} role="group" aria-label={sideLabel(side)}>
        <b aria-hidden="true">{sideLabel(side)}</b>
        <LabeledControl label="国家">
          {(id) => (
            <select id={id} value={country} onChange={(event) => {
              if (side === "A") onPrimaryChange?.(year, event.target.value);
              else setCountryB(event.target.value);
            }}>
              {/* At country level B is the recorded comparison country and must differ from A (offering A made the
                  choice snap back); at industry level A's country is allowed for a within-country comparison. */}
              {meta.countries.filter((code) => side === "A" || gran === "sector" || code !== countryA).map((code) => <option key={code} value={code}>{countryLabel(code)}</option>)}
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
      </div>
    );
  };

  const panel = (
    row: Row | undefined,
    side: "A" | "B",
    page: IndustryPage | null,
    sector: string,
    country: string,
    query: { status: AsyncStatus; error: string | null; retry: () => void },
  ) => {
    if (query.status !== "success" || !row) {
      return (
        <div style={{ minWidth: 0 }}>
          {entityPicker(side)}
          <DecompositionRequestMessage
            label={sideLabel(side)}
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
    const zeroTotalHint = zeroTotalDecompositionHint(model, cfg.totalLabel);
    // A negative total is not "too small": the identity line already explains it (总量为负，无法算比重).
    const negligible = model.total != null && gran === "sector" && (
      model.total === 0 || (model.total > 0 && countryTotal != null && countryTotal > 0 && model.total / countryTotal < 1e-4)
    );

    if (!model.values || model.total == null || model.sum == null || model.error == null) {
      return (
        <div style={{ minWidth: 0 }}>
          {entityPicker(side)}
          <div className="decomp-total-line">
            {cfg.totalLabel} = <b>{model.total == null ? "—（未定义）" : fmt(model.total, cfg.unit)}</b>
            {cfg.unit === "amount" && model.total != null && <span className="muted">（百万美元）</span>}
          </div>
          <IndicatorCalculationDisclosure step={step} row={row} />
          <div className="decomp-unavailable" role="status">
            <b>当前分解不可用</b>
            <div>{decompositionModelReason(model, cfg.weightTotal)}</div>
            {unavailableTotalNote(model, cfg) && <div>{unavailableTotalNote(model, cfg)}</div>}
            <div>{unavailableDashNote(model)}</div>
          </div>
          <DecompositionDetailTable
            caption={`${sideLabel(side)}：${year} 年 ${countryLabel(country)} · ${levelLabel(sector)} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
            parts={cfg.parts}
            values={model.contributions}
            shares={null}
            unit={cfg.unit}
            unavailable
            compact={compare}
            negativeNote={cfg.negativeNote}
          />
          {step === 6 && <MiniBackwardBar row={row} />}
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
    return (
      <div style={{ minWidth: 0 }}>
        {entityPicker(side)}
        <div className="decomp-total-line">
          {cfg.totalLabel} = <b>{fmt(model.total, cfg.unit)}</b>{cfg.unit === "amount" && <span className="muted">（百万美元）</span>}
        </div>
        <IndicatorCalculationDisclosure step={step} row={row} />
        <div className="decomp-bar" style={{ position: "relative", display: "block", overflow: "hidden" }}>
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
              title={`${part.label} · 当前值 ${fmt(value, cfg.unit)} · ${shareText}${segment.negative ? "（负值，位于零轴左侧）" : ""}`} />;
          })}
        </div>
        {model.closure != null ? (
          <div className={`decomp-identity ${model.closure ? "ok" : "bad"}`}>
            {model.closure ? "✓" : "✗"} {cfg.parts.length} 项相加 = {fmt(model.sum, cfg.unit)}，{model.closure ? "等于" : "不等于"}{cfg.totalLabel}{model.error < 1e-6 ? "" : `（差 ${model.error.toPrecision(2)}）`}
            {cfg.unit === "amount" && displayedSumNote(model.values, model.sum)}
          </div>
        ) : negligible && zeroTotalHint ? null : (
          // A zero total is explained once, by the specific hint below.
          <div className="decomp-identity neutral" role="status">
            ℹ {decompositionModelReason(model, cfg.weightTotal)}
            {model.amountCloses != null && ` ${cfg.parts.length} 项金额相加${model.amountCloses ? "等于" : "不等于"}总量。`}
          </div>
        )}
        {negligible && <div className="decomp-hint">⚠️ {countryLabel(country)} · {sectorLabel(sector)}：{
          zeroTotalHint ?? "这个行业的数值太小（不到本国各行业合计的 0.01%），建议换一个行业。"
        }</div>}
        <DecompositionDetailTable
          caption={`${sideLabel(side)}：${year} 年 ${countryLabel(country)} · ${levelLabel(sector)} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
          parts={cfg.parts}
          values={model.values}
          shares={model.shares}
          unit={cfg.unit}
          hover={hover}
          onHover={setHover}
          compact={compare}
          negativeNote={cfg.negativeNote}
        />
        {step === 6 && <MiniBackwardBar row={row} />}
        {cfg.note && sharesAvailable && <div className="decomp-note">{cfg.note(row, model.values)}</div>}
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
              onPrimaryChange?.(Number(event.target.value), countryA);
            }}>{meta.years.map((value) => <option key={value}>{value}</option>)}</select>
          )}
        </LabeledControl>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /> 并排比较另一个国家或行业
        </label>
      </div>
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
      <div style={{ display: "grid", gridTemplateColumns: compare ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)", gap: 18 }}>
        {panel(rowA, "A", pageA, effSectorA, countryA, sideAQuery)}
        {compare && panel(rowB, "B", pageB, effSectorB, countryB, sideBQuery)}
      </div>
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
      <caption className="sr-only">从节点 {source} 出发的最短路径明细</caption>
      <thead>
        <tr>
          <th scope="col" style={{ textAlign: "left" }}>目标</th>
          <th scope="col">距离</th>
          <th scope="col" style={{ textAlign: "left" }}>一条最短路径</th>
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
  const selectedValue = networkDemoMetricValue(sel, mode, C);
  const selectedEdges = teachingNetworkEdgesForNode(sel);

  return (
    <div className="demo-card">
      <div className="demo-title">🕸️ 动手演示 · 中心性是怎么数出来的</div>
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
            <marker id="net-demo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
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
            return (
              <line
                key={ekey(a, b)}
                x1={na.x + ux * 28} y1={na.y + uy * 28}
                x2={nb.x - ux * 32} y2={nb.y - uy * 32}
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
            const r = 18 + (val / visualMax) * 20;
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
                高亮的是全部入边和出边。（真实数据里还有自环，即行业卖给自己的部分，它在入度和出度中各算一次。）
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
                  : <>沿箭头到不了任何节点，记为 <b>0</b></>}
              </div>
              <p className="ndp-note">高亮的是从 {sel} 沿箭头出发的最短路线；到不了的节点不计入分子和分母。</p>
              <ScrollableRegion
                label={`从节点 ${sel} 出发的最短路径明细，可滚动`}
                style={{ maxHeight: 150, overflow: "auto", marginBottom: 10 }}
              >
                <ClosenessPathTable source={sel} paths={distancePaths} />
              </ScrollableRegion>
            </>
          )}
          <ScrollableRegion
            className="ndp-edges"
            label={`节点 ${sel} 的全部直接入边与出边，可横向滚动`}
          >
            <table className="data-table net-demo-edge-table">
              <caption>节点 {sel} 的全部直接入边与出边；演示网络每条边权重均为 1</caption>
              <thead>
                <tr><th scope="col">方向</th><th scope="col">相邻节点</th><th scope="col">有向边</th><th scope="col">演示权重</th></tr>
              </thead>
              <tbody>
                {selectedEdges.map((edge) => (
                  <tr key={`${edge.direction}-${edge.from}-${edge.to}`}>
                    <td>{edge.direction}</td>
                    <th scope="row">{edge.neighbor}</th>
                    <td>{edge.from} → {edge.to}</td>
                    <td>1</td>
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
