import { AUTH_TOKEN_KEY } from "./api";

export const AUTH_EXPIRES_KEY = "gvcsim_token_expires_at";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter extends StorageReader {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

/** A delayed request may clear only the login whose token it actually used. */
export function clearAuthenticationIfCurrent(storage: StorageWriter, expectedToken: string): boolean {
  if (storage.getItem(AUTH_TOKEN_KEY) !== expectedToken) return false;
  clearAuthentication(storage);
  return true;
}

/** Only token changes invalidate a mounted tab; expiry is metadata for the same login. */
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

export function urlWithoutStep(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("step");
  return `${url.pathname}${url.search}${url.hash}`;
}
