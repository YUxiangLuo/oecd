import { useState } from "react";
import { ScrollableRegion } from "../a11y";
import { api, isApiErrorStatus } from "../api";
import { useAsync } from "../labs/shared";
import { ReportMarkdown } from "../report-renderer-lazy";
import { showToast } from "../toast";
import type { AuthUser, TeacherReport } from "../types";
import { EmptyState, SearchInput, StatusPill, Toolbar } from "./ui";

const fmtTime = (value: string | null | undefined) => value ? value.slice(0, 16).replace("T", " ") : "—";
type Filter = "pending" | "graded" | "all";

const GRADE_RUBRIC = [
  ["概念与衔接 · 25", "能说明数据→指标→可视化→处理变量→回归→报告的关系，术语使用准确。"],
  ["证据使用 · 25", "引用实际保存的比较、点估计和区间，数字与报告快照一致。"],
  ["识别与边界 · 25", "区分描述、相对变化和因果结论，主动说明拟真冲击、薄对照、外溢与同期冲击。"],
  ["表达与可复核性 · 25", "研究问题明确，结论、证据与局限相互对应，教师可沿报告记录复核。"],
] as const;

export function ReportsTab({ user, onGraded }: { user: AuthUser; onGraded?: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const [openAccountId, setOpenAccountId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [query, setQuery] = useState("");
  const { data, error } = useAsync<{ reports: TeacherReport[] }>(() => api.classroom.reports(), [refresh]);
  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (openAccountId != null) {
    return <ReportView accountId={openAccountId} grader={user.username} onBack={(changed) => {
      setOpenAccountId(null);
      setRefresh((value) => value + 1);
      if (changed) onGraded?.();
    }} />;
  }
  const reports = data?.reports ?? [];
  const pending = reports.filter((report) => report.state === "pending").length;
  const needle = query.trim().toLowerCase();
  const shown = reports
    .filter((report) => filter === "all" || report.state === filter)
    .filter((report) => !needle || [report.display_name, report.username, report.student_no].some((value) => (value ?? "").toLowerCase().includes(needle)));
  return (
    <div>
      <Toolbar>
        <div className="segmented">
          {(["pending", "graded", "all"] as Filter[]).map((value) => <button key={value} className={filter === value ? "active" : undefined} onClick={() => setFilter(value)}>{value === "pending" ? "待评阅" : value === "graded" ? "已评阅" : "全部"}{value === "pending" && pending > 0 && <span className="seg-badge">{pending}</span>}</button>)}
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索学生 / 用户名 / 学号" />
      </Toolbar>
      <ScrollableRegion className="table-wrap" label="报告提交列表，可横向滚动">
        <table className="data-table"><thead><tr><th>学生</th><th>用户名</th><th>学号</th><th>提交时间</th><th>状态</th><th>得分</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
          {shown.map((report) => <tr key={report.account_id}>
            <td>{report.display_name}</td><td className="mono">{report.username}</td><td>{report.student_no || "—"}</td><td>{fmtTime(report.submitted_at)}</td>
            <td>{report.state === "graded" ? <StatusPill tone="ok">已评阅</StatusPill> : <StatusPill tone="warn">待评阅</StatusPill>}</td><td>{report.score ?? "—"}</td>
            <td><button className="primary sm" onClick={() => setOpenAccountId(report.account_id)}>{report.state === "graded" ? "查看/改评" : "评阅"}</button></td>
          </tr>)}
        </tbody></table>
        {shown.length === 0 && <EmptyState icon="📝" title={reports.length ? "没有匹配的报告" : "还没有学生提交报告"} hint={reports.length ? "换个筛选或关键词试试" : "学生提交报告后会出现在这里"} />}
      </ScrollableRegion>
    </div>
  );
}

function ReportView({ accountId, grader, onBack }: { accountId: number; grader: string; onBack: (changed: boolean) => void }) {
  const [refresh, setRefresh] = useState(0);
  const { data, error } = useAsync<TeacherReport>(() => api.classroom.reportDetail(accountId), [accountId, refresh]);
  if (error) return <div className="error-box" role="alert">{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;
  return <GradeView
    key={`${accountId}-${data.updated_at}`}
    data={data}
    grader={grader}
    onBack={onBack}
    onReload={() => setRefresh((value) => value + 1)}
  />;
}

export function GradeView({ data, grader, onBack, onReload }: {
  data: TeacherReport;
  grader: string;
  onBack: (changed: boolean) => void;
  onReload: () => void;
}) {
  const [score, setScore] = useState(data.score == null ? "" : String(data.score));
  const [feedback, setFeedback] = useState(data.feedback);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const submit = () => {
    const numeric = Number(score);
    if (score.trim() === "" || !Number.isInteger(numeric) || numeric < 0 || numeric > 100) return setSaveError("分数须为 0-100 的整数");
    setSaving(true);
    api.classroom.grade(data.account_id, numeric, feedback, data.updated_at).then(() => {
      showToast(`已保存对 ${data.display_name} 的评阅：${numeric} 分`);
      onBack(true);
    }, (cause) => {
      setSaving(false);
      setStale(isApiErrorStatus(cause, 409));
      setSaveError(String((cause as Error).message ?? cause));
    });
  };
  return (
    <div>
      <div className="review-topbar"><button className="back-btn" onClick={() => onBack(false)}>← 返回列表</button><span className="stage-chip">{data.display_name}（{data.username}）</span><span className="muted">提交于 {fmtTime(data.submitted_at)}</span></div>
      <div className="grade-split">
        <div className="grade-doc"><ReportMarkdown markdown={data.markdown} /></div>
        <aside className="grade-side"><div className="panel"><div className="panel-head"><span className="panel-ic">🖊️</span>评阅</div>
          <details className="grade-rubric" open>
            <summary>四项评分锚点（建议各 25 分）</summary>
            <ol>
              {GRADE_RUBRIC.map(([title, detail]) => <li key={title}><b>{title}</b><span>{detail}</span></li>)}
            </ol>
          </details>
          <label className="grade-field">分数（0-100）<input type="number" min={0} max={100} value={score} onChange={(event) => { setScore(event.target.value); setSaveError(null); }} /></label>
          <label className="grade-field">评语（可空）<textarea value={feedback} onChange={(event) => { setFeedback(event.target.value); setSaveError(null); }} rows={8} maxLength={4000} /></label>
          {saveError && <div className="error-box" role="alert">{saveError}</div>}
          {stale && <button className="secondary block" disabled={saving} onClick={onReload}>加载最新报告</button>}
          <button className="primary block" disabled={saving || stale} onClick={submit}>{saving ? "保存中…" : data.state === "graded" ? "更新评阅" : "提交评阅"}</button>
          <p className="muted">评阅人：{grader}；学生重新生成已提交报告时，旧评分会被清除。</p>
        </div></aside>
      </div>
    </div>
  );
}
