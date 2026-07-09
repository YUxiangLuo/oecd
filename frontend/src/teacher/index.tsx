import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AuthUser, SubmissionRow } from "../types";
import { AnnouncementsTab } from "./announcements";
import { OverviewTab } from "./overview";
import { ReportsTab } from "./reports";
import { StudentsTab } from "./students";

const NAV = [
  { key: "overview", icon: "📊", label: "班级概览", sub: "总览与统计" },
  { key: "students", icon: "👥", label: "班级与学生", sub: "建班 · 建号 · 进度" },
  { key: "reports", icon: "📝", label: "报告评阅", sub: "批改与打分" },
  { key: "announcements", icon: "📢", label: "课堂公告", sub: "发布与管理" },
] as const;

type TabKey = (typeof NAV)[number]["key"];

const TITLES: Record<TabKey, { title: string; sub: string }> = {
  overview: { title: "班级概览", sub: "教学数据一览:提交、评阅进度与实验进度分布" },
  students: { title: "班级与学生", sub: "创建班级与学生账号,查看每人实验进度" },
  reports: { title: "报告评阅", sub: "批阅学生在步骤 17 提交的实验报告并打分" },
  announcements: { title: "课堂公告", sub: "向全体或指定班级发布公告,学生端实时可见" },
};

/** 教师面板:左侧栏导航 + 主内容区(仅 role=teacher 可进入,替代 17 步实验外壳) */
export function TeacherDashboard({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<TabKey>("overview");
  // 拉一次提交列表算「待评阅」数,用于导航徽标(切 tab 时重新拉取,评阅后回到列表即更新)
  const { data: subs } = useAsync<{ submissions: SubmissionRow[] }>(() => api.classroom.submissions(), [tab]);
  const pending = (subs?.submissions ?? []).filter((r) => r.state === "pending").length;

  return (
    <div className="teacher-layout">
      <nav className="teacher-nav">
        <div className="teacher-nav-title">教师工作台</div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`teacher-nav-item${tab === n.key ? " active" : ""}`}
            onClick={() => setTab(n.key)}
          >
            <span className="teacher-nav-ic">{n.icon}</span>
            <span className="teacher-nav-text">
              <span className="teacher-nav-label">{n.label}</span>
              <span className="teacher-nav-sub">{n.sub}</span>
            </span>
            {n.key === "reports" && pending > 0 && <span className="nav-badge">{pending}</span>}
          </button>
        ))}
        <div className="teacher-nav-foot">教学数据存于本地 PostgreSQL;评阅与公告学生端实时可见。</div>
      </nav>

      <main className="teacher-main">
        <div className="dash-header">
          <div>
            <h2>{TITLES[tab].title}</h2>
            <p>{TITLES[tab].sub}</p>
          </div>
        </div>
        <div className="teacher-content">
          {tab === "overview" && <OverviewTab />}
          {tab === "students" && <StudentsTab />}
          {tab === "reports" && <ReportsTab user={user} />}
          {tab === "announcements" && <AnnouncementsTab />}
        </div>
      </main>
    </div>
  );
}
