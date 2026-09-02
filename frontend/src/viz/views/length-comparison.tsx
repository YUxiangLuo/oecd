import { formatMetric } from "../../format";
import { ChartDataDisclosure } from "../explore/charts";
import { CAT, Legend, type Row, cardStyle, countryLabel, num, topWithSelected, useTip } from "../shared";

/* ------------------------ 步骤8:前向/后向生产长度对比 ------------------------ */

const LENGTH_FIELDS = ["PLv", "PLv_GVC", "PLy", "PLy_GVC", "GVCPs"] as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function eligibleLengthRows(rows: readonly Row[]): Row[] {
  return rows.filter((row) => LENGTH_FIELDS.every((field) => finite(row[field])));
}

export function LengthViz({ rows, highlight = new Set<string>() }: { rows: Row[]; highlight?: Set<string> }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = topWithSelected(eligibleLengthRows(rows), "PLv", 15, highlight);
  const maxLen = Math.max(...top.map((r) => Math.max(num(r.PLv), num(r.PLy))), 1);
  const ticks = Array.from({ length: Math.floor(maxLen) + 1 }, (_, i) => i);
  const tipLines = (r: Row): [string, string][] => [
    ["", countryLabel(String(r.country))],
    ["前向总长度 PLv", formatMetric(num(r.PLv), "number")],
    ["前向 GVC 段 PLv_GVC", formatMetric(num(r.PLv_GVC), "number")],
    ["后向总长度 PLy", formatMetric(num(r.PLy), "number")],
    ["后向 GVC 段 PLy_GVC", formatMetric(num(r.PLy_GVC), "number")],
    ["位置指数 GVCPs", formatMetric(num(r.GVCPs), "number")],
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={[{ name: "前向长度 PLv(到最终吸收端)", color: CAT[0] }, { name: "后向长度 PLy(到初始投入端)", color: CAT[1] }]} />
      </div>
      {top.length === 0 ? (
        <p className="muted" role="status">生产长度对比当前没有同时具备 PLv、PLv_GVC、PLy、PLy_GVC 与 GVCPs 的有效数据。</p>
      ) : (
        <>
          <div style={{ position: "relative" }}>
            <div style={{ position: "absolute", inset: 0, left: 56, right: 56, pointerEvents: "none" }}>
              {ticks.map((t) => (
                <div key={t} style={{
                  position: "absolute", top: 0, bottom: 0, left: `${(t / maxLen) * 100}%`,
                  borderLeft: "1px solid #f0f1f6",
                }} />
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 11, position: "relative" }}>
              {top.map((r) => {
                const selected = highlight.has(String(r.country));
                return (
                  <div key={String(r.country)} data-selected={selected ? "true" : undefined}
                    style={{ display: "flex", alignItems: "center", gap: 12, fontWeight: selected ? 700 : 500 }}
                    onMouseEnter={(e) => show(e, tipLines(r))}
                    onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
                    <div style={{ width: 44, fontSize: 12, textAlign: "right", color: selected ? CAT[5] : undefined }}>{String(r.country)}</div>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ width: `${(num(r.PLv) / maxLen) * 100}%`, height: 8, background: selected ? CAT[5] : CAT[0], borderRadius: "0 4px 4px 0" }} />
                      <div style={{ width: `${(num(r.PLy) / maxLen) * 100}%`, height: 8, background: selected ? "#8d3f8f" : CAT[1], borderRadius: "0 4px 4px 0" }} />
                    </div>
                    <div style={{ width: 78, fontSize: 12.5, fontWeight: 600, color: selected ? CAT[5] : "#3a4050", fontVariantNumeric: "tabular-nums" }}
                      title="GVC 位置指数 = PLv_GVC / PLy_GVC">
                      GVCPs {formatMetric(num(r.GVCPs), "number")}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ position: "relative", height: 18, marginTop: 6, marginLeft: 56, marginRight: 56 }}>
              {ticks.map((t) => (
                <span key={t} style={{
                  position: "absolute", left: `${(t / maxLen) * 100}%`, transform: "translateX(-50%)",
                  fontSize: 10.5, color: "#b0b5c2", fontVariantNumeric: "tabular-nums",
                }}>{t}</span>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: "#5f6677" }}>
            按前向总生产长度 PLv 排序的 Top 15 + 已选国家；GVCPs = 前向/后向 GVC 段长度之比，&gt;1 表示更靠上游(WWYZ 2017b)
          </div>
        </>
      )}
      <ChartDataDisclosure
        label="生产长度对比"
        columns={[
          { key: "country", label: "经济体" },
          { key: "PLv", label: "前向总长度 PLv" },
          { key: "PLv_GVC", label: "前向 GVC 段 PLv_GVC" },
          { key: "PLy", label: "后向总长度 PLy" },
          { key: "PLy_GVC", label: "后向 GVC 段 PLy_GVC" },
          { key: "GVCPs", label: "位置指数 GVCPs" },
        ]}
        rows={top.map((row) => ({
          country: countryLabel(String(row.country)),
          PLv: formatMetric(num(row.PLv), "number"),
          PLv_GVC: formatMetric(num(row.PLv_GVC), "number"),
          PLy: formatMetric(num(row.PLy), "number"),
          PLy_GVC: formatMetric(num(row.PLy_GVC), "number"),
          GVCPs: formatMetric(num(row.GVCPs), "number"),
        }))}
      />
      {Tip}
    </div>
  );
}
