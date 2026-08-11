import type { SetStateAction } from "react";
import type { RegressionHistory } from "./regression";

export interface ScopedRegressionHistory {
  accountId: string | null;
  history: RegressionHistory;
}

export const EMPTY_SCOPED_REGRESSION_HISTORY: ScopedRegressionHistory = {
  accountId: null,
  history: {},
};

/** Never expose a snapshot unless it belongs to the account in the current render. */
export function historyForAccount(state: ScopedRegressionHistory, accountId: string | null): RegressionHistory {
  return accountId !== null && state.accountId === accountId ? state.history : {};
}

export function updateHistoryForAccount(
  state: ScopedRegressionHistory,
  accountId: string,
  update: SetStateAction<RegressionHistory>,
): ScopedRegressionHistory {
  const current = state.accountId === accountId ? state.history : {};
  return {
    accountId,
    history: typeof update === "function" ? update(current) : update,
  };
}
