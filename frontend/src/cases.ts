/**
 * 案例展示的静态配置(内容与 regteach.ts 同构:数据在此、渲染在 cases.tsx)。
 *
 * 两类案例:
 *  - INDICATOR_CASES:指标解读型。每个指标/可视化步骤配 2–3 个真实经济体范例,
 *    点开后由所在步骤把演示/图表跳到该经济体。此处只写“引用”(经济体代码、指标字段、
 *    文案),真实数值一律由 cases.tsx 走 api.countryIndicators 现拉,绝不硬编码。
 *  - POLICY_CASE:政策情景型。一条真实政策事件(2018 中美关税)贯穿 步2 冲击 → 步13–16
 *    回归 → 报告,仅提供叙述与每步假设;结论仍由既有 interpretResult 按真实回归结果生成。
 *
 * 约束:economy 必须在 COUNTRY_NAMES 里,metric 必须是指标 schema 的真实字段(见 cases.test.ts
 * 校验)。冲击数据为拟真 mock,POLICY_CASE.honesty 如实标注,不夸大真实因果结论。
 */

export interface IndicatorCase {
  economy: string; // ISO3,须在 COUNTRY_NAMES 中
  metric: string; // 指标 schema 字段键(如 "FVA_share")
  claim: string; // 标题,如 "越南 · 高后向 GVC 参与"
  why: string; // 一两句经济学解读
}

/** 步骤 n(4–11)→ 该步的真实经济体范例。全部为国家级指标,数值由 api.countryIndicators 现拉。 */
export const INDICATOR_CASES: Record<number, IndicatorCase[]> = {
  4: [
    { economy: "VNM", metric: "FVA_share", claim: "越南 · 高后向 GVC 参与", why: "出口大量使用进口中间投入,FVA(外国增加值)份额在全样本居前。" },
    { economy: "LUX", metric: "FVA_share", claim: "卢森堡 · 小型开放经济体", why: "高度依赖跨境增加值,毛出口里外国增加值占比极高。" },
    { economy: "USA", metric: "FVA_share", claim: "美国 · 大型内需经济体(对照)", why: "出口以本国增加值为主,FVA 份额偏低,适合与越南/卢森堡对照。" },
  ],
  5: [
    { economy: "SGP", metric: "3_VA_GVC_share", claim: "新加坡 · 深度嵌入全球生产", why: "增加值经中间品贸易跨境实现的比重高,GVC 生产份额居前。" },
    { economy: "USA", metric: "3_VA_GVC_share", claim: "美国 · 以国内生产为主(对照)", why: "纯国内生产活动占比高,GVC 生产份额相对低。" },
  ],
  6: [
    { economy: "RUS", metric: "GVCPs", claim: "俄罗斯 · 靠上游(资源供给)", why: "作为原材料供给方,前向/后向 GVC 长度之比(GVCPs)偏大,离最终需求远。" },
    { economy: "AUS", metric: "GVCPs", claim: "澳大利亚 · 原材料上游", why: "资源型经济体,GVCPs 通常较高,处于价值链上游。" },
    { economy: "CHN", metric: "GVCPs", claim: "中国 · 相对靠下游(加工组装)", why: "大量参与加工组装,GVCPs 较低,更靠近最终需求端。" },
  ],
  7: [
    { economy: "DEU", metric: "betweenesscentrality", claim: "德国 · 欧洲供应链枢纽", why: "居于大量最短路径之上,介数中心性高,是网络“咽喉”。" },
    { economy: "CHN", metric: "betweenesscentrality", claim: "中国 · 全球制造枢纽", why: "连接广、流量大,介数中心性突出。" },
    { economy: "USA", metric: "betweenesscentrality", claim: "美国 · 需求与技术枢纽", why: "在网络中扮演中转与终端吸收的双重角色。" },
  ],
  8: [
    { economy: "VNM", metric: "FVA_share", claim: "越南 · 落在「进口依赖·后向型」", why: "高 FVA 份额,在定位图上偏向后向嵌入象限。" },
    { economy: "USA", metric: "FVA_share", claim: "美国 · 落在「相对自给」一侧", why: "低 FVA 份额,出口以本国增加值为主。" },
    { economy: "DEU", metric: "FVA_share", claim: "德国 · 高进出双向嵌入", why: "既大量用外国增加值,又向外供给,适合观察双向联系。" },
  ],
  9: [
    { economy: "SGP", metric: "3_VA_GVC_share", claim: "新加坡 · 复杂 GVC 主导", why: "生产活动里复杂 GVC(多次跨境)份额高。" },
    { economy: "USA", metric: "3_VA_GVC_share", claim: "美国 · 纯国内主导(对照)", why: "四段构成里纯国内活动占比高。" },
  ],
  10: [
    { economy: "RUS", metric: "GVCPs", claim: "俄罗斯 · 长链上游", why: "GVC 生产长度长且靠上游,散点偏向前向长度一侧。" },
    { economy: "CHN", metric: "GVCPs", claim: "中国 · 靠近最终装配", why: "GVCPs 较低,位置靠下游。" },
  ],
  11: [
    { economy: "DEU", metric: "weighted degree", claim: "德国 · 核心枢纽", why: "加权度与介数中心性双高,落在枢纽地图核心象限。" },
    { economy: "CHN", metric: "weighted degree", claim: "中国 · 高流量枢纽", why: "贸易连接总流量巨大,加权度居前。" },
    { economy: "USA", metric: "betweenesscentrality", claim: "美国 · 高介数桥接者", why: "控扼要冲,介数中心性突出。" },
  ],
};

/** 政策情景型:一条真实事件贯穿多步的叙述与每步假设(数值/结论仍来自真实回归)。 */
export const POLICY_CASE: {
  id: string;
  title: string;
  shockType: string;
  background: string;
  framing: Record<number, string>;
  honesty: string;
} = {
  id: "us_china_2018_tariffs",
  title: "2018 中美关税",
  shockType: "关税冲击",
  background:
    "2018 年起美国依 301 条款分批对华加征关税,中方对美实施反制关税。本系统把这一情景编码为覆盖全部经济体的拟真冲击面板,用来贯穿演示“政策如何影响 GVC”。",
  framing: {
    2: "本案例以“美国 301 对华关税 + 中方反制”为主线。右表的宣布/生效时间线即该事件的编码;后续步骤 13–16 会用它作为回归的核心自变量。",
    12: "把上面这条关税事件设为贯穿案例:确认粒度与识别策略后,步骤 13–16 都围绕“加税是否改变了受影响经济体的 GVC 指标”展开。",
    13: "案例假设:关税上升压低受影响出口对外国增加值(FVA)的依赖——若系数显著为负,是供应链回流的证据。",
    14: "案例假设:复杂 GVC(增加值多次跨境)对贸易成本最敏感,加税后其生产份额预期收缩。",
    15: "案例假设:加税缩短前向 GVC 生产长度(PLv_GVC)——跨境环节减少,近岸/回流的迹象。",
    16: "案例假设:被加税/反制的经济体在生产网络中被边缘化,介数中心性下降——“脱钩”的早期信号。",
  },
  honesty:
    "本案例的冲击数据为拟真演示面板(事件与量级参考公开资料手工编码),结论仅用于验证系统链路,不构成真实因果研究结论。",
};
