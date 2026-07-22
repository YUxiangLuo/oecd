import type { StudentAssignmentContext } from "./types";

/** 在原生 select 中同时呈现课程身份、作业和可找回的提交/评分状态。 */
export function assignmentContextLabel(context: StudentAssignmentContext): string {
  const course = context.course_run_term
    ? `${context.course_run_name}·${context.course_run_term}`
    : context.course_run_name;
  const progress = context.submission_state === "graded"
    ? `已评分 ${context.score ?? "—"}`
    : context.submission_state === "pending"
      ? "已提交·待评阅"
      : context.max_step
        ? `最远第 ${context.max_step} 步`
        : "未开始";
  const historical = context.historical ? "·历史" : "";
  return `${course} / ${context.assignment_title} — ${progress}${historical}`;
}
