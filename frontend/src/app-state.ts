import { AUTH_TOKEN_KEY } from "./api";

export const AUTH_EXPIRES_KEY = "gvcsim_token_expires_at";

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
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

export function readAuthExpiry(storage: StorageReader): number | null {
  const value = Number(storage.getItem(AUTH_EXPIRES_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function storeAuthentication(
  storage: StorageWriter,
  token: string,
  expiresAt: number,
): void {
  storage.setItem(AUTH_TOKEN_KEY, token);
  storage.setItem(AUTH_EXPIRES_KEY, String(expiresAt));
}

export function clearAuthentication(storage: StorageWriter): void {
  storage.removeItem(AUTH_TOKEN_KEY);
  storage.removeItem(AUTH_EXPIRES_KEY);
}

export function clearAuthenticationIfCurrent(storage: StorageWriter, expectedToken: string): boolean {
  if (storage.getItem(AUTH_TOKEN_KEY) !== expectedToken) return false;
  clearAuthentication(storage);
  return true;
}

export function isExternalAuthenticationChange(
  key: string | null,
  newToken: string | null,
  activeToken: string | null,
): boolean {
  return key === AUTH_TOKEN_KEY && newToken !== activeToken;
}

export function urlWithStep(href: string, step: number): string {
  const url = new URL(href);
  url.searchParams.set("step", String(step));
  return `${url.pathname}${url.search}${url.hash}`;
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

export function introSeenStorageKey(username: string): string {
  return `gvcsim_intro_seen:${username}`;
}

export function shouldAutoShowIntro(storage: StorageReader, username: string): boolean {
  return storage.getItem(introSeenStorageKey(username)) !== "1";
}

export function markIntroSeen(storage: Pick<StorageWriter, "setItem">, username: string): void {
  storage.setItem(introSeenStorageKey(username), "1");
}
