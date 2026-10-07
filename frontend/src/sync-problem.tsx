import { createContext, useContext } from "react";

export interface SyncProblem {
  error: string | null;
  conflict: boolean;
  syncing: boolean;
  /** Retry the save, or load the server version after a conflict. */
  act: () => void;
}

/**
 * The tab's unsaved-record problem. A fullscreen workspace covers the page banner, so it reads this to
 * show the same warning inside the dialog: otherwise a student keeps working there believing it saved.
 */
export const SyncProblemContext = createContext<SyncProblem | null>(null);

export function SyncProblemBanner({ problem, compact = false }: { problem: SyncProblem; compact?: boolean }) {
  if (!problem.error) return null;
  return (
    <div className={`error-box persistent-qc-warning${compact ? " sync-problem--compact" : ""}`} role="alert">
      <b>{problem.conflict ? "另一个页面已经保存了更新的记录" : "实验记录尚未保存到服务器"}</b>
      {!compact && (
        <p>
          {problem.conflict
            ? "为避免互相覆盖，本页的修改（包括自动记录的报告材料）暂未保存。载入后，另一个页面改过的内容以它为准，本页的其他修改会自动保留并保存；两边在同一步改了同一项时，本页这一步的修改会被替换，需要的文字请先复制。"
            : `${problem.error} 本页内容还在，可以直接重试；关闭标签页可能丢失未保存的修改。`}
        </p>
      )}
      {compact && <span>{problem.conflict ? "本页的修改暂未保存，退出全屏可查看说明。" : problem.error}</span>}
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
