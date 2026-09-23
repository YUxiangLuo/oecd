# 经济学内容深度复核（2026-09-24）

## 范围与结论

复核基线为源码 commit `0d8759e480c32e740289db10fda5abfa8fe3b79f` 和本机 active v15 release `40c6a5d0d5d94084961a2dca04b9b260` 为对象，对照 OECD 原始方法、TiVA 指南及 WWZ/WWYZ 原论文，复核课程 1–15 步的概念、计算、模拟设计和解释。旧审查记录中的 E01–E11、ER01–ER04 属于历史基线；它们已有修复记录，不能直接当作当前缺陷。没有连接课堂数据库或修改 release，也没有进行 OECD 官方 TiVA 逐指标数值对表。

**总体判断：**真实 ICIO 部分的会计闭合、主要指标分解和教学边界有较扎实的实现与披露；固定的虚构关税面板适合教学生读单位、回归系数和诊断。最需要改进的是**模拟结果的语义**：四个模拟 Y 并不由政策冲击后的 IO 表、生产链或网络重新计算，局部界面却把回归方向解释成这些经济结构已经变化。这个问题不等于数值估计错误，却会改变学生学到的经济含义。

## 证据与复核

- `dataset.json` 为 artifact v15、2016–2020；39 个固定产物通过 `validate_release_cached`，五份原始 ICIO 通过 `validate_raw_source_bindings`。发布 QC 仍要求披露原始负 VA/TLS 和小额账户舍入，不把通过门禁解释为所有经济量均无不确定性。
- 当前 `panel_industry.csv` 在 2016 年、排除 ROW 后有 3420 个国家—行业单元；`panel_teaching.csv` 保留 3244 个，减少 176 个（5.15%），五年平衡面板共 16,220 行、76 国、44 个有保留观测的行业。筛选条件要求首年四个真实指标和美国出口份额同时可用且在定义域内，见 `gvcsim/regression/teaching.py`。
- 对本机 teaching panel 重新运行 `run_design_with_benchmark`，四项均为 `ok` 且通过 PanelOLS 数值对照：贸易 β̂ = −0.563844、生产 −0.279957、长度 −1.731325、网络 −5977.904257；按国家聚类的 p 值分别约 2.72e−24、3.28e−14、3.58e−11、3.69e−32。生成器预设 β 分别为 −0.55、−0.40、−1.8、−6000；估计与预设不必完全相同。四项结果都显示明显负向关系，是本次确定性模拟设定的特征，不能当作四项独立的现实经验发现。
- 选中样本中 2016 年真实国家—行业网络介数范围约 0.44–7751.13，同为 2016 年的模拟网络 Y 范围约 1807.22–4133.14（全五年为 1191.62–4223.08）；它只保留首年排序的近似信息，不保留真实水平、拓扑恒等式或后续网络轨迹。其他三个模拟 Y 同理。
- 与经济学相关的纯计算测试本轮 83 项通过（`test_teaching_regression.py`、`test_teaching_icio.py`、`test_indicators.py`、`test_regression_numerics.py`、`test_economics_fixes.py`）。测试和库对照证明实现行为及若干恒等式，不能证明外部经济识别假设。

## 分主题判断

