import { describe, expect, test } from "bun:test";
import {
  EMPTY_SCOPED_REGRESSION_HISTORY,
  historyForAccount,
  updateHistoryForAccount,
} from "./account-regression-history";

describe("account-scoped regression history", () => {
  test("never exposes one student's snapshots to another account", () => {
    const studentA = updateHistoryForAccount(EMPTY_SCOPED_REGRESSION_HISTORY, "1", {
      trade: [{ id: 1, settings: {} as never, response: {} as never }],
    });
    expect(historyForAccount(studentA, "1").trade).toHaveLength(1);
    expect(historyForAccount(studentA, "2")).toEqual({});
    expect(historyForAccount(studentA, null)).toEqual({});
  });

  test("a new account updater starts from an empty history", () => {
    const studentA = updateHistoryForAccount(EMPTY_SCOPED_REGRESSION_HISTORY, "1", { trade: [] });
    const studentB = updateHistoryForAccount(studentA, "2", (current) => ({ ...current, network: [] }));
    expect(studentB).toEqual({ accountId: "2", history: { network: [] } });
  });
});
