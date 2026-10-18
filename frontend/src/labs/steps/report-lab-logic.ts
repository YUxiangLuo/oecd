/**
 * Step 15's non-component logic: limits and counts of the writing fields, the report gate summary and its
 * focus hand-offs, and the labels of the report buttons. Kept apart from report-lab.tsx so that file exports
 * components only (Vite Fast Refresh) and tests can import the logic without the page.
 */
import { revealFocusedWhileSettling } from "../../content-scroll";
import { STEP_MATERIAL_ACTION_ID, stepTaskTitleId } from "../../step-task-card";
import type { ClassroomReport, ReportGateItem } from "../../types";
import type { SessionStatus } from "../../use-session";

export const REFLECTION_MAX_LENGTH = 2400;

/** What a cut at the limit kept: nothing or part of the new text, and whether a selection was pasted over. */
export function pasteCutMessage(cut: { wide: boolean; replaced?: boolean; none?: boolean }): string {
  const limit = `超过 ${REFLECTION_MAX_LENGTH} 字上限：`;
  if (cut.wide) return `${limit}这个表情按实际字符计算占多个字，剩余字数不够，没有保留；${cut.replaced ? "选中的原文已被替换" : "原有文字没有改动"}。`;
  const kept = cut.none ? "刚粘贴或输入的文字没有保留" : "刚粘贴或输入的文字有一部分没有保留";
  return `${limit}${kept}，${cut.replaced ? "选中的原文已被替换" : "原有文字没有改动"}。请精简后再补充。`;
}

/** `atLimit`: the field is full by the server's count (code points, every space and line break included), which
 * emoji or blank lines can reach before the shown count does. The limit is not moved to the shown count: the
 * server's report gate counts code points and would then refuse the text. Instead, a field full before the shown
 * count reaches the limit says why, rather than "已写 2380 / 2400 字 · 已达上限". */
export function reflectionCountLabel(
  length: number, min: number, max = REFLECTION_MAX_LENGTH, atLimit = false, stored = length,
): string {
  if (atLimit && length < max) return `已写 ${length} 字 · 已达 ${max} 字上限（空格、换行和表情符号按实际字符计，可能占多个字）`;
  if (length >= max || atLimit) return `已写 ${Math.min(length, max)} / ${max} 字 · 已达上限`;
  // Spaces, line breaks and invisible characters take room under the limit without counting as written: once
  // the room left is less than the counter suggests, say how much is left.
  const left = max - stored;
  const room = left < max - length && left < 200 ? ` · 还能再写 ${left} 字（空格和换行也占位置）` : "";
  return length >= min
    ? `已写 ${length} / ${max} 字 · 已达最低 ${min} 字${room}`
    : `已写 ${length} / ${max} 字 · 最低 ${min} 字${room}`;
}

export const REPORT_REFLECTION_TITLE_ID = "report-reflection-title";
export const REPORT_REFLECTION_INCOMPLETE_SELECTOR = "textarea[data-report-reflection-incomplete='true']:not(:disabled)";

type ReportGateFocusRoot = {
  getElementById(id: string): (Pick<HTMLElement, "focus"> & Partial<Pick<HTMLElement, "scrollIntoView">>) | null;
  querySelector?(selectors: string): Element | null;
};

type AnimationFrameScheduler = Pick<Window,
  "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
>;

/** A bounded hand-off across lazy step/data rendering. User navigation always wins. */
function activateLazyStepDestination(
  step: number,
  onNavigateStep: (step: number) => void,
  targetId: string,
  root: ReportGateFocusRoot,
  scheduler: AnimationFrameScheduler,
  timeoutMs: number,
) {
  const inputs = ["pointerdown", "keydown", "wheel", "touchstart", "popstate"] as const;
  let frame = 0;
  let arrived = false;
  let stopped = false;
  const stop = () => {
    stopped = true;
    scheduler.cancelAnimationFrame(frame);
    scheduler.clearTimeout(timer);
    for (const type of inputs) scheduler.removeEventListener(type, stop, true);
  };
  const timer = scheduler.setTimeout(stop, timeoutMs);
  for (const type of inputs) scheduler.addEventListener(type, stop, { capture: true, passive: true });
  onNavigateStep(step);
  const seek = () => {
    if (stopped) return;
    const task = root.getElementById(stepTaskTitleId(step));
    const otherTask = root.querySelector?.(`[id^="step-task-title-"]:not([id="${stepTaskTitleId(step)}"]):not([id="${stepTaskTitleId(15)}"])`);
    if (otherTask || (arrived && !task)) { stop(); return; }
    arrived ||= Boolean(task);
    const target = task ? root.getElementById(targetId) : null;
    if (target) {
      stop();
      target.focus({ preventScroll: true });
      if (target instanceof HTMLElement) revealFocusedWhileSettling(target);
      else target.scrollIntoView?.({ block: "start" });
      return;
    }
    frame = scheduler.requestAnimationFrame(seek);
  };
  frame = scheduler.requestAnimationFrame(seek);
}

