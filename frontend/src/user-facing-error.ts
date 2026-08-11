const NETWORK_FAILURE =
  /^(failed to fetch|load failed|networkerror(?: when attempting to fetch resource\.?)?|network request failed)$/i;

function rawErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim();
  return String(cause ?? "").trim();
}

/** 将服务端机器术语转换为学生能理解的课堂用语；稳定键仍保留在日志和接口中。 */
export function studentFacingTechnicalTerms(value: string): string {
  return value
    .replace(/\bmanifest(?:_id)?\b/gi, "数据版本")
    .replace(/\bartifact\b/gi, "课程数据")
    .replace(/\bassignment\b/gi, "作业")
    .replace(/\battempt(?:_id)?\b/gi, "实验轮次")
    .replace(/\breport_key\b/gi, "报告编号")
    .replace(/\bsession rev(?:ision)?\b/gi, "学习记录版本")
    .replace(/\bschema\b/gi, "字段结构")
    .replace(/\btreated\b/gi, "处理组标记")
    .replace(/\bmock\b/gi, "拟真教学数据");
}

/** Turn browser transport errors into actionable Chinese copy while preserving useful server detail. */
export function userFacingRequestError(cause: unknown, context: string): string {
  const raw = studentFacingTechnicalTerms(rawErrorMessage(cause));
  const detail = NETWORK_FAILURE.test(raw)
    ? "网络连接中断，请检查连接后重试。"
    : raw || "发生未知错误，请重试。";
  return `${context}：${detail}`;
}
