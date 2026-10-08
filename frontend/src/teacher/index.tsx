import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAsync } from "../labs/shared";
import type { AuthUser, TeacherReport } from "../types";
import { ReportsTab } from "./reports";
import { SemestersTab } from "./semesters";
import { StudentsTab } from "./students";
import { useTeacherReviewGuard } from "./review-guard";
import { useRefetchOnVisible } from "./ui";

/** Line icons drawn like the student sidebar's (24-unit box, 1.6 stroke in the text colour), not emoji. */
const NAV_ICONS = {
  semesters: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  students: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="16.5" cy="9.5" r="2.5" /><path d="M16 14.2c2.3.1 3.9 1.7 4.5 4.3" /></>,
  reports: <><path d="M6.5 3.5h8l4 4v13h-12z" /><path d="M14.5 3.5v4h4M9.5 12.5h6M9.5 16h4" /></>,
} as const;

const NAV = [
  { key: "semesters", label: "学期与班级", sub: "建学期、分班" },
  { key: "students", label: "学生与进度", sub: "账号与进度" },
  { key: "reports", label: "报告评阅", sub: "评阅与打分" },
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
            <span className="teacher-nav-ic" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{NAV_ICONS[item.key]}</svg>
            </span>
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
            <StudentsTab onOpenReport={(accountId, queue) => { setReportRequest({ accountId, queue }); setTab("reports"); }}
              onGoToSemesters={() => setTab("semesters")} />
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
