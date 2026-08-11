import { useState } from "react";
import { api } from "../../api";
import type { Meta, QcCheck } from "../../types";
import { useAsync, YearPicker } from "../shared";
import { QcChecksTable, QcSeverityGuide, studentQcText } from "./qc-checks-table";
import { summarizeQcRelease } from "./qc-release";

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
  const qcRelease = summarizeQcRelease(meta.artifact_provenance?.qc);

  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      <div className={failures || failedSections ? "warnbox" : "tipbox"} style={{ marginBottom: 16, fontWeight: 700 }}>
        {loading
          ? `正在汇总质检结果… 已读取 ${allChecks.length} 项`
          : failedSections
            ? `有 ${failedSections} 组质检未能读取（详见下方错误）；已读取 ${allChecks.length} 项中 ${failures} 项异常。`
            : failures
              ? `${allChecks.length} 项质检中 ${allChecks.length - failures} 项通过、${failures} 项异常；异常项已在各表置顶。`
              : `✓ ${allChecks.length} 项质检全部通过；仍可展开每项查看检查动机与口径。`}
      </div>

      <QcSeverityGuide />

      {qcRelease.requiresDisclosure && (
        <details className="warnbox qc-release-status">
          <summary>
            数据发布状态：当前课程数据版本包含需要持续说明的质检项
            {qcRelease.override ? "（包含人工例外放行）" : ""}
          </summary>
          {qcRelease.fatal.length > 0 && <p><b>严重错误：</b>{qcRelease.fatal.map(studentQcText).join("、")}</p>}
          {qcRelease.warning.length > 0 && <p><b>警告：</b>{qcRelease.warning.map(studentQcText).join("、")}</p>}
          {qcRelease.disclosure.length > 0 && <p><b>需持续说明：</b>{qcRelease.disclosure.map(studentQcText).join("、")}</p>}
          <p>
            这些边界属于当前课程数据版本，适用于后续所有描述、回归与报告；最终报告会自动带入，无需在这里另行提交。
          </p>
        </details>
      )}

      <div className="section-head">
        <span className="section-head-icon">🧾</span>OECD ICIO 数据质检
        <span className="section-head-line" />
      </div>
      <QcChecksTable rows={data} onNavigateStep={onNavigateStep} />

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>经济体–年份控制变量质检
        <span className="section-head-line" />
      </div>
      {controlError
        ? <div className="error-box">{controlError}</div>
        : <QcChecksTable rows={controlChecks} onNavigateStep={onNavigateStep} />}

      <div className="tipbox" style={{ marginTop: 16 }}>
        本步无需提交处置。请阅读异常等级与发布边界，并在下方理解检查中判断何时应停止、修正或持续说明。
      </div>
    </div>
  );
}
