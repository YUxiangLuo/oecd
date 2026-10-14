# 步骤 10–14 精简方案（含步骤 15 同步改动）

> 分析与路线建议，不含实现。当前行为以[技术手册](../技术手册.md)和[实验手册](../实验手册.md)为准；上一轮重构的决策见[步骤 10–14 回归相关页面重构分析](regression-steps-redesign-analysis.md)。

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-10-14 |
| 基线 | `cc` 分支 d7a74f5；本地 release `93c475281b7d4246afc33f4ec2239744`（v12，2016–2020）；教学库 `gvcsim-teaching-db-v14` |
| 性质 | 分析与分阶段计划，不含实现 |
| 问题 | 步骤 10–14 页面内容杂乱、缺乏主次；步骤 11–14 的“点条保存”“保存模型”“在上表对比”“放入报告”多套语义并存，认知成本高、bug 面大 |
| 结论 | 每个回归步骤只回答一个问题：报告材料固定为本步默认 Y 的默认模型，条形图改为只读探索；工作台改成“预设实验 + 每步一个放入报告的模型”；步骤 15 面板和报告四处同步改为每步一次运行、一个实验 |
| 相关分支 | `feat/regression-learning-flow`（f331f0a）建议不合并，其三处版面改动在阶段 1 重做，见第 5 节 |

## 1. 现状

### 1.1 实测方法

用 demo 构建（`bun run build:demo`）、新建空教学库和重算后的 v12 release 启动服务，以 `student` 登录逐页截图；以 `student02` 用 `scripts/seed_full_journey.py` 走完全程，在步骤 11 保存一个自设模型并勾选“放入报告”，再到步骤 15 生成草稿报告，核对会话记录与报告正文。视口 1440×1000。

### 1.2 页面高度与区块顺序

| 步骤 | 完整页面高度（像素） | 区块顺序 |
| --- | --- | --- |
| 10 | 约 4,500 | 任务卡 → 情景（4 块概念卡 + 3 个统计卡）→ 举例选择 → 五年趋势两张图 → 逐年表 → 37 国排序图 + 75 国读数表 → 理解题 |
| 11 | 约 4,900 | 任务卡 → 快捷链接 → 先看数据 → 默认模型 + 计算按钮 → 本类 Y 条形图 → 结论卡 → 改模型、对比（选做）→ 理解题 |
| 12 | 约 5,200 | 同上 |
| 13 | 约 5,000 | 同上 |
| 14 | 约 5,100 | 同上 |

步骤 11–14 跑完回归后的内容明细：

| 顺序 | 区块 | 性质 |
| --- | --- | --- |
| 1 | 任务卡：目标 + 3 条任务 + 2 个状态 | 必读 |
| 2 | 快捷链接“查看已保存结果 / 修改模型（选做）” | 导航 |
| 3 | “先看数据”：问题句 + 三组趋势图 + 折叠读数 + 3 行平行趋势说明 | 必读 |
| 4 | “默认模型”：方程 + 3 条解释 + 折叠算法说明 + 生成数据提示 + 计算按钮 + 提交后警告 | 必做 |
| 5 | 本类各 Y 条形图：点击某条即“改为保存该 Y”，带“已保存”标签、“当前保存…恢复默认”，灰条弹确认框 | 半必做 |
| 6 | 结论卡：黄色生成数据声明 + 结论句 + 方向徽章 + 当年／次年拆分 + 例子换算长句 + 解释限制 + 警告 | 必读 |
| 7 | “改模型、对比（选做）”：5 条试一试 + 16 个复选框 5 个下拉 + 方程预览 + 2 个按钮 + 折叠详细数字 + 对比图 + 约 20 行结果表 + 导出 CSV + 保存行（命名 + 保存）+ 已保存模型表（对比勾选、放入报告勾选、改名、删除）| 选做，占页面近一半 |
| 8 | 3 道理解题 + 提交 | 完成条件 |

### 1.3 三个主次失衡的根源

- **完成条件在最底部。** 学生必须做的只有“点一次计算、读结论句、答对 3 题”，理解题却被约 2,500 像素的选做工作台隔开。侧栏显示“理解题未完成”，页面上看不到题在哪。
- **一页里有三套“保存”语义。** 点条形图 = 替换本步报告材料（静默，灰条弹确认）；工作台“保存” = 自设模型命名入库；“放入报告”勾选 = 进报告附录；另有“在上表对比”勾选、“恢复默认”（换回 Y）、“恢复默认设定”（换回模型）。它们又与“报告已提交后材料被替换”的提示相互叠加。
- **四步重复讲同一件事。** 步骤 12–14 的任务说明已写明“同一个默认模型换 Y”，每页仍完整展开方程解释、平行趋势说明、试一试清单；黄色生成数据声明在计算前和结论卡里各出现一次。

