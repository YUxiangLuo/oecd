# 项目深度 Review（2026-09-24）

审查基线：`ebb59690a150bffcf144a5705ebc0deedf9746bc`，分支 `cc`；本机已有真实 v15 release `40c6a5d0d5d94084961a2dca04b9b260`，年份 2016–2020。结合源码、全量测试、独立开发课堂、agent-browser 实际操作与数据库只读核对。下文保留修复前发现；用户要求二次确认后，5 项均已确认并在工作区修复，见末尾修复记录。

**确认 5 项问题：2 项 P1、3 项 P2。** 最优先的是报告对已保存数据给出错误的极值结论，以及当前提交未通过完整测试门禁。学生的 15 步主流程、教师评阅、跨标签冲突和改密后草稿恢复均通过本轮浏览器验证；新增缺陷主要集中在报告内容完整性和教师操作的失败反馈。

| 建议修复顺序 | 优先级 | 编号 | 问题与定位 |
| --- | --- | --- | --- |
| 1 | P1 | R24-03 | 局部极值被写成完整保存范围的极值，`gvcsim/report_observed.py:142`、`:242` |
| 2 | P1 | R24-02 | 手册来源说明导致完整测试失败，`实验手册.md:629`、`tests/test_steps.py:47` |
| 3 | P2 | R24-05 | 自述中的未闭合围栏破坏整份报告，`gvcsim/report_observed.py:26`、`:48` |
| 4 | P2 | R24-04 | 前后向比较只生成前向主图，`gvcsim/report_observed.py:185` |
| 5 | P2 | R24-01 | 归档/恢复失败无反馈，`frontend/src/teacher/semesters.tsx:20`、`:51`、`:68` |

编号保留发现顺序，修复顺序以上表为准。

## 修复前已确认问题

### R24-03 / P1：行业排名报告截断样本后，生成错误的最大值和最小值结论

- **影响：** 自动报告的极值判断与学生实际保存的数据不一致，可能直接进入作业结论。
- **复现：** 新学生通过 UI 完成 15 步；步骤 9 选择“两国行业比较 → 定位行业”，CHN/USA、2020、加权总度、全部行业，保存并确认落库 90 条读数，再生成报告。
- **实际：** 主图只包含前 6 个行业的 12 条数据，自动读图称最高为 `CHN · C24（约 3.333e6）`、最低为 `USA · C13T15（约 6.325e4）`；完整 90 条数据的最高为 `USA · K = 3,368,349.8619`，最低为 `CHN · T = 0`（USA · T 也为 0）。单位均为百万美元。其余 78 条没有进入极值计算，重复生成后结果相同。完整明细仍在数据库和报告后面的操作记录中。
- **原因：** [report_observed.py](../gvcsim/report_observed.py) 第 142–146 行对行业身份静默 `[:6]`；第 242–246 行再对截断后的 `chart['items']` 计算 min/max，却用“保存范围内”描述。这会把第一国排序靠前的行业误当成两国保存数据的全范围。步骤 6–8 的行业比较也走此分支；本轮端到端反例取自步骤 9。
- **建议：** 极值必须从完整已保存的同口径观测计算；图表若限量展示，应明确展示范围，并让完整读数可核对。
- **验收：** 保存超过 6 个行业，将另一国最大值和最小值放在截断范围外；主图、自动文字与完整表逐项核对，包含并列极值。
- **证据：** [保存观测](../dogfood-output/deep-review-20260924/report-observations.json)、[报告 Markdown](../dogfood-output/deep-review-20260924/ranking-directions-report.md)、[计算对照](../dogfood-output/deep-review-20260924/R24-03-04-evidence.json)、[材料截图](../dogfood-output/deep-review-20260924/screenshots/R24-03-saved.png)、[报告截图](../dogfood-output/deep-review-20260924/screenshots/R24-03-report.png)、[录像](../dogfood-output/deep-review-20260924/videos/R24-03-04-report-charts.webm)。

### R24-02 / P1：当前提交未通过完整测试门禁

