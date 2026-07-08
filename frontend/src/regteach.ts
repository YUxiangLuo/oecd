/**
 * 步骤12-16 的讲解内容(文案移植自 prototype 原型,公式已修正为真实回归引擎口径)
 * 与结果动态解读生成器。
 */
import type { TeachBlock } from "./teach";
import type { RegressionResponse } from "./types";

const ICIO_CONTROLS = "可切换控制变量 γ·Controls_ct:ICIO 派生控制用于解释增加值规模、出口强度与产业结构;模拟宏观控制按 WDI/IMF 风格提供 GDP、人口、人均收入、汇率变动与 FDI 流入。价格口径切到实际值时,金额类控制变量会用 GDP 平减指数 mock 调整。";

export const REG_TEACH: Record<number, TeachBlock[]> = {
  12: [
    {
      kind: "concept", kicker: "核心概念", title: "动手回归前先对齐三件事",
      paras: [
        "在开发回归模块前,提前书面确认三件事,避免做完返工:① 分析粒度(国家级还是国家–行业级);② 冲击类型(关税 / 制裁 / 出口管制);③ 因果推断方式(双向固定效应、双重差分还是事件研究)。下方实验台会随你的选择即时生成回归方程。",
      ],
    },
    {
      kind: "pitfall", title: "两个致命陷阱",
      items: [
        "反向因果:GVC 参与度高的行业本就更容易被列为关税目标,须用时间线/DID 切断;",
        "预期效应:企业常在政策生效前就提前调整供应链,只看生效日会低估效应。",
      ],
    },
    {
      kind: "selfcheck",
      items: [{
        q: "为什么有精确时间线才能做 DID?",
        a: "DID 需要明确的“处理前/后”与处理组划分,依赖宣布日与生效日;没有时间线只能做相关性分析。",
      }],
    },
    {
      kind: "takeaway",
      items: [
        "粒度决定能否细到行业级;",
        "因果设计决定能否说“导致”而非仅“相关”;",
        "有精确时间线时优先 DID。",
      ],
    },
  ],
  13: [
    {
      kind: "concept", kicker: "研究问题", title: "关税冲击是否压低了 FVA 份额?",
      paras: [
        "被解释变量是出口中的国外增加值(FVA)份额,自变量是关税冲击,加入个体与年份双向固定效应识别处理组的相对变化。系数为负,说明关税上升降低了对外部增加值的依赖 —— 供应链回流的证据。",
      ],
    },
    {
      kind: "formula",
      tex: "FVA_share_ijt = β·(treated_ij × 1[t≥G_ij]) + α_ij + λ_t + ε_ijt",
      terms: [
        { sym: "β", def: "关税冲击的因果效应 ATT(关注符号与显著性)" },
        { sym: "treated×post", def: "处理组(曾受冲击的国家–行业)× 处理期(各个体首次冲击年 G_ij 起)" },
        { sym: "α_ij / λ_t", def: "国家–行业、年份双向固定效应" },
      ],
      note: "切换方法时解释变量随之变化:强度法用连续冲击 tariff_shock,事件研究用逐年动态系数。" + ICIO_CONTROLS,
    },
    {
      kind: "concept", kicker: "怎么读结果", title: "系数图与显著性",
      paras: [
        "系数表看符号、大小与显著性星号(*** / ** / *);系数图里点是估计值,横线是 95% 置信区间 —— 区间不跨过 0 才显著。点落在 0 左侧且区间不跨 0,代表显著的负向效应。",
      ],
    },
  ],
  14: [
    {
      kind: "concept", kicker: "研究问题", title: "冲击对复杂 GVC 生产的影响",
      paras: [
        "复杂 GVC 涉及增加值多次跨境,对贸易成本上升最敏感,预期受政策冲击影响最大。若系数显著为负,说明高强度的全球分工在冲击后收缩。",
      ],
    },
    {
      kind: "formula",
      tex: "ComplexGVC_ijt = β·(treated_ij × 1[t≥G_ij]) + α_ij + λ_t + ε_ijt",
      terms: [
        { sym: "ComplexGVC", def: "WWYZ 生产分解中的复杂 GVC 生产份额(增加值至少两次跨境)" },
        { sym: "β", def: "冲击对复杂全球分工的平均处理效应" },
      ],
      note: "打开“冲击×基期GVC”后可检验基期 GVC 生产份额(3_VA_GVC/SVA)越高的个体是否对政策冲击更敏感;基期取每个个体可用样本最早两年的均值,避免坏控制问题。" + ICIO_CONTROLS,
    },
    {
      kind: "takeaway",
      items: [
        "复杂 GVC 对冲击最敏感;",
        "负系数 = 全球分工收缩;",
        "异质性(关税×高参与度交互项)可在模型设定里打开。",
      ],
    },
  ],
  15: [
    {
      kind: "concept", kicker: "研究问题", title: "冲击是否缩短了跨境生产链",
      paras: [
        "若关税提高使前向 GVC 生产长度(PLv_GVC)变短,说明增加值在国际生产网络中辗转的环节变少 —— 企业在收缩全球分工、把生产环节搬回国内或邻近区域(近岸 / 回流)。",
      ],
    },
    {
      kind: "formula",
      tex: "ChainLength_ijt = β·(treated_ij × 1[t≥G_ij]) + α_ij + λ_t + ε_ijt",
      terms: [
        { sym: "PLv_GVC", def: "前向 GVC 生产长度(WWYZ 2017b;后向 PLy_GVC 与位置指数 GVCPs 是配套指标)" },
        { sym: "β", def: "冲击对跨境生产链长度的平均处理效应" },
      ],
      note: ICIO_CONTROLS,
    },
    {
      kind: "pitfall",
      items: [
        "未接外部价格指数 → 金额类指标仍是名义口径;当前用年份固定效应吸收共同年度冲击,并提供基期指数用于相对变化展示;",
        "链长受多因素影响,固定效应帮助隔离政策冲击。",
      ],
    },
  ],
  16: [
    {
      kind: "concept", kicker: "研究问题", title: "制裁是否让一国被网络边缘化",
      paras: [
        "看被制裁/加税的国家是否在生产网络中中心性下降,以此量化“脱钩”。介数中心性下降往往先于贸易额下降,是脱钩的早期信号。",
      ],
    },
    {
      kind: "formula",
      tex: "Centrality_ijt = β·(treated_ij × 1[t≥G_ij]) + α_ij + λ_t + ε_ijt",
      terms: [
        { sym: "Centrality", def: "生产网络介数中心性(本步因变量;度/特征向量中心性见步骤7/11)" },
        { sym: "β", def: "冲击对网络地位的平均处理效应" },
      ],
      note: "冲击类型可在关税、制裁清单、出口管制之间切换;" + ICIO_CONTROLS,
    },
    {
      kind: "takeaway",
      items: [
        "中心性下降 = 被边缘化 / 脱钩;",
        "介数中心性下降是早期信号;",
        "结合制裁清单解释机制。",
      ],
    },
  ],
};

