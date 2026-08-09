import type { RefObject } from "react";
import { AccountPasswordModal } from "./account-password";
import { assignmentContextLabel } from "./assignment-context";
import { LogoMark } from "./brand";
import { TeacherDashboard } from "./teacher";
import { ToastHost } from "./toast";
import type {
  Announcement,
  AuthUser,
  CompletionSummary,
  Meta,
  Step,
  StepsResponse,
  StudentAssignmentContext,
} from "./types";

const ROMAN = ["", "一", "二", "三", "四", "五"];

export function sessionExpiryLabel(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("zh-CN", { hour12: false });
}

export function AppBootSkeleton() {
  return (
    <div className="layout app-boot" role="region" aria-busy="true" aria-label="正在恢复课程">
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
              <span className="sidebar-steps">16 STEPS</span>
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
      <span className="sr-only" role="status">正在恢复最新课程与实验记录…</span>
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
            数据:OECD ICIO {meta?.years.length ? `${meta.years[0]}–${meta.years.at(-1)}` : "(未预计算)"}
          </span>
          {expiry && <span className="muted">会话至 {expiry}</span>}
          <span className="role-chip" title={`教师账号 · ${user.username}`}>{user.name}</span>
          <button onClick={onRequestPasswordChange}>修改密码</button>
          <button onClick={onLogout}>退出</button>
        </div>
      </header>
      <TeacherDashboard user={user} />
      {/* 教师和学生分支互斥，因此任一时刻只挂载一个 ToastHost。 */}
      <ToastHost />
      {showPasswordChange && (
        <AccountPasswordModal onClose={onClosePasswordChange} onChanged={onPasswordChanged} />
      )}
    </div>
  );
}

interface StudentTopbarProps {
  user: AuthUser;
  meta: Meta | null;
  authExpiresAt: number | null;
  assignmentContexts: StudentAssignmentContext[];
  switchingAssignment: boolean;
  completion: CompletionSummary | null;
  maxStep: number;
  totalSteps: number;
  introTriggerRef: RefObject<HTMLButtonElement | null>;
  onSwitchAssignment: (assignmentId: number) => void;
  onShowIntro: () => void;
  onRequestPasswordChange: () => void;
  onLogout: () => void;
}