- **影响：** 标准后端测试及 `scripts/local_ci.sh` 在手册来源一致性检查处失败；此前 148 项定向测试未覆盖此文件。
- **复现：** 全量测试得到 `1 failed, 704 passed`；失败为 `tests/test_steps.py::test_student_manual_source_note_matches_screenshot_manifest`。
- **原因：** `实验手册.md:629` 只保留 `5312bd0` 短哈希，而 `docs/student-manual/screenshots.json` 的顶层 `baseline_commit` 是完整 `5312bd0733cd5ee6f4b8051c2e979d4f7c8f8f02`。测试第 47 行要求完整值在正文中出现。属于 `ebb5969` 的文档与门禁契约不一致，不能据此宣称截图来源本身错误。
- **建议：** 正文保留完整基线哈希并同步 PDF；或明确设计兼容短哈希及逐图不同基线的契约，然后相应调整测试。恢复全量门禁通过。
- **验收：** 独立失败用例及完整测试均通过；修改正文时同步手册 PDF。
- **证据：** [全量测试日志](../dogfood-output/deep-review-20260924/backend-tests.log)、[独立复现日志](../dogfood-output/deep-review-20260924/manual-provenance-repro.log)。

### R24-05 / P2：学生自述中的未闭合 Markdown 围栏破坏整份报告后续排版

- **影响：** 学生粘贴或编辑自述时留下未闭合围栏，仍可成功提交，但真实指标图、回归表及后续章节全部变为代码文本。图表 JSON 直接显示，报告难以阅读和评阅。
- **真实操作：** 在步骤 15 保留“局限与反思”的原文，追加空行、单独一行 `~~~`，再追加一句正常的局限说明；仍在长度限制内。点击“重新生成并提交”及“查看已提交报告”，重复生成再次核对。
- **实际：** 正常报告有 4 张图、17 张表、9 个二级标题；触发后变为 0 张图、0 张表、1 个二级标题，后续约 23,434 字符进入同一个 `<pre>`。两次复现相同。测试结束后已恢复原文并重新生成正常报告。
- **原因：** [report_observed.py](../gvcsim/report_observed.py) 第 26–28 行直接返回学生原文，第 31–50 行把它拼进整篇 Markdown，未建立解析边界。[report-renderer.tsx](../frontend/src/report-renderer.tsx) 第 324 行起统一解析整篇，学生端和教师端共用；禁用 raw HTML 和图片不能隔离 Markdown 围栏。
- **建议：** 保留学生原文，同时在构建或渲染层将自述作为独立文本/Markdown 块解析，使其不能改变自动章节的块结构。不要通过删掉标点损坏原文。
- **验收：** 在现有段落、行内反引号及竖线保真测试之外，加入未闭合反引号和波浪号围栏，断言后续自动标题、图和表仍然存在。该项是格式完整性缺陷，本轮没有发现或声称脚本执行。
- **证据：** [输入前截图](../dogfood-output/deep-review-20260924/screenshots/R24-05-before.png)、[异常报告截图](../dogfood-output/deep-review-20260924/screenshots/R24-05-after.png)、[录像](../dogfood-output/deep-review-20260924/videos/R24-05-reflection-markdown.webm)、[首次 DOM 对照](../dogfood-output/deep-review-20260924/R24-05-first.json)、[重复验证](../dogfood-output/deep-review-20260924/R24-05-second.json)。

### R24-04 / P2：步骤 8 保存的后向长度没有进入报告主图和自动读图

- **影响：** 学生选择“前后向与位置”并保存两项指标，报告的核心可视证据却只有前向长度，丢失该视角要比较的另一半。完整明细仍在后面的操作记录中，不能描述成数据库丢失。
- **复现：** 步骤 8 选择 CHN/USA、2016–2020、“前后向与位置”，保存 20 条读数；生成报告。
- **实际：** 已保存的 metric 同时包含 `PLv_GVC`、`PLy_GVC`，报告本步仅有一张 `PLv_GVC` 两国趋势图及前向变化解释，没有后向图或后向自动读图。
- **原因：** [report_observed.py](../gvcsim/report_observed.py) 第 185–203 行的 `_observed_charts` 仅为构成演变 `evolution` 拆分多指标；`directions` 落入 `_observed_chart` 单指标选择，只取 selection.metric 或首个指标。
- **建议：** 将前后向视角按指标分别生成图表与解读，或使用明确区分方向且完整保留两项的图形。
- **验收：** 两国 × 五年 × 两方向的 20 条读数全部进入主图的可视证据；自动解释同时保留两项，图名与说明跟随实际视角。
- **证据：** [保存观测与生成图表对照](../dogfood-output/deep-review-20260924/R24-03-04-evidence.json)、[材料截图](../dogfood-output/deep-review-20260924/screenshots/R24-04-saved.png)、[报告截图](../dogfood-output/deep-review-20260924/screenshots/R24-04-report.png)。与 R24-03 共用报告和录像。

