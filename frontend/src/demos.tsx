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
import { cjkJoin, stripNegativeZero } from "./format";
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
  /** 加权模式:分项贡献 = row[key] × row[weightKey] / row[weightTotal](见步骤4) */
  weightKey?: string;
};
type DecompCfg = {
  total: string;
  totalLabel: string;
  unit: "amount" | "number";
  parts: Part[];
  /** 加权模式的权重分母(如 SVA);设置后各分项按 VA 份额加权 */
  weightTotal?: string;
  note?: (r: Row, values: number[]) => string;
};

const DECOMP: Record<number, DecompCfg> = {
  4: {
    total: "gross_exports",
    totalLabel: "总出口",
    unit: "amount",
    parts: [
      { key: "DVAex", label: "DVAex 国内增加值出口", color: "#4b47e0", desc: "出口中由本国创造、并被国外最终吸收的增加值；占比越高表示这类国内增加值构成越高。" },
      { key: "DVArt", label: "DVArt 返回国内", color: "#7a6bff", desc: "先随出口离境、绕一圈又回到本国被吸收的国内增加值。" },
      { key: "DDC", label: "DDC 国内重复计算", color: "#b6b1f2", desc: "本国增加值在跨境往返中被海关多次统计的部分。" },
      { key: "FVA", label: "FVA 外国增加值", color: "#159a86", desc: "WWZ 分解中的外国增加值项，不含外国重复计算 FDC。在不含 TLS 的口径下，总出口中的全部外国含量 = FVA（外国增加值）+ FDC（外国重复计算，不是增加值）。" },
      { key: "FDC", label: "FDC 外国重复计算", color: "#e0982a", desc: "外国增加值在跨境中被重复统计的部分。" },
      { key: "taxsub", label: "taxsub 税收减补贴", color: "#98a0b3", desc: "出口直接及间接所含的产品税减补贴（TLS），由 ICIO TLS 账户沿投入产出链计算。" },
    ],
    note: (_r, values) =>
      `EXDVA 出口国内增加值合计 = DVAex + DVArt = ${fmt(values[0] + values[1], "amount")}` +
      `（WWZ 16 个明细项归并为 DVAex / DVArt / DDC / FVA / FDC 五类；taxsub 是本系统基于 OECD ICIO TLS 账户加入的扩展项，不属于 WWZ 原文分类。）`,
  },
  5: {
    total: "SVA",
    totalLabel: "总增加值 SVA",
    unit: "amount",
    parts: [
      { key: "1_VA_D", label: "1_VA_D 纯国内生产", color: "#4b47e0", desc: "增加值只服务本国最终需求，完全不跨境。" },
      { key: "2_VA_RT", label: "2_VA_RT 传统贸易生产", color: "#159a86", desc: "增加值随最终产品直接出口，只跨境一次。" },
      { key: "3a_VA_GVC_S", label: "3a 简单 GVC 生产", color: "#e0982a", desc: "增加值随中间品跨境一次后在国外被吸收。" },
      { key: "3b_VA_GVC_C", label: "3b 复杂 GVC 生产", color: "#f4693b", desc: "增加值至少两次跨越国境。" },
    ],
    note: (_r, values) =>
      `3_VA_GVC = 3a + 3b = ${fmt(values[2] + values[3], "amount")}；` +
      `另有对称的后向分解 FGY 系列（按最终产品完成地记账），可在步骤 7 选择“（后向）”指标查看。`,
  },
  6: {
    total: "PLv",
    totalLabel: "前向总生产长度 PLv",
    unit: "number",
    weightTotal: "SVA",
    parts: [
      { key: "PLv_D", label: "纯国内加权贡献", color: "#4b47e0", desc: "纯国内生产活动的平均长度，按 1_VA_D/SVA 份额加权计入总长度。", weightKey: "1_VA_D" },
      { key: "PLv_RT", label: "传统贸易加权贡献", color: "#159a86", desc: "传统贸易生产活动的平均长度，按 2_VA_RT/SVA 份额加权计入。", weightKey: "2_VA_RT" },
      { key: "PLv_GVC", label: "GVC 加权贡献", color: "#f4693b", desc: "GVC 生产活动的段长度，按 3_VA_GVC/SVA 份额加权计入；段长度与加权贡献不是同一个数。", weightKey: "3_VA_GVC" },
    ],
    note: (r) => {
      const segment = (lengthKey: string, weightKey: string) => {
        const length = finiteNumber(r[lengthKey]);
        if (length != null) return length.toFixed(2);
        return finiteNumber(r[weightKey]) === 0 ? "—（无此类活动）" : "—";
      };
      const position = finiteNumber(r.GVCPs);
      return `各分项是“增加值份额 × 段长度”的加权贡献（总长度是各段长度的增加值加权平均，见 WWYZ 2017b）。` +
        `段长度本身：PLv_D=${segment("PLv_D", "1_VA_D")}、PLv_RT=${segment("PLv_RT", "2_VA_RT")}、PLv_GVC=${segment("PLv_GVC", "3_VA_GVC")}；` +
        `GVC 位置指数 GVCPs = PLv_GVC / PLy_GVC = ${position?.toFixed(3) ?? "—（未定义）"}。`;
    },
  },
};