export function StudentTopbar({
  user,
  meta,
  authExpiresAt,
  assignmentContexts,
  switchingAssignment,
  completion,
  maxStep,
  totalSteps,
  introTriggerRef,
  onSwitchAssignment,
  onShowIntro,
  onRequestPasswordChange,
  onLogout,
}: StudentTopbarProps) {
  const expiry = sessionExpiryLabel(authExpiresAt);
  return (
    <header className="topbar">
      <LogoMark size={30} />
      <div>
        <h1>供应链仿真系统</h1>
        <div className="sub">GVC SIMULATION LAB</div>
      </div>
      <div className="topbar-user">
        {assignmentContexts.length > 0 && (
          <label className="assignment-context-picker">
            <span>课程作业</span>
            <select
              aria-label="切换课程作业"
              value={String(meta?.assignment_id ?? "")}
              disabled={switchingAssignment}
              onChange={(event) => onSwitchAssignment(Number(event.target.value))}
            >
              {assignmentContexts.map((context) => (
                <option key={context.assignment_id} value={context.assignment_id}>
                  {assignmentContextLabel(context)}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="muted">
          数据:OECD ICIO {meta?.years.length ? `${meta.years[0]}–${meta.years.at(-1)}` : "(未预计算)"}
        </span>
        {completion ? (
          <span
            className="progress-pill"
            title={`已完成 ${completion.completed_count} 步；最远到过第 ${maxStep} 步（到过不等于完成）`}
          >
            已完成 <b>{completion.completed_count}</b><span>/{totalSteps}</span>
          </span>
        ) : (
          <span className="progress-pill" title={`最远到过第 ${maxStep} 步`}>
            最远到第 <b>{Math.min(maxStep, totalSteps)}</b> 步
          </span>
        )}
        <span className="role-chip" title={`学生账号 · ${user.username}`}>{user.name}</span>
        {expiry && <span className="muted" title="服务端签发的 expires_at">会话至 {expiry}</span>}
        <button ref={introTriggerRef} onClick={onShowIntro}>ⓘ 系统介绍</button>
        <button onClick={onRequestPasswordChange}>修改密码</button>
        <button onClick={onLogout}>退出</button>
      </div>
    </header>
  );
}

interface AnnouncementBannerProps {
  announcements: Announcement[];
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}

export function AnnouncementBanner({ announcements, expanded, onToggle, onDismiss }: AnnouncementBannerProps) {
  if (!announcements.length) return null;
  const first = announcements[0];
  return (
    <section className="announce-banner" aria-label="课程公告">
      <span className="announce-banner-ic">📢</span>
      <div className="announce-banner-body">
        <b>{first.title}</b>
        {first.body && expanded && <p>{first.body}</p>}
        {expanded && announcements.slice(1).map((announcement) => (
          <div key={announcement.id} className="announce-banner-more">
            <b>{announcement.title}</b>
            {announcement.body && <p>{announcement.body}</p>}
          </div>
        ))}
      </div>
      {(announcements.length > 1 || first.body) && (
        <button onClick={onToggle}>
          {expanded ? "收起" : `展开${announcements.length > 1 ? `全部 ${announcements.length} 条` : ""}`}
        </button>
      )}
      <button type="button" aria-label="关闭课程公告" title="关闭课程公告" onClick={onDismiss}>×</button>
    </section>
  );
}

interface CourseSidebarProps {
  stepsData: StepsResponse;
  current: number;
  maxStep: number;
  completion: CompletionSummary | null;
  onNavigate: (step: number) => void;
}

export function CourseSidebar({ stepsData, current, maxStep, completion, onNavigate }: CourseSidebarProps) {
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
        ) : (
          <div
            className="progress-track"
            role="img"
            aria-label={`最远到过第 ${Math.min(maxStep, totalSteps)} 步,共 ${totalSteps} 步;这是浏览位置,不代表已完成`}
          >
            <div
              className="progress-bar"
              style={{ width: `${Math.max(6, (Math.min(maxStep, totalSteps) / totalSteps) * 100)}%` }}
            />
          </div>
        )}
        <div className="sidebar-sub">全球价值链实证分析 · 数据→指标→回归→报告</div>
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
              const state = done ? "done" : step.n === current ? "cur" : step.n <= maxStep ? "past" : "future";
              const accessibleName = [
                `第 ${step.n} 步：${step.title}`,
                step.n === current ? "当前步骤" : null,
                done ? "已完成" : "未完成",
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
                  <span className="step-row-title" aria-hidden="true">{step.title}</span>
                  <span className="step-code" aria-hidden="true">{String(step.n).padStart(2, "0")}</span>
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
        <button className="primary" disabled={!next} onClick={() => next && onNavigate(next.n)}>下一步 →</button>
      </div>
    </div>
  );
}

export function StepRail({ step, previous, next, stageName, totalSteps, onNavigate }: StepNavigationProps) {
  return (
    <aside className="rightrail" aria-label="本步速览">
      <div className="rail-head"><span className="rail-head-ic">📌</span>本步速览</div>
      <div className="rail-stage">
        <div className="rail-stage-loc">阶段{ROMAN[step.stage]} · {stageName}</div>
        <div className="rail-stage-num"><b>{String(step.n).padStart(2, "0")}</b><span>/ {totalSteps} 步</span></div>
      </div>
      <div className="rail-sec">
        <div className="rail-label">🎯 本步目标</div>
        <div className="rail-goal">{step.goal}</div>
      </div>
      <div className="rail-tip"><span>💡</span><div><b>关键提示 · </b>{step.tip}</div></div>
      <div className="rail-sec">
        <div className="rail-label">🔗 关联数据 / 依赖</div>
        <div className="rail-chips">{step.deps.map((dependency) => <span key={dependency} className="rail-chip">{dependency}</span>)}</div>
      </div>
      <div className="rail-flow">
        <div className="rail-label">流程位置</div>
        {previous && (
          <button type="button" className="rail-flow-row" onClick={() => onNavigate(previous.n)}>
            <span className="rail-flow-k">↑ 上一步</span>
            <span className="rail-flow-t">{previous.title}</span>
          </button>
        )}
        <div className="rail-flow-row cur">
          <span className="rail-flow-k">● 当前</span>
          <span className="rail-flow-t">{step.title}</span>
        </div>
        {next && (
          <button type="button" className="rail-flow-row" onClick={() => onNavigate(next.n)}>
            <span className="rail-flow-k">↓ 下一步</span>
            <span className="rail-flow-t">{next.title}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

interface StepFooterProps {
  steps: Step[];
  step: Step;
  next?: Step;
  stageName: string;
  current: number;
  maxStep: number;
  completedSteps: Set<number>;
  onNavigate: (step: number) => void;
}

export function StepFooter({
  steps,
  step,
  next,
  stageName,
  current,
  maxStep,
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
            className={`fdot${item.n === current ? " on" : completedSteps.has(item.n) ? " done" : item.n <= maxStep ? " past" : ""}`}
          />
        ))}
      </div>
      <div className="footer-next">{next ? `下一步 · ${next.title}` : "已到最后一步"}</div>
    </footer>
  );
}
