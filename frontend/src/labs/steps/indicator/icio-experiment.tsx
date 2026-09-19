import { useState } from "react";
import { api } from "../../../api";
import { AsyncStateMessage, fmtDb, useAsync } from "../../shared";
import "./icio-experiment.css";

export type IndicatorTopic = "trade" | "production" | "length";
type Values = Record<string, number | null>;
export interface TeachingScenario {
  id: string;
  title: string;
  description: string;
  nodes: string[];
  regions: string[];
  Z: number[][];
  Y: number[][];
  va: number[];
  x: number[];
  A: number[][];
  B: number[][];
  trade: Values[];
  production: Values[];
  length: Values[];
}
export interface TeachingIcio { scenarios: TeachingScenario[] }

const questions = {
  trade: "出口100元，为什么不全是本国创造的？",
  production: "本国创造的增加值，最终通过什么路径被使用？",
  length: "同样100元最终需求，为什么生产长度不同？",
};
const fields: Record<IndicatorTopic, [string, string][]> = {
  trade: [["DVAex", "国内价值·国外吸收"], ["DVArt", "国内价值·返回本国"], ["FVA", "外国增加值"], ["DDC", "国内重复计算"], ["FDC", "外国重复计算"], ["taxsub", "产品税减补贴"]],
  production: [["1_VA_D", "纯国内"], ["2_VA_RT", "传统贸易"], ["3a_VA_GVC_S", "简单GVC"], ["3b_VA_GVC_C", "复杂GVC"]],
  length: [["PLv", "前向总长度"], ["PLy", "后向总长度"], ["PLv_GVC", "前向GVC段"], ["PLy_GVC", "后向GVC段"], ["GVCPs", "GVC位置指数"]],
};