export function activateReportMaterialDestination(step: number, onNavigateStep: (step: number) => void) {
  activateLazyStepDestination(step, onNavigateStep, STEP_MATERIAL_ACTION_ID, document, window, 4000);
}

/** Restore a useful keyboard position after the gate link itself unmounts. */
export function focusReportGateDestination(
  step: number,
  root: ReportGateFocusRoot = document,
  quizOnly = false,
): boolean {
  // Only the quiz is missing: go to the quiz, not the top of the step. The step's data loads after this frame and
  // grows the page above the quiz, so the quiz is kept in view until the page settles (or the student moves on).
  if (quizOnly) {
    const quiz = root.getElementById(`quiz-title-${step}`);
    if (!quiz) return false;
    quiz.focus({ preventScroll: true });
    if (quiz instanceof HTMLElement) revealFocusedWhileSettling(quiz);
    else quiz.scrollIntoView?.({ block: "start" });
    return true;
  }
  const target = root.getElementById(stepTaskTitleId(step));
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** Step 15 is already mounted: return the student to the first unfinished writing field. */
export function focusReportReflection(root: ReportGateFocusRoot = document): boolean {
  const incomplete = root.querySelector?.(REPORT_REFLECTION_INCOMPLETE_SELECTOR) as Pick<HTMLElement, "focus"> | null | undefined;
  const target = incomplete ?? root.getElementById(REPORT_REFLECTION_TITLE_ID);
  if (!target) return false;
  target.focus();
  return true;
}

export function activateReportGateDestination(
  step: number,
  onNavigateStep: (step: number) => void,
  root: ReportGateFocusRoot = document,
  scheduler: AnimationFrameScheduler = window,
  quizOnly = false,
): boolean {
  if (step <= 0) return false;
  if (step === 15) return focusReportReflection(root);
  if (quizOnly) {
    // A cold regression module suspends with the quiz inside it. Keep the
    // destination pending until it mounts, unless the student moves on.
    activateLazyStepDestination(step, onNavigateStep, `quiz-title-${step}`, root, scheduler, 30000);
    return true;
  }
  onNavigateStep(step);
  scheduler.requestAnimationFrame(() => { focusReportGateDestination(step, root, quizOnly); });
  return true;
}

const REPORT_GATE_STAGES = [
  { label: "数据接入", first: 1, last: 1 },
  { label: "指标计算", first: 2, last: 5 },
  { label: "图表比较", first: 6, last: 9 },
  { label: "关税回归", first: 10, last: 14 },
  { label: "实验报告", first: 15, last: 15 },
] as const;

function reportGateStage(step: number): string {
  return REPORT_GATE_STAGES.find((stage) => step >= stage.first && step <= stage.last)?.label ?? "其他条件";
}

export function summarizeReportGate(blocked: ReportGateItem[]) {
  const ordered = [...blocked].sort((left, right) => {
    if (left.step <= 0 && right.step > 0) return 1;
    if (left.step > 0 && right.step <= 0) return -1;
    return left.step - right.step;
  });
  const groups = [...REPORT_GATE_STAGES.map(({ label }) => label), "其他条件"]
    .map((label) => ({ label, items: ordered.filter((item) => reportGateStage(item.step) === label) }))
    .filter((group) => group.items.length > 0);
  // Steps 1–14 (materials and quizzes) are counted apart from step 15's own analysis, the same split as the
  // roadmap above the gate; one combined count next to the roadmap's read as a contradiction.
  const earlier = blocked.filter((item) => item.step > 0 && item.step < 15);
  const stepCount = new Set(earlier.map((item) => item.step)).size;
  const globalCount = blocked.filter((item) => item.step <= 0).length;
  const count = (items: ReportGateItem[]) => items.reduce((total, item) => total + item.missing.length, 0);
  const missingCount = count(blocked);
  const ownCount = count(blocked.filter((item) => item.step >= 15));
  const scope = [
    stepCount > 0 ? `步骤 1–14 中 ${stepCount} 个步骤` : null,
    globalCount > 0 ? `${globalCount} 项其他条件` : null,
  ].filter(Boolean).join("、");
  const earlierCount = missingCount - ownCount;
  const parts = [
    earlierCount > 0 ? `${scope || "当前记录"}还有 ${earlierCount} 项待补齐` : null,
    ownCount > 0 ? `本步还有 ${ownCount} 项待完成` : null,
  ].filter(Boolean);
  return {
    groups,
    missingCount,
    next: ordered[0] ?? null,
    summary: parts.join("；") || "当前记录还有 0 项待补齐",
  };
}

/** "生成" before the first submission; "更新" once a submitted report exists (it is updated, not generated). */
export function reportGateVerb(report: Pick<ClassroomReport, "state"> | null | undefined): "生成" | "更新" {
  return report && report.state !== "draft" ? "更新" : "生成";
}
/** The window title while printing: browsers name the PDF after it (实验报告 · 学生 · 日期). */
export function reportPrintTitle(report: ClassroomReport): string {
  const student = /^学生：(.+)$/m.exec(report.markdown)?.[1]?.trim();
  return ["实验报告", student, report.generated_at?.slice(0, 10)].filter(Boolean).join(" · ");
}

export const REPORT_GENERATE_FIRST_LABEL = "只生成草稿（不提交）";

/**
 * What to do when the report misses later edits. A draft can be regenerated on its own. A submitted report cannot:
 * regenerating replaces the one report the server keeps and submits it again (a graded one loses its grade), so
 * the teacher keeps the submitted version until the student updates it.
 */
export function reportOutdatedAdvice(state: ClassroomReport["state"]): string {
  if (state === "draft") return "修改后请先点“重新生成草稿”，再提交或导出。";
  const kept = `在你更新之前，老师那里仍是已${state === "graded" ? "评阅" : "提交"}的版本。`;
  return state === "graded"
    ? `${kept}点“更新报告并提交给老师”会按最新记录重新生成并再次提交，同时清除原评分和评语；需要留档时，可先导出已评阅版本的 PDF（含评分与评语）。`
    : `${kept}点“更新报告并提交给老师”会按最新记录重新生成并再次提交（已提交的报告不能只生成草稿）；更新后才能导出 PDF。`;
}

export function reportGenerateLabel(report: ClassroomReport | null) {
  if (!report) return REPORT_GENERATE_FIRST_LABEL;
  return report.state === "pending" || report.state === "graded" ? "重新生成并提交" : "重新生成草稿";
}

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "grapheme" })
  : null;

