import { useRef, type RefObject } from "react";
import { AccountPasswordModal } from "./account-password";
import { LogoMark } from "./brand";
import { oecdIcioDatasetLabel } from "./dataset-label";
import { isDemoStudentUsername } from "./login";
import { TeacherDashboard } from "./teacher";
import { ToastHost } from "./toast";
import { materialStatusForStep } from "./step-task-card";
import type {
  AuthUser,
  CompletionSummary,
  Meta,
  ReportGateItem,
  Step,
  StepsResponse,
} from "./types";

const ROMAN = ["", "一", "二", "三", "四", "五"];

export function sessionExpiryLabel(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("zh-CN", { hour12: false });
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
  authExpiresAt: number | null;
  showPasswordChange: boolean;
  onRequestPasswordChange: () => void;
  onClosePasswordChange: () => void;
  onPasswordChanged: () => void;
  onLogout: () => void;
}

export function TeacherWorkspace({
  user,
  meta,
  authExpiresAt,
  showPasswordChange,
  onRequestPasswordChange,
  onClosePasswordChange,
  onPasswordChanged,
  onLogout,
}: TeacherWorkspaceProps) {
  const expiry = sessionExpiryLabel(authExpiresAt);
  const passwordTriggerRef = useRef<HTMLButtonElement>(null);
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
          {expiry && <span className="muted">会话至 {expiry}</span>}
          <span className="role-chip" title={`${user.name} · 教师账号 · ${user.username}`}><span>{user.name}</span></span>
          <button ref={passwordTriggerRef} onClick={onRequestPasswordChange}>修改密码</button>
          <button onClick={onLogout}>退出</button>
        </div>
      </header>
      <TeacherDashboard user={user} />
      {/* 教师和学生分支互斥，因此任一时刻只挂载一个 ToastHost。 */}
      <ToastHost />
      {showPasswordChange && (
        <AccountPasswordModal
          onClose={onClosePasswordChange}
          onChanged={onPasswordChanged}
          returnFocusRef={passwordTriggerRef}
        />
      )}
    </div>
  );
}

interface StudentTopbarProps {
  user: AuthUser;
  meta: Meta | null;
  authExpiresAt: number | null;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  passwordTriggerRef: RefObject<HTMLButtonElement | null>;
  onShowIntro: () => void;
  onRequestPasswordChange: () => void;
  onLogout: () => void;
}

export function StudentTopbar({
  user,
  meta,
  authExpiresAt,
  introTriggerRef,
  passwordTriggerRef,
  onShowIntro,
  onRequestPasswordChange,
  onLogout,
}: StudentTopbarProps) {
  const expiry = sessionExpiryLabel(authExpiresAt);
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
        {expiry && <span className="muted" title="服务端签发的 expires_at">会话至 {expiry}</span>}
        <button ref={introTriggerRef} onClick={onShowIntro}>ⓘ 系统介绍</button>
        <button
          ref={passwordTriggerRef}
          disabled={fixedDemoPassword}
          title={fixedDemoPassword ? "固定轮换凭证由系统维护" : undefined}
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
}

export function CourseSidebar({ stepsData, current, completion, materialGate, onNavigate }: CourseSidebarProps) {
  const steps = stepsData.steps;
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
      </div>
      <div className="sidebar-list">
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
              const accessibleName = [
                `第 ${step.n} 步：${step.title}`,
                step.n === current ? "当前步骤" : null,
                done ? "已完成" : "未完成",
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
                  title={`第 ${step.n} 步：${step.title}${done ? "（已完成）" : ""}`}
                >
                  <span className={`step-badge ${state}`} aria-hidden="true">{done ? "✓" : step.n}</span>
                  <span className="step-row-copy" aria-hidden="true">
                    <span className="step-row-title">{step.title}</span>
                    <span className="step-row-status">
                      理解{done ? "已完成" : "未完成"} · 材料{materialStatus === "checking" ? "检查中" : materialStatus === "ready" ? "已齐全" : "未齐全"}
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
