/** The course default model as the step shows it: its equation, what each term does, and the data facts folded. */
import { displayBaselineLabel } from "../regression-lessons";
import type { RegressionDesignInfo } from "../types";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };

export function sampleFilterLabel(filter: string | undefined): string {
  if (!filter) return "—";
  if (/^排除 ROW/.test(filter)) return "不含 ROW（OECD 把其他国家合在一起的“世界其他地区”）和美国（加征关税的一方）";
  return filter.replace("(", "（").replace(")", "）");
}

function DesignMeta({ design }: { design: RegressionDesignInfo }) {
  return (
    <div className="design-meta">
      {/* Same name as the Y list and the report ("加权总度"); the schema label's "（入+出）" is a step 5 detail. */}
      <span>结果指标 Y：{displayBaselineLabel(design.depvar_label)}</span>
      <span>解释变量：{explanatoryText(design)}</span>
      <span>数据：课程生成的关税教学面板（国家×行业×年份）</span>
      <span>观察单位：{ENTITY_LABEL[design.entity] ?? design.entity}，每年一条记录</span>
      <span>标准误按{ENTITY_LABEL[design.cluster] ?? design.cluster}聚类，95% 区间据此计算</span>
      <span>模型：双向固定效应</span>
      <span>样本：{sampleFilterLabel(design.sample_filter)}</span>
      <span>首年对美出口份额 w：各年固定用 2016 年的值</span>
    </div>
  );
}

/** Short names of the controls in the equation ("γ₁·汇率_it"). */
const CONTROL_SYMBOLS: Record<string, string> = {
  teaching_exchange_rate_change: "汇率变动",
  teaching_log_gdp: "GDP 对数",
  teaching_population_growth: "人口增长率",
  teaching_trade_openness: "贸易开放度",
  teaching_fdi_gdp: "FDI 净流入占比",
  log_gdp_proxy: "增加值总额对数",
  export_intensity: "出口强度",
  manufacturing_va_share: "制造业增加值占比",
};

/**
 * Column names in the saved equation shown as symbols: "teaching_y_trade_ijt" reads "Y_ijt", "β₂·…_lag1_ijt" reads
 * "β₂·L1.X_ijt", "γ₁·teaching_exchange_rate_change_it" reads "γ₁·汇率_it".
 */
export function equationSymbol(part: { text: string; term?: string }): string {
  if (part.term === "dependent") return part.text.replace(/^.*_(\w+)$/, "Y_$1");
  if (part.term === "policy") {
    const match = /^(β\S*)·teaching_tariff_exposure(?:_lag(\d))?_(\w+)$/.exec(part.text);
    if (match) return `${match[1]}·${match[2] ? `L${match[2]}.X` : "X"}_${match[3]}`;
    return part.text.replace(/^(β\S*)·.*_(\w+)$/, "$1·X_$2");
  }
  if (part.term === "control") {
    // The unit index is the last "_it" (a control's own name has underscores too).
    const match = /^(γ\S*)·(.+?)(?:__lag(\d))?_(it|ijt)$/.exec(part.text);
    if (match) return `${match[1]}·${match[3] ? `L${match[3]}.` : ""}${CONTROL_SYMBOLS[match[2]] ?? match[2]}_${match[4]}`;
  }
  return part.text;
}

/** "关税暴露 X、上一年的 X（L1.X）；控制变量：汇率变动" from the saved model; "关税暴露 X" for a single-X model. */
export function explanatoryText(design: Pick<RegressionDesignInfo, "spec" | "control_labels">): string {
  const lags = design.spec?.x_lags ?? [0];
  const xs = lags.map((lag) => (lag === 0 ? "关税暴露 X" : lag === 1 ? "上一年的 X（L1.X）" : `${lag} 年前的 X（L${lag}.X）`));
  const controls = Object.values(design.control_labels ?? {});
  return `${xs.join("、")}${controls.length ? `；控制变量：${controls.join("、")}` : ""}`;
}

/** "α_ij" with its index as a subscript. */
function withSubscripts(text: string) {
  return text.split(/(_\w+)/).filter(Boolean).map((token, index) => token.startsWith("_")
    ? <sub key={index}>{token.slice(1)}</sub>
    : <span key={index}>{token}</span>);
}

const FALLBACK_EQUATION = ["Y_ijt", " = ", "β·X_ijt", " + ", "α_ij", " + ", "λ_t", " + ", "ε_ijt"];

/** The step's model before and after the run: its equation and what each part does, the data facts folded. */
export function DesignEquation({ design, expanded = true }: { design: RegressionDesignInfo; expanded?: boolean }) {
  const parts = design.equation_parts?.length ? design.equation_parts.map(equationSymbol) : FALLBACK_EQUATION;
  const yLabel = displayBaselineLabel(design.depvar_label) || "本步的结果指标";
  const lagged = (design.spec?.x_lags ?? [0]).includes(1);
  const controls = Object.values(design.control_labels ?? {});
  return (
    <div className="reg-model-box">
      <div className="model-eq" role="group" aria-label="本步计算的公式">
        {parts.map((text, index) => <span key={`${text}-${index}`}>{withSubscripts(text)}</span>)}
      </div>
      {/* Three points: open on step 11, where the model is first met; folded on steps 12–14, which reuse it. */}
      <details className="reg-model-terms" open={expanded}>
        <summary>公式里各项的意思</summary>
      <ul className="model-eq-terms" aria-label="公式里各项的意思">
        {lagged
          ? <li><b>β₁·X + β₂·L1.X</b>：当年和上一年的关税暴露。关税的影响可能分两年显现，β₁ 是当年的关联，β₂ 是次年再出现的关联，<b>两者之和是两年累计关联</b>，即本步的主结果。累计的是系数，不是把图上两个年份的 Y 变化相加。</li>
          : <li><b>β·X</b>：关税暴露（首年对美出口份额 w × 加征税率 τ）；β 是 X 每高 1 个百分点时 Y 平均相差多少。</li>}
        {controls.length > 0 && (
          <li><b>γ·{controls.join("、")}</b>：控制变量。{controls.length > 1 ? "它们" : "它"}与加税同时变化、又与 Y 有关，放进模型是为了不把{controls.length > 1 ? "它们" : "它"}的作用算到关税头上。</li>
        )}
        <li><b>α + λ</b>：先扣掉每个国家×行业自己的平均水平（α）和每年所有国家×行业共同的变化（λ），即“双向固定效应”；ε 是剩下的随机波动。Y 是{yLabel}，i = 国家，j = 行业，t = 年份。</li>
      </ul>
      </details>
      <details className="reg-model-facts">
        <summary>数据、样本和区间的算法</summary>
        <DesignMeta design={design} />
      </details>
    </div>
  );
}

/** One step-10 example unit: its label and its final-year exposure X (a proportion). */
