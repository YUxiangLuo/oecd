import { CAT, Legend, type Row, cardStyle, num, useTip } from "../shared";

/* --------------------------- 步骤9:生产结构堆叠条 --------------------------- */

const PROD_SEGS = [
  { key: "1_VA_D", name: "纯国内" },
  { key: "2_VA_RT", name: "传统贸易" },
  { key: "3a_VA_GVC_S", name: "简单 GVC" },
  { key: "3b_VA_GVC_C", name: "复杂 GVC" },
];

const shareOf = (r: Row, key: string) => {
  const sva = num(r.SVA);
  return sva > 0 ? num(r[key]) / sva : 0;
};

export function StackedShareViz({ rows }: { rows: Row[] }) {
  const { wrapRef, Tip, show, hide } = useTip();
  const top = [...rows].sort((a, b) => shareOf(b, "3b_VA_GVC_C") - shareOf(a, "3b_VA_GVC_C")).slice(0, 15);
  const tipLines = (r: Row): [string, string][] => [
    ["", String(r.country)],
    ...PROD_SEGS.map((s) => [s.name, `${(shareOf(r, s.key) * 100).toFixed(1)}%`] as [string, string]),
  ];
  return (
    <div ref={wrapRef} style={cardStyle}>
      <div style={{ marginBottom: 16 }}>
        <Legend items={PROD_SEGS.map((s, i) => ({ name: s.name, color: CAT[i] }))} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {top.map((r) => (
          <div key={String(r.country)} style={{ display: "flex", alignItems: "center", gap: 12 }}
            onMouseEnter={(e) => show(e, tipLines(r))}
            onMouseMove={(e) => show(e, tipLines(r))} onMouseLeave={hide}>
            <div style={{ width: 44, fontSize: 12, fontWeight: 500, textAlign: "right" }}>{String(r.country)}</div>
            <div style={{ flex: 1, display: "flex", height: 18, gap: 2 }}>
              {PROD_SEGS.map((s, i) => (
                <div key={s.key} style={{
                  width: `${shareOf(r, s.key) * 100}%`, background: CAT[i],
                  borderRadius: i === PROD_SEGS.length - 1 ? "0 4px 4px 0" : 0,
                }} />
              ))}
            </div>
            <div style={{ width: 86, fontSize: 11.5, color: "#8a90a0", fontVariantNumeric: "tabular-nums" }}>
              复杂 {(shareOf(r, "3b_VA_GVC_C") * 100).toFixed(1)}%
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 11, color: "#a2a8b6" }}>
        按 WWYZ 复杂 GVC 份额(3b_VA_GVC_C / SVA)排序的 Top 15;条内四段加总 = 该国增加值 SVA 的 100%
      </div>
      {Tip}
    </div>
  );
}
