# 步骤 1 至 5 深度审查

审查日期：2026-10-15。基线：`cc` / `125a5fd`。范围为 OECD ICIO 原始表浏览、贸易分解、生产分解、长度分解及全球生产网络计算五页，追踪到自动记录、材料完成判定和报告读数。数据为真实 OECD ICIO 2016–2020，release `8565f226719d4179967f6372dbc7c49e`。

确认 **2 项 P2 问题**，分别是步骤 2–5 的指标元数据失败无提示，以及步骤 1、5 的筛选与翻页竞态。两项均有失败组件测试和真实生产构建浏览器复现。独立核验未发现新的底层计算错误。以下两节保留初次审查的故障描述与基线行号；随后按用户要求二次确认并修复，两项的修复验证见文末。

## RSTEP01 指标元数据失败会静默阻断自动记录

**P2，影响步骤 2、3、4、5。** 首次打开页面时，若 `/api/indicators/schema` 请求失败，即使国家和行业数值接口全部成功，材料卡仍一直显示“正在记录当前选择…”，没有错误提示或重试入口。步骤 5 的表格还会只剩国家、行业和年份三列，全部指标列消失。

四页浏览器结果均为 `alerts=[]`、重试按钮 0、没有保存 `observations`。步骤 2–4 的真实分解表仍显示数值，尤其容易让学生误以为材料正在后台正常保存。恢复接口后当前页面仍停在原状态，刷新页面才恢复记录。

根因在 [auto-comparison.tsx](../frontend/src/labs/steps/indicator/auto-comparison.tsx) 第 64 行：自动记录要求 `schema.status === "success"`，但第 83–85 行只向材料卡暴露国家数值请求的错误和重试。schema 的加载入口位于 [calculation-step.tsx](../frontend/src/labs/steps/indicator/calculation-step.tsx) 第 20 行和 [network.tsx](../frontend/src/labs/steps/indicator/network.tsx) 第 17 行，没有对应错误边界。

影响是无法自动形成新材料、无法正常满足材料完成条件，已有服务端记录没有被删除。修复应把 schema 的加载、错误与重试纳入页面状态，并保证恢复后使用当前国家和年份；已有材料应继续保留，不能把失败伪装成正常记录中。

证据：

- [四页真实浏览器故障与刷新恢复](../dogfood-output/steps1-5-review-20261015/browser/finding-schema.json)
- [步骤 2 截图](../dogfood-output/steps1-5-review-20261015/browser/finding-schema-step2.png)、[步骤 5 截图](../dogfood-output/steps1-5-review-20261015/browser/finding-schema-step5.png)
- [四个失败组件用例及通过的竞态/恢复测试](../dogfood-output/steps1-5-review-20261015/calculation-ui/repro-tests.log)

## RSTEP02 筛选加载期间沿用旧页数导致越界空表

**P2，影响步骤 1 和步骤 5。** 新筛选还没返回时，分页器保留上一筛选的总页数，允许继续翻页。新范围只有一页时仍会请求第二页，随后停在“第 2 / 1 页”，显示无数据。

两条稳定复现路径：

1. 步骤 1 默认中间投入 Z 表为 45 行、2 页。把供给行业改为 C26，在该请求加载期间点“下一页”。最终返回 `page=2, total=1, rows=[]`，有效的 C26 切片显示为空。
2. 步骤 5 国家选“全部”，再改为 CHN，在单国请求加载期间点“下一页”。单国请求每页 200 行、共 45 行，但仍请求第二页并显示空表。

浏览器通过暂缓真实 fetch、正常点击筛选和翻页、随后放行请求复现，没有伪造接口响应或改动后台记录。两页点击“上一页”后都能恢复，其中步骤 5 恢复全部 45 个行业。已记录材料不丢失。

根因是 [db-lab.tsx](../frontend/src/labs/steps/db-lab.tsx) 第 819–822 行的 `lastPages` 和 [indicator-table.tsx](../frontend/src/labs/steps/indicator/indicator-table.tsx) 第 485–487 行的 `knownPages` 没有绑定筛选范围。分页器继续使用旧页数，结果到达后也未纠正越界页码。迟到响应隔离本身正常：旧的第一页没有覆盖第二页，问题出在第二页本就不该被允许请求。

