import { formatMetric } from "../../format";
import type { IndicatorSchema } from "../../types";
import { type Row, SEQ, cardStyle, num, rowLabel } from "../shared";

/* ----------------------------- 步骤11:热力表 ----------------------------- */

const HEAT_COLS = [
  { key: "weighted degree", name: "加权度", fmt: "amount", desc: "与该节点直接相连的中间投入边流量总和(百万美元)。" },
  { key: "betweenesscentrality", name: "介数中心性", fmt: "raw", desc: "经过该节点的有向最短路径原始计数，不归一化。" },
  { key: "closnesscentrality", name: "接近中心性", fmt: "num", desc: "沿出边可达节点数除以到这些节点的最短距离之和。" },
  { key: "harmonicclosnesscentrality", name: "调和中心性", fmt: "num", desc: "沿出边到可达节点的距离倒数平均值。" },
  { key: "eigencentrality", name: "特征向量中心性", fmt: "num", desc: "按入边邻居的重要性迭代并以最大值归一。" },
];

const fmtVal = (v: number, fmt: string) => formatMetric(v, fmt === "amount" ? "amount" : "number");

export function HeatTableViz({ rows, schema }: { rows: Row[]; schema?: IndicatorSchema | null }) {
  const isIndustry = rows.some((row) => row.industry != null);
  const top = [...rows].sort((a, b) => num(b["betweenesscentrality"]) - num(a["betweenesscentrality"])).slice(0, 15);
  const maxOf: Record<string, number> = {};
  HEAT_COLS.forEach((c) => { maxOf[c.key] = Math.max(...top.map((r) => num(r[c.key])), 1e-9); });
  const cell = (r: Row, key: string, fmt: string) => {
    const v = num(r[key]);
    const idx = Math.min(SEQ.length - 1, Math.floor((v / maxOf[key]) * SEQ.length));
    return (
      <div title={`${rowLabel(r)} · ${schema?.fields[key]?.label ?? key}: ${fmtVal(v, fmt)}`} style={{
        width: 104, padding: "5px 0", borderRadius: 7, textAlign: "center",
        background: SEQ[idx], color: idx >= 3 ? "#fff" : "#1b1f2b",
        fontSize: 12, fontVariantNumeric: "tabular-nums",
      }}>{fmtVal(v, fmt)}</div>
    );
  };
  return (
    <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "11px 18px", background: "#fafbfd", borderBottom: "1px solid #eef0f5", fontSize: 11.5, color: "#8a90a0", fontWeight: 600 }}>
        <div style={{ flex: 1 }}>{isIndustry ? "行业节点" : "国家 / 地区"}(按介数排序 Top 15)</div>
        {HEAT_COLS.map((c) => <div key={c.key} title={schema?.fields[c.key]?.desc ?? c.desc} style={{ width: 118, textAlign: "center" }}>{c.name} ⓘ</div>)}
      </div>
      {top.map((r) => (
        <div key={`${String(r.country)}-${String(r.industry ?? "")}`} style={{ display: "flex", alignItems: "center", padding: "6px 18px", borderBottom: "1px solid #f4f5f8", fontSize: 12.5 }}>
          <div title={r.industry != null ? String(r.industry) : undefined} style={{ flex: 1, fontWeight: 500 }}>{rowLabel(r)}</div>
          {HEAT_COLS.map((c) => (
            <div key={c.key} style={{ width: 118, display: "flex", justifyContent: "center" }}>{cell(r, c.key, c.fmt)}</div>
          ))}
        </div>
      ))}
      <div style={{ padding: "10px 18px", fontSize: 11, color: "#a2a8b6" }}>
        颜色深浅 = 该列内相对大小(每列独立归一化)；Gephi 有向全正边口径：加权度为流量金额，介数为原始路径计数。行业值在完整全球图上计算。
      </div>
    </div>
  );
}
