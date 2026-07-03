async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    throw new Error(body?.detail ?? `${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

export const api = {
  steps: () => get<import("./types").StepsResponse>("/api/steps"),
  meta: () => get<import("./types").Meta>("/api/meta"),
  qc: (year: number) => get<import("./types").QcCheck[]>(`/api/qc/${year}`),
  countryIndicators: (year: number) =>
    get<Record<string, string | number | null>[]>(`/api/indicators/country/${year}`),
  sectorIndicators: (year: number, country: string, page: number) =>
    get<import("./types").SectorPage>(
      `/api/indicators/sector/${year}?page=${page}${country ? `&country=${country}` : ""}`,
    ),
  runRegression: async (step: number) => {
    const resp = await fetch("/api/regression/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step }),
    });
    if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText);
    return resp.json() as Promise<import("./types").RegressionResponse>;
  },
  report: (year: number) => get<{ path: string; markdown: string }>(`/api/report/${year}`),
};