修复应区分同一筛选翻页和新筛选加载，将已知页数绑定筛选范围，或在新结果返回时纠正越界页码；同时保留正常翻页的键盘焦点行为。

证据：[步骤 1 故障数据](../dogfood-output/steps1-5-review-20261015/browser/finding-paging.json)、[步骤 1 截图](../dogfood-output/steps1-5-review-20261015/browser/finding-paging.png)、[步骤 5 故障数据](../dogfood-output/steps1-5-review-20261015/browser/finding-paging5.json)、[步骤 5 截图](../dogfood-output/steps1-5-review-20261015/browser/finding-paging5.png)、[两个失败组件用例](../dogfood-output/steps1-5-review-20261015/step1/recovery-and-race.log)。

## 自动化与独立数值核验

| 检查 | 结果 |
| --- | --- |
| 前端相关既有测试 | 224 项通过：步骤 1 的 31 项，计算/分解/报告相关 193 项，文件不重叠 |
| 额外异常恢复与竞态测试 | 15 项通过；另 6 项按预期失败，分别对应四页 schema 故障与两页分页竞态 |
| 后端相关 pytest | 去重后 220 项通过；两组分别为 54 与 169 项，重叠的 `test_report_labels.py` 为 3 项 |
| 步骤 1 真实 CSV 切片 | 525 次切片，175,500 个数值逐项一致；15,000 项结构、分页、账户转置、行合计断言通过 |
| 后端独立路径计算 | 五年全部 17,325 个行业年份，250 组核验、478,555 个数值通过 |
| 前端分解与显示精度 | 17,710 行、53,130 个分解、766,207 次断言通过；34,434 个金额面板、170,630 行显示值手算核验 |
| API→保存→报告材料 | 51 次认证请求、14,300 个数值、20 条真实材料通过 |
| 生产构建 | `bun run build` 的 TypeScript 和 Vite 构建通过 |
| 真实浏览器矩阵 | 102 条检查通过；五页分别为 27、14、13、13、35 条，另完成 4 个网络 PDF、步骤 1 窄屏及步骤 15 材料核对 |
| PDF 资料与报告清单 | 全部 14 篇本地 PDF 返回有效 PDF 内容；五页已保存标签与步骤 15 清单逐项一致 |
| 主数据故障恢复 | 步骤 2–5 行业请求失败均显示错误和重试，恢复后已有国家材料保持不变 |
| 浏览器未捕获异常 | 主矩阵、故障/恢复及无障碍会话均为 0 条 |
| 无障碍自动审计 | 五页各三个滚动位置，15 次 axe-core 4.12.1 检查均为 0 个确认违规、0 处外层溢出 |

6 个失败用例是已确认问题的最小复现，不与正常测试通过混为一谈。测试脚本和日志保存在忽略目录 `dogfood-output/steps1-5-review-20261015/`，临时组件测试运行后从源码目录移除。

步骤 1 直接对照原始 CSV 的 Z、Y 与 TLS/VA/OUT 账户，核对供给/使用方向、两页及越界页、行列筛选、负存货与零值，以及按当前选列计算的合计。

后端独立算法不调用项目的 loader、逆矩阵或生产/长度实现，而从原始 CSV 递推“0 次、1 次、至少 2 次中间品跨境”的路径和生产阶段数。每年展开 102–110 个生产节点长度，核对前后向活动分量、8 类长度、位置比值、带符号/零活动及国家加权聚合。网络核对正向 Z 边、入/出方向、流量及自环；贸易核对六项闭合与国家加总。

前端 oracle 覆盖 52,009 个正总量完整分解、986 个非正总量、135 个不可用边界；金额、份额和贡献保持一致。147 个不能仅按舍入显示值精确还原的金额面板均触发已有舍入说明。七节点教学网络另用独立最短路径穷举核对度、介数及接近中心性。

保存与报告核对包括材料门槛与理解题分开判定、正确答题后完成状态、浏览不改变已记录材料的报告指纹、陈旧写入返回 409 并保留服务端记录，以及行业级读数不能冒充国家材料。

