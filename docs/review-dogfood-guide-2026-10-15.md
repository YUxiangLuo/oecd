# 24 小时改动总结与审阅／试用指南（2026-10-15）

对象：`cc` 分支从 `0348911^`（PR #62 合入前）到 `0495639`（PR #67 合入后），2026-10-14 06:30Z 至 2026-10-14 22:55Z 合入的 6 个 PR、24 个非合并提交，130 个文件（其中 `benchmarks/` 与手册截图占绝大部分行数）。数据 release 未变：`8565f226719d4179967f6372dbc7c49e`；教学生成契约 v12 → **v13**（P17），会话契约 → **v4**，教学库 → v15。实验手册 2.24 → **2.28**。

本文件只做两件事：把这 24 小时的改动按主题讲清楚，然后给出审阅（看代码）和 dogfood（真实操作）的具体清单。设计依据与每个数字的来源在各主题指向的方案文档里，不在这里重复。

## 1. 六个 PR 一览

| PR | 合入 | 主题 | 规模 | 方案／记录 |
| --- | --- | --- | --- | --- |
| #62 | 10-14 15:32 | 步骤 10–15 精简：报告材料固定为默认 Y 的默认模型，预设实验 + 每步一个记入报告的模型；全模型空间核查；最终优化方案 | 65 文件 +7.3k −2.3k | `regression-steps-simplification-2026-10-14.md`、`regression-model-space-check-2026-10-14.md`、`regression-steps-11-14-optimization-final-2026-10-14.md` |
| #63 | 10-14 19:37 | 教学生成器 v13（P17）：改不同模型设定真的得到不同数值；设定值句、两档预设、拆分句、更全的回归表；**因变量下拉框**；round 10 深度 dogfood 修两处 | 41 文件（含 benchmarks） | 同上最终方案第 4–8 节 |
| #64 | 10-14 20:40 | 步骤 1–10、15 页面优化计划（只文档） | 1 文件 | `steps-1-15-page-optimization-plan-2026-10-14.md` |
| #65 | 10-15 06:50 | 计划阶段 1 + 2a：步骤 15 报告按节折叠；6–9 改为显式记录、标签平等；任务卡横幅删除；步骤 8、1、10 小收口 | 36 文件 +727 −360 | 计划第 10 节实施记录 |
| #66 | 10-15 07:04 | 计划阶段 3：步骤 10 的 38 国列表并入读数表折叠；实验手册 2.27 全部 20 张图重拍、PDF 重导 | 27 文件 | 计划 6.3 |
| #67 | 10-15 07:54 | 每步一张统一的「本步报告材料」卡片；每条记录保存 `material_label`；步骤 15「你记录的材料」表；放入报告 → 记入报告 | 35 文件 +714 −285 | 本文件第 2.5 节 |

## 2. 按主题的改动

### 2.1 步骤 11–14：工作台精简（#62）

- 报告材料固定为本步默认 Y 的默认模型；条形图只读探索；“添加到对比／保存模型／放入报告”三套语义合并为“预设实验 + 每步最多一个记入报告的模型”。
- 理解题移到折叠的工作台之前（步骤 10–14 同样）。
- 步骤 15 的面板与报告附录改为每步一次运行、一个实验（`gvcsim/report_workbench.py`、`report_render.py`）。
- 会话契约 v4：旧版 `qualified_run`／`custom_results` 记录在保存时被 `gvcsim/classroom/routes.py::_checked_session` 拒绝并提示。
- 前端 `regression.tsx` 拆成 `frontend/src/regression-step/`（`result-card`、`model-equation`、`family-bars`、`saved-run`、`use-regression-run`）。

### 2.2 步骤 11–14：v13 生成器与页面 F1–F4（#63）

