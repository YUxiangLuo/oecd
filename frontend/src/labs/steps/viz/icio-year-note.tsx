/** The warning follows the years actually displayed, never the simulated panel. */
export function IcioYearNote({ years }: { years: number[] }) {
  if (!years.includes(2020)) return null;
  return <p className="reg-boundary" aria-label="2020 年数据解释边界">
    <b>2020 年：现价与疫情期外推限制。</b>金额按当年价格计，变化可能包含价格因素。OECD 2023 版中部分国家的投入产出结构由此前基准表外推，疫情对行业的冲击并不均匀。读图时请区分价格、统计编制与实际数量或结构变化，不能仅凭该年转折判断生产调整。
    {" "}<a href="https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/trade-in-value-added/tiva-indicators-guide-2023.pdf#page=42" target="_blank" rel="noreferrer">OECD 说明（第 42 页）</a>
  </p>;
}