| 主题 | 当前判断 | 教学边界 |
| --- | --- | --- |
| ICIO 数据 | OECD 2023 版 76 个经济体加 ROW、45 行业、6 类最终需求的版本化截面是自洽的固定课堂数据。Z 的行供给、列使用，现价金额单位为百万美元。 | ICIO 是多来源平衡、估计和外推的统计表，不能把单格都说成直接调查观测。2020 年尤其需披露疫情时期基准表外推的不确定性。固定在 2023 版有利于课堂复现，但不应称为 OECD 最新版本。 |
| WWZ 贸易分解 | `DVAex + DVArt + DDC + FVA + FDC + taxsub = gross exports`，把 TLS 作为额外账户项而非关税，做法透明；先汇总金额再求份额正确。 | 只存五类 WWZ 聚合而不存双边 16 项，适合入门，但无法支撑细分目的地/返流来源解释。课程 `FVA_share = FVA/gross_exports` 不等于 OECD `EXGR_FVASH`，不能用同名直接对表。 |
| WWYZ 生产与长度 | 前后向生产分解、四类活动、分母限制和加权链长的代码与课程公式一致，现有小矩阵反例及产物 QC 未暴露新代数错误。 | 复杂 GVC 指中间品至少一次跨境、累计至少两次跨境；长度是累计总产出与关联 VA 的比率，不是物理工序或过境国家的直接计数。份额高不表示更稳健、更先进。 |
| 网络 | 对完整国家×行业中间使用网络计算有向、全正边、无权 Brandes 介数；加权度保留金额。展示边集与计算边集分开说明，国家完全图的介数为零也已披露。 | 极小正流量与大额边在最短路径上等价；无阈值敏感性，因此介数只能作拓扑编码练习，不能称经济瓶颈或不可替代性。 |
| 模拟关税 | `X = 2016 年销往美国的出口份额 × 虚构税率`，权重固定在冲击前，税率及四个 Y 均有版本、seed 和来源绑定。 | 这不是实际美国政策，也不是把关税加进 IO 模型后重新求均衡；不能从 X 推出真实福利、产量、价格、转移或企业调整。 |
| 回归 | 当前唯一公开模型为国家×行业及年份双向固定效应、无控制、按国家聚类；实现与 PanelOLS 对照，单位换算正确，限制性结果可完整保存。 | 估计仅恢复预设模拟关系并练习样本内描述；固定效应、预处理份额和很小的 p 值都不赋予现实因果解释。四个逐项 95% 区间不是同时置信带。 |

## 修复前发现与优先级

### E24-01 / 高：模拟 Y 的方向被局部解释为经济结构的实际方向

`gvcsim/regression/teaching.py` 用首年真实指标**排名**构造基准水平，再加预设 β×X、hash 扰动和时间趋势；没有为每个模拟年份重算 WWZ/WWYZ、ICIO 或网络。实际可见的方向解释在 `frontend/src/regression.tsx` 的“计算方法说明”中，来自 `regression-lessons.ts` 的 `downMeaning/upMeaning`；其中出现链条缩短、拓扑中介位置下降等表述。自动报告的 `gvcsim/report_common.py::_OUTCOME_INTERPRETATIONS` 也将类似解释写入“可以支持的表述”，应一并修复。

源码中 `frontend/src/regression-verdict.ts` 的 `interpretation` 字段同样有旧解释，但当前没有被页面渲染，不能将它作为主结果卡实际可见的证据。主结果卡已有教学模拟标题和 X/Y 免责声明；本项针对具体方向句与这条边界不一致的问题。

**建议：**所有方向性句子都以“模拟 Y 的数值下降/上升”开头；随后用条件句说明“若真实同定义指标这样变化，才可能与某种结构变化一致”，并说明本实验没有生成相应的新 IO 表或网络。特别是网络 Y，不能称其下降为“拓扑位置下降”，因为模拟年份并不存在产生该 Y 的图。

### E24-02 / 中：模拟推断对象需要放在主结果旁

四个 β 是生成器预设的、全部为负；本机四次估计的逐项区间均不跨 0。由固定 seed 哈希生成的这一份面板可重复，却不是来自 OECD 观测、随机化政策或可供推及现实的随机样本。国家聚类 CR1 和 `t(G−1)` 是这套模拟误差过程下练习统计计算的选择，不能把极小 p 值表述为现实政策证据。当前技术折叠区可以查看“原始 β”，报告也标注模拟，主结果卡已有“教学模拟结果”与“两者在模拟数据中怎样一起变化”的标题，但方向判断仍使用“发现负向变化证据”。

**建议：**主结果附近标注“预设模拟关系的估计”，并展示预设 β、估计 β̂ 与误差；将“证据”限定为“本次模拟样本内”。步骤 12 已有独立的区间跨零／不跨零读数练习（`IntervalReadingExercise`），宜提高其可见性；需要时再扩展零关系示例，避免重复建设。此项是教学设计改进，并非 p 值或标准误数值错误。

### E24-03 / 中：五年趋势和 2020 年数据质量的提示应更靠近图