### R24-01 / P2：学期、班级归档失败没有任何页面反馈

- **影响：** 网络中断或后端拒绝归档/恢复请求时，教师看不到失败原因，也没有保存状态，容易把点击当成成功或连续重试。
- **复现：** 教师进入“学期与班级”，新建临时学期及班级；模拟断网，点击学期“归档”。两次复现均保持“使用中”，页面没有错误提示，控制台出现未处理的 Promise 拒绝。班级按钮使用相同调用链。
- **原因：** [semesters.tsx](../frontend/src/teacher/semesters.tsx) 第 20–23 行的 `mutate` 只等待操作，成功后刷新；第 51、68 行的归档/恢复按钮以 `void mutate(...)` 调用，没有 `catch`、错误状态或等待禁用。第 25 行的 `error` 只来自列表读取。新建/改名使用有错误处理的弹窗，不能把问题泛化到所有教师操作。
- **建议：** 为每个归档操作维护 pending/error 状态，捕获请求失败并在对应卡片显示错误；成功后刷新，失败后允许重试。
- **验收：** 学期和班级的归档/恢复分别覆盖断网与服务端失败，检查提示、状态未误变及联网后的重试。本轮浏览器直接复现的是学期归档，其他按钮的范围由共享代码路径确认。
- **证据：** [操作前](../dogfood-output/deep-review-20260924/screenshots/R24-01-before.png)、[失败后](../dogfood-output/deep-review-20260924/screenshots/R24-01-after.png)、[录像](../dogfood-output/deep-review-20260924/videos/R24-01-archive-failure.webm)、[页面及错误记录](../dogfood-output/deep-review-20260924/R24-01-evidence.json)。

## 项目结构与审查判断

| 范围 | 当前实现及本轮判断 |
| --- | --- |
| 课程与前端 | React/TypeScript/Vite，15 步固定课程；步骤交互、理解题、材料记录与报告门禁相互关联。全新学生实际走通；分支材料进入报告后是否完整，仍需单独核验。 |
| 数据与计算 | Python 后端读取版本化产物；ICIO、分解和网络使用真实数据，教学回归使用独立模拟面板。release 绑定、QC 和固定模拟契约清楚；本轮没有重算或替换产物。 |
| 持久化与认证 | PostgreSQL 按账号/release 隔离，客户端串行保存，服务端版本冲突返回 409；草稿暂存在当前标签页。三标签冲突和两类改密恢复均实测通过。 |
| 报告与评阅 | 后端从已保存材料生成 Markdown，学生/教师共用渲染器；评分与重新生成具有版本保护。主流程与并发保护通过，但生成层存在范围截断、多指标遗漏及块边界问题。 |
| 教师管理 | 学期/班级、账号、进度和评阅组成课堂闭环；新建账号和评阅完成，归档失败反馈存在明确缺口。 |
| 工程验证 | 前后端单测、静态检查、浏览器旅程及故障脚本较齐全。90.16% 后端覆盖率仍未阻止报告语义错误；全量测试暴露了此前定向测试漏掉的手册契约回归。 |

维护上最值得补强的是“已保存材料 → 报告”的数据契约：同一套观测用于画图、计算摘要和附录时，应显式保留完整范围、指标集合、单位和来源。仅检验字符串存在、图表格式合法或主流程可提交，不能证明报告忠实表达了学生保存的全部内容。

## 验证与覆盖

### 自动测试与构建

| 检查 | 本轮结果 | 证据/说明 |
| --- | --- | --- |
| 全量后端 pytest | **704 passed，1 failed**，268.07 秒 | `backend-tests.log`，失败为 R24-02 |
| 后端覆盖率 | **90.16%**，超过 85% 门槛 | `coverage.json`；覆盖率通过不等于测试全通过 |
| 失败用例独立重跑 | **1 failed** | `manual-provenance-repro.log` |
| 前端单测 | **409 pass，0 fail**，69 文件、2104 个断言 | `frontend-tests.log` |
| Ruff | 通过 | `.venv/bin/ruff check .` |
| Mypy | 66 个源码文件通过 | `.venv/bin/mypy` |
| TypeScript + Vite 生产构建 | 通过 | `frontend-build.log` |

后端使用独立一次性数据库 `gvcsim_deep_review_tests_20260924`。测试夹具会重建 `public` schema，因此没有对保留浏览器证据的开发课堂运行数据库测试。

核心命令（`REVIEW_TEST_DSN` 必须指向新建的一次性测试库）：

