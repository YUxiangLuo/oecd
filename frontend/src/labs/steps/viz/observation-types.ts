/** Row and reading shapes shared by the step 6–9 views and their pure models (no component imports, so
 * indicator-model.ts and scaffold.tsx do not import each other). */
export type Row = Record<string, string | number | null>;

export type ObservationScope = "country" | "country-industry";

export interface VizObservation {
  entity: string;
  country: string;
  industry?: string;
  year: number;
  value: number;
  /** Indicator and request provenance for explicitly saved readings. */
  metric?: string;
  unit?: string;
  release?: string;
  scope?: ObservationScope;
  generation?: number;
  request_key?: string;
  source?: "explicit-network-trend" | "explicit-network-ranking" | "explicit-indicator-trend" | "explicit-indicator-comparison" | "explicit-indicator-composition";
}
