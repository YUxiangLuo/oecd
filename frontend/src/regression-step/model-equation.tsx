/** The course default model as the step shows it: its equation, what each term does, and the data facts folded. */
import { displayBaselineLabel } from "../regression-lessons";
import type { RegressionDesignInfo } from "../types";
import { equationSymbol, explanatoryText, sampleFilterLabel } from "./model-equation-text";

const ENTITY_LABEL: Record<string, string> = { entity_id: "国家×行业", country: "国家" };

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
        {/* What the formula is about and its subscripts first, before any term uses them. */}
        <li><b>Y</b> 是{yLabel}；下标 i = 国家，j = 行业，t = 年份。</li>
        {lagged
          ? <li><b>β₁·X + β₂·L1.X</b>：当年和上一年的关税暴露。β₁ 是当期 X 的条件关联，β₂ 是上一年的 X 在今年对应的条件关联。<b>两者之和是两年累计关联</b>：X 仅当期提高后恢复时的两期关联之和，也对应 X 持续提高时第二期的关联。累计的是系数，不是把图上两个年份的 Y 变化相加；这些是控制其他变量和固定效应后的共同条件斜率，不是国家×行业的等权平均，也不是因果效应。</li>
          : <li><b>β·X</b>：关税暴露（首年对美出口份额 w × 加征税率 τ）；β 是 X 每高 1 个百分点时 Y 平均相差多少。</li>}
        {controls.length > 0 && (
          <li><b>γ·{controls.join("、")}</b>：控制变量。{controls.length > 1 ? "它们" : "它"}与加税同时变化、又与 Y 有关，放进模型是为了不把与{controls.length > 1 ? "它们" : "它"}相关的变化算到 X 上。</li>
        )}
        <li><b>α + λ</b>：先扣掉每个国家×行业自己的平均水平（α）和每年所有国家×行业共同的变化（λ），即“双向固定效应”；ε 是剩下的随机波动。</li>
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