- 数据侧（`gvcsim/regression/teaching.py`）：GDP 混杂与关税同向、开放度反向、汇率贬值 −8.0、共同年份变化改为锯齿；新增 `first_wave_decomposition` 与 `simulation_parameters()["macro_paths"]`。效果：去掉汇率／GDP／开放度／年份固定效应各带来 6–20% 的可见变化，默认模型仍恢复真值（200 种子基准 `benchmarks/teaching_design_v13.json`）。
- F1 结论卡写“课程设定值 … 你算出 … 偏差 ±n%”，`options()` 返回 `design_values`；F2 预设分“必看／进阶”两档，国家×年份 FE 与 L2.X 在表单里解释为什么按设计不变；F3 走势图下的第一批 2020 年拆分句（运行响应 `decomposition`）；F4 单模型详细表默认展开，加显著性列、Prob > F、Root MSE。
- **因变量下拉框**：自定义模型可在本步指标族内换 Y（`gvcsim/regression/workbench.py`、`regression-workbench.tsx`），报告按（步骤，Y）记录与打印。
- round 10 修复：刷新后分解句丢失；导出 CSV 缺“课程设定值”行。
- 核查脚本：`scripts/check_model_space.py`（新增三项判定、修复预设元组解包）、`scripts/teaching_variants.py`。

### 2.3 步骤 15 与横向收口（#65 阶段 1）

- 报告正文按二级标题折叠（`frontend/src/report-renderer.tsx` 的 `rehypeFoldSections`、`FOLDED_REPORT_SECTIONS`），默认只展开结论、真实指标比较、关键证据摘要；打印前全部展开、打印后恢复；教师端不折叠。页面高度 24,889 → 9,389 px。
- 任务卡“自动记录已暂停”横幅删除（`step-task-card.tsx`）。
- 步骤 8 “前后向位置”只画轨迹图，读数卡两张在前、其余进“更多读数”（`viz/card-grid.tsx`，`CARDS_IN_VIEW = 2`）。
- 步骤 10 默认对照国改为澳大利亚（`teaching-example.ts`）；38 国列表并入读数表折叠（#66，`viz/regression/country-exposure.tsx`）。

### 2.4 步骤 6–9：显式记录、标签平等（#65 阶段 2a）

- 不再自动记录“最后看的一张图”。每张可记录的图有一个按钮“把这张图记为本步报告材料”，保存 `material_chosen: true`，报告写“学生选定”。
- 不能记录的标签（定位图、行业结构、步骤 9 的四个探索标签）在同一位置写“这张图没有可记录的读数条目”。阶段 2b（把这六类图接入记录）明确不排期。
- **行为变化**：新学生在 6–9 必须各点一次按钮才算材料齐全。旧会话的自动记录在报告里措辞不变。

### 2.5 统一材料卡与 `material_label`（#67）

- 新组件 `frontend/src/material-card.tsx`：`<section aria-label="本步报告材料">`，三种状态芯片（已记录／尚未记录／暂不能记录），一句话材料内容，一行记录方式，卡内唯一的记录按钮，唯一的“核对读数”折叠。所有步骤 1–14 放在主图表／表格下方、理解题上方。
- 句子生成在 `frontend/src/material-label.ts`（`vizMaterialLabel`、`networkMaterialLabel`、`shockMaterialLabel`、`regressionMaterialLabel`），步骤 2–5 由 `auto-comparison.tsx::indicatorMaterialLabel`，步骤 1 由 `db-lab.tsx::withDbLabel`。
- 每条记录多存一个 `material_label` 字符串；服务端放在 `gvcsim/classroom/records.py::_VIEW_ONLY_KEYS`，**不进报告指纹**，所以旧记录没有这个键也不触发“报告需更新”。
- 步骤 15 新增「你记录的材料」表（`report-lab.tsx::RecordedMaterials`）：14 行，同一套句子，未记录的行给原因并可跳回该步；旧记录无句子时显示“已记录（旧记录，到本步查看）”。
- 全局用词：放入报告 → 记入报告；11–14 的实验按钮为“也记入报告（选做）／已记入报告／从报告移除”。
- CI journey 脚本改为等 `.material-card button.material-card-action`。

### 2.6 文档与手册

- 实验手册 2.25（v13 文案）→ 2.27（全部 20 张图在 v13 重拍、PDF 28 页）→ 2.28（材料卡文案，**截图未重拍**，影响图 3、5–13、15–16）。
- 技术手册：1.6／6.2／15.1（v13）、`material_label` 视图键。`README.md`、`DEPLOY.md` 同步 v13。