/** What a reader sees as one character: a family emoji or a letter with an accent is one (code points where
 * the browser has no Intl.Segmenter). */
export function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment) : [...text];
}

/** Code points: what the server's 2,400 limit counts (Python ``len``). */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

// Python's str.split() whitespace (the server's rule in report_gate.reflection_length), so both sides count alike.
const SERVER_WHITESPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
// Code points that show nothing by themselves: control, format (zero-width, bidi), combining marks.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}]/gu;

/** The written length the minimums are checked against, as the server counts it: visible code points, each run of
 *  spaces or line breaks between words counting as one. Invisible characters do not count, so a field of
 *  zero-width spaces is empty; an emoji counts its code points (a flag is 2), as the limit note says. */
export function reflectionLength(text: string): number {
  const words = text.split(SERVER_WHITESPACE).map((word) => word.replace(INVISIBLE, "")).filter(Boolean);
  return codePointLength(words.join(" "));
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Keep a change within the limit without touching the student's own text: when the new value is too long,
 * only the newly inserted part (at the caret) is shortened, at whole characters, and the text before and after
 * it stays as it was. `caret` is the textarea's caret right after the change (the end of the insertion).
 * `wide` (with a cut): the first character left out takes several code points (a combined emoji such as a family),
 * so it did not fit although it looks like one character.
 */
export function limitInsertion(
  previous: string,
  next: string,
  caret: number | null,
  max = REFLECTION_MAX_LENGTH,
): { value: string; caret: number; cut: boolean; wide?: boolean; replaced?: boolean; none?: boolean } {
  const end = caret ?? next.length;
  if (codePointLength(next) <= max) return { value: next, caret: end, cut: false };
  // Split the new value into unchanged head, insertion and unchanged tail, for a given tail length.
  const split = (tail: number) => {
    const oldHead = previous.slice(0, previous.length - tail);
    const newHead = next.slice(0, next.length - tail);
    let head = 0;
    while (head < oldHead.length && head < newHead.length && oldHead[head] === newHead[head]) head += 1;
    return { prefix: head, suffix: tail, removed: previous.length - head - tail };
  };
  // The longest common tail; with repeated characters the caret (the end of the insertion) places the
  // insertion more exactly, unless it implies replacing more of the old text (a caret the browser moved).
  let common = 0;
  while (common < previous.length && common < next.length
    && previous[previous.length - 1 - common] === next[next.length - 1 - common]) common += 1;
  let chosen = split(common);
  if (caret != null && caret >= 0 && caret <= next.length && next.length - caret <= common) {
    const byCaret = split(next.length - caret);
    if (byCaret.removed <= chosen.removed) chosen = byCaret;
  }
  let { prefix, suffix } = chosen;
  // The change replaced some of the old text (a selection pasted over): that part is gone, as the student meant.
  const replaced = chosen.removed > 0;
  // Never split a surrogate pair between the kept text and the insertion.
  while (prefix > 0 && isLowSurrogate(next.charCodeAt(prefix))) prefix -= 1;
  while (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix))) suffix -= 1;
  const before = next.slice(0, prefix);
  const after = next.slice(next.length - suffix);
  const inserted = next.slice(prefix, next.length - suffix);
  let room = max - codePointLength(before) - codePointLength(after);
  let kept = "";
  let wide = false;
  for (const part of graphemes(inserted)) {
    const size = codePointLength(part);
    if (size > room) {
      wide = size > 1;
      break;
    }
    kept += part;
    room -= size;
  }
  // A field already over the limit (saved elsewhere) may still lose characters: that is not a cut.
  const cut = kept.length !== inserted.length;
  return {
    value: before + kept + after, caret: before.length + kept.length, cut,
    ...(cut ? { wide, replaced, none: kept.length === 0 } : {}),
  };
}

