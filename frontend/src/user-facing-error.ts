const NETWORK_FAILURE =
  /^(failed to fetch|load failed|networkerror(?: when attempting to fetch resource\.?)?|network request failed)$/i;

function rawErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message.trim();
  return String(cause ?? "").trim();
}

/** The browser could not reach the server at all (fetch's own failure, worded per browser). */
export function isNetworkFailure(cause: unknown): boolean {
  return NETWORK_FAILURE.test(rawErrorMessage(cause));
}

/** Turn browser transport errors into actionable Chinese copy while preserving server detail. */
export function userFacingRequestError(cause: unknown, context: string): string {
  const raw = rawErrorMessage(cause);
  const detail = NETWORK_FAILURE.test(raw)
    ? "网络连接中断，请检查连接后重试。"
    : raw || "操作未完成，请刷新页面后重试。";
  return `${context}：${detail}`;
}
