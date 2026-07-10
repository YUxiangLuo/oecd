import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import { ReportMarkdown } from "../report-renderer";
import { showToast } from "../toast";
import type { AuthUser, SubmissionDetail, SubmissionRow } from "../types";
import { EmptyState, SearchInput, StatusPill, Toolbar } from "./ui";

const fmtTime = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") : "—");

type Filter = "pending" | "graded" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "待评阅" },
  { key: "graded", label: "已评阅" },
  { key: "all", label: "全部" },
];

/** 报告评阅:分段筛选 + 搜索的提交列表 → 左右双栏批阅 */
export function ReportsTab({ user, onGraded }: { user: AuthUser; onGraded?: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [query, setQuery] = useState("");
  const { data, error } = useAsync<{ submissions: SubmissionRow[] }>(() => api.classroom.submissions(), [refresh]);

  if (error) return <div className="error-box">{error}</div>;
  if (openId != null) {
    return (
      <SubmissionView
        id={openId}
        grader={user.username}
        onBack={(changed) => {
          setOpenId(null);
          if (changed) {
            setRefresh((n) => n + 1);
            onGraded?.();
          }
        }}
      />
    );
  }

  const rows = data?.submissions ?? [];
  const pending = rows.filter((r) => r.state === "pending").length;
  const q = query.trim().toLowerCase();
  const shown = rows
    .filter((r) => filter === "all" || r.state === filter)
    .filter((r) => !q || [r.display_name, r.student_no, r.title].some((v) => (v ?? "").toLowerCase().includes(q)));

  return (
    <div>
      <Toolbar>
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? "active" : undefined}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {f.key === "pending" && pending > 0 && <span className="seg-badge">{pending}</span>}
            </button>
          ))}
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="搜索学生 / 学号 / 标题" />
      </Toolbar>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>学生</th>
              <th>学号</th>
              <th>班级</th>
              <th>报告标题</th>
              <th>年份</th>
              <th>提交时间</th>
              <th>状态</th>
              <th>得分</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>{r.display_name}</td>
                <td>{r.student_no || "—"}</td>
                <td>{r.class_name ?? "—"}</td>
                <td>{r.title}</td>
                <td>{r.year}</td>
                <td>{fmtTime(r.submitted_at)}</td>
                <td>
                  {r.state === "graded" ? (
                    <StatusPill tone="ok">已评阅</StatusPill>
                  ) : (
                    <StatusPill tone="warn">待评阅</StatusPill>
                  )}
                </td>
                <td>{r.score ?? "—"}</td>
                <td>
                  <button className="primary sm" onClick={() => setOpenId(r.id)}>
                    {r.state === "graded" ? "查看/改评" : "评阅"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <EmptyState
            icon="📝"
            title={rows.length ? "没有匹配的提交" : "还没有学生提交报告"}
            hint={
              rows.length
                ? "换个筛选或关键词试试"
                : "学生在步骤 17 生成报告后点击「提交报告给老师」即会出现在这里"
            }
          />
        )}
      </div>
    </div>
  );
}

function SubmissionView({ id, grader, onBack }: { id: number; grader: string; onBack: (changed: boolean) => void }) {
  const { data, error } = useAsync<SubmissionDetail>(() => api.classroom.submissionDetail(id), [id]);
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;
  return <SubmissionGradeView key={`${id}-${data.submitted_at}`} data={data} grader={grader} onBack={onBack} />;
}

const SCORE_PRESETS = [60, 70, 80, 90, 100];
const FEEDBACK_PRESETS = [
  "结构完整",
  "请补充识别假设",
  "请区分 mock 与真实数据",
  "请完善显著性和稳健性解读",
];

function SubmissionGradeView({
  data,
  grader,
  onBack,
}: {
  data: SubmissionDetail;
  grader: string;
  onBack: (changed: boolean) => void;
}) {
  const [score, setScore] = useState(data.score != null ? String(data.score) : "");
  const [feedback, setFeedback] = useState(data.feedback ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const submitGrade = () => {
    // 显式输入才接受:空串会被 Number("") 静默转成 0,须先挡掉
    if (score.trim() === "") {
      setSaveError("请填写分数(0-100)");
      return;
    }
    const n = Number(score);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setSaveError("分数须为 0-100 的整数");
      return;
    }
    setSaving(true);
    api.classroom.grade(data.id, n, feedback).then(
      () => {
        showToast(`已保存对 ${data.display_name} 的评阅:${n} 分`);
        onBack(true);
      },
      (e) => {
        setSaving(false);
        setSaveError(String(e.message ?? e));
      },
    );
  };

  const design = Object.entries(data.design ?? {})
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? (v ? "是" : "否") : String(v)}`)
    .join(" · ");

  return (
    <div>
      <div className="review-topbar">
        <button className="back-btn" onClick={() => onBack(false)}>
          ← 返回列表
        </button>
        <span className="stage-chip">
          {data.display_name}({data.username}){data.student_no ? ` · ${data.student_no}` : ""}
        </span>
        {data.state === "graded" ? (
          <StatusPill tone="ok">已评 {data.score} 分 · {data.graded_by}</StatusPill>
        ) : (
          <StatusPill tone="warn">待评阅</StatusPill>
        )}
        <span className="muted">提交于 {fmtTime(data.submitted_at)}</span>
      </div>

      <div className="grade-split">
        <div className="grade-doc">
          <h3 className="grade-doc-title">
            {data.title}
            <span className="muted"> · 数据年份 {data.year}</span>
          </h3>
          {design && <p className="muted">回归设定:{design}</p>}
          <ReportMarkdown markdown={data.markdown} />
        </div>

        <aside className="grade-side">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-ic">🖊️</span>评阅
            </div>
            <label className="grade-field">
              分数(0-100)
              <input type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} />
            </label>
            <div className="pill-row" style={{ margin: "-4px 0 12px" }} aria-label="快捷分值">
              {SCORE_PRESETS.map((value) => (
                <button key={value} className={`pill${score === String(value) ? " on" : ""}`} onClick={() => setScore(String(value))}>
                  {value}
                </button>
              ))}
            </div>
            <label className="grade-field">
              评语(学生在步骤 17 页面可见)
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={6} />
            </label>
            <div className="pill-row" style={{ margin: "-4px 0 12px" }} aria-label="评语模板">
              {FEEDBACK_PRESETS.map((text) => (
                <button
                  key={text}
                  className="pill"
                  onClick={() => setFeedback((current) => current.trim() ? `${current.trim()}；${text}` : text)}
                >
                  {text}
                </button>
              ))}
            </div>
            {saveError && <div className="error-box">{saveError}</div>}
            <button className="primary block" disabled={saving} onClick={submitGrade}>
              {saving ? "提交中…" : data.state === "graded" ? "更新评阅" : "提交评阅"}
            </button>
            <p className="muted">评阅人:{grader};学生重新提交会重置评阅状态。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
