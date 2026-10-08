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
  { key: "semesters", icon: "🗓️", label: "学期与班级", sub: "建学期、分班" },
  { key: "students", icon: "👥", label: "学生与进度", sub: "账号与进度" },
  { key: "reports", icon: "📝", label: "报告评阅", sub: "评阅与打分" },
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
  // A report opened from the student table: 报告评阅 starts on it, with the table's order for 上一份/下一份.
  const [reportRequest, setReportRequest] = useState<{ accountId: number; queue: number[] } | null>(null);
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

  // The grading panel sticks below the page header and must end inside the window: publish the pane's and
  // the header's heights (both change with the window and with wrapping) for teacher.css to size it.
  const mainRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const main = mainRef.current;
    const header = headerRef.current;
    if (!main || !header || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      main.style.setProperty("--teacher-pane-h", `${main.clientHeight}px`);
      main.style.setProperty("--dash-header-h", `${header.offsetHeight}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    observer.observe(header);
    return () => observer.disconnect();
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
            title={item.label}
            onClick={() => item.key === tab || reviewGuard.attempt(() => { setReportRequest(null); setTab(item.key); })}
          >
            <span className="teacher-nav-ic" aria-hidden="true">{item.icon}</span>
            <span className="teacher-nav-text">
              <span className="teacher-nav-label">{item.label}</span>
              <span className="teacher-nav-sub">{item.sub}</span>
            </span>
            {item.key === "reports" && pending > 0 && <span className="nav-badge">{pending}</span>}
          </button>
        ))}
      </nav>
      <main ref={mainRef} className="teacher-main">
        <div ref={headerRef} className="dash-header">
          <div>
            <h2 ref={headingRef} tabIndex={-1}>{tab === "semesters" ? "学期与班级" : tab === "students" ? "学生与进度" : "报告评阅"}</h2>
            <p>{tab === "semesters" ? "新建学期和班级，管理学生分班"
              : tab === "students" ? "创建账号、分配班级并查看学生已完成的步骤"
                : "评阅学生提交的实验报告"}</p>
          </div>
        </div>
        <div className="teacher-content">
          {tab === "semesters" ? <SemestersTab /> : tab === "students" ? (
            <StudentsTab onOpenReport={(accountId, queue) => { setReportRequest({ accountId, queue }); setTab("reports"); }} />
          ) : (
            <ReportsTab user={user} initialReview={reportRequest ?? undefined}
              onGraded={() => setReviewBump((value) => value + 1)}
              onRefresh={() => setReviewBump((value) => value + 1)} />
          )}
        </div>
      </main>
    </div>
  );
}
