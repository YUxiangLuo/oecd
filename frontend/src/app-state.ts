import { AUTH_TOKEN_KEY } from "./api";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter extends StorageReader {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StepHistoryWriter {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type StepHistoryMode = "push" | "replace";

/** The course's last step (the report): a ?step= beyond it opens this one. */
export const LAST_STEP = 15;

/**
 * The step a ?step= link asks for: 1–15 as written, a larger whole number the last step (15). Anything else
 * (0, "abc", "1e1", "0x5", " 7 ", "07") is no step: the caller opens the student's first unfinished step.
 */
export function stepFromSearch(search: string): number | null {
  // Only a plain step number: Number() would also accept "1e1", "0x5" or " 7 ".
  const raw = new URLSearchParams(search).get("step");
  if (raw == null || !/^[1-9]\d*$/.test(raw)) return null;
  return raw.length > 2 || Number(raw) > LAST_STEP ? LAST_STEP : Number(raw);
}

/**
 * The one-time notice (role="status") for a ?step= link that names no course step, once `opened` is the step shown
 * instead (the URL is then rewritten to it). Null for a valid step, an empty one, or no ?step= at all.
 */
export function stepLinkNotice(search: string, opened: number): string | null {
  const raw = new URLSearchParams(search).get("step");
  if (raw == null || raw === "" || /^(?:[1-9]|1[0-5])$/.test(raw)) return null;
  if (/^[1-9]\d*$/.test(raw)) return `链接里的步骤 ${raw.length > 6 ? `${raw.slice(0, 6)}…` : raw} 不存在（课程共 ${LAST_STEP} 步），已打开步骤 ${opened}。`;
  const shown = raw.length > 12 ? `${raw.slice(0, 12)}…` : raw;
  return `链接里的步骤“${shown}”不是有效的步骤号，已按你的进度打开步骤 ${opened}。`;
}

export function storeAuthentication(storage: StorageWriter, token: string): void {
  storage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthentication(storage: StorageWriter): void {
  storage.removeItem(AUTH_TOKEN_KEY);
}

export function clearAuthenticationIfCurrent(storage: StorageWriter, expectedToken: string): boolean {
  if (storage.getItem(AUTH_TOKEN_KEY) !== expectedToken) return false;
  clearAuthentication(storage);
  return true;
}

export function urlWithStep(href: string, step: number): string {
  const url = new URL(href);
  url.searchParams.set("step", String(step));
  return `${url.pathname}${url.search}${url.hash}`;
}

export const LOGGED_OUT_HERE_KEY = "gvcsim_logged_out_here";

/**
 * Whether a login should ignore the step in the URL. A link opened in a fresh tab (`/?step=15`) is a real
 * destination and is kept, as is the step a user returns to after an expired session. It is dropped when
 * this tab logged out before (Back after logout restores the previous user's step) or when a different
 * account signs in than the one the step belonged to.
 */
export function shouldDropStepOnLogin(loggedOutHere: boolean, previousUser: string | null, nextUser: string): boolean {
  return loggedOutHere || (previousUser != null && previousUser !== nextUser);
}

/** Forget the step in the current history entry, so the next login starts from the account's own progress. */
export function dropStepFromHistory(history: StepHistoryWriter, href: string): void {
  const url = new URL(href);
  url.searchParams.delete("step");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Write a real history entry for a user navigation, but never duplicate the current URL. */
export function writeStepHistory(
  history: StepHistoryWriter,
  href: string,
  step: number,
  mode: StepHistoryMode,
): boolean {
  const current = new URL(href);
  const currentRelativeUrl = `${current.pathname}${current.search}${current.hash}`;
  const nextUrl = urlWithStep(href, step);
  if (currentRelativeUrl === nextUrl) return false;
  history[mode === "push" ? "pushState" : "replaceState"](null, "", nextUrl);
  return true;
}

/**
 * 系统介绍在**每次学生登录**后都自动显示，不按账号记忆“已读”。
 * 登录页据此写入 sessionStorage 标记，加载后的 App 读取并弹出一次；
 * 同一会话内的刷新不会重复弹出。
 */
export function shouldAutoShowIntro(role: string): boolean {
  return role === "student";
}
