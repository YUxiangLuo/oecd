import { useEffect, useState } from "react";
import { api } from "../../api";
import type { Meta, QcCheck } from "../../types";
import { useAsync, YearPicker } from "../shared";
import { QcChecksTable } from "./qc-checks-table";
import { inspectQcSection, summarizeQcSections, type QcSectionState } from "./qc-contract";
import { inspectShockContract } from "./step2/shock-contract";
import { summarizeQcRelease } from "./qc-release";
import { userFacingRequestError } from "../../user-facing-error";

const QC_DECISIONS = [
  {
    level: "Fatal（阻断）",
    action: "停止正式分析与发布；修正数据并复检。教学 override 也必须显式披露。",
  },
  {
    level: "Warning（警告）",
    action: "可以继续，但结论必须带上风险说明，并做相应稳健性检查。",
  },
  {
    level: "Disclosure（披露）",
    action: "检查本身可以通过；仍要在报告中说明口径、例外或适用边界。",
  },
] as const;

const LEONTIEF_DIAGNOSTICS = [
  ["谱半径", "看投入需求是否会收敛；接近 1 是放大风险警告，达到或超过 1 表示级数不收敛，属于 Fatal。"],
  ["条件数", "看输入中的小误差会不会被求逆显著放大；越高越不稳定。"],
  ["逆残差", "把算出的逆矩阵乘回 (I−A)，检查结果是否足够接近单位矩阵。"],
  ["非负性", "检查逆矩阵是否出现违背通常投入产出解释的实质负值。"],
] as const;

/** Fetch errors must be retryable from the fail-closed decision, not only the empty table row. */
export function QcRequestRetryActions({
  year,
  icioError,
  controlError,
  onRetryIcio,
  onRetryControls,
}: {
  year: number;
  icioError: string | null;
  controlError: string | null;
  onRetryIcio: () => void;
  onRetryControls: () => void;
}) {
  if (!icioError && !controlError) return null;
  return (
    <div className="qc-retry-actions">
      {icioError && (
        <button type="button" className="secondary" onClick={onRetryIcio}>
          重试 {year} 年 OECD ICIO 质检
        </button>
      )}
      {controlError && (
        <button type="button" className="secondary" onClick={onRetryControls}>
          重试国家-年份控制变量质检
        </button>
      )}
    </div>
  );
}