/** A negative part keeps its own colour (so parts stay distinguishable) striped with the negative red. */
export function negativeFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 5px, #e34948 5px 8px)`;
}

function fmt(v: number, unit: "amount" | "number"): string {
  return stripNegativeZero(unit === "amount"
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toFixed(3));
}

function disclosureAmount(value: number | null): string {
  if (value == null) return "—";
  // Six significant digits would round 1,067,093 to 1,067,090 and contradict the total shown
  // above (formatted as a whole number), so large amounts keep every integer digit.
  const options = Math.abs(value) >= 1e5 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 6 };
  return stripNegativeZero(value.toLocaleString("zh-CN", options));
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

export function IndicatorCalculationDisclosure({ step, row }: { step: number; row: Row }) {
  if (step === 4 || step === 5) {
    const numeratorKey = step === 4 ? "FVA" : "3b_VA_GVC_C";
    const denominatorKey = step === 4 ? "gross_exports" : "SVA";
    const numerator = finiteNumber(row[numeratorKey]);
    const denominator = finiteNumber(row[denominatorKey]);
    const ratio = disclosureRatio(numerator, denominator);
    const title = step === 4 ? "外国增加值项占比" : "复杂 GVC 生产份额";
    const denominatorLabel = step === 4 ? "总出口" : "总增加值 SVA";
    return (
      <section className="indicator-calculation-disclosure" aria-label={`${title}计算公示`}>
        <div className="icd-kicker">指标计算公示</div>
        <div className="icd-title">{title}</div>
        <div className="icd-formula">{title} = {numeratorKey} / {denominatorLabel}</div>
        <div className="icd-calc">
          = {disclosureAmount(numerator)} / {disclosureAmount(denominator)} = <b>{ratio == null ? "—（分母非正或数据缺失）" : `${stripNegativeZero((ratio * 100).toFixed(1))}%`}</b>
        </div>
        <p>{step === 4
          ? "FVA 不含外国重复计算 FDC；分母是六项加总得到的 VA+TLS 账户口径总出口（gross exports），不是 OECD 官方 EXGR_FVASH 口径。"
          : "3b 只统计增加值至少两次跨境的复杂 GVC 路径；该份额反映生产活动构成，不直接代表技术水平或收益。"}</p>
      </section>
    );
  }

  const forward = finiteNumber(row.PLv_GVC);
  const backward = finiteNumber(row.PLy_GVC);
  const position = forward != null && backward != null && Math.abs(backward) > 1e-12
    ? forward / backward
    : null;
  return (
    <section className="indicator-calculation-disclosure" aria-label="GVC 位置指数计算公示">
      <div className="icd-kicker">指标计算公示</div>
      <div className="icd-title">GVC 位置指数 GVCPs</div>
      <div className="icd-formula">GVCPs = PLv_GVC / PLy_GVC</div>
      <div className="icd-calc">
        = {disclosureLength(forward)} / {disclosureLength(backward)} = <b>{position == null ? "—（分母为零或数据缺失）" : stripNegativeZero(position.toFixed(3))}</b>
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
}) {
  return (
    <table className={`decomp-table${compact ? " decomp-table--compact" : ""}`}>
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">分解组成</th>
          <th scope="col">分项数值</th>
          <th scope="col">占比（可为负）</th>
          {!compact && <th scope="col">组成含义</th>}
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
            <td className="dt-share">{unavailable ? "—" : share == null ? "—（分母非正）" : `${share.toFixed(1)}%`}</td>
            {!compact && <td className="dt-desc">{part.desc}</td>}
          </tr>
        );
      })}</tbody>
    </table>
  );
}