```bash
GVCSIM_PG_DSN="$REVIEW_TEST_DSN" GVCSIM_FILE_CACHE_MODE=notify \
OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 \
.venv/bin/python -m pytest --cov=gvcsim --cov-report=term-missing -q
bun run --cwd frontend test:unit
bun run --cwd frontend build
.venv/bin/ruff check .
.venv/bin/mypy
```

### 浏览器实际操作

浏览器全部使用 agent-browser。主站 `http://127.0.0.1:5173`、API `http://127.0.0.1:8000`，独立开发课堂 `gvcsim_dev_browser_20260924`。

| 场景 | 操作与结果 | 证据 |
| --- | --- | --- |
| 完整新生课程 | 教师在 UI 新建学生；学生在 UI 完成步骤 1–15、四项回归、全部理解题、材料保存和报告提交；逐步检查持久化，**15/15 通过** | `course.log`、`course/results.json`、各步截图 |
| 教师评阅与旧报告保护 | 教师评 93 分；旧学生页面重新生成时收到 409，未覆盖新评分；刷新后看到成绩，**通过** | `course/student-graded.png`、旅程日志 |
| 三标签冲突 | 专用代理控制请求时序，检查冲突提示及显式恢复，**重复两轮通过** | `interleavings/results.json` |
| 教师改密撤销认证 | 请求在途时撤销旧认证，切换账号，再恢复原账号草稿，**重复两轮通过** | `interleavings/results.json`、截图 |
| 本人改密时有未保存内容 | 浏览器制造保存失败，经 UI 改密、重新登录并恢复草稿，**重复两轮通过** | `self-password/results.json`、截图 |
| 桌面可访问性及溢出 | 1200×800，15 步 × 3 个滚动位置，**45 次检查，所选 WCAG 2 A/AA 自动规则 0 违规，整页横向溢出 0** | `accessibility/summary.json` |
| 正常报告 PDF | agent-browser 生成 PDF，Poppler 独立提取文本，**四类指标对照表七列均保留** | `report.pdf`，通过 `scripts/verify_report_pdf.py` |
| 边界及失败场景 | 保存 90 条行业读数和 20 条前后向读数，编辑自述并重新生成，模拟归档断网；确认 R24-01/03/04/05 | 各发现列出的截图、录像与 JSON |

完整课程使用 `scripts/agent_browser_course_journey.py`，新账号为 `browser-course-23b6be44`。后续报告边界检查也使用该账号，所以当前报告已重新生成并待评阅；93 分成功评阅的时点由旅程证据保留。

故障恢复脚本通过公开 API 准备普通测试账号，编辑、登录、冲突和恢复动作由浏览器执行；这类验证与从零开始的纯 UI 课程旅程分别记录。

## 边界与排除项

- 可信课堂、桌面宽度至少 1200 px 是项目明示范围。本轮没有把缺少防作弊、教师之间不隔离分组或手机布局列为漏洞。
- 前轮经济学审查及修复见 [经济学复核](economics-review-20260924.md)。本轮课程及报告可见模拟关系、样本筛选和解释边界；没有把已修复的 E24-01–05 重新计为开放问题。R24-02 是那次提交中的文档门禁回归。
- 全量测试包含数值与课程契约测试，但没有重新对照 OECD 官方 TiVA 全部指标，也没有重新生成独立 Gephi golden fixture；不能据此宣称外部数值口径已全面验证。
- 没有重新运行整个 `scripts/local_ci.sh`、50 人容量测试、生产部署或灾难恢复演练。当前全量 pytest 的失败已足以确认该脚本对应阶段不能通过。
- 可访问性自动规则通过不等于完整 WCAG 合规；PDF 七列文本保留不等于逐页人工排版验收。PDF 使用正常自述，Markdown 异常报告的影响由页面复现确认。
- raw HTML 和 Markdown 图片已禁用，R24-05 只证明报告块结构可被破坏；没有证据支持把它升级为 XSS 或账号越权。
- 截图、录像、日志和临时 PDF 位于被 Git 忽略的 `dogfood-output/deep-review-20260924/`，用于本机复核；本文的证据链接不是远程仓库附件。

## 修复后的验收重点

按开头优先级逐项修复，并先通过每项列出的反例，再统一检查完整课程、报告渲染及全量门禁。极值应从全部已保存观测独立计算；图表完整性应与实际保存的指标集合比较；Markdown 保真需要同时证明原文保留和后续自动章节不受影响。避免只增加与实现结构相同的快照断言。