### 1.4 代码与测试

| 文件 | 行数 | useState / useRef / useEffect |
| --- | --- | --- |
| `frontend/src/regression.tsx` | 987 | 12 / 11 / 8 |
| `frontend/src/regression-workbench.tsx` | 615 | 13 / 4 / 4 |
| `frontend/src/labs/steps/shock-lab.tsx` | 586 | 6 / 3 / 3 |

`regression.tsx` 约一半的 state 和 ref 只为“点条保存”服务：灰条确认框、替换提示归因于按钮还是条、失败重试放在条下还是按钮上、焦点回到哪一条、运行按钮的 5 种文案。工作台另有改名、删除、重名检测、对比上限、报告上限、焦点恢复。相关测试约 10,500 行，其中直接绑定“点条保存、`qualified_run`、命名、放入报告”语义的约 3,000 行（`regression-ux.test.tsx` 721、`regression-workbench.test.tsx` 629、`tests/test_workbench.py` 533，以及 `test_teaching_report.py`、`test_route_adapters.py`、`test_classroom.py`、`test_steps.py`、`test_session.py`、`test_seed_full_journey.py` 的相关用例）。

## 2. 记录如何进入报告

### 2.1 数据流

| 步骤 | 会话里保存什么 | 报告里用在哪 |
| --- | --- | --- |
| 10 | `compared`、`teaching_industry`、`teaching_country`、`teaching_year`、`viewed_teaching_panel`、`teaching_panel_version`、`teaching_observation`（w、τ、X） | “保存的实验快照 · 步骤 10”；步骤 11–14 每段的“按步骤 10 的例子换算” |
| 11–14 | `run`（约 8.7 KB）、`qualified_run`（同一内容的第二份副本）、`custom_results[]`（每个约 2 KB：id、name、spec、in_report、snapshot）、`custom_draft`（视图状态） | “四项回归结果汇总”表和图；每步一张本类 Y 图 + 一张结果表 + 例子换算；“技术附录：保存的回归结果”每步一张系数表；“附录：学生设计的模型”；步骤 15 页顶“四步回归结果”面板 |

student02 的步骤 11 记录约 20 KB，四步约 80 KB，占 300 KB 保存预算的四分之一，其中一半是 `qualified_run` 的重复副本。

### 2.2 决定简化安全的三个事实

- **报告数字从不读浏览器快照。** `gvcsim/report_saved_run.py` 的 `server_runs` 只拿保存记录里的（步骤，Y）去服务器缓存重算；自设模型由 `gvcsim/report_workbench.py` 的 `recompute` 按 spec 重算。保存的快照只用于刷新后恢复页面。改掉“点条保存”不影响任何报告数值。
- **`qualified_run` 在后端已经是空转。** 报告门槛 `_gate_qualified_runs` 直接返回 `_saved_runs`，并不检查是否 qualified；前端 `nextRegressionSave` 维护的第二份副本只会让报告为一步打印两次计算并标注“（用于汇总表）/（另一次计算，未用于汇总表）”。这整套分支只因允许学生换 Y 才存在。
- **理解题不依赖这些交互。** 步骤 10–14 的默认题目只问 X 的定义、两年累计、控制变量、单位、区间含义，没有一题涉及“点击另一条”“保存”或“放入报告”。要改的只有 `gvcsim/steps.py` 的任务文案和实验手册。

### 2.3 另外两个发现

- **换 Y 的预览不需要调服务器。** 条形图来自 `/api/regression/teaching-overview`，它已包含本类每个 Y 的估计和区间。现在点条会触发一次服务器回归、一次会话保存、一套限流和失败重试；预览只需在本地显示该条的数字。
- **步骤 15 面板与报告对 `custom_results` 的读取有三处**：`regression-teach.tsx` 的 `ReportedCustomModels`、`report_workbench.reported_models`、`classroom/records.py` 的报告指纹投影 `_report_data`。三处都只取 `in_report` 为真的项，改为单个对象时改动集中。

## 3. 目标形态

### 3.1 步骤 10：不改语义，只收版面

- 4 块概念卡（X、L1.X、汇率变动、GDP 与贸易开放度）合并成一条两行的定义带。
- 逐年表、75 国读数表默认折叠。
- 37 国排序图只显示前 15 个国家，提供“展开全部”。
- 例子选择器仍是页面主动作；记录结构和报告门槛不变。

### 3.2 步骤 11–14：每页只回答一个问题

自上而下固定为五段：

