import { createContext, useContext } from "react";

export interface SyncProblem {
  error: string | null;
  conflict: boolean;
  syncing: boolean;
  /** The save will be sent again on its own (the server or network was briefly unreachable). */
  autoRetry?: boolean;
  /** Retry the save, or load the server version after a conflict. */
  act: () => void;
}

/**
 * The tab's unsaved-record problem. A fullscreen workspace covers the page banner, so it reads this to
 * show the same warning inside the dialog: otherwise a student keeps working there believing it saved.
 */
export const SyncProblemContext = createContext<SyncProblem | null>(null);

/** Set when the student edited again while the server version was loading: the conflict is still open. */
export const EDITED_DURING_RELOAD = "载入时你又改了内容，已为你保留。请再点一次“载入服务器版本”。";

export function SyncProblemBanner({ problem, compact = false }: { problem: SyncProblem; compact?: boolean }) {
  if (!problem.error) return null;
  const conflictNote = problem.error === EDITED_DURING_RELOAD
    ? EDITED_DURING_RELOAD
    : "本页的修改暂未保存。点“载入服务器版本”后，本页的其他修改会保留；如果两边在同一步改了同一项，本页这一步会被替换，请先复制需要保留的文字。";
  return (
    <div className={`error-box persistent-qc-warning${compact ? " sync-problem--compact" : ""}`} role="alert">
      <b>{problem.conflict ? "你的账号在别处保存了更新的记录" : "实验记录尚未保存到服务器"}</b>
      {!compact && (
        <p>
          {problem.conflict
            ? conflictNote
            : `${problem.error} 本页内容还在，${problem.autoRetry ? "系统会自动重试，也可以现在重试" : "可以直接重试"}；关闭标签页可能丢失未保存的修改。`}
        </p>
      )}
      {compact && <span>{problem.conflict && problem.error !== EDITED_DURING_RELOAD ? "本页的修改暂未保存，退出全屏可查看说明。" : problem.error}</span>}
      <button type="button" className="secondary" disabled={problem.syncing} onClick={problem.act}>
        {problem.syncing
          ? problem.conflict ? "正在载入…" : "正在重试…"
          : problem.conflict ? "载入服务器版本" : "重试保存"}
      </button>
    </div>
  );
}

/** Rendered inside an expanded fullscreen panel; nothing outside a student workspace or without a problem. */
export function FullscreenSyncProblem() {
  const problem = useContext(SyncProblemContext);
  return problem ? <SyncProblemBanner problem={problem} compact /> : null;
}
