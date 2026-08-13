import { useState } from "react";
import { api } from "../../api";
import type { Meta, QcCheck } from "../../types";
import { useAsync, YearPicker } from "../shared";
import { QcChecksTable } from "./qc-checks-table";
import { summarizeQcRelease } from "./qc-release";

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

/** 第 2 步只展示数据发布质检；处置边界由本步选择题检查。 */
export function QcLab({ meta, onNavigateStep }: {
  meta: Meta;
  onNavigateStep: (step: number) => void;
}) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync<QcCheck[]>(() => api.qc(year), [year]);
  const { data: controlChecks, error: controlError } = useAsync<QcCheck[]>(() => api.qcControls(), []);
  if (error) return <div className="error-box">{error}</div>;

  const sections = [
    { rows: data, error: null as string | null },
    { rows: controlChecks, error: controlError },
  ];
  const loading = sections.some((section) => section.rows == null && section.error == null);
  const failedSections = sections.filter((section) => section.error != null).length;
  const allChecks = sections.flatMap((section) => section.rows ?? []);
  const failures = allChecks.filter((check) => !check.passed).length;
  const qcRelease = summarizeQcRelease(meta.dataset?.qc);

  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
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
      <div className={failures || failedSections ? "warnbox" : "tipbox"} style={{ marginBottom: 16, fontWeight: 700 }}>
        {loading
          ? `正在汇总质检结果… 已读取 ${allChecks.length} 项`
          : failedSections
            ? `有 ${failedSections} 组质检未能读取（详见下方错误）；已读取 ${allChecks.length} 项中 ${failures} 项异常。`
            : failures
              ? `${allChecks.length} 项质检中 ${allChecks.length - failures} 项通过、${failures} 项异常；异常项已在各表置顶。`
              : `✓ ${allChecks.length} 项质检全部通过；仍可展开每项查看检查动机与口径。`}
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
      <QcChecksTable rows={data} onNavigateStep={onNavigateStep} />

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>国家-年份控制变量质检
        <span className="section-head-line" />
      </div>
      {controlError
        ? <div className="error-box">{controlError}</div>
        : <QcChecksTable rows={controlChecks} onNavigateStep={onNavigateStep} />}

      <div className="tipbox" style={{ marginTop: 16 }}>
        本步无需提交处置。请阅读异常等级与发布边界，并在下方理解检查中判断何时应停止、修正或披露。
      </div>
    </div>
  );
}
