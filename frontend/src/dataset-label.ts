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

export function oecdIcioDatasetLabel(meta: Meta | null | undefined): string {
  const edition = oecdIcioEdition(meta);
  const years = meta?.years ?? [];
  const coverage = years.length ? `${years[0]}–${years.at(-1)}` : "未预计算";
  return `OECD ICIO${edition ? ` ${edition} 版` : ""} · 数据期 ${coverage}`;
}