## 3. 需要重点审阅的行为变化

| # | 变化 | 影响 | 看哪里 |
| --- | --- | --- | --- |
| B1 | 旧 `qualified_run`／`custom_results` 记录保存时被拒绝 | 已有学生的旧会话若在 11–14 保存会收到提示，需重做该步 | `gvcsim/classroom/routes.py::_checked_session`，提示文案 |
| B2 | 6–9 必须按按钮 | 旧会话的自动记录仍算齐全；新会话不按则步骤 15 门槛不过 | `gvcsim/report_gate.py`，`network.tsx`／`indicator-explorer.tsx` 的保存路径 |
| B3 | 报告默认折叠 | 学生可能以为报告变短；打印必须完整 | `report-renderer.tsx`、`report-lab.tsx` 的 beforeprint／afterprint |
| B4 | 步骤 10 对照国换为 AUS | 已有报告里的例子不变（随记录），新学生默认见澳大利亚 | `teaching-example.ts`、`shock-lab.tsx` |
| B5 | v13 数值全部变化 | 任何写死数字的文案、测试夹具、手册都要对 | `regression-workbench-options.fixture.json`、`benchmarks/`、手册 11–14 节 |
| B6 | `material_label` 只存不校验 | 句子与记录内容不一致时不会被服务器发现 | 第 4.4 节的检查项 |
| B7 | 用词“记入报告” | 旧截图、手册旧段落、教师端文案是否还有“放入报告” | `grep -rn 放入报告` 应只剩历史文档 |

## 4. 审阅指南（看代码）

建议按 PR 顺序读，每个 PR 的 body 都列了“审阅重点”。以下是跨 PR 最值得花时间的地方。

### 4.1 后端：会话契约与记录投影

- `gvcsim/classroom/records.py`：`_VIEW_ONLY_KEYS` 现含 `material_label`；`projected` 把它剔除后再算指纹。确认 `experiment` 的处理（第 90–91 行）在 11–14 之外的步骤仍为 `None`。
- `gvcsim/classroom/routes.py::_checked_session`：v4 拒绝路径的错误码、文案，以及是否可能误拒绝合法的新记录（例如只带 `experiment` 不带旧键）。
- `gvcsim/report_gate.py`：6–9 的齐全条件是 `material_chosen` 或旧式自动记录二者之一；确认没有第三种状态漏判。
- `gvcsim/report_workbench.py`／`report_render.py`：每步一个实验表；换 Y 的实验在附录里标注 Y；“学生选定”措辞只出现在 `material_chosen` 为真的材料。
- `gvcsim/regression/workbench.py`：因变量下拉的候选集严格等于本步指标族；传入族外的 Y 要 4xx 而不是 500。

### 4.2 后端：v13 生成器与估计

- `gvcsim/regression/teaching.py`：常量（`COMMON_GDP_GROWTH`、`WAVE1_EXTRA_GDP_GROWTH`、`WAVE1_OPENNESS_RISE` 等）与最终方案第 4 节的 P17 表逐项对照；`first_wave_decomposition` 的恒等式（各分项之和等于总变化）。
- `gvcsim/regression/estimation.py`／`model.py`：Root MSE、Prob > F、固定效应模型无常数项；显著性列的阈值。
- `scripts/check_model_space.py`：三项新判定的方向（漏 GDP 高估、漏开放度低估、去掉年份 FE 低估）与 `RECOVERY_TOLERANCE` 的取值是否写明理由。

### 4.3 前端：材料卡与句子

