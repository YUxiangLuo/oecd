import { useState } from "react";
import type { AuthUser } from "../types";
import { AnnouncementsTab } from "./announcements";
import { OverviewTab } from "./overview";
import { ReportsTab } from "./reports";
import { StudentsTab } from "./students";

const TABS = [
  { key: "overview", label: "班级概览" },
  { key: "students", label: "班级与学生" },
  { key: "reports", label: "报告评阅" },
  { key: "announcements", label: "课堂公告" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** 教师面板:替代 17 步实验外壳的顶层视图(仅 role=teacher 可进入) */
export function TeacherDashboard({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<TabKey>("overview");
  return (
    <div className="teacher-shell">
      <div className="teacher-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`teacher-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <span className="muted teacher-tabs-hint">教学数据存于本地 PostgreSQL;评阅与公告学生端实时可见</span>
      </div>
      <div className="teacher-body">
        {tab === "overview" && <OverviewTab />}
        {tab === "students" && <StudentsTab />}
        {tab === "reports" && <ReportsTab user={user} />}
        {tab === "announcements" && <AnnouncementsTab />}
      </div>
    </div>
  );
}