/**
 * Why regenerating was refused (409), from the report this page showed and the one the server now has:
 * a new grade, a submission from another tab, or another update. Null when the server's report is unknown
 * or unchanged (the server's own message is shown then).
 */
export function reportConflictMessage(seen: ClassroomReport | null, latest: ClassroomReport | null): string | null {
  if (!latest) return null;
  if (latest.state === "graded" && (seen?.state !== "graded" || seen.graded_at !== latest.graded_at)) {
    return "老师刚刚评阅了这份报告，页面已显示最新状态。请先查看评分与评语，再决定是否重新生成。";
  }
  if (latest.state === "pending" && seen?.state !== "pending") {
    return "这份报告已在别处提交给老师，页面已显示最新状态。请核对后再决定是否重新生成。";
  }
  if (seen?.updated_at !== latest.updated_at || seen?.state !== latest.state) {
    return "这份报告已在别处更新，页面已显示最新状态。请核对后再决定是否重新生成。";
  }
  return null;
}

/** Said instead of exporting a graded version the server no longer has (it was regenerated or regraded elsewhere). */
export function gradedExportRefusal(latest: ClassroomReport | null): string {
  return latest?.state === "graded"
    ? "老师刚刚重新评阅了这份报告，页面已显示最新评分；请核对后再导出。"
    : "这份报告已在别处重新生成，原评分和评语已清除，不能再导出已评阅版本；页面已显示最新状态。";
}

/** Space kept above an element scrolled to the top of the course scroller, so nothing sits under its upper edge. */
const REVEAL_OFFSET = 16;

/** Bring an element to the top of the course scroller with a little room above it (see content-scroll.ts). */
export function revealWithOffset(target: HTMLElement | null, offset = REVEAL_OFFSET): void {
  if (!target) return;
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  const scroller = target.closest<HTMLElement>(".content");
  if (!scroller) {
    target.scrollIntoView?.({ behavior, block: "start" });
    return;
  }
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  scroller.scrollTo?.({ top: Math.max(0, top), left: 0, behavior });
}

export function reportWaitLabel(
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
  syncError: string | null = null,
  syncConflict = false,
): string | null {
  if (syncConflict) return "请先处理保存异常";
  if (syncError) return "保存失败，请先重试";
  if (sessionStatus !== "ready") return "正在恢复实验记录…";
  if (sessionSyncing || sessionUnsynced) return "正在保存实验记录…";
  return null;
}

export function reportGenerateButtonLabel(
  report: ClassroomReport | null,
  generating: boolean,
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
  syncError: string | null = null,
  syncConflict = false,
): string {
  if (generating) return "正在生成报告…";
  // The primary button beside this one already says the save failed; this one keeps its own action in the
  // label, so the two never read the same.
  const action = !report ? "生成草稿" : report.state === "draft" ? "重新生成草稿" : "重新生成";
  if (syncConflict) return `处理保存异常后才能${action}`;
  if (syncError) return `重试保存后才能${action}`;
  return reportWaitLabel(sessionStatus, sessionUnsynced, sessionSyncing, syncError, syncConflict) ?? reportGenerateLabel(report);
}

/** The autosave state shown next to the writing area. */
export function reportAutosaveLabel(
  sessionStatus: SessionStatus,
  sessionUnsynced: boolean,
  sessionSyncing: boolean,
  syncError: string | null = null,
  syncConflict = false,
): string | null {
  if (syncConflict || syncError) return "未保存";
  if (sessionStatus !== "ready") return null;
  return sessionSyncing || sessionUnsynced ? "保存中…" : "已保存";
}
