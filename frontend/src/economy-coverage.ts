export interface EconomyAccountCoverage {
  economies: number;
  rowAccounts: number;
  totalAccounts: number;
}

const FALLBACK_COVERAGE: EconomyAccountCoverage = {
  economies: 76,
  rowAccounts: 1,
  totalAccounts: 77,
};

/**
 * OECD ICIO 的 ROW 是“世界其他地区”聚合账户，不是单个经济体。
 * 登录页尚未取得 meta 时使用当前课程快照的保守回退值。
 */
export function economyAccountCoverage(countries?: readonly string[] | null): EconomyAccountCoverage {
  if (!countries?.length) return { ...FALLBACK_COVERAGE };
  const rowAccounts = countries.filter((code) => code === "ROW").length;
  return {
    economies: countries.length - rowAccounts,
    rowAccounts,
    totalAccounts: countries.length,
  };
}

export function economyAccountCoverageLabel(countries?: readonly string[] | null): string {
  const coverage = economyAccountCoverage(countries);
  if (!coverage.rowAccounts) return `${coverage.economies} 个经济体`;
  return `${coverage.economies} 个经济体和 ${coverage.rowAccounts} 个“世界其他地区”（ROW）聚合账户`;
}
