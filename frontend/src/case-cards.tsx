/**
 * 案例展示组件(渲染;内容见 cases.ts)。
 *  - CaseStrip:指标解读型范例条。现拉 api.countryIndicators 显示真实数值,点开由宿主
 *    步骤把演示/图表跳到该经济体(onPick)。经济体不在当前数据集时该卡自动隐藏。
 *  - PolicyCaseCard:政策情景型贯穿卡,只展示叙述/假设 + 拟真数据的诚实标注。
 */
import { api } from "./api";
import { INDICATOR_CASES, POLICY_CASE, type IndicatorCase } from "./cases";
import { fmtField, useAsync } from "./labs/shared";
import { SectionHead } from "./teach";
import type { IndicatorSchema, Meta } from "./types";
import { countryLabel } from "./viz";

type Row = Record<string, string | number | null>;

export function CaseStrip({ step, meta, onPick, rows: rowsProp, schema: schemaProp, year: yearProp }: {
  step: number;
  meta: Meta;
  onPick: (c: IndicatorCase) => void;
  /** 宿主已加载的国家级指标行 / schema / 年份;传入则复用,避免重复请求。 */
  rows?: Row[];
  schema?: IndicatorSchema | null;
  year?: number;
}) {
  // 只保留当前数据集里真实存在的经济体,避免展示“死案例”。
  const cases = (INDICATOR_CASES[step] ?? []).filter((c) => meta.countries.includes(c.economy));
  const year = yearProp ?? meta.years.at(-1);
  // 仅当宿主未提供且确实有案例要显示时才自行拉取,避免重复请求与空条也发请求。
  const needRows = rowsProp === undefined;
  const { data: fetchedRows } = useAsync<Row[]>(
    () => (needRows && cases.length > 0 && year != null ? api.countryIndicators(year) : Promise.resolve([])),
    [needRows, year, cases.length],
  );
  const needSchema = schemaProp === undefined;
  const { data: fetchedSchema } = useAsync<IndicatorSchema | null>(
    () => (needSchema && cases.length > 0 ? api.indicatorSchema() : Promise.resolve(null)),
    [needSchema, cases.length],
  );
  if (!cases.length) return null;
  const rows = rowsProp ?? fetchedRows ?? [];
  const schema = schemaProp ?? fetchedSchema ?? null;
  const byCountry = new Map(rows.map((r) => [String(r.country), r]));

  return (
    <div className="case-strip">
      <SectionHead icon="📎" label="真实案例 · 点开跳到该经济体" />
      <div className="case-cards">
        {cases.map((c) => {
          const value = byCountry.get(c.economy)?.[c.metric] ?? null;
          return (
            <button
              key={`${c.economy}-${c.metric}`}
              type="button"
              className="case-card"
              onClick={() => onPick(c)}
              title={`跳到 ${countryLabel(c.economy)}`}
            >
              <div className="case-claim">{c.claim}</div>
              <div className="case-metric">
                {schema?.fields[c.metric]?.label ?? c.metric}:<b>{fmtField(value, c.metric, schema)}</b>
              </div>
              <div className="case-why muted">{c.why}</div>
              <div className="case-cta">查看 {countryLabel(c.economy)} →</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PolicyCaseCard({ step }: { step: number }) {
  const framing = POLICY_CASE.framing[step];
  if (!framing) return null;
  return (
    <div className="teach-card case-policy">
      <div className="teach-kicker">📌 贯穿案例 · {POLICY_CASE.title}</div>
      {step === 2 && <p>{POLICY_CASE.background}</p>}
      <p>{framing}</p>
      <div className="teach-note">{POLICY_CASE.honesty}</div>
    </div>
  );
}