1. **问题与数据**：一句问题 + 三组趋势图；平行趋势说明折叠为“这张图怎么读”。
2. **计算**：方程一行；逐项解释在步骤 11 展开、12–14 折叠；一个按钮；黄色生成数据声明整页只出现一次（放在结论卡）。
3. **结论**：结论句 + 方向徽章 + 本类各 Y 条形图。条形图只读：悬停或方向键看区间，点击在图下显示该 Y 的一句预览，不写任何记录。报告材料固定为本步默认 Y 的默认模型。例子换算拆成两行，细则折叠。
4. **理解题**：紧跟结论，答完即可下一步。
5. **模型实验（选做，默认折叠）**：
   - 5 个预设按钮对应现有 `TRIES` 的 5 条（去掉汇率变动、只放当期 X、固定效应改为国家 + 行业 + 年份、去掉 GDP 对数、加人口增长率与 FDI），点一下就算；完整表单收进“自定义设定”折叠。
   - 结果表只有“默认 / 本次”两列加对比图；详细数字和导出 CSV 放在折叠里。
   - 保存语义只剩一个按钮“把本次放入报告”，每步最多一个，再点即替换，另有“移出报告”。不命名、不改名、不删除、不勾对比。报告里的名称由服务器按与默认模型的差异自动生成（如“去掉汇率变动”），不再有学生输入的文本。

由此删除：灰条确认框、“已保存”标签、“当前保存…恢复默认”、按条归因的替换提示、条下的独立重试、`qualified_run` 双轨记录、提交后“点条会替换材料”的警告、命名与重名检测、改名、删除确认、对比勾选与上限、焦点恢复链。

### 3.3 步骤 11–14 的记录契约

```
{
  quiz,
  run,                       // 默认 Y 的默认模型，仅用于刷新后恢复页面
  experiment?: { spec, snapshot, saved_at },   // 放入报告的一个自设模型
  custom_draft               // 视图状态，不计入报告指纹
}
```

删除 `qualified_run`、`custom_results[]` 及其 `id`、`name`、`in_report`、`compare`。后端 `regression/workbench.py` 的 `custom_results_problem` 改为校验单个 `experiment`（spec 合法、snapshot 字节上限），`MAX_SAVED`、`MAX_IN_REPORT`、`MAX_COMPARED`、`NAME_MAX_LENGTH` 删除。

### 3.4 步骤 15 同步改动

| 位置 | 现在 | 改为 |
| --- | --- | --- |
| 页顶“四步回归结果”面板（`regression-teach.tsx`） | 汇总图读 `qualified_run ?? run`；“你放入报告的模型”表列出各步勾选项 | 汇总图只读 `run`；“你的模型实验”表最多 4 行，列为步骤、改动、本次合计、默认合计 |
| 报告“关键证据摘要”（`report_render.py`） | 每步可能两次运行并标注“（用于汇总表）/（另一次计算）”；“你还在本步比较了 n 个自己设计的模型” | 每步固定一次运行，去掉标记；改为一句“你在本步做了一个模型实验：…” |
| 报告“技术附录：保存的回归结果” | 每步可能多张系数表（“保存 1/2”） | 每步一张 |
| 报告“附录：学生设计的模型”（`report_workbench.py`） | 每步一张多列表，列名为学生命名 | 改名“附录：模型实验”，每步一张两列表（默认 / 实验），列名自动生成；`recompute` 路径沿用 |
| 报告指纹投影（`classroom/records.py`） | 投影 `custom_results` 中 `in_report` 项的 name、baseline、spec | 投影 `experiment` 的 spec 与 baseline |
| 报告门槛（`report_gate.py`） | 步骤 11–14 缺 `run` 时提示“请点击计算…回归” | 不变 |
| 教师端（`teacher/reports.tsx`） | 渲染 Markdown | 不变 |

## 4. 实施计划

| 阶段 | 内容 | 涉及文件 | 契约与文档 | 预估 |
| --- | --- | --- | --- | --- |
| 1 版面 | 理解题前移；工作台折叠到末尾；12–14 折叠解释；去重声明；步骤 10 折叠长表与排序图 | `regression.tsx`、`student-workspace.tsx`、`lab-router.tsx`、`shock-lab.tsx`、`workbench.css` | 无 | 1–2 天 |
| 2 语义 | 条形图只读预览；删 `qualified_run`；工作台改预设按钮 + 单个实验；步骤 15 面板与报告四处改动；任务文案 | 前端 `regression.tsx`、`regression-workbench.tsx`、`regression-save.ts`、`regression-teach.tsx`、`types.ts`；后端 `regression/workbench.py`、`report_workbench.py`、`report_render.py`、`report_saved_run.py`、`classroom/records.py`、`classroom/routes.py`、`steps.py`；`scripts/seed_full_journey.py` | 会话版本与教学库版本升到 v15，按 README 约定新建空开发库，不迁移；实验手册步骤 10–15 段、技术手册 7.3 与 8.1–8.3、README 第二条 | 3–4 天 |
| 3 代码 | `regression.tsx` 拆成页面、运行 hook、结论卡、条形图；删绑定旧语义的测试并补新测试；跑 `scripts/local_ci.sh` | 上述前端文件及约 3,000 行测试 | 无 | 1–2 天 |

