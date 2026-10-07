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
  const n = Number(new URLSearchParams(search).get("step"));
  return Number.isInteger(n) && n >= 1 && n <= 15 ? n : null;
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