- `material-card.tsx`：一个卡片只渲染一个按钮；`state` 与 `action.disabled` 的组合是否都有对应的 `how` 文案；`role="status"` 的摘要在状态切换时会不会反复播报。
- `material-label.ts` 与各步调用方：句子里的国家名、行业名、年份区间、读数条数来自与保存内容相同的变量，不是来自另一处 UI 状态（B6）。
- `indicator-explorer.tsx`、`network-trend.tsx`：“已记录的是另一张图；当前图表暂不能记录：原因”的分支，确认 `blockedReason` 覆盖了换标签、换国家、无效年份、定位／结构图四种情况。
- `regression.tsx`：`regressionMaterialLabel` 用 `perPointDigits` 取位数；区间端点与结论卡显示的一致。
- `report-lab.tsx::RecordedMaterials`：缺失原因过滤掉理解题类文案；点击标题按钮调用 `onNavigateStep` 后焦点落到目标步的卡片（`tabIndex=-1` 的 section）。

### 4.4 前端：报告折叠与打印

- `report-renderer.tsx::rehypeFoldSections`：只对二级标题折叠；未知标题默认展开；`foldSections=false` 时输出与改前完全一致（教师端走这条路径）。
- `report-lab.tsx`：`beforeprint` 展开后 `afterprint` 恢复的是用户当时的开合状态，而不是全部收起；`window.print()` 与 Ctrl+P 两条路径都触发。

### 4.5 测试与脚本

- 新增／改动的测试是否覆盖了行为变化本身而不只是快照：`tests/test_classroom.py`（v4 拒绝、`material_label` 投影）、`tests/test_report_fingerprint.py`、`frontend/src/material-card.test.tsx`、`material-label.test.ts`、`report-lab` 的 RecordedMaterials 用例。
- `scripts/agent_browser_course_journey.py`：6–9 的等待条件与按钮文案；步骤 15 的门槛断言。
- 已知：`tests/test_report_fingerprint.py` 单独运行会循环导入，需与 `test_classroom` 一起跑（改动前就存在）。

## 5. Dogfood 指南（真实操作）

### 5.1 环境

1. 新建空库，不要复用旧课堂：`createdb -U agent -h 127.0.0.1 gvclab_dogfood_$(date +%Y%m%d)`，`GVCSIM_PG_DSN` 指向它。
2. 后端：`GVCSIM_DEMO_MODE=1 GVCSIM_BOOTSTRAP_PASSWORD=gvclab2026 uv run gvcsim serve --port 8000`。
3. 前端：`cd frontend && bun run build:demo && bun run preview -- --port 4173`（或 `bun run dev`）。演示构建自带 `student`、`student02`–`student50`（口令 `gvclab2026-NN`）与 `teacher`。
4. 一个“已完成全流程”的账号用 `uv run python scripts/seed_full_journey.py` 生成，用来看步骤 15、教师端和旧记录兼容。
5. 浏览器用 `agent-browser`，每条发现截图；分辨率至少跑 1440×1000 与 1000 px 宽各一次。

### 5.2 自动化先跑

| 项 | 命令 | 期望 |
| --- | --- | --- |
| 本地 CI | `bash scripts/local_ci.sh` | 全绿：后端 1,237、前端 955、课程 journey 15 步、教师 journey |
| 模型空间 | `uv run python scripts/check_model_space.py` | 与 `benchmarks/model_space_v13.json` 一致（20,111 次，12 个已知的加权出度偏离） |
| 单项改动表 | `uv run python scripts/teaching_variants.py --variant v13` | 与最终方案第 5 节表一致 |
| 报告快照 | `uv run python scripts/dogfood_report_snapshots.py` | 通过（只改展示不改已保存回归） |

### 5.3 学生端逐步清单（空白账号）

每一步都先核对三件事：卡片是否在主图表／表格下方、理解题上方；页面上除卡片外没有别的记录按钮；卡片句子与你刚做的选择一致。

