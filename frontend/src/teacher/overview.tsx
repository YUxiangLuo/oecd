import { useState } from "react";
import { LabeledControl, ScrollableRegion } from "../a11y";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { ClassInfo, ClassOverview } from "../types";
import { GradingDonut, StepFunnel, TrendChart } from "./charts";
import { Toolbar } from "./ui";

/** 班级概览:KPI 卡行 + 面板网格(成绩分布 / 评阅进度 / 提交趋势 / 步骤漏斗 / 班级对比) */
export function OverviewTab({ onSelectStep }: {
  onSelectStep: (step: number, classId: number | null, kind: "reached" | "completed") => void;
}) {
  const [classId, setClassId] = useState<number | null>(null);
  const { data: cls } = useAsync<{ classes: ClassInfo[] }>(() => api.classroom.classes(), []);
  const { data, error } = useAsync<ClassOverview>(() => api.classroom.overview(classId), [classId]);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <p className="muted">加载中…</p>;

  const pending = Math.max(0, data.submitted - data.graded);
  const maxBucket = Math.max(1, ...data.score_buckets.map((b) => b.count));
  const showBreakdown = classId == null && data.class_breakdown.length > 1;
  const fullyVerified = data.step_completion.find((item) => item.step === 16)?.completed ?? 0;

  const kpis = [
    { ic: "👥", tone: "indigo", num: data.student_count, label: "学生人数", sub: data.disabled_count ? `停用 ${data.disabled_count}` : "" },
    { ic: "📤", tone: "indigo", num: data.submitted, label: "已提交报告", sub: `共 ${data.student_count} 人` },
    { ic: "⏳", tone: "amber", num: pending, label: "待评阅", sub: pending ? "需要处理" : "已清空" },
    { ic: "✅", tone: "green", num: data.graded, label: "已评阅", sub: "" },
    { ic: "⭐", tone: "indigo", num: data.avg_score ?? "—", label: "平均分", sub: "已评阅" },
    { ic: "🔥", tone: "green", num: data.active_7d, label: "近 7 天活跃", sub: "有进度上报" },
    { ic: "✅", tone: "green", num: fullyVerified, label: "16 步完成", sub: "答题通过并生成报告" },
  ] as const;

  return (
    <div>
      <Toolbar>
        <div className="field">
          <LabeledControl label="班级">
            {(id) => (
              <select id={id} value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">全部班级</option>
                {(cls?.classes ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </LabeledControl>
        </div>
      </Toolbar>

      <div className="kpi-row">
        {kpis.map((k) => (
          <div key={k.label} className="kpi-card">
            <span className={`kpi-ic ${k.tone}`}>{k.ic}</span>
            <div className="kpi-body">
              <div className="kpi-num">{k.num}</div>
              <div className="kpi-label">{k.label}</div>
              {k.sub && <div className="kpi-sub">{k.sub}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="panel-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-ic">📊</span>成绩分布
            <span className="panel-tag">已评阅 {data.graded} 份</span>
          </div>
          {data.graded === 0 ? (
            <p className="muted panel-empty">暂无评阅成绩</p>
          ) : (
            <div className="bucket-bars">
              {data.score_buckets.map((b) => (
                <div key={b.label} className="bucket-row">
                  <span className="bucket-label">{b.label}</span>
                  <div className="bucket-track">
                    <div className="bucket-bar" style={{ width: `${(b.count / maxBucket) * 100}%` }} />
                  </div>
                  <span className="bucket-count">{b.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-ic">🖊️</span>评阅进度
            <span className="panel-tag">已提交 {data.submitted} 份</span>
          </div>
          {data.submitted === 0 ? (
            <p className="muted panel-empty">还没有学生提交报告</p>
          ) : (
            <GradingDonut submitted={data.submitted} graded={data.graded} />
          )}
        </section>

        <section className="panel wide">
          <div className="panel-head">
            <span className="panel-ic">📈</span>近 14 天提交与评阅趋势
          </div>
          <TrendChart data={data.submission_trend} />
        </section>

        <section className="panel wide">
          <div className="panel-head">
            <span className="panel-ic">🧭</span>实验进度 · 到达与完成
            <span className="panel-tag">共 {data.student_count} 人</span>
          </div>
          <StepFunnel
            steps={data.step_reach}
            completions={data.step_completion}
            total={data.student_count}
            onSelect={(step, kind) => onSelectStep(step, classId, kind)}
          />
          <p className="muted panel-note">紫线是学生上报的最远到达位置；绿线是服务端判定的步骤完成数。点击对应数据点筛选学生，两者不是同一概念。</p>
        </section>

        {showBreakdown && (
          <section className="panel wide">
            <div className="panel-head">
              <span className="panel-ic">🏫</span>班级对比
            </div>
            <ScrollableRegion className="table-wrap" label="班级对比表，可横向滚动">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>班级</th>
                    <th>学生</th>
                    <th>已提交</th>
                    <th>提交率</th>
                    <th>已评阅</th>
                    <th>平均分</th>
                  </tr>
                </thead>
                <tbody>
                  {data.class_breakdown.map((c) => {
                    const rate = c.student_count ? Math.round((c.submitted / c.student_count) * 100) : 0;
                    return (
                      <tr key={c.class_id}>
                        <td>{c.name}</td>
                        <td>{c.student_count}</td>
                        <td>{c.submitted}</td>
                        <td>
                          <span className="rate-cell">
                            <span className="mini-track">
                              <span className="mini-bar" style={{ width: `${rate}%` }} />
                            </span>
                            {rate}%
                          </span>
                        </td>
                        <td>{c.graded}</td>
                        <td>{c.avg_score ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollableRegion>
          </section>
        )}
      </div>
    </div>
  );
}