/** 第 2 步只展示数据发布质检；处置边界由本步选择题检查。 */
export function QcLab({ meta, onNavigateStep, onCompletionBlockChange }: {
  meta: Meta;
  onNavigateStep: (step: number) => void;
  onCompletionBlockChange?: (reason: string | null) => void;
}) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const icioQuery = useAsync<QcCheck[]>(
    () => api.qc(year),
    [year],
    { requestKey: `qc:icio:${year}` },
  );
  const controlsQuery = useAsync<QcCheck[]>(
    () => api.qcControls(),
    [],
    { requestKey: "qc:controls" },
  );
  const { data, error } = icioQuery;
  const { data: controlChecks, error: controlError } = controlsQuery;
  const contract = meta.dataset?.qc_contract;
  const icioState = inspectQcSection(data, contract, "icio");
  const controlsState = inspectQcSection(controlChecks, contract, "controls");
  const sections = [
    { label: "OECD ICIO", state: icioState, error },
    { label: "国家-年份控制变量", state: controlsState, error: controlError },
  ];
  const summary = summarizeQcSections(sections);
  const shockContract = inspectShockContract(
    meta.dataset?.shock_contract,
    meta.dataset?.artifact_contract_version,
  );
  const completionBlock = summary.blockedReason ?? shockContract.reason;
  const qcRelease = summarizeQcRelease(meta.dataset?.qc);
  const decision = completionBlock
    ? `暂不能继续：${completionBlock}`
    : qcRelease.fatal.length > 0
      ? "只能在明确 override 的教学边界内继续；正式研究必须先修复 Fatal 并重新发布。"
      : summary.failures > 0 || qcRelease.requiresDisclosure
        ? "可以继续，但报告必须披露下列 Warning / Disclosure，并据此限制结论。"
        : "可以继续：当前发布门禁通过；后续仍须按各指标和模型的解释边界作答。";
  useEffect(() => {
    onCompletionBlockChange?.(completionBlock);
  }, [completionBlock, onCompletionBlockChange]);

  const changeYear = (nextYear: number) => {
    onCompletionBlockChange?.("正在读取新年份质检结果，完成前不能提交本步。");
    setYear(nextYear);
  };
  const tableMessage = (state: QcSectionState, requestError: string | null) => {
    if (requestError) return userFacingRequestError(requestError, "质检读取失败");
    if (state.status === "loading") return "正在读取质检结果…";
    return state.reason ?? "未返回任何质检结果，不能判定通过。";
  };

  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={changeYear} />
      <div className={completionBlock || qcRelease.fatal.length > 0 ? "warnbox" : "tipbox"} role={completionBlock ? "alert" : "status"} style={{ marginBottom: 16 }}>
        <b>本步决定：{decision}</b>
        <p style={{ marginBottom: 0 }}>下一步只使用通过当前发布门禁的数据计算指标；本步的 Warning / Disclosure 会继续带入第 16 步报告。</p>
        <QcRequestRetryActions
          year={year}
          icioError={error}
          controlError={controlError}
          onRetryIcio={icioQuery.retry}
          onRetryControls={controlsQuery.retry}
        />
      </div>
      <div className={summary.className} role={summary.blockedReason ? "alert" : "status"} style={{ marginBottom: 16, fontWeight: 700 }}>
        {summary.text}
      </div>
      <details className="card concept-card qc-guide-details">
        <summary className="kicker">理解质检等级与数值诊断</summary>
        <section className="qc-teaching-guide" aria-labelledby="qc-guide-title">
          <div>
            <h3 id="qc-guide-title">先判断严重度，再决定能否继续</h3>
            <p>质检等级描述的是处置边界，不只是颜色。Fatal 会阻断发布；Warning 和 Disclosure 都允许继续，但承担的说明义务不同。</p>
            <dl className="qc-decision-list">
              {QC_DECISIONS.map((item) => (
                <div key={item.level}>
                  <dt>{item.level}</dt>
                  <dd>{item.action}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3>程序能求逆，还要检查什么？</h3>
            <p><code>(I−A)⁻¹</code> 被算出来，只说明软件返回了一个数值结果；以下四项分别排除不同风险。</p>
            <dl className="qc-diagnostic-list">
              {LEONTIEF_DIAGNOSTICS.map(([term, meaning]) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{meaning}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </details>
      <div className={shockContract.valid ? "tipbox" : "warnbox"} role={shockContract.valid ? "status" : "alert"} style={{ marginBottom: 16 }}>
        {shockContract.valid
          ? `Shock contract v${meta.dataset?.shock_contract?.version} 已精确验证：treated 使用严格 ${meta.dataset?.shock_contract?.treated_operator}${meta.dataset?.shock_contract?.treated_threshold} 阈值并保留三类完整字段。允许集合包含 OECD ICIO 与显式教学 fallback；“允许”不等于“官方”，实际来源/口径必须以步骤 11 的第六项 provenance QC 为准。`
          : shockContract.reason}
      </div>

      {qcRelease.requiresDisclosure && (
        <details className="warnbox qc-release-status">
          <summary>
            数据发布状态：当前产物含需持续披露的 QC 项
            {qcRelease.override ? "（包含显式 override）" : ""}
          </summary>
          {qcRelease.fatal.length > 0 && <p><b>Fatal：</b>{qcRelease.fatal.join("、")}</p>}
          {qcRelease.warning.length > 0 && <p><b>Warning：</b>{qcRelease.warning.join("、")}</p>}
          {qcRelease.disclosure.length > 0 && <p><b>Disclosure：</b>{qcRelease.disclosure.join("、")}</p>}
          <p>
            这些边界属于当前数据版本，适用于后续所有描述、回归与报告；最终报告会自动带入，无需在这里另行提交。
          </p>
          {qcRelease.fatal.length > 0 && (
            <p>
              <b>使用边界：</b>含 Fatal 的产物不满足正式研究或发布要求。显式 override 只允许继续教学演示，且必须保留上述披露，不能把结果冒充研究结论。
            </p>
          )}
        </details>
      )}

      <div className="section-head">
        <span className="section-head-icon">🧾</span>OECD ICIO 数据质检
        <span className="section-head-line" />
      </div>
      <QcChecksTable
        rows={icioState.status === "valid" ? icioState.rows : []}
        label="OECD ICIO 数据质检结果表，可横向滚动"
        emptyMessage={tableMessage(icioState, error)}
        emptyState={icioState.status === "loading" && !error ? "loading" : "invalid"}
        onRetry={error ? icioQuery.retry : undefined}
        retryLabel={`重试 ${year} 年质检`}
        onNavigateStep={onNavigateStep}
      />

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>国家-年份控制变量质检
        <span className="section-head-line" />
      </div>
      <QcChecksTable
        rows={controlsState.status === "valid" ? controlsState.rows : []}
        label="国家-年份控制变量质检结果表，可横向滚动"
        emptyMessage={tableMessage(controlsState, controlError)}
        emptyState={controlsState.status === "loading" && !controlError ? "loading" : "invalid"}
        onRetry={controlError ? controlsQuery.retry : undefined}
        retryLabel="重试控制变量质检"
        onNavigateStep={onNavigateStep}
      />

      <div className="tipbox" style={{ marginTop: 16 }}>
        本步无需提交处置。请阅读异常等级与发布边界，并在下方理解检查中判断何时应停止、修正或披露。
      </div>
    </div>
  );
}
