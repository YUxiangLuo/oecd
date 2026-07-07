import { useState } from "react";
import { api } from "../../api";
import type { Meta, QcCheck } from "../../types";
import { useAsync, YearPicker } from "../shared";

export function QcLab({ meta }: { meta: Meta }) {
  const [year, setYear] = useState(meta.years.at(-1)!);
  const { data, error } = useAsync<QcCheck[]>(() => api.qc(year), [year]);
  const { data: shockChecks, error: shockError } = useAsync<QcCheck[]>(() => api.qcShocks(), []);
  const { data: controlChecks, error: controlError } = useAsync<QcCheck[]>(() => api.qcControls(), []);
  if (error) return <div className="error-box">{error}</div>;
  const table = (rows: QcCheck[] | null) => (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr><th>质检项</th><th>类型</th><th>结果</th><th style={{ textAlign: "left" }}>详情</th></tr>
        </thead>
        <tbody>
          {(rows ?? []).map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{c.kind}</td>
              <td className={c.passed ? "qc-pass" : "qc-fail"}>{c.passed ? "✓ 通过" : "✗ 异常"}</td>
              <td style={{ textAlign: "left", whiteSpace: "normal" }}>
                {c.detail}
                {c.warnings.map((w) => (
                  <div key={w} className="muted">⚠ {w}</div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <div>
      <YearPicker years={meta.years} year={year} onChange={setYear} />
      <div className="section-head">
        <span className="section-head-icon">🧾</span>OECD ICIO 数据质检
        <span className="section-head-line" />
      </div>
      {table(data)}

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>政策冲击面板质检
        <span className="section-head-line" />
      </div>
      {shockError ? <div className="error-box">{shockError}</div> : table(shockChecks)}

      <div className="section-head" style={{ marginTop: 18 }}>
        <span className="section-head-icon">🧾</span>国家-年份控制变量质检
        <span className="section-head-line" />
      </div>
      {controlError ? <div className="error-box">{controlError}</div> : table(controlChecks)}
    </div>
  );
}
