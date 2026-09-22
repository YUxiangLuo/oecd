import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AuthUser, TeacherReport } from "../types";
import { ReportsTab } from "./reports";
import { SemestersTab } from "./semesters";
import { StudentsTab } from "./students";
import { useTeacherReviewGuard } from "./review-guard";

const NAV = [
  { key: "semesters", icon: "🗓️", label: "学期与班级", sub: "分组 · 归属" },
  { key: "students", icon: "👥", label: "学生与进度", sub: "账号 · 完成状态" },
  { key: "reports", icon: "📝", label: "报告评阅", sub: "批改与打分" },
] as const;

type TabKey = (typeof NAV)[number]["key"];

export function TeacherDashboard({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<TabKey>("students");
  const [reviewBump, setReviewBump] = useState(0);
  const { data } = useAsync<{ reports: TeacherReport[] }>(() => api.classroom.reports(), [tab, reviewBump]);
  const pending = (data?.reports ?? []).filter((report) => report.state === "pending").length;
  const reviewGuard = useTeacherReviewGuard();

  return (
    <div className="teacher-layout">
      <nav className="teacher-nav" aria-label="教师工作台主导航">
        <div className="teacher-nav-title">教师工作台</div>
        {NAV.map((item) => (
          <button
            key={item.key}
            className={`teacher-nav-item${tab === item.key ? " active" : ""}`}
            aria-current={tab === item.key ? "page" : undefined}
            onClick={() => item.key === tab || reviewGuard.attempt(() => setTab(item.key))}
          >
            <span className="teacher-nav-ic" aria-hidden="true">{item.icon}</span>
            <span className="teacher-nav-text">
              <span className="teacher-nav-label">{item.label}</span>
              <span className="teacher-nav-sub">{item.sub}</span>
            </span>
            {item.key === "reports" && pending > 0 && <span className="nav-badge">{pending}</span>}
          </button>
        ))}
        <div className="teacher-nav-foot">学期和班级用于教师端分组；实验记录仍跟随学生账号和数据版本。</div>
      </nav>
      <main className="teacher-main">
        <div className="dash-header">
          <div>
            <h2>{tab === "semesters" ? "学期与班级" : tab === "students" ? "学生与进度" : "报告评阅"}</h2>
            <p>{tab === "semesters" ? "建立教学分组并管理使用中与历史班级"
              : tab === "students" ? "创建账号、分配班级并查看服务端判定的完成状态"
                : "按学期和班级筛选、批阅学生提交的步骤 15 实验报告"}</p>
          </div>
        </div>
        <div className="teacher-content">
          {tab === "semesters" ? <SemestersTab /> : tab === "students" ? <StudentsTab /> : (
            <ReportsTab user={user} onGraded={() => setReviewBump((value) => value + 1)} />
          )}
        </div>
      </main>
    </div>
  );
}