export function IcioExperiment({ topic }: { topic: IndicatorTopic }) {
  const query = useAsync(() => api.teachingIcio(), []);
  const [scenarioId, setScenarioId] = useState(topic === "trade" ? "complex-gvc" : "domestic");
  const [selected, setSelected] = useState<number | null>(null);
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const scenario = query.data?.scenarios.find((item) => item.id === scenarioId);
  const active = scenario?.x.flatMap((value, index) => value > 0 ? [index] : []) ?? [];
  const defaultNode = topic === "trade" || (topic === "length" && direction === "backward") ? active.at(-1) : active[0];
  const node = selected != null && active.includes(selected) ? selected : defaultNode;

  return <section className="icio-experiment" aria-label="ICIO计算小实验">
    <header><span className="icio-kicker">01 / 计算小实验 · 教学数据</span><h2>{questions[topic]}</h2>
      <p>切换一个场景，再点选行业。看投入产出表里的数字怎样变成指标。</p></header>
    <AsyncStateMessage status={query.status} error={query.error} loadingLabel="正在计算教学ICIO账户…" onRetry={query.retry} />
    {scenario && node != null && <>
      <div className="icio-scenarios" role="group" aria-label="教学场景">
        {query.data!.scenarios.map((item) => <button key={item.id} type="button" aria-pressed={item.id === scenario.id}
          onClick={() => { setScenarioId(item.id); setSelected(null); }}>{item.title}</button>)}
      </div>
      <p className="icio-scenario-description">{scenario.description}</p>
      <div className="icio-path" aria-label="生产与使用路径">
        {active.map((i) => <span key={i}><button type="button" aria-pressed={i === node}
          onClick={() => setSelected(i)}>{scenario.nodes[i]}<small>新增价值 {fmtDb(scenario.va[i])} 元</small></button>
          <span aria-hidden="true"> → </span></span>)}
        <b>{scenario.regions[scenario.Y[active.at(-1)!].findIndex((v) => v > 0)]}消费<br /><small>最终需求100元</small></b>
      </div>
      <div className="icio-workspace">
        <section className="icio-input"><h3>① 找到ICIO里的输入</h3>
          <p>行看“卖给谁”，列看“买了什么”。点击行业名，联动右侧计算。</p>
          <div className="icio-table-scroll" tabIndex={0} role="region" aria-label="教学投入产出表，可横向滚动">
            <table><caption>微型ICIO · 金额：元 · 隐去全零行业</caption>
              <thead><tr><th scope="col">供给 ↓ / 使用 →</th>{active.map((j) => <th key={j} scope="col">{scenario.nodes[j]}</th>)}
                {scenario.regions.map((r) => <th key={r} scope="col">{r}最终需求</th>)}<th scope="col">总产出</th></tr></thead>
              <tbody>{active.map((i) => <tr key={i} className={i === node ? "icio-selected-row" : ""}>
                <th scope="row"><button type="button" aria-pressed={i === node} onClick={() => setSelected(i)}>{scenario.nodes[i]}</button></th>
                {active.map((j) => <td key={j} className={scenario.Z[i][j] > 0 ? "icio-z" : ""}>{fmtDb(scenario.Z[i][j])}</td>)}
                {scenario.Y[i].map((v, j) => <td key={j} className={v > 0 ? "icio-y" : ""}>{fmtDb(v)}</td>)}<td>{fmtDb(scenario.x[i])}</td>
              </tr>)}
              <tr className="icio-va"><th scope="row">增加值 VA</th>{active.map((i) => <td key={i}>{fmtDb(scenario.va[i])}</td>)}<td colSpan={4}>劳动、资本等创造的新价值</td></tr>
              <tr><th scope="row">总投入</th>{active.map((i) => <td key={i}>{fmtDb(scenario.x[i])}</td>)}<td colSpan={4}>每个行业：总投入 = 总产出</td></tr></tbody>
            </table>
          </div>
          <p className="icio-legend"><span>紫色：中间投入 Z</span><span>蓝色：最终需求 Y</span><span>绿色：增加值 VA</span></p>
        </section>
        <section className="icio-calculation" aria-live="polite"><h3>② 跟着数字算 · {scenario.nodes[node]}</h3>
          <p>每生产1元，需要多少中间投入？</p>
          <div className="icio-equation">{fmtDb(scenario.Z.reduce((sum, row) => sum + row[node], 0))} ÷ {fmtDb(scenario.x[node])} = {fmtDb(scenario.A.reduce((sum, row) => sum + row[node], 0))}</div>
          <p>其中新创造的价值：{fmtDb(scenario.va[node])} ÷ {fmtDb(scenario.x[node])} = {fmtDb(scenario.va[node] / scenario.x[node])} 元。</p>
          {topic === "trade" && <>
            <p>先加总这一行卖给国外的中间品和最终品，得到总出口；再沿投入链追溯价值来源与最终吸收地。</p>
            <div className="icio-equation">总出口 = {fmtDb(scenario.trade[node].gross_exports)}</div>
            {scenario.trade[node].gross_exports !== 0 && <>
              <p>在本例中，各来源的价值含量 = 来源增加值系数 × 累计投入系数 × 出口额：</p>
              {active.filter((i) => scenario.B[i][node] > 0).map((i) => <p key={i}>
                <b>{scenario.nodes[i]}</b>：{fmtDb(scenario.va[i] / scenario.x[i])} × {fmtDb(scenario.B[i][node])} × {fmtDb(scenario.trade[node].gross_exports)}
                {" = "}{fmtDb(scenario.va[i] / scenario.x[i] * scenario.B[i][node] * scenario.trade[node].gross_exports!)} 元
              </p>)}
            </>}
            <p>{scenario.trade[node].gross_exports === 0 ? "这个行业没有出口；金额为0不代表存在可比较的出口占比。" : "下面的分项由正式WWZ算法计算，不是把进口投入直接当作外国增加值。"}</p>
          </>}
          {topic === "production" && <>
            <p>从当前行业创造的价值出发，追踪到最终使用者。最终品直接出口是传统贸易；中间品跨境后在进口国消费是简单GVC，继续跨境则为复杂GVC。</p>
            <div className="icio-equation">总增加值 {fmtDb(scenario.production[node].SVA)} = {fields.production.map(([key]) => fmtDb(scenario.production[node][key])).join(" + ")}</div>
            <p>换成加工品行业：同一条链，不同来源的增加值可能属于不同类别。</p>
          </>}
          {topic === "length" && <>
            <div className="icio-scenarios" role="group" aria-label="长度计算视角">
              <button type="button" aria-pressed={direction === "forward"} onClick={() => { setDirection("forward"); setSelected(active[0]); }}>前向：从价值来源出发</button>
              <button type="button" aria-pressed={direction === "backward"} onClick={() => { setDirection("backward"); setSelected(active.at(-1)!); }}>后向：从最终产品回溯</button>
            </div>
            {direction === "forward" ? <>
              <p>投入系数沿链传递：B = I + A + A² + …。把各行业产出按B的这一行累计，再除以本行业产出。</p>
              <div className="icio-equation">({active.map((j) => `${fmtDb(scenario.B[node][j])} × ${fmtDb(scenario.x[j])}`).join(" + ")}) ÷ {fmtDb(scenario.x[node])} = {fmtDb(scenario.length[node].PLv)}</div>
              <p>这里增加值系数在分子、分母中约去。没有中间投入时长度为1；增加国内加工也能拉长生产链。</p>
            </> : <>
              <p>站在最终产品端，按各来源增加值在生产中被计入产出的次数加权。在这个无税、无循环的小例子里：</p>
              <div className="icio-equation">{scenario.Y[node].some((v) => v > 0)
                ? `(${active.map((i) => `${fmtDb(scenario.va[i])} × ${i === node ? "1" : "2"}`).join(" + ")}) ÷ 100 = ${fmtDb(scenario.length[node].PLy)}`
                : `后向长度 = ${fmtDb(scenario.length[node].PLy)}`}</div>
              <p>{scenario.Y[node].some((v) => v > 0) ? active.length === 1 ? "没有中间加工，全部增加值只经过一次生产。" : "初级品价值经过初级生产和加工，加工新增价值只经过加工。" : "该行业没有实际最终需求；此值是其技术结构对应的单位产品后向长度，不代表本场景有最终产品在这里完成。"}</p>
            </>}
          </>}
        </section>
      </div>
      <section className="icio-results" aria-label="教学指标计算结果"><h3>③ 看见指标结果</h3>
        <div>{fields[topic].map(([key, label]) => <article key={key}><span>{label}</span><strong>{fmtDb(scenario[topic][node][key])}</strong><small>{topic === "length" ? "无量纲" : "元"}</small></article>)}</div>
      </section>
      <p className="icio-boundary">{topic === "trade" ? "这些无循环示例的重复计算项为0；重复跨境不自动等于重复计算。税收项也设为0，真实ICIO另计产品税减补贴（TLS）。" : topic === "length" ? "长度不是跨境次数。试着在国内加工与跨国加工之间切换：跨境改变了，长度不一定变。— 表示对应活动不存在、比值未定义。" : "简单与复杂GVC按价值经过的跨境路径区分；第二次跨境也可以是最终品。复杂GVC占比高不自动代表收益更高。"}</p>
      <details><summary>从这个小例子到真实ICIO：完整计算口径</summary>
        <p>Z是中间投入，Y是最终需求。Aᵢⱼ = Zᵢⱼ / xⱼ，vᵢ = VAᵢ / xᵢ，B = (I − A)⁻¹。B把直接和间接的生产需求全部累计起来；各国国内逆矩阵与跨境投入块进一步区分价值路径。</p>
        <p>本例只有最多两道生产环节，没有循环投入，因此A² = 0，B = I + A。下表每格显示“直接系数A → 累计系数B”。</p>
        <div className="icio-table-scroll"><table><caption>投入系数的计算结果</caption><thead><tr><th scope="col">来源 / 生产行业</th>{active.map((j) => <th key={j} scope="col">{scenario.nodes[j]}</th>)}</tr></thead>
          <tbody>{active.map((i) => <tr key={i}><th scope="row">{scenario.nodes[i]}</th>{active.map((j) => <td key={j}>{fmtDb(scenario.A[i][j])} → {fmtDb(scenario.B[i][j])}</td>)}</tr>)}</tbody>
        </table></div>
        <p>{topic === "trade" ? "正式算法将WWZ双边16项聚合为五类，再加OECD税收扩展。只看出口国的一列投入，无法区分返回本国与重复计算。" : topic === "production" ? "WWYZ先按国内最终需求、国外最终需求与跨境中间投入分解，再按最终吸收路径区分简单和复杂GVC。这里展示增加值来源端的前向分解。" : "前向PLv = (Bx)ᵢ / xᵢ，后向PLy = (v′BB)ⱼ / (v′B)ⱼ。GVC位置 = 前向GVC段 / 后向GVC段，不是前向总长度 / 后向总长度。国家级先加总对应分子与分母，不能简单平均行业比值。"}</p>
        <p>教学账户与真实数据复用后台计算函数，但彼此隔离。真实结果依赖全球国家×行业关系，不能用截取的一小块原表完整复算。以下真实数据金额单位为百万美元，不是本实验的元。</p>
      </details>
    </>}
  </section>;
}