审查收尾：已停止本轮专用的 5175 前端及 18095 故障代理，删除一次性 pytest 数据库；主开发服务 5173/8000 和独立开发课堂保留，便于复核。

## 二次确认与修复（2026-09-24）

在上述基线上再次核对后修复，未更换数据 release、数据库 schema 或课程完成条件。

| 编号 | 二次确认 | 已实施修复 |
| --- | --- | --- |
| R24-03 | 浏览器再次看到旧报告的错误极值；新增步骤 6、9 的反例测试在旧代码均失败 | 极值从完整保存范围计算并列出并列项；主图保留有界展示，明确标注“12 / 90 条读数”，引导至完整实验快照。构成图明确极值仅比较构成项，不混入总量。 |
| R24-02 | 独立重跑手册来源用例仍失败 | 正文恢复完整基线哈希，同步重新导出 28 页 A4 PDF，未改变既有逐图来源记录。 |
| R24-05 | 旧后端经浏览器再次生成含未闭合围栏的报告，仍为 0 图、0 表 | 自述以长度大于原文所有反引号串的围栏封装；共用渲染器按字面文本显示，保留段落、标点及原文，不让输入改变后续章节结构。 |
| R24-04 | 新增两方向测试在旧代码得到 1 张图而非 2 张，浏览器结果一致 | 趋势按已保存的指标分别生成，前后向各有一张两国图及自动解读；保留构成演变排除总量的既有规则。 |
| R24-01 | 源码确认归档变更的拒绝未被捕获；旧组件在学期/班级归档、恢复的 4 个交互用例均失败 | 复用归档操作组件，维护等待和错误状态，等待时禁用按钮，失败显示中文原因并允许原操作重试。 |

### 修复后浏览器验收

- 同一真实数据课堂、同一份 90 条行业观测，报告现在写明最高为 `USA · K（3.368e+06）`、最低为 `CHN · T、USA · T（0）`；可见展示限额说明。
- 步骤 8 的前后向两图共保留 20 个点；报告合计 5 张图、17 张表。
- 保留触发问题的 `~~~` 输入重新生成，原文按字面显示，后续图表正常；随后恢复测试账号的原文并再次生成。教师评阅页也核对了 5 图、17 表及 3 段自述。
- 学期与班级各自的归档、恢复均通过“断网 → 中文错误提示 → 联网重试成功”验证，浏览器没有未处理错误；额外检查 1200 px 桌面布局，整页无横向溢出。临时学期、班级最后恢复到原来的使用中状态。
- 含围栏自述的报告通过实际浏览器 PDF 导出，独立文本提取确认结果表七列保留。手册 PDF 仍为 28 页 A4，完整哈希进入成品；浏览器检查所有页面正文未侵入页脚。

证据位于 `dogfood-output/review-fixes-20260924/`：[报告对照](../dogfood-output/review-fixes-20260924/report-after.json)、[自述修复截图](../dogfood-output/review-fixes-20260924/reflection-after.png)、[后向图](../dogfood-output/review-fixes-20260924/directions-after.png)、[极值截图](../dogfood-output/review-fixes-20260924/extrema-after.png)、[教师报告](../dogfood-output/review-fixes-20260924/teacher-report.json)、[归档/恢复结果](../dogfood-output/review-fixes-20260924/archive-results.json)、[修复后 PDF](../dogfood-output/review-fixes-20260924/report-after.pdf)。

### 回归验证与应用范围

- 完整后端测试 **711 passed**，271.98 秒；覆盖率 **90.19%**。使用独立一次性数据库 `gvcsim_review_fixes_tests_20260924`，未触碰浏览器开发课堂。
- 前端全部单测 **414 pass，0 fail**，70 文件、2145 个断言；Ruff 检查及格式检查、Mypy（66 个源码文件）、TypeScript/Vite 生产构建、`git diff --check` 均通过。
- 对应日志：[后端](../dogfood-output/review-fixes-20260924/backend-tests.log)、[前端](../dogfood-output/review-fixes-20260924/frontend-tests.log)、[构建](../dogfood-output/review-fixes-20260924/build.log)。本轮浏览器验收针对修复分支，没有重复整套 15 步旅程；初次审查的完整旅程结果见上文。

已有报告作为保存快照保留；报告内容修复对重新生成的报告生效。重新生成已评分报告仍遵循原有确认并清空评分的流程，本次没有批量改写历史报告。自述原文保存在会话中，报告按字面文本显示其中的 Markdown 标点。