| 步骤 | 操作 | 期望 |
| --- | --- | --- |
| 1 | 进入即看卡片；点另一格 | 进入为“已记录”默认格；点击后句子换成新格，无需按钮 |
| 2–5 | 换国家、换年份 | 卡片随选择更新为“已记录”，记录方式写“随你的选择自动记录”；“核对读数”条数与表一致 |
| 6–8 | 开页、换标签、换国家都不点按钮 | 始终“尚未记录”；进入步骤 15 时该步列为缺失并可跳回 |
| 6–8 | 在历年变化点按钮 | 变“已记录”，按钮变禁用文案；换到定位图／行业结构时卡片写“这张图没有可记录的读数条目”；换到另一张可记录图时写“已记录的是另一张图；当前图表暂不能记录：…” |
| 8 | 看“前后向位置”与“历年变化” | 轨迹图只在前者；读数卡两张在前、其余在“更多读数” |
| 9 | 四个探索标签 + 趋势图 | 只有趋势图能记录；换指标后句子里的指标名跟着变 |
| 10 | 默认例子；换对照国；展开读数表 | 默认 CAN 对 AUS · C29；卡片句子随换国更新；38 国列表只在折叠内，方向键走到末尾自动展开 |
| 11–14 | 只算默认模型 | 卡片“已记录”，句子含两年累计与 95% 区间，位数与结论卡一致；“记入报告的模型实验：无（选做）” |
| 11–14 | 点一个必看预设 → 也记入报告 | 偏差百分比与 PR #63 的表同量级（汇率 +13%、GDP +9%、开放度 −6%、年份 FE −9%…−20%）；卡片第二行出现实验名；“从报告移除”后恢复“无” |
| 11–14 | 自定义：换因变量 | 下拉只列本步指标族；计算后结果、报告附录都标明该 Y；刷新后分解句仍在；导出 CSV 含“课程设定值”行 |
| 11–14 | 一分钟内算 20 个新设定 | 第 21 个提示倒计时；已算过的设定仍可用 |
| 15 | 门槛页 | 「你记录的材料」14 行，句子与各步卡片逐字一致；缺失行点标题跳回且焦点落在该步卡片 |
| 15 | 生成报告 | 默认只展开结论、真实指标比较、关键证据摘要；Ctrl+P 预览全部展开，取消后开合状态恢复；附录“模型实验”每步最多一个表，6–9 的材料写“学生选定” |
| 15 | 提交后回到 6–9 | 按钮变“替换报告材料（之后需在步骤 15 更新报告）”；替换后步骤 15 提示报告需更新 |

### 5.4 兼容与并发

- 用 `seed_full_journey.py` 的旧账号打开 6–9 与 15：旧自动记录算齐全，材料表显示“已记录（旧记录，到本步查看）”，报告不提示需更新（`material_label` 不进指纹）。
- 带旧 `qualified_run` 的会话（可从 v12 前的备份恢复一条）在 11–14 保存：收到 v4 拒绝提示，页面给出重做路径，不丢其他步骤的数据。
- 两个标签页同一账号：A 在步骤 7 记录，B 在步骤 7 换标签不记录；刷新 B 后卡片显示 A 的记录。11–14 两处各记入一个实验，冲突提示仍是“载入服务器版本”的旧逻辑，确认记入报告的是哪一个。
- 教师端：报告不折叠；附录可见换 Y 的实验与其 Y；评分流程不受影响。

### 5.5 数值抽查

- 11–14 每步取默认模型与 3 个预设，把页面系数、区间、Prob > F、Root MSE 与 `GET /api/regression/...` 的响应对照，再与 `check_model_space.py --variant v13` 的记录对照（相对差应 < 1e-9）。
- 拆分句：各分项之和等于走势图上第一批 2020 年的变化。
- 步骤 2–5 与 6–9 任取 10 组读数，与接口响应逐值对照。

### 5.6 已知未改，不必重复报

- 报告附录统计块没有 Prob > F 与 Root MSE（只有单模型详细表有）。
- 极小系数显示为 0.0000。
- 实验手册 2.28 的截图是 2.27 的界面（无材料卡），图 3、5–13、15–16 待重拍；重拍流程见 `docs/student-manual/README.md`。
- 阶段 2b（定位图、行业结构等六类图接入记录）不排期。

## 6. 发现的记录方式

沿用 `docs/review-dogfood-2026-10-11.md` 的格式：P1（数据丢失／错误数值）、P2（功能错误、可访问性 serious）、P3（外观文案）、需要决定。每条写操作路径、账号、截图路径、复现次数；数值问题附接口响应。本轮之后的修复放在新分支，PR body 引用本文件的条目编号。