真实浏览器使用 agent-browser 访问 production 构建。步骤 1 覆盖三表五年、六类最终需求、账户国家切换、行列筛选、翻页、自动与手动记录、键盘导航和全屏退出。步骤 2–4 覆盖全部年份的国家材料/API 精确一致、行业浏览不冒充国家材料、刷新恢复，以及 ITA/C19 负增加值、LUX/T 无活动、CHN/E 无出口边界。步骤 5 覆盖五年国家读数、三个国家的两种行业排序、全部国家分页、展开全部字段、7 节点 × 3 指标教学演示。五页还检查 1000 像素宽度，未见文档横向溢出或非有限图形坐标。

浏览器证据：[矩阵汇总](../dogfood-output/steps1-5-review-20261015/browser/browser-summary.json)、[步骤 1](../dogfood-output/steps1-5-review-20261015/browser/matrix-step1.json)、[步骤 2](../dogfood-output/steps1-5-review-20261015/browser/matrix-step2.json)、[步骤 3](../dogfood-output/steps1-5-review-20261015/browser/matrix-step3.json)、[步骤 4](../dogfood-output/steps1-5-review-20261015/browser/matrix-step4.json)、[步骤 5](../dogfood-output/steps1-5-review-20261015/browser/matrix-step5.json)、[主数据恢复](../dogfood-output/steps1-5-review-20261015/browser/main-recoveries.json)、[步骤 15 材料清单](../dogfood-output/steps1-5-review-20261015/browser/report-materials.json)。

证据入口：[步骤 1 汇总](../dogfood-output/steps1-5-review-20261015/step1/summary.json)、[后端汇总](../dogfood-output/steps1-5-review-20261015/backend/summary.json)、[前端数值汇总](../dogfood-output/steps1-5-review-20261015/calculation-ui/real-data-oracle-summary.json)、[无障碍审计](../dogfood-output/steps1-5-review-20261015/a11y/assessment.json)。

## 非阻断观察与覆盖限制

步骤 4 的位置公式分别将两个操作数和结果保留三位小数，少量结果不能按显示操作数精确验算。例如 FIN 国家整体 2020 显示 `4.127 / 3.959 = 1.043`，显示操作数相除后取三位为 `1.042`。底层比值正确，差异来自舍入；可以考虑用近似等号或说明“按未舍入数值计算”。本次将其列为显示精度观察，不计作第三项计算错误。[浏览器读数](../dogfood-output/steps1-5-review-20261015/browser/precision-observation.json)

步骤 5 行业表只使用中间品流量，自动报告材料则是国家整体出口加进口，包含中间品和最终品、不含国内流量。两种范围不能直接相加对比；页面材料卡和后端报告已明确说明，未将其列为缺陷。步骤 2–4 探索行业时，自动报告材料也始终明确为所选国家的国家整体代表指标。

无障碍审计的 `incomplete` 包括对比度自动判定失败，以及阅读列表通用 `div` 的 `aria-label` 需人工判读；未将其当作确认违规。没有测试真实屏幕阅读器或 PDF 内部内容，不能据此宣称完整 WCAG 合规。

本次没有重算完整真实网络全部 Brandes 介数，也没有逐项重展开真实数据的全部 WWZ Table A2 项；这些方法使用既有独立小系统与 golden 测试，真实数据另核对流量、闭合与聚合。没有重跑完整 `scripts/local_ci.sh`、生产部署、负载验收或完整报告提交评分旅程。

选取部分后端测试直接运行时，遇到既有循环导入收集问题和未初始化临时库缺少理解题配置的问题。先导入 API、初始化独立临时库后，所选测试全部通过；初始日志与最终日志均保留，未把环境/收集问题算作本次页面缺陷。所有数据库测试均显式使用独占一次性数据库。

初次审查结束后，已关闭当次三个浏览器会话和 API/preview 服务、删除所有自建临时数据库及源码目录中的临时测试文件。截图、日志和复现脚本保留在忽略目录，没有操作既有课堂数据库。


## 二次确认与修复

在未修改的 `125a5fd` 上重新执行 21 项验收用例，得到 15 项通过、6 项预期失败，分别对应四页的元数据失败恢复和两页的分页竞态。修复后同一组用例全部通过；验收断言要求错误和重试可见，以及新筛选不会请求越界页，不依赖原先的错误文案或分页按钮必须存在。

