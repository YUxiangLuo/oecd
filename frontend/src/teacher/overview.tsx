import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { ClassInfo, ClassOverview } from "../types";

/** 班级概览:统计卡 + 分数段分布 + 17 步到达率 */
export function OverviewTab() {
  const [classId, setClassId] = useState<number | null>(null);
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), []);
  const { data, error } = useAsync<ClassOverview>(() => api.classroom.overview(classId), [classId]);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;

  const maxBucket = Math.max(1, ...data.score_buckets.map((b) => b.count));
  const denom = Math.max(1, data.student_count);
  return (
    <div>
      <div className="controls">
        <label>班级</label>
        <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">全部班级</option>
          {(cls?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="stat-num">{data.student_count}</div><div className="stat-label">学生人数{data.disabled_count ? `(停用 ${data.disabled_count})` : ""}</div></div>
        <div className="stat-card"><div className="stat-num">{data.submitted}</div><div className="stat-label">已提交报告</div></div>
        <div className="stat-card"><div className="stat-num">{data.graded}</div><div className="stat-label">已评阅</div></div>
        <div className="stat-card"><div className="stat-num">{data.avg_score ?? "—"}</div><div className="stat-label">平均分(已评阅)</div></div>
      </div>

      <div className="section-head"><span className="section-head-icon">📊</span>成绩分布(已评阅 {data.graded} 份)<span className="section-head-line" /></div>
      <div className="bucket-bars">
        {data.score_buckets.map((b) => (
          <div key={b.label} className="bucket-row">
            <span className="bucket-label">{b.label}</span>
            <div className="bucket-track"><div className="bucket-bar" style={{ width: `${(b.count / maxBucket) * 100}%` }} /></div>
            <span className="bucket-count">{b.count}</span>
          </div>
        ))}
      </div>

      <div className="section-head"><span className="section-head-icon">🧭</span>实验进度 · 各步到达人数<span className="section-head-line" /></div>
      <div className="step-heat">
        {data.step_completion.map((s) => {
          const ratio = s.reached / denom;
          return (
            <div key={s.step} className="step-heat-cell" title={`步骤${s.step}:${s.reached}/${data.student_count} 人到达`}>
              <div className="step-heat-bar"><div className="step-heat-fill" style={{ height: `${Math.max(4, ratio * 100)}%`, opacity: s.reached ? 1 : 0.25 }} /></div>
              <span className="step-heat-num">{s.step}</span>
            </div>
          );
        })}
      </div>
      <p className="muted">到达人数按学生上报的最远步骤统计;学生端切换步骤时自动上报,无需手动操作。</p>
    </div>
  );
}
