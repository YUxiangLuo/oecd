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

export function stepFromSearch(search: string): number | null {
  // Only a plain step number: Number() would also accept "1e1", "0x5" or " 7 ".
  const raw = new URLSearchParams(search).get("step");
  return raw != null && /^(?:[1-9]|1[0-5])$/.test(raw) ? Number(raw) : null;
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
