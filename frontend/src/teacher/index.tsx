import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AuthUser, TeacherReport } from "../types";
import { ReportsTab } from "./reports";
import { SemestersTab } from "./semesters";
import { StudentsTab } from "./students";
import { useTeacherReviewGuard } from "./review-guard";
import { useRefetchOnVisible } from "./ui";

const NAV = [
  { key: "semesters", icon: "🗓️", label: "学期与班级", sub: "分组 · 归属" },
  { key: "students", icon: "👥", label: "学生与进度", sub: "账号 · 完成状态" },
  { key: "reports", icon: "📝", label: "报告评阅", sub: "批改与打分" },
] as const;

type TabKey = (typeof NAV)[number]["key"];

/** Same product name as App's APP_TITLE (not imported: App imports this module). */
const TEACHER_TITLE_SUFFIX = "教师工作台 · 供应链仿真系统 · GVC Simulation Lab";

export function teacherDocumentTitle(tab: TabKey): string {
  return `${NAV.find((item) => item.key === tab)!.label} · ${TEACHER_TITLE_SUFFIX}`;
}

export function TeacherDashboard({ user }: { user: AuthUser }) {
  const [tab, setTab] = useState<TabKey>("students");
  const [reviewBump, setReviewBump] = useState(0);
  const { data } = useAsync<{ reports: TeacherReport[] }>(() => api.classroom.reports(), [tab, reviewBump], { keepPreviousData: true });
  const pending = (data?.reports ?? []).filter((report) => report.state === "pending").length;
  const reviewGuard = useTeacherReviewGuard();
  // New submissions arrive while the teacher is elsewhere: recount the badge when they come back to this tab.
  useRefetchOnVisible(() => setReviewBump((value) => value + 1));

  // After login the page reloads with nothing focused: start keyboard and screen-reader users at the heading.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (document.activeElement == null || document.activeElement === document.body) headingRef.current?.focus();
  }, []);

  // Each tab gets its own window title, so history entries and assistive tech can tell them apart.
  useEffect(() => {
    document.title = teacherDocumentTitle(tab);
  }, [tab]);

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
            <h2 ref={headingRef} tabIndex={-1}>{tab === "semesters" ? "学期与班级" : tab === "students" ? "学生与进度" : "报告评阅"}</h2>
            <p>{tab === "semesters" ? "建立教学分组并管理使用中与历史班级"
              : tab === "students" ? "创建账号、分配班级并查看学生已完成的步骤"
                : "按学期和班级筛选、批阅学生提交的步骤 15 实验报告"}</p>
          </div>
        </div>
        <div className="teacher-content">
          {tab === "semesters" ? <SemestersTab /> : tab === "students" ? <StudentsTab /> : (
            <ReportsTab user={user}
              onGraded={() => setReviewBump((value) => value + 1)}
              onRefresh={() => setReviewBump((value) => value + 1)} />
          )}
        </div>
      </main>
    </div>
  );
}
