import { describe, expect, jest, test } from "bun:test";

import { api, getActiveAuthToken, setActiveAuthToken, shouldExpireAuth, withQuery } from "./api";
import { emptySession } from "./session-store";
import type { AuthUser } from "./types";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (key: string) => this.map.get(key) ?? null;
  setItem = (key: string, value: string) => void this.map.set(key, String(value));
  removeItem = (key: string) => void this.map.delete(key);
  clear = () => this.map.clear();
}

if (typeof globalThis.localStorage === "undefined") {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
}

function authUser(username: string): AuthUser {
  return { username, name: username, role: "student" };
}

describe("auth expiration", () => {
  test("a delayed 401 can only expire the token used by that request", () => {
    expect(shouldExpireAuth("old-token", "old-token")).toBe(true);
    expect(shouldExpireAuth("old-token", "new-token")).toBe(false);
    expect(shouldExpireAuth(null, "new-token")).toBe(false);
  });

  test("logout is local-only and has no API method", () => {
    expect("logout" in api).toBe(false);
  });

  test("mounted tabs keep their validated token when shared storage changes", () => {
    const originalToken = localStorage.getItem("gvcsim_token");
    try {
      setActiveAuthToken("token-a");
      localStorage.setItem("gvcsim_token", "token-b");
      expect(getActiveAuthToken()).toBe("token-a");
    } finally {
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
    }
  });

  test("a mounted tab sends mutations with its own token, not another tab's stored token", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = localStorage.getItem("gvcsim_token");
    let authorization: string | null = null;
    try {
      setActiveAuthToken("token-a");
      localStorage.setItem("gvcsim_token", "token-b");
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      await api.classroom.saveSession({ session: emptySession() });
      expect(String(authorization)).toBe("Bearer token-a");
    } finally {
      setActiveAuthToken(originalToken);
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET requests", () => {
  test("times out a stalled GET and allows a later retry", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    jest.useFakeTimers();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(new Response(JSON.stringify(authUser("after-timeout")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    try {
      const stalled = api.me("timeout-token");
      jest.advanceTimersByTime(10_000);
      await expect(stalled).rejects.toThrow("请求超时（10 秒）");
      expect(await api.me("timeout-token")).toEqual(authUser("after-timeout"));
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("withQuery", () => {
  test("encodes every user-controlled query value", () => {
    const url = withQuery("/api/items", {
      country: "A&B",
      sector: "C+26",
      enabled: false,
      page: 2,
      empty: "",
      missing: undefined,
    });
    expect(url).toBe("/api/items?country=A%26B&sector=C%2B26&enabled=false&page=2");
  });

  test("does not append an empty question mark", () => {
    expect(withQuery("/api/items", { country: null })).toBe("/api/items");
  });
});
