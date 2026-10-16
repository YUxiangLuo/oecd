/** The default model's equation and data facts in words (non-component helpers of model-equation.tsx). */
import type { RegressionDesignInfo } from "../types";

export function sampleFilterLabel(filter: string | undefined): string {
  if (!filter) return "—";
  if (/^排除 ROW/.test(filter)) return "不含 ROW（OECD 把其他国家合在一起的“世界其他地区”）和美国（加征关税的一方）";
  return filter.replace("(", "（").replace(")", "）");
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