const PLY_DECOMP: DecompCfg = {
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
    return "完整零总量行，所有分项均为 0；可能没有活动或为结构零，但当前数据没有原因元数据。";
  }
  if (kind === "signed-offset") {
    return `${totalLabel}=0，因为正负有符号分项相互抵消；构成占比未定义。`;
  }
  if (kind === "nonclosing") {
    return `${totalLabel}=0，但非零有符号分项未闭合到总量；构成占比未定义。`;
  }
  return null;
}

export function decompositionModelReason(model: DecompositionModel, weightLabel?: string): string {
  if (model.reason === "zero-weight-denominator") {
    return `${weightLabel ?? "权重分母"}=0（结构零），加权生产长度未定义。`;
  }
  if (model.reason === "negative-weight-denominator") {
    return `${weightLabel ?? "权重分母"}<0，不满足正权重平均的定义域。`;
  }
  if (model.reason === "missing-fields") {
    return `分解数据不完整或未定义${model.missingFields.length ? `（${model.missingFields.join("、")}）` : ""}。`;
  }
  if (model.reason === "nonfinite-calculation") return "分解计算产生非有限值，不能用于图形、份额或闭合判断。";
  if (model.reason === "zero-total") {
    const kind = directZeroTotalKind(model);
    if (kind === "all-zero") {
      return "完整零总量行：所有分项均为 0，可能为结构零，但当前数据没有原因元数据；普通构成占比未定义。";
    }
    if (kind === "signed-offset") {
      return "总量为 0，因为正负有符号分项相互抵消；普通构成占比未定义。";
    }
    if (kind === "nonclosing") {
      return "总量为 0，但非零有符号分项加总不等于总量；普通构成占比未定义。";
    }
    return "总量为 0；普通构成占比未定义。";
  }
  return "总量为负，普通构成占比未定义。";
}

