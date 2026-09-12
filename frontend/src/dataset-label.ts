import type { Meta } from "./types";

/** Read the release vintage from immutable dataset provenance, never from the current year. */
export function oecdIcioEdition(meta: Meta | null | undefined): string | null {
  const sources = meta?.dataset?.data_sources;
  const oecd = sources && typeof sources === "object"
    ? (sources as Record<string, unknown>).oecd_icio
    : null;
  if (!oecd || typeof oecd !== "object") return null;
  const release = (oecd as Record<string, unknown>).release;
  return typeof release === "string" && release.trim() ? release.trim() : null;
}

/** Name the active source, including synthetic releases; missing provenance is not OECD evidence. */
export function icioDatasetName(meta: Meta | null | undefined): string {
  const sources = meta?.dataset?.data_sources;
  if (sources && typeof sources === "object" && "ci_synthetic_icio" in sources) {
    return "模拟投入产出数据（教学用）";
  }
  if (sources && typeof sources === "object" && "oecd_icio" in sources) {
    const edition = oecdIcioEdition(meta);
    return `OECD ICIO${edition ? ` ${edition} 版` : ""}`;
  }
  return "投入产出数据（来源待确认）";
}

export function oecdIcioDatasetLabel(meta: Meta | null | undefined): string {
  const years = meta?.years ?? [];
  const coverage = years.length ? `${years[0]}–${years.at(-1)}` : "未预计算";
  return `${icioDatasetName(meta)} · 数据期 ${coverage}`;
}