当前金额是当年价格，代码中若干图表和报告已有名义值说明；但 OECD 对 2023 版 TiVA/ICIO 的 2020 年特别提醒：许多国家的 SUT/IOT 使用此前结构外推，疫情期间行业冲击高度不均。学生在 6–9 步看到 2019→2020 的金额或网络流量跳变时，至少应区分价格、统计编制与数量/结构三种可能来源。现有通用说明正确，但在该年转折的图和实验手册处可更显眼。

**建议：**只对涉及 2020 年的趋势提示“现价与疫情期外推限制”；无需删除 2020 年或把所有 2020 数值视为错误。若目标扩展到真实增长研究，需要价格/数量指标和版本敏感性。

OECD 现提供前一年价格 ICIO 与链式实际量指标，可用于后续课程扩展；这不是要求当前入门实验立即更换数据版本。当前的里昂惕夫逆用于**既有流量的核算分解**，并非关税冲击后的行为或一般均衡预测。若把固定投入系数模型用于真实冲击预测，还要处理价格、替代和供应约束。

### E24-04 / 中：回归样本筛选范围未充分进入学生的结论句

为让四个模拟 Y 共用可用样本，生成器一次性要求四类首年指标均有效。当前 release 排除 ROW 后又排除 176/3420 个国家—行业单元。学生结果卡显示 N、实体数和聚类数，但没有在主解释处直接说“使用 3244 个符合共同有效条件的单元构造教学样本”；对 45 行业或全部 76 国行业组合的概括会超出样本。

**建议：**结果卡和报告样本说明同步显示原始候选数、剔除数和共同有效规则。三个数量已经存储在 `simulation_contract.source_filter_disclosure`，可直接使用；回归 `sample_flow` 从生成后的年度记录开始，不能替代生成阶段的筛选披露。保持四结果同样本是好的教学选择，不必为此改成四套互不相同的样本。

### E24-05 / 低：旧 DID 术语仍残留在非主路径

`gvcsim/report_build.py` 的自动参考文献仍列 Goodman-Bacon、Sun–Abraham、Callaway–Sant’Anna 与前趋势预检文献，而当前公开回归只做连续强度 TWFE；`frontend/src/regression.tsx` 仍有“cohort-time ATT 不定义组内 R²”兜底文案，`frontend/src/regression-lessons.ts` 中也保留未渲染的 cohort/置换/前趋势措辞。它们没有改变本机主估计结果，但增加维护和阅读混淆。

**建议：**将 DID 文献单列为“历史/延伸方法，当前模型未使用”，把兜底和元数据文案换成当前 TWFE 语义，移除无用旧字段。

## 被接受的简化与升级边界

1. 课程应继续使用固定数据版本和简化聚合项，以保证 15 步可复现；通过哈希与数学 QC 不能替代与外部官方 TiVA 序列的逐口径校对。
2. 课程可以保留人为设定的 `w×τ` 和四个 Y，以讲授暴露强度、固定效应、单位及诊断；若将来声称研究真实关税，必须另外取得真实政策时点/税率、真实结果序列、价格处理、处理选择与外溢识别，并预设估计对象及稳健性检验。不能把当前模拟结果重新命名为经验政策评估。真实政策若包含多个国家共享的行业冲击，还须单独论证国家聚类是否足够，不能机械沿用当前标准误。
3. 网络练习可以保留全正边二值介数以复现软件口径；若要讨论供应链瓶颈，需要边阈值、金额/距离定义、替代路径以及冲击前后网络比较。

## 本轮修复与验证（2026-09-24）

以下为 `0d8759e` 基线上的工作区修复；上述发现保留为修复前证据。

