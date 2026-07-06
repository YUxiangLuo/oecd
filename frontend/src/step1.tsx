/**
 * 步骤1「数据库介绍与选型」——页内多阶段向导的第一个样板。
 * 5 个阶段:① 为什么需要 IO 表(示意小矩阵)② 数据库选型对比 ③ 认识 ICIO 表结构
 * ④ 亲手切片(真实原表浏览器)⑤ 自检小测。用可复用的 StepStages 容器串起。
 */
import { useState } from "react";
import { api } from "./api";
import type { DbMeta } from "./types";
import { DbBrowser, useAsync } from "./labs";
import { StepStages, type Stage } from "./stages";
import { SectionHead, TeachCards, type TeachBlock } from "./teach";

/* ------------------- 阶段① 为什么需要投入产出表:示意小矩阵 ------------------- */
const IO_SECTORS = ["农业", "钢铁", "汽车", "服务"];
// 行=卖方,列=买方;单元格=卖方卖给买方的中间投入(教学虚构值)
const IO_FLOWS = [
  [10, 2, 5, 8],
  [1, 15, 30, 4],
  [0, 3, 12, 10],
  [6, 9, 14, 40],
];

function MiniIoStage() {
  const [sel, setSel] = useState<[number, number] | null>(null);
  const rowTotal = (i: number) => IO_FLOWS[i].reduce((a, b) => a + b, 0);
  const colTotal = (j: number) => IO_FLOWS.reduce((a, r) => a + r[j], 0);
  const teach: TeachBlock[] = [
    {
      kind: "concept", kicker: "为什么需要它", title: "投入产出表:一张「谁买了谁」的账本",
      paras: [
        "GDP 和进出口统计只告诉你「总量」,却说不清「结构」——一件出口的汽车里,用了多少钢铁、钢铁又用了多少电力。投入产出表把这些部门间的相互买卖,摊成一张矩阵。",
        "矩阵的行是卖方部门、列是买方部门,每个格子就是「列部门从行部门购买的中间投入」。点下面的格子亲手看看。",
      ],
    },
  ];
  return (
    <div className="demo-card">
      <TeachCards blocks={teach} />
      <div className="mini-io-wrap">
        <table className="mini-io">
          <thead>
            <tr>
              <th className="mini-io-corner">卖方 ＼ 买方</th>
              {IO_SECTORS.map((s, j) => <th key={s} className={sel && sel[1] === j ? "col-on" : ""}>{s}</th>)}
              <th className="mini-io-tot">行合计·总产出</th>
            </tr>
          </thead>
          <tbody>
            {IO_SECTORS.map((s, i) => (
              <tr key={s} className={sel && sel[0] === i ? "row-on" : ""}>
                <th className={sel && sel[0] === i ? "row-on" : ""}>{s}</th>
                {IO_SECTORS.map((_, j) => (
                  <td
                    key={j}
                    className={[
                      sel && sel[0] === i && sel[1] === j ? "cell-on" : "",
                      sel && sel[1] === j ? "col-on" : "",
                      i === j ? "diag" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setSel([i, j])}
                  >
                    {IO_FLOWS[i][j]}
                  </td>
                ))}
                <td className="mini-io-tot">{rowTotal(i)}</td>
              </tr>
            ))}
            <tr>
              <th className="mini-io-tot">列合计·总投入</th>
              {IO_SECTORS.map((_, j) => <td key={j} className="mini-io-tot">{colTotal(j)}</td>)}
              <td className="mini-io-tot" />
            </tr>
          </tbody>
        </table>
        <div className="mini-io-readout">
          {sel
            ? sel[0] === sel[1]
              ? <p><b>{IO_SECTORS[sel[0]]}</b> 的对角格 = 该部门自己买自己的中间投入(内部循环),共 <b>{IO_FLOWS[sel[0]][sel[1]]}</b> 单位。</p>
              : <p>「<b>{IO_SECTORS[sel[1]]}</b>」从「<b>{IO_SECTORS[sel[0]]}</b>」购买了 <b>{IO_FLOWS[sel[0]][sel[1]]}</b> 单位中间投入 —— 这一格,就是投入产出表里的<b>一个数字</b>。</p>
            : <p className="muted">点任意一格:高亮的行是卖方、列是买方。行合计 = 该部门总产出,列合计 = 该部门总投入。</p>}
          <div className="ndp-disclaim">此为 4×4 示意矩阵,数字为教学虚构。真实 OECD ICIO 是约 76 经济体 × 45 行业的大矩阵(见阶段④亲手切片)。</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- 阶段② 数据库选型:横向对比 ------------------------- */
const DB_NAMES = ["OECD ICIO", "WIOD", "Eora MRIO"];
const DB_DIMS = [
  { key: "cov", label: "覆盖经济体", vals: ["约 76", "43", "约 190"] },
  { key: "sec", label: "行业细度", vals: ["45 行业", "56 行业", "异质 26–500+"] },
  { key: "yr", label: "年份跨度", vals: ["1995–2020", "2000–2014", "1990–2015+"] },
  { key: "freq", label: "更新频率", vals: ["年度更新", "已停更", "不定期"] },
  { key: "use", label: "适用场景", vals: ["覆盖-细度-时效平衡,系统主源", "行业更细但年份偏旧,做稳健性", "覆盖最广,口径/许可成本高"] },
];

function DbCompareStage() {
  const [dim, setDim] = useState(0);
  const [why, setWhy] = useState(false);
  return (
    <div className="demo-card">
      <p className="wizard-lead">三大全球投入产出数据库各有取舍。选一个维度,横向对比它们:</p>
      <div className="pill-group">
        {DB_DIMS.map((d, i) => (
          <button key={d.key} className={dim === i ? "on" : ""} onClick={() => setDim(i)}>{d.label}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data-table dbcmp">
          <thead><tr><th>维度</th>{DB_NAMES.map((n) => <th key={n}>{n}{n === "OECD ICIO" && " ★"}</th>)}</tr></thead>
          <tbody>
            {DB_DIMS.map((d, i) => (
              <tr key={d.key} className={dim === i ? "dbcmp-on" : ""}>
                <td>{d.label}</td>
                {d.vals.map((v, j) => <td key={j} className={j === 0 ? "dbcmp-primary" : ""}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ndp-disclaim">数值为近似,用于教学对比;以各库官方发布口径为准。另有中国国家统计局表可作国内校准补充(不替代全球 MRIO)。</p>
      <button className="reveal-btn" onClick={() => setWhy((w) => !w)}>
        {why ? "▾ " : "▸ "}为什么本系统选 OECD ICIO?
      </button>
      {why && (
        <div className="tipbox">
          三点:①<b>覆盖与细度平衡</b> —— 76 经济体 × 45 行业,够细又不至口径失真;②<b>时效</b> —— 年度更新且覆盖到 2020,能对上 2018–2020 的政策冲击;③<b>账户一致</b> —— 自带 TLS/VA/OUT 账户项,后面所有增加值分解都靠它,口径统一。WIOD 停在 2014、Eora 口径异质且成本高,故作备选。
        </div>
      )}
    </div>
  );
}

/* ---------------------- 阶段③ 认识 ICIO 表结构:示意图 + 真实 meta ---------------------- */
function IcioSchematicStage({ meta }: { meta: DbMeta | null }) {
  const [band, setBand] = useState<"z" | "y" | "acc">("z");
  if (!meta) return <p className="muted">读取 ICIO 表结构…</p>;
  if (!meta.years.length) {
    return (
      <div className="warnbox">
        未找到本地 OECD ICIO 原始 CSV。请将 ICIO2023_YYYY.csv 放入 OECD_ICIO/ 后刷新本页,即可看到真实的表结构。
      </div>
    );
  }
  const info = {
    z: { title: "Z · 中间投入矩阵", text: `左侧主块:行与列都是「国家-行业」(${meta.countries.length} 国 × ${meta.sectors.length} 行业)。格子 = 某国某行业 卖给 另一国某行业 的中间投入,是最大的一块。` },
    y: { title: "Y · 最终需求", text: `右侧若干列:每个目的国的最终需求类别(${meta.final_demand_categories.join(" / ")})。格子 = 某国某行业的产品被最终消费/投资吸收的量。` },
    acc: { title: "账户项 · TLS / VA / OUT", text: `底部几行:${meta.account_rows.join(" / ")}(税净额 / 增加值 / 总产出)。它们让每列「中间投入 + 增加值 = 总产出」闭合 —— 后面所有增加值分解的地基。` },
  } as const;
  const cur = info[band];
  const rc = (b: typeof band) => `sch${band === b ? " sch-on" : ""}`;
  return (
    <div className="demo-card">
      <p className="wizard-lead">这就是本系统真正读的表。它由三块拼成 —— 点一块看它是什么:</p>
      <div className="db-summary">
        <span>整张原表 {meta.n_rows.toLocaleString("zh-CN")} 行 × {meta.n_columns.toLocaleString("zh-CN")} 列</span>
        <span>{meta.countries.length} 经济体</span>
        <span>{meta.sectors.length} 行业</span>
        <span>{meta.years[0]}–{meta.years.at(-1)}</span>
      </div>
      <svg viewBox="0 0 640 360" className="schematic" role="img">
        <rect x={40} y={30} width={400} height={250} className={rc("z")} onClick={() => setBand("z")} />
        <text x={240} y={150} className="sch-t">Z · 中间投入</text>
        <text x={240} y={172} className="sch-sub">国家-行业 × 国家-行业</text>
        <rect x={448} y={30} width={152} height={250} className={rc("y")} onClick={() => setBand("y")} />
        <text x={524} y={150} className="sch-t">Y · 最终需求</text>
        <text x={524} y={172} className="sch-sub">× 需求类别</text>
        <rect x={40} y={288} width={560} height={48} className={rc("acc")} onClick={() => setBand("acc")} />
        <text x={320} y={317} className="sch-t">账户 · TLS / VA / OUT</text>
      </svg>
      <div className="tipbox"><b>{cur.title}</b> · {cur.text}</div>
    </div>
  );
}

/* -------------------------------- 阶段⑤ 自检小测 -------------------------------- */
function SelfCheckStage({ meta }: { meta: DbMeta | null }) {
  // 无本地 CSV 时 meta 存在但 n_rows/n_columns=0,退回 ICIO 的典型规模,避免答成 0×0
  const size = meta?.years.length
    ? `约 ${meta.n_rows.toLocaleString("zh-CN")} 行 × ${meta.n_columns.toLocaleString("zh-CN")} 列`
    : "约 3,468 行 × 3,929 列(以本地实际数据为准)";
  const blocks: TeachBlock[] = [
    {
      kind: "selfcheck", items: [
        { q: "投入产出表里的一个单元格代表什么?", a: "列部门从行部门购买的中间投入额(某国某行业 卖给 另一国某行业 的量)。" },
        { q: "为什么本系统选 OECD ICIO,而不是 WIOD 或 Eora?", a: "覆盖(约 76 国)-细度(45 行业)-时效(年度到 2020)三者平衡,且自带一致的 TLS/VA/OUT 账户口径,支撑后续所有增加值分解。" },
        { q: "Z、Y、账户三块分别是什么?", a: "Z = 中间投入矩阵、Y = 最终需求、账户 = TLS/VA/OUT(税净额/增加值/总产出),后者让每列投入产出闭合。" },
        { q: "真实 ICIO 原表大致多大?", a: `${size}。` },
      ],
    },
    {
      kind: "takeaway", items: [
        "投入产出表 = 部门间「谁买谁」的矩阵;一个格子就是一笔中间投入。",
        "本系统选 OECD ICIO:覆盖 / 细度 / 时效平衡 + 一致账户口径。",
        "原表分 Z(中间投入)/ Y(最终需求)/ 账户(TLS·VA·OUT)三块,可在阶段④亲手翻。",
      ],
    },
  ];
  return <TeachCards blocks={blocks} />;
}

/* ----------------------------------- Step1 ----------------------------------- */
export function Step1() {
  const { data: meta } = useAsync<DbMeta>(() => api.dbMeta(), []);
  const stages: Stage[] = [
    { key: "why", title: "为什么需要投入产出表", node: <MiniIoStage /> },
    { key: "select", title: "数据库选型:三选一", node: <DbCompareStage /> },
    { key: "structure", title: "认识 ICIO 表结构", node: <IcioSchematicStage meta={meta} /> },
    {
      key: "browse", title: "亲手切片:真实 ICIO 原表", node: (
        <div>
          <SectionHead icon="🧪" label="动手切片 · 在真实 ICIO 原表里选年份/国家/行业并翻页" />
          <DbBrowser meta={meta} />
        </div>
      ),
    },
    { key: "check", title: "自检小测", node: <SelfCheckStage meta={meta} /> },
  ];
  return <StepStages stages={stages} />;
}