- 阶段 1 可以独立发布，不动任何记录。
- 阶段 2 是一次性契约变更，在一个 PR 里完成前后端和文档；验证用 `scripts/seed_full_journey.py`、`scripts/dogfood_report_snapshots.py`、`scripts/accept_workbench_reports.py` 和 `scripts/agent_browser_full_journey.sh`。
- 阶段 3 只整理代码，覆盖率门槛 85% 不变。

### 4.1 需要确认的两个课程决定

| 决定 | 建议 | 理由 |
| --- | --- | --- |
| 报告材料固定为默认 Y | 是 | 步骤标题、理解题、实验手册“四类回归记录”表本来就按默认 Y 写，固定后页面、报告、手册三处一致 |
| 每步一个模型实验 | 是 | 若要多个，把 `experiment` 改成最多 2 个的数组代价很小，但命名、改名、删除、对比勾选不恢复 |

### 4.2 明确不做的

- 不恢复真实事件目录的回归路径（见上一轮分析 1.1）。
- 不改理解题题库。
- 不为手机、平板增加断点。
- 不给步骤 15 增加新的输入项。

## 5. 对分支 `feat/regression-learning-flow` 的判断

提交 f331f0a 做对了三件便宜的事：理解题移到工作台前面、工作台折叠成 `<details>`、步骤 12–14 默认收起方程解释。

但在核心问题上方向相反：它保留“点条换 Y”，再叠加“正在查看 / 已记录”两个状态和“返回已记录结果”“用此结果替换本步报告材料”两个按钮，并用一行状态文字解释两者的区别；state 从 12 个变为 13 个，按钮可用性用 `result === recordedResponse` 的对象引用比较决定；工作台的保存、对比、放入报告完全未触碰。它减少了版面噪音，没有减少认知负担，并让材料语义更难解释。建议不合并；三处版面改动与预览逻辑写在同一提交里，在阶段 1 重做比摘取省事。

## 6. 验证记录

- 本地启动：`uv run gvcsim classroom-init`（库 `gvcsim_cc_demo_20261014`）→ `uv run gvcsim compute`（约 8 分钟，生成 release `93c4752…`）→ `gvcsim serve --port 8000` + `vite preview --port 4173`。
- `student` 逐页截图步骤 10–14（初始与运行后）；`student02` 经 `seed_full_journey.py` 完成 15 步，步骤 11 保存自设模型并放入报告，步骤 15 生成草稿：报告 25,654 字符、548 行，含“附录：学生设计的模型 · 步骤 11”一节。
- 以上数字只适用于本次基线和 demo 账号，不是容量或验收结论。

## 7. 实施记录

### 7.1 阶段 1（2026-10-14，分支 `regression-simplification`，ed06138）

- 理解题经 `lab-router.tsx` 传入回归步骤，排在结论卡之后；“改模型、对比（选做）”改为折叠的 `<details>`，展开后才加载选项。
- 方程逐项解释在步骤 11 展开、12–14 折叠；趋势图说明折叠为“这张图怎么读”。
- 步骤 10：四块变量卡合并为一条定义带（原卡片折叠在“各变量的定义与来源”下），逐年表折叠，排序图默认只显示 X 最高的 15 国。
- 页面高度：步骤 10 约 4,500 → 2,500 像素，步骤 11 约 4,900 → 2,700 像素（跑完回归、工作台折叠时）。
- 验证：`bunx tsc`、`bun test` 962 通过；demo 截图核对。

### 7.2 阶段 2（2026-10-14，同一分支）

