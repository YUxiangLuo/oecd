import { type Row, SEQ, cardStyle, num } from "../shared";

/* ----------------------------- 步骤11:热力表 ----------------------------- */

const HEAT_COLS = [
  { key: "degree", name: "度" },
  { key: "indegree", name: "入度" },
  { key: "outdegree", name: "出度" },
  { key: "betweenesscentrality", name: "介数中心性" },
];

export function HeatTableViz({ rows }: { rows: Row[] }) {
  const top = [...rows].sort((a, b) => num(b.betweenesscentrality) - num(a.betweenesscentrality)).slice(0, 15);
  const maxOf: Record<string, number> = {};
  HEAT_COLS.forEach((c) => { maxOf[c.key] = Math.max(...top.map((r) => num(r[c.key])), 1e-9); });
  const cell = (r: Row, key: string) => {
    const v = num(r[key]);
    const idx = Math.min(SEQ.length - 1, Math.floor((v / maxOf[key]) * SEQ.length));
    return (
      <div title={`${String(r.country)} · ${v.toFixed(4)}`} style={{
        width: 116, padding: "5px 0", borderRadius: 7, textAlign: "center",
        background: SEQ[idx], color: idx >= 3 ? "#fff" : "#1b1f2b",
        fontSize: 12, fontVariantNumeric: "tabular-nums",
      }}>{v.toFixed(3)}</div>
    );
  };
  return (
    <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", padding: "11px 18px", background: "#fafbfd", borderBottom: "1px solid #eef0f5", fontSize: 11.5, color: "#8a90a0", fontWeight: 600 }}>
        <div style={{ flex: 1 }}>国家 / 地区(按介数排序 Top 15)</div>
        {HEAT_COLS.map((c) => <div key={c.key} style={{ width: 128, textAlign: "center" }}>{c.name}</div>)}
      </div>
      {top.map((r) => (
        <div key={String(r.country)} style={{ display: "flex", alignItems: "center", padding: "6px 18px", borderBottom: "1px solid #f4f5f8", fontSize: 12.5 }}>
          <div style={{ flex: 1, fontWeight: 500 }}>{String(r.country)}</div>
          {HEAT_COLS.map((c) => (
            <div key={c.key} style={{ width: 128, display: "flex", justifyContent: "center" }}>{cell(r, c.key)}</div>
          ))}
        </div>
      ))}
      <div style={{ padding: "10px 18px", fontSize: 11, color: "#a2a8b6" }}>
        颜色深浅 = 该列内相对大小(每列独立归一化);数值为原始中心性
      </div>
    </div>
  );
}