- **E24-01：已修复。** 页面方向句及自动报告先陈述模拟 Y 的数值方向，真实结构含义使用条件句；主结果明确没有生成冲击后的 IO 表或网络。移除没有被渲染的旧 `interpretation` 字段。实验手册同步修改长度和网络解释。
- **E24-04：已修复。** 结果卡读取当前 release 元数据，自动报告从同一元数据生成来源说明并保存在既有 provenance 中；展示候选、剔除、保留单元及共同有效规则，另列回归输入与剔除年度行数，未硬编码 3420/3244。
- **E24-02：已修复。** 主结果和报告展示预设关系、估计及差值，均换算为 X 增加 1 个百分点对应的 Y 单位；推断被抑制或缺少系数时不显示该比较。说明单次区间不保证包含预设值。步骤 12 提高已有可选跨零练习的可见性。
- **E24-03：已修复。** 步骤 6–9 的实际所选年份含 2020 时，在图旁显示现价和疫情期外推提示；自动报告按已记录观测年份提示，链接 OECD 指南第 42 页。学生手册同步更新。
- **E24-05：已修复。** 删除自动报告中未使用的 DID 参考文献、未渲染的旧课程字段与旧置换注释；缺失 R² 兜底改为当前 TWFE 语义。

本轮保持原有模拟生成器、β、seed、release、课程完成判定与数据库 schema。学生手册升级为 1.6，更新三张相关截图并重新导出 28 页 A4 PDF；逐图来源记录说明其为独立课堂的 API 辅助浏览器验收。

验证结果：

- 后端相关测试 **148 passed**（命令见下），前端全部单测 **409 passed**。
- Mypy（66 个源码文件）、Ruff 检查及格式检查通过；前端 TypeScript 与 Vite 生产构建通过。
- 独立临时课堂、真实 v15 release：公开 API 准备学习记录后，agent-browser 验证结果卡及报告中的 3420→3244 单元筛选、16,220 行回归输入、同单位预设对照、模拟网络解释、2020 提示的年份切换、可选练习反馈。检查 1280 px 与 1200 px 桌面显示，非完整纯 UI 课程验收。
- 手册 PDF 为 28 页 A4；浏览器检查全部页面内容未侵入页脚，`pdftotext` 确认新增说明进入成品。

```bash
# 这些定向测试不使用数据库；用不可连接的测试 DSN 防止触碰课堂库。
GVCSIM_PG_DSN='postgresql://agent@127.0.0.1:1/review_no_database' \
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 \
.venv/bin/python -m pytest -q \
  tests/test_teaching_report.py tests/test_report_pdf.py \
  tests/test_teaching_regression.py tests/test_teaching_icio.py \
  tests/test_indicators.py tests/test_regression_numerics.py tests/test_economics_fixes.py
bun run --cwd frontend test:unit
bun run --cwd frontend build
.venv/bin/mypy
.venv/bin/ruff check .
.venv/bin/ruff format --check .
```

浏览器补充证据位于忽略目录 `dogfood-output/economics-fixes-20260924/`；三张更新后的手册截图及其来源清单随文档维护。

## 一手参考资料

- [OECD, *Development of the OECD ICIO Database 2023*](https://www.oecd.org/en/publications/development-of-the-oecd-inter-country-input-output-database-2023_5a5d0665-en.html)
- [OECD, *Guide to TiVA Indicators 2023*](https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/trade-in-value-added/tiva-indicators-guide-2023.pdf)，尤其 EXGR_FVA/FVASH 定义及 2020 年数据说明。
- [OECD, *Previous Year's Prices ICIO and real GVC indicators*](https://www.oecd.org/en/data/datasets/global-value-chain-data-across-trade-multinationals-and-services.html)
- [OECD, IO shock-analysis substitution limitation](https://one.oecd.org/document/TAD/TC/WP/RD%282023%294/FINAL/en/pdf)
- [Wang, Wei & Zhu, WWZ bilateral/sector gross-export decomposition](https://www.nber.org/papers/w19677)
- [Wang, Wei, Yu & Zhu, production activity decomposition](https://www.nber.org/papers/w23222)
- [Wang, Wei, Yu & Zhu, production length and upstreamness](https://www.nber.org/papers/w23261)
- [NetworkX 官方节点介数定义](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.centrality.betweenness_centrality.html)
- [Cameron & Miller, cluster-robust inference](https://escholarship.org/uc/item/1jq5d0pq)
- [Adão, Kolesár & Morales, shared shocks and shift-share inference](https://www.nber.org/papers/w24944)
- [ASA, p-value statement](https://www.amstat.org/asa/files/pdfs/p-valuestatement.pdf)
