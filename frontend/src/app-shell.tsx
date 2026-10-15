import { useLayoutEffect, useRef, type RefObject } from "react";
import { AccountPasswordModal } from "./account-password";
import { LogoMark } from "./brand";
import { oecdIcioDatasetLabel } from "./dataset-label";
import { isDemoStudentUsername } from "./login";
import { TeacherDashboard } from "./teacher";
import { TeacherReviewGuardProvider, useTeacherReviewGuard } from "./teacher/review-guard";
import { showToast, ToastHost } from "./toast";
import { materialStatusForStep, reportStatusLabel, stepMaterialStatusText } from "./step-task-card";
import { revealOutlineStep } from "./step-navigation";
import type {
  AuthUser,
  CompletionSummary,
  Meta,
  ReportGateItem,
  Step,
  StepsResponse,
} from "./types";

const ROMAN = ["", "一", "二", "三", "四", "五"];
// Vite includes the canonical PDF as a versioned asset in both production and demo builds.
const STUDENT_MANUAL_URL = new URL("../../实验手册.pdf", import.meta.url).href;

const DEMO_PASSWORD_NOTE = "演示账号不能修改密码";

// Short enough for one line at phone width; the full advice is also its title.
export const NARROW_WINDOW_NOTICE = "窗口较窄：请左右滚动，或放宽窗口、缩小浏览器缩放";

/** Shown by CSS only below the supported width (course-shell.css), on every page including login. */
export function NarrowWindowNotice() {
  return <div className="narrow-window-notice" role="note" title={NARROW_WINDOW_NOTICE}>{NARROW_WINDOW_NOTICE}</div>;
}

export function AppBootSkeleton() {
  return (
    <div className="layout app-boot" role="region" aria-busy="true" aria-label="正在恢复实验">
      <header className="topbar">
        <LogoMark size={30} />
        <div>
          <h1>供应链仿真系统</h1>
          <div className="sub">GVC SIMULATION LAB</div>
        </div>
        <div className="topbar-user app-boot-topbar">
          <span className="skeleton-block skeleton-course" />
          <span className="skeleton-block skeleton-meta" />
          <span className="skeleton-block skeleton-pill" />
          <span className="skeleton-block skeleton-button" />
        </div>
      </header>
      <div className="main">
        <aside className="sidebar app-boot-sidebar">
          <div className="sidebar-head">
            <div className="sidebar-head-row">
              <span className="sidebar-title">课程大纲</span>
              <span className="sidebar-steps">共 15 步</span>
            </div>
            <div className="progress-track"><div className="progress-bar" style={{ width: "35%" }} /></div>
          </div>
          <div className="sidebar-list app-boot-step-list">
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index} className="skeleton-block skeleton-step" />
            ))}
          </div>
        </aside>
        <div className="workarea">
          <div className="step-header-bar app-boot-step-header">
            <span className="skeleton-block skeleton-step-number" />
            <span className="skeleton-block skeleton-step-title" />
          </div>
          <div className="content-row">
            <main className="content">
              <div className="content-inner">
                <div className="card skeleton-card">
                  <span className="skeleton-block skeleton-line wide" />
                  <span className="skeleton-block skeleton-line" />
                  <span className="skeleton-block skeleton-line short" />
                </div>
                <div className="skeleton-block skeleton-report" />
              </div>
            </main>
          </div>
        </div>
      </div>
      <span className="sr-only" role="status">正在恢复最新数据与实验记录…</span>
    </div>
  );
}