- 条形图只读：点另一条在图下显示该 Y 的读数（来自已加载的 overview，不调服务器、不保存）；报告材料固定为本步默认 Y 的默认模型；删去灰条确认框、“已保存”切换、按条归因的替换提示、条下重试与 `qualified_run`。
- 工作台：先列 7 个预设实验（服务端 `options().presets`，点一下即计算），自定义表单折叠；结果表为“默认模型 / 本次 / 已放入报告”；每步一个 `experiment`（`{spec, saved_at, snapshot}`，移出为 `null`）；命名由预设决定，不匹配预设的写作“自定义设定”（模型摘要另列），前后端同一规则，不再有学生输入的名称。
- 后端：`regression/workbench.py` 以 `experiment_problem`／`reported_experiment`／`experiment_label` 取代 `custom_results_problem`、命名校验与上限；`report_saved_run._saved_runs` 只读 `run`；`classroom/routes.py` 拒绝旧契约键 `qualified_run`、`custom_results`；报告指纹投影 `experiment.spec`；附录改名“附录：模型实验”，每步一表；关键证据摘要每步一句“你在本步做了一个模型实验（…）”。
- 版本：`SESSION_VERSION` → `experiment-session-simple-v4`，`TEACHING_DB_VERSION` → `gvcsim-teaching-db-v15`；按 README 约定新建空库，不迁移。
- 步骤 15：页顶“你的模型实验”表（`ReportedExperiments`）；报告附录与摘要同步。
- 文档：README、DEPLOY.md、技术手册 2.2／3.1／3.3／7.2／7.3／8.1／8.2／10.3、实验手册步骤 11–15 相关段落、`docs/student-manual/README.md`（截图未重拍，已注明）。
- 验证：`uv run ruff check .`、`ruff format --check .`、`mypy` 通过；`pytest` 1,228 通过（专用测试库）；`bunx tsc`、`bun test` 940 通过（删除了约 3,000 行绑定旧语义的测试，新增预设、放入／替换／移出、旧契约拒绝等用例）；demo（新建 v15 库、`seed_full_journey.py` 为 student02 走完 15 步）上核对：步骤 11 点另一条只出预览，预设“去掉汇率变动”一键计算并放入报告，步骤 15 面板与草稿报告“附录：模型实验”均按保存设定重算。
- 未做：实验手册 PDF 与图 10、14–16、18 未重拍；`scripts/accept_workbench_reports.py` 已改为每步一个实验但未在隔离库上重跑；阶段 3（`regression.tsx` 拆分）未开始。

### 7.3 阶段 3（2026-10-14，同一分支）

- `frontend/src/regression.tsx` 拆为页面（315 行，4 个 state、2 个 ref、3 个 effect）和 `frontend/src/regression-step/` 下的五个模块：方程说明、结论卡、保存的运行、本类条形图与趋势图辅助、运行 hook（请求、中断、429 倒计时）。页面继续再导出课程其他文件用到的名字，行为不变。
- `scripts/agent_browser_course_journey.py` 的默认模型项集合改为从 `DEFAULT_SPEC` 取 X 滞后与全部控制变量（原先只含汇率变动，与 v12 默认模型不符，使浏览器验收在步骤 11 误报）。
- 验证：`scripts/local_ci.sh` 全部通过（Gephi 基准、`ruff`／`mypy`、后端 1,228 个测试、覆盖率 92%、前端 940 个测试、学生 15 步与教师浏览器验收）；证据目录 `dogfood-output/local-ci/20261014T025947Z-1280154`。

### 7.4 Dogfood（2026-10-14，round 8）

- 用 agent-browser 真实操作步骤 10–15 与教师评阅（账号 student03、teacher；截图与发现见 `dogfood-output/round8-20261014/FINDINGS.md`）。
- 修正：自定义设定的模型名改为“自定义设定”（摘要另列，报告摘要句附摘要）；计算后等条形图到达再滚到结论；报告按钮不再撑满整行；前端在 `options` 缺 `custom_label` 时回退命名。
- 未改：提交后替换模型时两条提示并列；折叠卡片与底部圆点条只在自动滚动时可能重叠。

### 7.5 模型空间核查（2026-10-14）

- 新增 `scripts/check_model_space.py`：对步骤 11–14 可构造的 1,183 种设定（7 种 X 滞后 × 13 种固定效应 × 13 种控制设置）× 17 个 Y 共 20,111 次估计，逐项与 `teaching.py` 的生成规则对照（恢复 β 与 60/40 拆分、L2.X 为零、三项斜率、无关控制为零、漏汇率／滞后汇率高估、只放当期 X 低估、零效应 Y、三条恒等式、贸易镜像、库对照）。结果与解读见 `docs/regression-model-space-check-2026-10-14.md`，摘要见 `benchmarks/model_space_v12.json`，单元测试 `tests/test_check_model_space.py`。
- 结论：没有与构造思路相悖的结果；三组“未通过”是同一份数据的 2 个标准误左右的抽样波动。两点设计观察：“去掉 GDP 对数”几乎不改变结果（GDP 混杂按设计很弱）；错误固定效应的偏差方向与大小因 Y 而异。
