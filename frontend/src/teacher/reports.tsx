import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AuthUser, SubmissionDetail, SubmissionRow } from "../types";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

/** 报告评阅:提交列表 → 报告全文 + 打分/评语 */
export function ReportsTab({ user }: { user: AuthUser }) {
  const [refresh, setRefresh] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, error } = useAsync<{ submissions: SubmissionRow[] }>(
    () => api.classroom.submissions(),
    [refresh],
  );

  if (error) return <div className="error-box">{error}</div>;
  if (openId != null) {
    return (
      <SubmissionView
        id={openId}
        grader={user.username}
        onBack={(changed) => { setOpenId(null); if (changed) setRefresh((n) => n + 1); }}
      />
    );
  }
  const rows = data?.submissions ?? [];
  const pending = rows.filter((r) => r.state === "pending").length;
  return (
    <div>
      <div className="section-head">
        <span className="section-head-icon">📝</span>
        报告提交列表(待评阅 {pending} / 共 {rows.length})
        <span className="section-head-line" />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>学生</th><th>学号</th><th>班级</th><th>报告标题</th><th>年份</th><th>提交时间</th><th>状态</th><th>得分</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.display_name}</td>
                <td>{r.student_no || "—"}</td>
                <td>{r.class_name ?? "—"}</td>
                <td>{r.title}</td>
                <td>{r.year}</td>
                <td>{fmtTime(r.submitted_at)}</td>
                <td>{r.state === "graded" ? `已评阅(${r.graded_by})` : "待评阅"}</td>
                <td>{r.score ?? "—"}</td>
                <td><button className="primary" onClick={() => setOpenId(r.id)}>{r.state === "graded" ? "查看/改评" : "评阅"}</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted">还没有学生提交报告;学生在步骤 17 生成报告后点击「提交报告给老师」即会出现在这里。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SubmissionView({ id, grader, onBack }: { id: number; grader: string; onBack: (changed: boolean) => void }) {
  const { data, error } = useAsync<SubmissionDetail>(() => api.classroom.submissionDetail(id), [id]);
  const [score, setScore] = useState<string>("");
  const [feedback, setFeedback] = useState<string>("");
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;
  if (!initialized) {
    setScore(data.score != null ? String(data.score) : "");
    setFeedback(data.feedback ?? "");
    setInitialized(true);
  }

  const submitGrade = () => {
    const n = Number(score);
    if (!Number.isInteger(n) || n < 0 || n > 100) { setSaveError("分数须为 0-100 的整数"); return; }
    setSaving(true);
    api.classroom.grade(id, n, feedback).then(
      () => onBack(true),
      (e) => { setSaving(false); setSaveError(String(e.message ?? e)); },
    );
  };

  const design = Object.entries(data.design ?? {})
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? (v ? "是" : "否") : String(v)}`)
    .join(" · ");
  return (
    <div>
      <div className="controls">
        <button onClick={() => onBack(false)}>← 返回列表</button>
        <span className="stage-chip">{data.display_name}({data.username}){data.student_no ? ` · ${data.student_no}` : ""}</span>
        <span className="muted">提交于 {fmtTime(data.submitted_at)}{data.state === "graded" ? ` · 已评 ${data.score} 分(${data.graded_by})` : ""}</span>
      </div>
      <h3 style={{ margin: "10px 0 4px" }}>{data.title}(数据年份 {data.year})</h3>
      {design && <p className="muted">回归设定:{design}</p>}
      <div className="report-md">{data.markdown}</div>

      <div className="section-head"><span className="section-head-icon">🖊️</span>评阅<span className="section-head-line" /></div>
      <div className="grade-form">
        <div className="controls">
          <label>分数(0-100)</label>
          <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} style={{ width: 80 }} />
        </div>
        <textarea
          placeholder="评语(学生在步骤 17 页面可见)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
        />
        {saveError && <div className="error-box">{saveError}</div>}
        <div className="controls">
          <button className="primary" disabled={saving} onClick={submitGrade}>
            {saving ? "提交中…" : data.state === "graded" ? "更新评阅" : "提交评阅"}
          </button>
          <span className="muted">评阅人:{grader};学生重新提交会重置评阅状态</span>
        </div>
      </div>
    </div>
  );
}