/* ------------------------------ 结果动态解读 ------------------------------ */

// 步骤 → 因变量的中文名与效应方向含义;pct 型因变量把系数换算为百分点
const STEP_READ: Record<number, { noun: string; neg: string; pos: string; pct: boolean }> = {
  13: {
    noun: "出口中外国增加值(FVA)份额", pct: true,
    neg: "对外部增加值的依赖下降 —— 供应链回流的证据",
    pos: "对外国增加值的依赖不降反升 —— 与供应链回流假说相反",
  },
  14: {
    noun: "复杂 GVC 生产份额", pct: true,
    neg: "增加值多次跨境的复杂分工在收缩",
    pos: "复杂全球分工不缩反扩",
  },
  15: {
    noun: "前向 GVC 生产长度(PLv_GVC)", pct: false,
    neg: "跨境生产链缩短 —— 近岸/回流的迹象",
    pos: "跨境生产链反而拉长",
  },
  16: {
    noun: "生产网络介数中心性", pct: false,
    neg: "受冲击国家在生产网络中被边缘化 —— “脱钩”的量化证据",
    pos: "受冲击国家的网络地位不降反升",
  },
};

const DISCLAIMER = "以上解读由系统根据系数符号与显著性自动生成;冲击为拟真演示面板,结论仅用于验证系统链路,不构成研究结论。";