- **RSTEP01 已修复。** 自动材料状态同时纳入元数据和国家数据的加载、失败和重试，只重试失败依赖。已有材料在失败与重试期间保持可见，明确区分旧记录和当前选择；恢复后仅记录最新国家与年份，锁定材料不自动改写。缺少元数据时优先使用已保存标签，旧记录缺少标签时按单位格式化，百分比不会变成小数。步骤 5 保留国家、年份控件，元数据未就绪时隐藏不完整指标表。
- **RSTEP02 已修复。** 步骤 1、5 的已知页数绑定完整筛选范围。新范围加载或失败时不沿用旧页数，切回旧范围也等待新结果；同一范围翻页继续保留分页器节点和键盘焦点。

新增 20 项永久回归测试：13 项覆盖四页元数据恢复、重试期间切换选择、已有/锁定材料和双依赖失败；7 项覆盖分页竞态、迟到响应、范围往返、失败重试、正常翻页焦点及首末页/输入行为。

| 修复后检查 | 结果 |
| --- | --- |
| 同一组问题验收 | 21 项通过，0 失败（修复前 15 通过、6 失败） |
| 全量前端单元测试 | 1,067 项通过，0 失败；98 文件、7,519 次断言 |
| TypeScript 与构建模式 | `bun run test:build-modes` 通过生产→演示→生产三次构建，最终为生产产物 |
| 独立代码复核 | 两项修复及全部新增用例未发现阻断问题；`git diff --check` 通过 |
| 生产构建真实浏览器 | agent-browser 验证四页共 8 次 schema 恢复；已有材料在故障重载时的完整会话保持不变，重试中切换选择后与真实 API 精确一致 |
| 筛选与焦点 | 两页新范围加载时均无法误入第二页；同范围翻页时按钮 DOM 与焦点保留，结果行数与接口一致 |
| 窄屏与运行异常 | 四页 1000 像素宽度无外层横向溢出；浏览器未捕获异常 0 条 |

本次修改仅涉及前端故障恢复和分页状态，没有更改底层计算；上文大规模数值 oracle 和后端测试属于初次审查结果，没有在此次修复阶段重新执行。非阻断的 FIN 显示舍入观察保持原样。

修复证据：[二次确认基线](../dogfood-output/steps1-5-fixes-20261015/second-confirmation/baseline.log)、[同组验收](../dogfood-output/steps1-5-fixes-20261015/validation/acceptance.log)、[前端全量测试](../dogfood-output/steps1-5-fixes-20261015/validation/frontend-unit.log)、[构建模式](../dogfood-output/steps1-5-fixes-20261015/validation/build-modes.log)。


浏览器使用独占一次性数据库和真实生产前端，通过阻断元数据请求、暂缓真实数据响应来复现，不伪造数值。四页均先验证空材料故障→重试期间切换选择→记录当前值，再验证已有材料故障重载→重试期间保留原记录→恢复当前值。步骤 5 恢复后完整显示 45 个行业和指标列。

浏览器证据：[汇总](../dogfood-output/steps1-5-fixes-20261015/browser/summary.json)、[四页恢复与材料](../dogfood-output/steps1-5-fixes-20261015/browser/schema-recovery.json)、[步骤 1 筛选](../dogfood-output/steps1-5-fixes-20261015/browser/step1-narrow.json)、[步骤 5 筛选](../dogfood-output/steps1-5-fixes-20261015/browser/step5-narrow.json)、[步骤 1 焦点](../dogfood-output/steps1-5-fixes-20261015/browser/step1-page-focus.json)、[步骤 5 焦点](../dogfood-output/steps1-5-fixes-20261015/browser/step5-page-focus.json)、[错误与旧材料窄屏截图](../dogfood-output/steps1-5-fixes-20261015/browser/step2-existing-error-1000.png)、[步骤 5 错误截图](../dogfood-output/steps1-5-fixes-20261015/browser/step5-schema-error.png)。

浏览器脚本最初把全局分页默认大小写成 50，实际接口默认为 25；已改为按真实请求响应核对。agent-browser 的错误结果还包含 lifecycle 元数据，断言也已改为只检查 errors 数组。相关检查修正后通过，初始日志保留；这两处是测试脚本假设问题，没有据此更改业务代码。

修复验证结束后，已关闭本次 agent-browser 会话及 API/preview 服务，删除独占临时数据库和源码目录中的临时验收文件。业务修复、20 项回归测试及本记录一并纳入修复提交。
