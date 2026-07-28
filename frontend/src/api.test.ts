import { describe, expect, jest, test } from "bun:test";

import { api, shouldExpireAuth, withQuery } from "./api";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("auth expiration", () => {
  test("a delayed 401 can only expire the token used by that request", () => {
    expect(shouldExpireAuth("old-token", "old-token")).toBe(true);
    expect(shouldExpireAuth("old-token", "new-token")).toBe(false);
    expect(shouldExpireAuth(null, "new-token")).toBe(false);
  });

  test("logout revokes the exact server token", async () => {
    const originalFetch = globalThis.fetch;
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.logout("signed-token");
      expect(seen[0]?.url).toBe("/api/auth/logout");
      expect(seen[0]?.init?.method).toBe("POST");
      expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer signed-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET request coalescing", () => {
  test("shares one parsed request for concurrent calls with the same token and URL", async () => {
    const originalFetch = globalThis.fetch;
    const response = deferred<Response>();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return response.promise;
    }) as unknown as typeof fetch;
    try {
      const first = api.me("same-token");
      const second = api.me("same-token");
      expect(calls).toBe(1);
      response.resolve(new Response(JSON.stringify(authUser("student")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      expect(await first).toEqual(authUser("student"));
      expect(await second).toEqual(authUser("student"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not merge requests across bearer tokens", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await Promise.all([api.me("token-a"), api.me("token-b")]);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("starts a fresh GET after a mutation and keeps coalescing the newer request", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = localStorage.getItem("gvcsim_token");
    const staleResponse = deferred<Response>();
    const freshResponse = deferred<Response>();
    let announcementCalls = 0;
    localStorage.setItem("gvcsim_token", "mutation-token");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/classroom/announcements") {
        announcementCalls += 1;
        return announcementCalls === 1 ? staleResponse.promise : freshResponse.promise;
      }
      if (url === "/api/classroom/progress") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const stale = api.classroom.announcements();
      await api.classroom.reportProgress(1);

      const fresh = api.classroom.announcements();
      expect(announcementCalls).toBe(2);

      staleResponse.resolve(new Response(JSON.stringify({ announcements: [{ id: 1 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      expect((await stale).announcements.map((item) => item.id)).toEqual([1]);

      const coalescedFresh = api.classroom.announcements();
      expect(announcementCalls).toBe(2);
      freshResponse.resolve(new Response(JSON.stringify({ announcements: [{ id: 2 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      expect((await fresh).announcements.map((item) => item.id)).toEqual([2]);
      expect((await coalescedFresh).announcements.map((item) => item.id)).toEqual([2]);
    } finally {
      if (originalToken == null) localStorage.removeItem("gvcsim_token");
      else localStorage.setItem("gvcsim_token", originalToken);
      globalThis.fetch = originalFetch;
    }
  });

  test("evicts a failed request so an explicit retry reaches the server", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ detail: "temporary" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify(authUser("recovered")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as unknown as typeof fetch;
    try {
      await expect(api.me("retry-token")).rejects.toThrow("temporary");
      expect(await api.me("retry-token")).toEqual(authUser("recovered"));
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