interface TeacherWorkspaceProps {
  user: AuthUser;
  meta: Meta | null;
  showPasswordChange: boolean;
  onRequestPasswordChange: () => void;
  onClosePasswordChange: () => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

export function TeacherWorkspace({
  user,
  meta,
  showPasswordChange,
  onRequestPasswordChange,
  onClosePasswordChange,
  onPasswordChanged,
  onLogout,
}: TeacherWorkspaceProps) {
  return <TeacherReviewGuardProvider><TeacherWorkspaceContent
    user={user} meta={meta} showPasswordChange={showPasswordChange}
    onRequestPasswordChange={onRequestPasswordChange} onClosePasswordChange={onClosePasswordChange}
    onPasswordChanged={onPasswordChanged} onLogout={onLogout}
  /></TeacherReviewGuardProvider>;
}

function TeacherWorkspaceContent({
  user, meta, showPasswordChange, onRequestPasswordChange, onClosePasswordChange, onPasswordChanged, onLogout,
}: TeacherWorkspaceProps) {
  const passwordTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewGuard = useTeacherReviewGuard();
  // The demo teacher's password is what the login page's 教师身份 chip fills in; changing it would lock the demo.
  const fixedDemoPassword = import.meta.env.VITE_DEMO_MODE === "1" && user.username === "teacher";
  return (
    <div className="layout">
      <header className="topbar">
        <LogoMark size={30} />
        <div>
          <h1>供应链仿真系统</h1>
          <div className="sub">GVC SIMULATION LAB · 教师端</div>
        </div>
        <div className="topbar-user">
          <span className="muted">
            数据：{oecdIcioDatasetLabel(meta)}
          </span>
          <span className="role-chip" title={`${user.name} · 教师账号 · ${user.username}`}><span>{user.name}</span></span>
          <button
            ref={passwordTriggerRef}
            aria-disabled={fixedDemoPassword || undefined}
            aria-describedby={fixedDemoPassword ? "fixed-demo-password-note" : undefined}
            title={fixedDemoPassword ? DEMO_PASSWORD_NOTE : undefined}
            onClick={fixedDemoPassword ? () => showToast(DEMO_PASSWORD_NOTE, "info") : () => reviewGuard.attempt(onRequestPasswordChange)}
          >
            修改密码
          </button>
          {fixedDemoPassword && <span id="fixed-demo-password-note" className="sr-only">{DEMO_PASSWORD_NOTE}</span>}
          <button onClick={() => reviewGuard.attempt(() => { reviewGuard.clear(); onLogout(); })}>退出登录</button>
        </div>
      </header>
      <TeacherDashboard user={user}
        onChangePassword={fixedDemoPassword ? undefined : () => reviewGuard.attempt(onRequestPasswordChange)} />
      {/* 教师和学生分支互斥，因此任一时刻只挂载一个 ToastHost。 */}
      <ToastHost />
      {showPasswordChange && (
        <AccountPasswordModal
          onClose={onClosePasswordChange}
          onChanged={() => { reviewGuard.clear(); onPasswordChanged(); }}
          returnFocusRef={passwordTriggerRef}
        />
      )}
    </div>
  );
}

interface StudentTopbarProps {
  user: AuthUser;
  meta: Meta | null;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  passwordTriggerRef: RefObject<HTMLButtonElement | null>;
  onShowIntro: () => void;
  onRequestPasswordChange: () => void;
  onLogout: () => void;
}

export function StudentTopbar({
  user,
  meta,
  introTriggerRef,
  passwordTriggerRef,
  onShowIntro,
  onRequestPasswordChange,
  onLogout,
}: StudentTopbarProps) {
  const fixedDemoPassword = import.meta.env.VITE_DEMO_MODE === "1" && isDemoStudentUsername(user.username);
  return (
    <header className="topbar">
      <LogoMark size={30} />
      <div>
        <h1>供应链仿真系统</h1>
        <div className="sub">GVC SIMULATION LAB</div>
      </div>
      <div className="topbar-user">
        <span className="muted">
          数据：{oecdIcioDatasetLabel(meta)}
        </span>
        <span className="role-chip" title={`${user.name} · 学生账号 · ${user.username}`}><span>{user.name}</span></span>
        <button ref={introTriggerRef} onClick={onShowIntro}>ⓘ 系统介绍</button>
        {/* aria-disabled (not disabled) keeps the explanation reachable by keyboard and screen readers. */}
        <button
          ref={passwordTriggerRef}
          aria-disabled={fixedDemoPassword || undefined}
          aria-describedby={fixedDemoPassword ? "fixed-demo-password-note" : undefined}
          title={fixedDemoPassword ? DEMO_PASSWORD_NOTE : undefined}
          onClick={fixedDemoPassword ? () => showToast(DEMO_PASSWORD_NOTE, "info") : onRequestPasswordChange}
        >
          修改密码
        </button>
        {fixedDemoPassword && <span id="fixed-demo-password-note" className="sr-only">{DEMO_PASSWORD_NOTE}</span>}
        <button onClick={onLogout}>退出登录</button>
      </div>
    </header>
  );
}

type MaterialStatus = ReturnType<typeof materialStatusForStep>;

/** A step's report-material status: the current step's as its task card shows it (unsaved/saving included). */
function stepMaterialStatus(
  step: number, current: number, materialGate: ReportGateItem[] | null, currentMaterialStatus?: MaterialStatus,
): MaterialStatus {
  return step === current && currentMaterialStatus ? currentMaterialStatus : materialStatusForStep(step, materialGate);
}

/** A step's mark, alike in the outline and the footer dots: done, or partial when the quiz is passed but the step's
 * report material is still missing (amber, so a step that still needs something does not read as finished). */
export function stepProgress(step: Pick<Step, "lab">, done: boolean, materialStatus: MaterialStatus): "done" | "partial" | null {
  if (!done) return null;
  return step.lab !== "rep" && materialStatus === "missing" ? "partial" : "done";
}

interface CourseSidebarProps {
  stepsData: StepsResponse;
  current: number;
  completion: CompletionSummary | null;
  materialGate: ReportGateItem[] | null;
  onNavigate: (step: number) => void;
  /** Whether a report has been generated, even if it no longer matches the saved records. */
  reportExists?: boolean;
  reportState?: "draft" | "pending" | "graded" | null;
  /** Whether the latest report matches the saved record (server report_current). */
  reportCurrent?: boolean | null;
  /** The current step's material status as its task card shows it (includes unsaved/saving). */
  currentMaterialStatus?: MaterialStatus;
}

export function CourseSidebar({ stepsData, current, completion, materialGate, onNavigate, reportExists = false, reportState, reportCurrent, currentMaterialStatus }: CourseSidebarProps) {
  const steps = stepsData.steps;
  const outlineRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { revealOutlineStep(outlineRef.current); }, [current, steps]);
  const totalSteps = steps.length;
  const stages = [...new Set(steps.map((step) => step.stage))];
  const completedSteps = new Set(completion?.completed ?? []);
  // The server counts step 15 only once the report is handed in (records.report_handed_in), as the teacher's table.
  const doneCount = completion?.completed_count ?? 0;
  return (
    <aside className="sidebar" aria-label="课程大纲">
      <div className="sidebar-head">
        <div className="sidebar-head-row">
          <span className="sidebar-title">课程大纲</span>
          <span className="sidebar-steps">共 {totalSteps} 步</span>
        </div>
        {completion ? (
          <div className="progress-track" role="img" aria-label={`已完成 ${doneCount} 步，共 ${totalSteps} 步`}>
            <div
              className="progress-bar done"
              style={{ width: `${totalSteps > 0 ? (doneCount / totalSteps) * 100 : 0}%` }}
            />
          </div>
        ) : <div className="progress-track" />}
        <div className="sidebar-sub">
          {completion
            ? `完成进度 ${doneCount}/${totalSteps}`
            : "正在读取完成进度…"}
        </div>
        <a
          className="student-manual-link"
          href={STUDENT_MANUAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开实验手册（PDF，新标签页）"
          title="在新标签页阅读，可下载或打印"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z" strokeLinejoin="round" />
          </svg>
          <span>实验手册</span>
          <span className="student-manual-format" aria-hidden="true">PDF ↗</span>
        </a>
      </div>
      <div ref={outlineRef} className="sidebar-list">
        {stages.map((stage) => (
          <div key={stage}>
            <div className="stage-label">
              <span className="roman">{ROMAN[stage]}</span>
              {stepsData.stages[String(stage)]}
              <span className="stage-rule" />
            </div>
            {steps.filter((step) => step.stage === stage).map((step) => {
              const done = completedSteps.has(step.n);
              const materialStatus = stepMaterialStatus(step.n, current, materialGate, currentMaterialStatus);
              // One vocabulary with the task card: 检查中 / 保存中 / 未保存 / 已齐全 / 未齐全, and for step 15
              // 你的分析 已完成 / 未完成 (it counts the analysis answers, not report material).
              const material = stepMaterialStatusText(step, materialStatus);
              const materialLabel = `${material.name}${material.value}`;
              const state = stepProgress(step, done, materialStatus) ?? (step.n === current ? "cur" : "future");
              const completionLabel = step.lab === "rep" ? `报告${reportStatusLabel(reportCurrent, reportExists, reportState)}` : (done ? "理解题已完成" : "理解题未完成");
              const accessibleName = [
                `步骤 ${step.n}：${step.title}`,
                step.n === current ? "当前步骤" : null,
                completionLabel,
                materialLabel,
              ].filter(Boolean).join("，");
              return (
                <button
                  type="button"
                  key={step.n}
                  className={`step-row${step.n === current ? " active" : ""}`}
                  aria-label={accessibleName}
                  aria-current={step.n === current ? "step" : undefined}
                  onClick={() => onNavigate(step.n)}
                  title={`步骤 ${step.n}：${step.title}（${completionLabel}）`}
                >
                  <span className={`step-badge ${state}`} aria-hidden="true">{done ? "✓" : step.n}</span>
                  <span className="step-row-copy" aria-hidden="true">
                    <span className="step-row-title">{step.title}</span>
                    <span className="step-row-status">
                      {completionLabel} · {materialLabel}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

interface StepNavigationProps {
  step: Step;
  previous?: Step;
  next?: Step;
  stageName: string;
  totalSteps: number;
  onNavigate: (step: number) => void;
}

export function StepHeader({ step, previous, next, stageName, totalSteps, onNavigate }: StepNavigationProps) {
  return (
    <div className="step-header-bar" role="region" aria-labelledby="current-step-heading">
      <div className="big-num">{String(step.n).padStart(2, "0")}</div>
      <div className="step-header-mid">
        <div className="step-header-meta">
          <span className="stage-chip">{stageName}</span>
          <span className="step-count">步骤 {step.n} / {totalSteps}</span>
        </div>
        <h2 id="current-step-heading">{step.title}</h2>
      </div>
      <div className="nav-btns">
        <button disabled={!previous} onClick={() => previous && onNavigate(previous.n)}>← 上一步</button>
        {/* The last step keeps a (disabled) button in the same place: arriving there with 下一步 leaves focus on it. */}
        {next
          ? <button className="primary" onClick={() => onNavigate(next.n)}>下一步 →</button>
          : <button type="button" className="nav-last" aria-disabled="true">已到最后一步</button>}
      </div>
    </div>
  );
}

interface StepFooterProps {
  steps: Step[];
  step: Step;
  next?: Step;
  stageName: string;
  current: number;
  completedSteps: Set<number>;
  /** As the sidebar's, so a dot is amber where its outline tick is. */
  materialGate?: ReportGateItem[] | null;
  currentMaterialStatus?: MaterialStatus;
  onNavigate: (step: number) => void;
}

export function StepFooter({
  steps,
  step,
  next,
  stageName,
  current,
  completedSteps,
  materialGate = null,
  currentMaterialStatus,
  onNavigate,
}: StepFooterProps) {
  return (
    <footer className="stepfooter">
      <div className="footer-loc">{stageName} · {step.title}</div>
      <div className="footer-dots">
        {steps.map((item) => {
          const state = item.n === current
            ? "on"
            : stepProgress(item, completedSteps.has(item.n), stepMaterialStatus(item.n, current, materialGate, currentMaterialStatus));
          return (
            <button
              type="button"
              key={item.n}
              onClick={() => onNavigate(item.n)}
              aria-label={`前往步骤 ${item.n}：${item.title}`}
              title={`步骤 ${item.n}：${item.title}`}
              aria-current={item.n === current ? "step" : undefined}
              className={`fdot${state ? ` ${state}` : ""}`}
            />
          );
        })}
      </div>
      {/* It reads like a link, so it is one: a button to the next step. */}
      {next
        ? <button type="button" className="footer-next" onClick={() => onNavigate(next.n)}>下一步 · {next.title}</button>
        : <button type="button" className="footer-next footer-next--last" aria-disabled="true">已到最后一步</button>}
    </footer>
  );
}
