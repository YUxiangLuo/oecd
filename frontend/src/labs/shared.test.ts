import { describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { asyncRequestIdentity, currentAsyncSnapshot, useAsync } from "./shared";

const success = <T>(requestIdentity: string | null, settledIdentity: string | null, data: T | null) => (
  currentAsyncSnapshot({
    enabled: true,
    requestIdentity,
    settledIdentity,
    data,
    error: null,
    status: "success",
  })
);

describe("request-bound async snapshots", () => {
  test("switching the query and leaving the step aborts obsolete requests", async () => {
    const requests: Array<{ signal: AbortSignal; resolve: (value: number) => void }> = [];
    const query = (signal: AbortSignal) => new Promise<number>((resolve) => requests.push({ signal, resolve }));
    const view = renderHook(({ year }) => useAsync(query, [year], { requestKey: String(year) }), { initialProps: { year: 2019 } });
    try {
      await waitFor(() => expect(requests.length).toBe(1));
      view.rerender({ year: 2020 });
      await waitFor(() => expect(requests.length).toBe(2));
      expect(requests[0].signal.aborted).toBe(true);
      expect(requests[1].signal.aborted).toBe(false);
      await act(async () => requests[0].resolve(2019));
      expect(view.result.current.data).toBeNull();
      await act(async () => requests[1].resolve(2020));
      expect(view.result.current.data).toBe(2020);
    } finally {
      view.unmount();
    }
    expect(requests[1].signal.aborted).toBe(true);
  });

  test("does not expose a delayed old-year result under a new request key", () => {
    const oldYear = asyncRequestIdentity("release:2019:country", 0);
    const newYear = asyncRequestIdentity("release:2020:country", 0);
    expect(success(newYear, oldYear, [{ country: "CHN", value: 2019 }])).toEqual({
      data: null,
      error: null,
      status: "loading",
    });
  });

  test("accepts only the current result when responses resolve out of order", () => {
    const current = asyncRequestIdentity("release:2020:country", 0);
    expect(success(current, current, [{ country: "CHN", value: 2020 }]).data).toEqual([
      { country: "CHN", value: 2020 },
    ]);
    expect(success(current, asyncRequestIdentity("release:2019:country", 0), [{ value: 2019 }]).data).toBeNull();
  });

  test("a retry generation synchronously makes the prior generation ineligible", () => {
    const prior = asyncRequestIdentity("release:2020:country", 0);
    const retry = asyncRequestIdentity("release:2020:country", 1);
    expect(success(retry, prior, [{ value: "prior" }])).toEqual({
      data: null,
      error: null,
      status: "loading",
    });
  });

  test("a failed current request exposes only its own error and no prior data", () => {
    const current = asyncRequestIdentity("release:2020:country", 0);
    expect(currentAsyncSnapshot({
      enabled: true,
      requestIdentity: current,
      settledIdentity: current,
      data: null,
      error: "2020 failed",
      status: "error",
    })).toEqual({ data: null, error: "2020 failed", status: "error" });
  });

  test("disabled keyed requests are idle and cannot expose settled data", () => {
    const current = asyncRequestIdentity("release:2020:country", 0);
    expect(currentAsyncSnapshot({
      enabled: false,
      requestIdentity: current,
      settledIdentity: current,
      data: [{ value: 2020 }],
      error: null,
      status: "success",
    })).toEqual({ data: null, error: null, status: "idle" });
  });
});