function fmtEffect(coef: number, pct: boolean): string {
  return pct ? `${Math.abs(coef * 100).toFixed(2)} 个百分点` : Math.abs(coef).toFixed(4);
}

function sigLabel(stars: string, p: number): string {
  if (stars === "***") return "在 1% 水平上显著";
  if (stars === "**") return "在 5% 水平上显著";
  if (stars === "*") return "在 10% 水平上显著";
  return `统计上不显著(p = ${p.toFixed(3)})`;
}

/** 根据真实回归结果生成中文解读段落(按方法分派)。 */
export function interpretResult(step: number, resp: RegressionResponse): string[] {
  const read = STEP_READ[step];
  if (!read) return [DISCLAIMER];
  const { method } = resp.design;
  const coefs = resp.result.coefs;
  const policyCoefs = coefs.filter((c) => !resp.design.controls.includes(c.name));
  const out: string[] = [];

  if (method === "事件研究") {
    const eventCoefs = policyCoefs.filter((c) => c.name.startsWith("k="));
    const pre = eventCoefs.filter((c) => c.name.startsWith("k=-"));
    const post = eventCoefs.filter((c) => !c.name.startsWith("k=-"));
    const preBad = pre.filter((c) => c.stars !== "");
    out.push(
      preBad.length === 0
        ? `平行趋势检验:冲击前(k<0)的 ${pre.length} 个系数均不显著 ✓ —— 处理组与对照组在冲击前走势平行,DID 识别假设成立。`
        : `⚠ 平行趋势存疑:冲击前系数 ${preBad.map((c) => c.name).join("、")} 显著,处理组在冲击前已有差异化走势,动态效应解读需谨慎。`,
    );
    const sigPost = post.filter((c) => c.stars !== "");
    if (sigPost.length === 0) {
      out.push(`冲击后(k≥0)各期系数均不显著,未检测到${read.noun}的明显动态响应。`);
    } else {
      const peak = sigPost.reduce((a, b) => (Math.abs(b.coef) > Math.abs(a.coef) ? b : a));
      const dir = peak.coef < 0 ? "下降" : "上升";
      out.push(
        `动态效应:${sigPost.map((c) => `${c.name} 期 ${c.coef < 0 ? "−" : "+"}${fmtEffect(c.coef, read.pct)}${c.stars}`).join(",")};` +
        `效应在 ${peak.name} 期达到峰值(${dir} ${fmtEffect(peak.coef, read.pct)}),${peak.coef < 0 ? read.neg : read.pos}。`,
      );
    }
  } else {
    const key = policyCoefs[0];
    if (key) {
      const isDid = method === "双重差分 (DID)";
      const dir = key.coef < 0 ? "下降" : "上升";
      const sig = key.stars !== "";
      // 强度法:tariff_shock 以比例计,+1 个百分点 = +0.01 → 因变量变化 0.01β
      const feEffect = read.pct
        ? `${Math.abs(key.coef).toFixed(2)} 个百分点`
        : Math.abs(key.coef * 0.01).toFixed(4);
      const head = isDid
        ? `DID 估计:冲击发生后,处理组的${read.noun}相对对照组${dir} ${fmtEffect(key.coef, read.pct)}`
        : `强度法估计:平均额外关税每上升 1 个百分点,${read.noun}${dir}约 ${feEffect}`;
      out.push(`${head}(β = ${key.coef.toFixed(4)}${key.stars},${sigLabel(key.stars, key.p)})。`);
      out.push(sig
        ? (key.coef < 0 ? read.neg : read.pos) + "。"
        : "效应未达到常规显著性水平,不能据此下结论。");
    }
  }
  out.push(DISCLAIMER);
  return out;
}