function MiniBackwardBar({ row }: { row: Row }) {
  const model = buildDecompositionModel(row, PLY_DECOMP);
  const position = finiteNumber(row.GVCPs);
  if (model.status !== "valid" || !model.values || model.total == null || model.sum == null || model.error == null) {
    return (
      <div className="decomp-unavailable" role="status" style={{ marginTop: 14 }}>
        <b>后向 PLy · 暂不可分解</b>
        <div>{decompositionModelReason(model, "FGY")}</div>
        <div>PLy = {model.total == null ? "—（未定义）" : fmt(model.total, "number")}；GVCPs = {position?.toFixed(3) ?? "—（未定义）"}</div>
        <div>{PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} style={{ marginRight: 10 }}>
            {part.label}: {model.contributions[index] == null ? "—" : fmt(model.contributions[index]!, "number")}
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
        <b>后向 PLy · 最终品回溯到初始投入端</b>
        <span>{fmt(model.total, "number")}</span>
      </div>
      <div style={{ position: "relative", height: 12, background: "#eceef4", borderRadius: 5, overflow: "hidden" }}>
        {PLY_DECOMP.parts.map((part, index) => (
          <span key={part.key} title={`${part.label}: ${fmt(model.values![index], "number")}`}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${layout.segments[index].leftPct}%`, width: `${layout.segments[index].widthPct}%`, background: layout.segments[index].negative ? negativeFill(part.color) : part.color }} />
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
        PLy = Σ（FGY 分项份额 × 对应段长度） = {fmt(model.sum, "number")}；{model.error < 1e-6 ? "与总量一致" : `与总量相差 ${model.error.toPrecision(2)}`}。
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
        loadingLabel={`加载${label}的分解数据中…`}
        onRetry={onRetry}
      />
    );
  }
  if (status === "error") {
    return (
      <AsyncStateMessage
        status="error"
        error={userFacingRequestError(error, `${label}的分解加载失败`)}
        onRetry={onRetry}
      />
    );
  }
  if (empty) {
    return <p className="muted async-empty" role="status">{label} 在当前国家与年份下没有可用分解数据。</p>;
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
  const sectorsB = (pageB?.rows ?? []).map((row) => String(row.industry));
  const effSectorA = sectorsA.includes(sectorA) ? sectorA : sectorsA[0] ?? "";
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

  const entityPicker = (side: "A" | "B") => {
    const country = side === "A" ? countryA : countryB;
    const sector = side === "A" ? effSectorA : effSectorB;
    const setSector = side === "A" ? setSectorA : setSectorB;
    const sectors = side === "A" ? sectorsA : sectorsB;
    return (
      <div className="demo-controls" style={{ marginBottom: 10 }} role="group" aria-label={compare ? `对象 ${side}` : "分析对象"}>
        <b aria-hidden="true">{compare ? `对象 ${side}` : "分析对象"}</b>
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
            label={`对象 ${side}`}
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
    const negligible = model.total != null && gran === "sector" && (
      model.total === 0 || (countryTotal != null && countryTotal > 0 && Math.abs(model.total) / countryTotal < 1e-4)
    );

    if (!model.values || model.total == null || model.sum == null || model.error == null) {
      return (
        <div style={{ minWidth: 0 }}>
          {entityPicker(side)}
          <div className="decomp-total-line">
            {cfg.totalLabel} = <b>{model.total == null ? "—（未定义）" : fmt(model.total, cfg.unit)}</b>
            {cfg.unit === "amount" && model.total != null && <span className="muted"> (百万美元)</span>}
          </div>
          <IndicatorCalculationDisclosure step={step} row={row} />
          <div className="decomp-unavailable" role="status">
            <b>当前分解不可用</b>
            <div>{decompositionModelReason(model, cfg.weightTotal)}</div>
            <div>缺失或未定义的值显示为“—”，不会按 0 参与加总或闭合判断。</div>
          </div>
          <DecompositionDetailTable
            caption={`对象 ${side}：${year} 年 ${countryLabel(country)} · ${gran === "sector" ? sectorLabel(sector) : "国家级"} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
            parts={cfg.parts}
            values={model.contributions}
            shares={null}
            unit={cfg.unit}
            unavailable
            compact={compare}
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
          {cfg.totalLabel} = <b>{fmt(model.total, cfg.unit)}</b>{cfg.unit === "amount" && <span className="muted"> (百万美元)</span>}
        </div>
        <IndicatorCalculationDisclosure step={step} row={row} />
        <div className="decomp-bar" style={{ position: "relative", display: "block", overflow: "hidden" }}>
          {panelDomain.negative > 0 && <span aria-hidden style={{ position: "absolute", zIndex: 3, left: `${layout.zeroPct}%`, top: -2, bottom: -2, borderLeft: "2px solid #4b5263" }} />}
          {cfg.parts.map((part, index) => {
            const value = model.values![index];
            const share = model.shares?.[index];
            const segment = layout.segments[index];
            const shareText = share == null ? "构成占比未定义" : `有符号占比 ${share.toFixed(1)}%`;
            return <span key={part.key}
              className={`decomp-seg${hover && hover !== part.key ? " dim" : ""}`}
              style={{ position: "absolute", top: 0, bottom: 0, left: `${segment.leftPct}%`, width: `${segment.widthPct}%`, background: segment.negative ? negativeFill(part.color) : part.color }}
              onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}
              title={`${part.label} · 当前值 ${fmt(value, cfg.unit)} · ${shareText}${segment.negative ? "（负值，位于零轴左侧）" : ""}`} />;
          })}
        </div>
        {model.closure != null ? (
          <div className={`decomp-identity ${model.closure ? "ok" : "bad"}`}>
            {model.closure ? "✓" : "✗"} {cfg.parts.length} 项加总 = {fmt(model.sum, cfg.unit)} · 与 {cfg.totalLabel} 一致{model.error < 1e-6 ? "" : `（差 ${model.error.toPrecision(2)}）`}
          </div>
        ) : (
          <div className="decomp-identity neutral" role="status">
            ℹ {decompositionModelReason(model, cfg.weightTotal)}
            {model.amountCloses != null && ` ${cfg.parts.length} 项金额数学加总${model.amountCloses ? "相等" : "不相等"}，但不作为构成占比闭合认证。`}
          </div>
        )}
        {negligible && <div className="decomp-hint">⚠️ {country} · {sectorLabel(sector)}：{
          zeroTotalHint ?? `${cfg.totalLabel}占本国行业合计不足 0.01%，建议换一个活跃行业。`
        }</div>}
        <DecompositionDetailTable
          caption={`对象 ${side}：${year} 年 ${countryLabel(country)} · ${gran === "sector" ? sectorLabel(sector) : "国家级"} · ${cjkJoin(cfg.totalLabel, "分解明细")}`}
          parts={cfg.parts}
          values={model.values}
          shares={model.shares}
          unit={cfg.unit}
          hover={hover}
          onHover={setHover}
          compact={compare}
        />
        {step === 6 && <MiniBackwardBar row={row} />}
        {cfg.note && sharesAvailable && <div className="decomp-note">{cfg.note(row, model.values)}</div>}
      </div>
    );
  };

  if (!demoAvailable) {
    return (
      <div className="demo-card">
        <div className="demo-title">动手拆解 · 请先选择国家</div>
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
      <div className="demo-title">动手拆解 · 各分项的金额、占比与含义</div>
      <div className="demo-controls">
        <div className="pill-group" role="group" aria-label="分析层级">
          <button type="button" className={gran === "sector" ? "on" : ""} aria-pressed={gran === "sector"} onClick={() => setGran("sector")}>国家–行业级</button>
          <button type="button" className={gran === "country" ? "on" : ""} aria-pressed={gran === "country"} onClick={() => setGran("country")}>国家级</button>
        </div>
        <LabeledControl label="年份">
          {(id) => (
            <select id={id} value={year} onChange={(event) => {
              onPrimaryChange?.(Number(event.target.value), countryA);
            }}>{meta.years.map((value) => <option key={value}>{value}</option>)}</select>
          )}
        </LabeledControl>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /> 并排对比两个对象
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
            >{cfg.weightTotal && part.weightKey
                ? `(${part.weightKey}/${cfg.weightTotal}) × ${part.key}`
                : part.label.split(" ")[0]}</span>
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
  degree: "度中心性",
  betweenness: "介数中心性",
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

// 重建一条经过 v 的、跨度尽量大的最短路径,用于高亮演示
function samplePathThrough(v: string, C: ReturnType<typeof computeCentrality>): string[] {
  const ids = NET_NODES.map((n) => n.id);
  let best: string[] = [];
  let bestLen = -1;
  for (const s of ids) for (const t of ids) {
    if (s === t || s === v || t === v || !Number.isFinite(C.dist[s][t])) continue;
    if (C.dist[s][v] + C.dist[v][t] === C.dist[s][t] && C.dist[s][t] > bestLen) {
      // 沿 preds 从 t 回溯一条经过 v 的最短路径
      const half = (from: string, to: string): string[] | null => {
        // 回溯 to<-…<-from 的一条最短路径
        const path: string[] = [to];
        let cur = to;
        while (cur !== from) {
          const p = C.preds[from][cur][0];
          if (p === undefined) return null;
          path.push(p); cur = p;
        }
        return path.reverse();
      };
      const p1 = half(s, v), p2 = half(v, t);
      if (p1 && p2) { best = [...p1, ...p2.slice(1)]; bestLen = C.dist[s][t]; }
    }
  }
  return best;
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

  const pathNodes = mode === "betweenness" ? samplePathThrough(sel, C) : [];
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
              aria-label={`显示${NETWORK_DEMO_MODE_LABELS[metric]}`}
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
                高亮的是全部入边和出边。Gephi 中自环会分别计入一次入度和一次出度，因此总度计两次。
              </p>
            </>
          ) : mode === "betweenness" ? (
            <>
              <div className="ndp-formula">介数中心性 = Σ σₛₜ(v) / σₛₜ（有向；未按节点对数归一化）</div>
              <div className="ndp-calc">= <b>{networkDemoMetricText(C.bet[sel], "betweenness")}</b></div>
              <p className="ndp-note">
                {pathNodes.length >= 3
                  ? <>例如 {pathNodes[0]} → {pathNodes[pathNodes.length - 1]} 的无权最短路要穿过 {sel}（已高亮）。越多这类路径对经过它，拓扑介数越高；这不自动说明它是经济瓶颈。</>
                  : C.bet[sel] === 0
                    ? <>{selNode.label} 不在任何其他节点对的最短路径上，介数为 0。</>
                    : <>{selNode.label} 很少落在别人的最短路径上，介数中心性低。</>}
              </p>
            </>
          ) : (
            <>
              <div className="ndp-formula">接近中心性 = 沿出边可达节点数 / 最短距离和</div>
              <div className="ndp-calc">
                {reachablePaths.length > 0
                  ? <>= {reachablePaths.length} / {distanceSum} = <b>{C.closeness[sel].toFixed(3)}</b></>
                  : <>无可达节点；按 Gephi 约定记为 <b>0</b></>}
              </div>
              <p className="ndp-note">高亮边组成从 {sel} 沿箭头出发的最短路径树；不可达节点不进入分子和分母。</p>
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
            这是一个 7 节点的有向演示网络。真实系统保留全部正流量边和正自环，在完整的全球「国家×行业」生产网络上按同一 Gephi 口径计算。
          </div>
        </div>
      </div>
    </div>
  );
}
