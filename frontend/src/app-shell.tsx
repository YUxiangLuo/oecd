import { useLayoutEffect, useRef, type RefObject } from "react";
import { AccountPasswordModal } from "./account-password";
import { LogoMark } from "./brand";
import { oecdIcioDatasetLabel } from "./dataset-label";
import { isDemoStudentUsername } from "./login";
import { TeacherDashboard } from "./teacher";
import { TeacherReviewGuardProvider, useTeacherReviewGuard } from "./teacher/review-guard";
import { ToastHost } from "./toast";
import { materialStatusForStep, reportStatusLabel } from "./step-task-card";
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
              <span className="sidebar-steps">15 STEPS</span>
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
          <button ref={passwordTriggerRef} onClick={() => reviewGuard.attempt(onRequestPasswordChange)}>修改密码</button>
          <button onClick={() => reviewGuard.attempt(() => { reviewGuard.clear(); onLogout(); })}>退出</button>
        </div>
      </header>
      <TeacherDashboard user={user} />
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
        <button
          ref={passwordTriggerRef}
          disabled={fixedDemoPassword}
          title={fixedDemoPassword ? "演示账号的密码由系统统一管理，不能修改" : undefined}
          onClick={onRequestPasswordChange}
        >
          {fixedDemoPassword ? "固定演示口令" : "修改密码"}
        </button>
        <button onClick={onLogout}>退出</button>
      </div>
    </header>
  );
}

interface CourseSidebarProps {
  stepsData: StepsResponse;
  current: number;
  completion: CompletionSummary | null;
  materialGate: ReportGateItem[] | null;
  onNavigate: (step: number) => void;
  /** Whether a report has been generated, even if it no longer matches the saved records. */
  reportExists?: boolean;
}

export function CourseSidebar({ stepsData, current, completion, materialGate, onNavigate, reportExists = false }: CourseSidebarProps) {
  const steps = stepsData.steps;
  const outlineRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { revealOutlineStep(outlineRef.current); }, [current, steps]);
  const totalSteps = steps.length;
  const stages = [...new Set(steps.map((step) => step.stage))];
  const completedSteps = new Set(completion?.completed ?? []);
  return (
    <aside className="sidebar" aria-label="课程大纲">
      <div className="sidebar-head">
        <div className="sidebar-head-row">
          <span className="sidebar-title">课程大纲</span>
          <span className="sidebar-steps">{totalSteps} STEPS</span>
        </div>
        {completion ? (
          <div className="progress-track" role="img" aria-label={`已完成 ${completion.completed_count} 步,共 ${totalSteps} 步`}>
            <div
              className="progress-bar done"
              style={{ width: `${Math.max(2, (completion.completed_count / totalSteps) * 100)}%` }}
            />
          </div>
        ) : <div className="progress-track" />}
        <div className="sidebar-sub">
          {completion
            ? `理解进度 ${completion.completed_count}/${totalSteps} · 数据→指标→回归→报告`
            : "正在读取理解进度…"}
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
              const materialStatus = materialStatusForStep(step.n, materialGate);
              const materialLabel = materialStatus === "checking"
                ? "报告材料检查中"
                : materialStatus === "ready" ? "报告材料已齐" : "报告材料未齐";
              const state = done ? "done" : step.n === current ? "cur" : "future";
              const completionLabel = step.lab === "rep" ? `报告${reportStatusLabel(done, reportExists)}` : (done ? "理解已完成" : "理解未完成");
              const accessibleName = [
                `第 ${step.n} 步：${step.title}`,
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
                  title={`第 ${step.n} 步：${step.title}（${completionLabel}）`}
                >
                  <span className={`step-badge ${state}`} aria-hidden="true">{done ? "✓" : step.n}</span>
                  <span className="step-row-copy" aria-hidden="true">
                    <span className="step-row-title">{step.title}</span>
                    <span className="step-row-status">
                      {completionLabel} · 材料{materialStatus === "checking" ? "检查中" : materialStatus === "ready" ? "已齐全" : "未齐全"}
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
          <span className="step-count">STEP {step.n} / {totalSteps}</span>
        </div>
        <h2 id="current-step-heading">{step.title}</h2>
      </div>
      <div className="nav-btns">
        <button disabled={!previous} onClick={() => previous && onNavigate(previous.n)}>← 上一步</button>
        {next
          ? <button className="primary" onClick={() => onNavigate(next.n)}>下一步 →</button>
          : <span className="muted">已到最后一步</span>}
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
  onNavigate: (step: number) => void;
}

export function StepFooter({
  steps,
  step,
  next,
  stageName,
  current,
  completedSteps,
  onNavigate,
}: StepFooterProps) {
  return (
    <footer className="stepfooter">
      <div className="footer-loc">{stageName} · {step.title}</div>
      <div className="footer-dots">
        {steps.map((item) => (
          <button
            type="button"
            key={item.n}
            onClick={() => onNavigate(item.n)}
            aria-label={`前往步骤 ${item.n}：${item.title}`}
            aria-current={item.n === current ? "step" : undefined}
            className={`fdot${item.n === current ? " on" : completedSteps.has(item.n) ? " done" : ""}`}
          />
        ))}
      </div>
      <div className="footer-next">{next ? `下一步 · ${next.title}` : "已到最后一步"}</div>
    </footer>
  );
}
