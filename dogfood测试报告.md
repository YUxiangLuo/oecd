# GVC Simulation Lab 深度 Dogfood 测试报告

| 字段 | 值 |
|---|---|
| 测试日期 | 2026-07-29 |
| 被测提交 | `5189134`（`cc`） |
| 应用地址 | `http://127.0.0.1:5173` |
| 浏览器工具 | `agent-browser 0.33.0` / Google Chrome 150 |
| 证据目录 | [`dogfood-output/5189134-20260729`](dogfood-output/5189134-20260729/) |
| 测试范围 | 全新部署、学生 16 步学习流程、教师管理与评阅、权限与异常、响应式、可访问性、并发与稳定性 |
| 当前状态 | **完成：有条件通过** |

## 摘要

| 严重程度 | 数量 |
|---|---:|
| Critical | 0 |
| High | 4 |
| Medium | 5 |
| Low | 2 |
| **总计** | **11** |

核心教学、数据、回归、报告、评阅和成绩回流链路全部完成，100 个独立学生账号的容量验收也通过，
未发现 Critical、数据串号、越权读取、提交丢失或 5xx。结论为“有条件通过”：桌面鼠标用户可完成
完整业务流程，但 4 个 High 问题均影响键盘、屏幕阅读器或移动端辅助技术，尚不满足无障碍发布要求。

## 测试环境与部署

| 项目 | 实际值 |
|---|---|
| 源码 | `cc`，`5189134df5179a69f937f840266d67883917dec7`（Merge PR #25） |
| 主机 | Arch Linux，Linux `7.1.5-arch1-1`，12 个逻辑 CPU，31 GiB 内存 |
| 运行时 | Python 3.13.11、Node.js 26.5.0、uv 0.10.12、PostgreSQL 18.4 |
| 前端 | Vite 7.3.6，`127.0.0.1:5173`；生产构建另行验证通过 |
| 主 API | production 配置，`127.0.0.1:8000`，2 workers，线程令牌 16 |
| 主数据库池 | min 1 / max 4，CPU permits 4，admission 32 |
| 主测试数据库 | 全新隔离库 `gvclab_dogfood_5189134_20260729` |
| 数据产物 | manifest `b38756069af3f3d3`，2016–2020，artifact schema 3 |
| 课堂 schema | `gvcsim-teaching-db-v6` |
| 容量环境 | 隔离库 `gvclab_dogfood_5189134_loadtest`，6 workers，pool max 4，CPU permits 8 |
| 池上限 1 专项 | 单 worker、pool min/max 均为 1，独立监听 `18001` |

主库在测试前新建，随后完全通过教师 UI 建立 1 个班级、1 个学生、1 个作业和 1 条公告。测试身份为
`dogfoodteacher` 与 `dogfoodstudent`；凭证和签名密钥不写入报告。容量账号文件位于临时目录且权限
为 `0600`。主部署当前仍运行在 `5173/8000`；容量与 pool=1 的辅助进程在取证后已停止。

服务启动预检最终结果为：

```text
服务启动预检通过：manifest=b38756069af3f3d3，年份=2016,2017,2018,2019,2020，
schema=gvcsim-teaching-db-v6
```

生成数据产物时仓库已包含本次新建的报告/证据文件，因此 manifest 记录了 `git_dirty=true`；
被测产品源码仍对应上述固定 HEAD，没有在 dogfood 过程中修改产品代码。

## 覆盖矩阵

| 范围 | 场景 | 结果 | 代表证据 |
|---|---|---|---|
| 部署 | 全新 PostgreSQL、迁移、artifact/preflight、前后端启动 | 通过 | [初始登录页](dogfood-output/5189134-20260729/screenshots/00-login-initial.png) |
| 登录 | 错误密码、短密码校验、SQL 注入字符串、退出 | 通过 | [注入登录被拒](dogfood-output/5189134-20260729/screenshots/67-login-injection-rejected.png) |
| 教师初始化 | 建班、创建学生、发布作业、发布公告 | 通过；表单有 ISSUE-001 | [作业已发布](dogfood-output/5189134-20260729/screenshots/11-assignment-published.png)、[公告已发布](dogfood-output/5189134-20260729/screenshots/13-announcement-created.png) |
| 学生 1–6 | 原始数据、质检、贸易/生产/长度/网络指标 | 通过；表格有 ISSUE-004 | [步骤 3](dogfood-output/5189134-20260729/screenshots/25-step3-interactions.png)、[步骤 6](dogfood-output/5189134-20260729/screenshots/29-step6-network-betweenness.png) |
| 学生 7–10 | 四类交互可视化、筛选、切换视角 | 功能通过；ISSUE-008/009 | [贸易流](dogfood-output/5189134-20260729/screenshots/32-step7-fva-ranking.png)、[网络](dogfood-output/5189134-20260729/screenshots/40-step10-trade-network.png) |
| 学生 11 | 政策事件接入、支持范围和 QC 展开 | 通过 | [政策 QC](dogfood-output/5189134-20260729/screenshots/43-step11-policy-qc-expanded.png) |
| 学生 12–15 | DID、控制变量、交互、事件研究、网络回归、安慰剂 | 通过 | [步骤 12](dogfood-output/5189134-20260729/screenshots/48-step12-event-study-result.png)、[步骤 15](dogfood-output/5189134-20260729/screenshots/53-step15-placebo.png) |
| 学生 16 | gate、报告生成、打印入口、提交、评语与成绩显示 | 通过；ISSUE-004/010 | [已提交](dogfood-output/5189134-20260729/screenshots/56-step16-report-submitted.png)、[成绩回流](dogfood-output/5189134-20260729/screenshots/63-student-grade-visible.png) |
| 教师评阅 | 待评阅列表、详情、分数校验、快捷评语、评分提交 | 通过 | [评阅完成](dogfood-output/5189134-20260729/screenshots/61-teacher-review-submitted.png) |
| 教师概览 | KPI、成绩分布、评阅进度、步骤下钻 | 通过；ISSUE-002/007/011 | [完整概览](dogfood-output/5189134-20260729/screenshots/64-teacher-overview-complete.png)、[步骤下钻](dogfood-output/5189134-20260729/screenshots/65-teacher-progress-drilldown.png) |
| 鉴权与 RBAC | 匿名深链、匿名 API、学生读教师 API、教师读学生私有 API | 通过：401/403 符合预期 | [匿名深链](dogfood-output/5189134-20260729/screenshots/66-anon-deep-link-login.png) |
| 会话隔离 | 同一学生双会话、单会话退出、另一会话刷新 | 通过 | [第二会话仍有效](dogfood-output/5189134-20260729/screenshots/68-second-session-remains-authenticated.png) |
| 响应式 | 1440×900、768×1024、390×844 | 桌面/平板通过；移动端有 ISSUE-005/006/007 | [学生移动端](dogfood-output/5189134-20260729/screenshots/71-student-mobile-step7-after-wait.png)、[教师平板](dogfood-output/5189134-20260729/screenshots/83-teacher-tablet-overview.png) |
| 键盘与无障碍 | Tab、模态焦点、名称、对比度、滚动区、SVG 语义 | 未通过；ISSUE-001–006、011 | [焦点逃逸视频](dogfood-output/5189134-20260729/videos/issue-003-intro-focus-repro.webm) |
| 异常恢复 | 整页离线/恢复、单 API 中止/恢复 | 网络恢复后可用；失败态有 ISSUE-009 | [API 失败视频](dogfood-output/5189134-20260729/videos/issue-009-api-failure.webm) |
| 100 学生容量 | 100 登录、读取、回归、25 次安慰剂、100 次进度写入 | 通过 | [容量 JSON](dogfood-output/5189134-20260729/capacity-100-result.json) |
| pool=1 回归 | 4 组并发 overview/students，共 8 请求 | 通过，均为 200 且 16/16 | 本报告“性能、稳定性与可访问性” |
| 自动验证 | 后端 pytest、前端单测、TypeScript/Vite build | 通过 | 本报告“完成审计” |

## 问题清单

### ISSUE-001：教师与学生端多个表单控件缺少可访问名称

| 字段 | 值 |
|---|---|
| 严重程度 | High |
| 分类 | Accessibility |
| URL | `http://127.0.0.1:5173/`（教师工作台与学生实验页） |
| 复现视频 | N/A（弹窗打开后静态存在） |
| 证据 | [添加学生弹窗](dogfood-output/5189134-20260729/screenshots/06-create-student-dialog.png)、[发布作业弹窗](dogfood-output/5189134-20260729/screenshots/10-publish-assignment-dialog.png)、[课堂公告表单](dogfood-output/5189134-20260729/screenshots/12-announcements-empty.png)、[学生步骤 3 控件](dogfood-output/5189134-20260729/screenshots/24-step3-scrollable-table.png) |

**描述**

“添加学生账号”弹窗中的显示姓名、学号、密码三个输入框没有关联的 `<label>`、`aria-label`、
`aria-labelledby`、`title` 或 placeholder；班级选择器也没有可访问名称。页面上方的班级筛选器
同样无名称。“发布作业”弹窗的作业标题和发布标识输入框也只有可见文字、没有程序化名称。
“课堂公告”的班级选择器和正文输入框同样在无障碍树中显示为无名称控件。
学生步骤 3 中用于表格国家/年份筛选、共享年份以及分析实体国家/行业选择的 5 个下拉框也全部
没有可访问名称，说明问题并非局限于一个教师弹窗。
`agent-browser a11y`（axe-core 4.12.1，WCAG 2 A/AA）分别报告：

- `label`：3 个 critical-impact 节点；
- `select-name`：2 个 critical-impact 节点。
- 切换到“发布作业”弹窗后，`label` 仍有 2 个 critical-impact 节点。
- 学生步骤 3 的 `select-name` 为 5 个 critical-impact 节点。

可见文字标签与控件没有程序化关联，屏幕阅读器用户无法可靠判断每个空白输入框的用途，也无法区分
页面筛选器和弹窗内的班级选择器。预期所有表单控件都具有唯一且描述准确的可访问名称。

**复现步骤**

1. 使用教师账号登录，进入“班级与学生”。
2. 点击“+ 添加学生”。
3. 查看无障碍树：用户名输入框仅以 placeholder 命名，其余三个输入框显示为无名称 `textbox`，
   班级选择器显示为无名称 `combobox`。
4. 运行 `agent-browser a11y --tags wcag2a,wcag2aa --json`，观察上述 `label` 与
   `select-name` 违规。
5. 关闭弹窗并打开“课程与作业”→“发布作业”，再次运行审计，观察默认填值的作业标题与发布标识
   同样被报告为无标签。
6. 打开“课堂公告”，观察班级 `combobox` 与正文 `textbox` 同样没有可访问名称。
7. 使用学生账号进入步骤 3，运行同一审计，观察 5 个筛选/分析下拉框同样无名称。

---

### ISSUE-002：教师与学生端辅助文字对比度低于 WCAG AA

| 字段 | 值 |
|---|---|
| 严重程度 | Medium |
| 分类 | Accessibility / Visual |
| URL | `http://127.0.0.1:5173/`（教师工作台与学生报告页） |
| 复现视频 | N/A（静态存在） |
| 证据 | [教师端空数据状态](dogfood-output/5189134-20260729/screenshots/03-teacher-empty-students.png)、[学生报告页](dogfood-output/5189134-20260729/screenshots/84-student-tablet-report.png) |

**描述**

教师工作台的 `agent-browser a11y` 检出 11–13 个确定的 `color-contrast` 违规节点（不同标签页
数量略有差异）。顶部数据/会话信息、教师工作台
标题、侧栏各导航项的副标题和侧栏说明文字使用浅灰色小字号：

- 多处对比度为 2.38:1；
- 当前导航副标题最低为 2.04:1；
- 顶部辅助信息为 3.19:1；
- WCAG 2 AA 对这些普通字号文本要求至少 4.5:1。

学生步骤 16 的独立审计又报告 14 个 serious-impact 对比度违规，包括顶部用户/进度信息、
侧栏步骤计数、报告操作说明、服务端凭据过期时间和代码值等，并非仅教师主题存在问题。

这些内容在白色或浅紫背景上明显偏淡，低视力用户难以阅读。预期文字颜色或背景组合满足至少 4.5:1。

**复现步骤**

1. 使用教师账号登录。
2. 打开任一教师工作台标签页。
3. 运行 `agent-browser a11y --tags wcag2a,wcag2aa --json`。
4. 观察 `color-contrast` 规则列出的 11–13 个违规节点及 2.04–3.19:1 的测量结果。
5. 使用学生账号打开步骤 16 并运行同一审计，观察另有 14 个 serious-impact 节点。

---

### ISSUE-003：首次登录介绍层没有对话框语义和焦点隔离

| 字段 | 值 |
|---|---|
| 严重程度 | High |
| 分类 | Accessibility / Interaction |
| URL | `http://127.0.0.1:5173/?step=1`（学生首次登录） |
| 复现视频 | [键盘焦点逃逸复现](dogfood-output/5189134-20260729/videos/issue-003-intro-focus-repro.webm) |
| 证据 | [介绍层打开](dogfood-output/5189134-20260729/screenshots/18-issue003-modal-open.png)、[背景控件获得焦点](dogfood-output/5189134-20260729/screenshots/19-issue003-background-focused.png) |

**描述**

学生首次登录后会显示覆盖全屏的五页系统介绍，但该覆盖层没有 `dialog` / `role="dialog"`、
`aria-modal="true"` 或可访问标题关联。页面载入后的活动元素仍为 `body`，按 `Tab` 后焦点直接进入
被遮罩的后台课程控件（包括顶部“系统介绍”按钮），没有进入覆盖层的“跳过介绍”“上一页”或
“下一页”，也不存在焦点陷阱。无障碍树同时暴露后台的 16 步导航、筛选器、答题控件以及数千个
数据表单元格；背景页面也未被 `inert` 或 `aria-hidden` 隔离。

这会让键盘与屏幕阅读器用户无法判断当前交互上下文，并可能在看不见后台控件的情况下触发操作。
预期介绍层具有模态对话框语义，打开时焦点落入覆盖层，Tab/Shift+Tab 始终在其中循环，关闭后焦点
回到触发控件，同时后台内容对辅助技术不可用。

**复现步骤**

1. 使用从未登录过的新学生会话登录。
2. 等待首次登录系统介绍覆盖层出现。
3. 检查活动元素与无障碍树：活动元素为 `body`，页面中没有对话框节点，后台完整课程仍可访问。
4. 按一次或两次 `Tab`。
5. 观察焦点进入遮罩下方的顶部课程/“系统介绍”等后台控件，而不是覆盖层操作按钮。

---

### ISSUE-004：多个横向可滚动的数据表区域无法通过键盘聚焦

| 字段 | 值 |
|---|---|
| 严重程度 | Medium |
| 分类 | Accessibility / Interaction |
| URL | `http://127.0.0.1:5173/?step=3` 与 `?step=16` |
| 复现视频 | N/A（静态存在） |
| 证据 | [WWZ 分解数据表](dogfood-output/5189134-20260729/screenshots/24-step3-scrollable-table.png)、[学生报告页](dogfood-output/5189134-20260729/screenshots/84-student-tablet-report.png) |

**描述**

“WWZ 分解数据表”的 `.table-wrap.bounded-data-table` 是横向可滚动区域，但自身不能获得键盘焦点，
内部也没有可聚焦的内容。`agent-browser a11y`（axe-core 4.12.1）报告
`scrollable-region-focusable` serious-impact 违规。鼠标或触控用户可以横向滚动查看后续指标列，
只使用键盘的用户无法把焦点移入该区域，也就无法访问视口之外的列。
步骤 16 的生成报告中另一个 `.table-wrap` 也被同一规则检出，表明共享表格容器在多个步骤中均受影响。

预期滚动容器可通过 Tab 聚焦（例如具有合适的 `tabindex`、可访问名称及清晰焦点样式），或者内部
提供可聚焦的滚动机制。

**复现步骤**

1. 学生进入步骤 3“GVC 总贸易流分解指标”。
2. 定位“WWZ 分解数据表”，确认其内容宽度超过可视容器并需要横向滚动。
3. 使用 Tab 键尝试进入表格滚动区域；焦点会跳过该容器。
4. 运行 `agent-browser a11y --tags wcag2a,wcag2aa --json`。
5. 观察 `.table-wrap` 被报告为 `scrollable-region-focusable` 违规。
6. 打开步骤 16 并重复审计，观察报告内的 `.table-wrap` 同样被报告。

---

### ISSUE-005：移动端 16 个步骤导航全部退化为同名“✓”按钮

| 字段 | 值 |
|---|---|
| 严重程度 | High |
| 分类 | Accessibility / Responsive |
| URL | `http://127.0.0.1:5173/?step=7`（390 × 844 移动视口） |
| 复现视频 | N/A（静态存在） |
| 证据 | [移动端标注截图](dogfood-output/5189134-20260729/screenshots/69-student-mobile-step7.png)、[移动端干净截图](dogfood-output/5189134-20260729/screenshots/71-student-mobile-step7-after-wait.png) |

**描述**

在 390 px 宽视口中，课程大纲会横向折叠为 16 个圆形完成按钮。步骤标题和编号元素被
`display: none` 隐藏，按钮没有 `aria-label`；由于每一步都已完成，唯一仍参与名称计算的内容都是
“✓”。`agent-browser snapshot` 因而将 16 个按钮全部暴露为 `button "✓"`，无法区分当前步骤、
目标步骤或步骤序号。按钮虽有 `title="第 N 步：…"`，但可见的“✓”已成为可访问名称，`title`
并未在无障碍树中提供区分信息。

这使移动端屏幕阅读器和语音控制用户无法可靠跳转 16 个核心实验步骤。预期每个按钮始终具有唯一
名称，例如“第 7 步：GVC 贸易流指标可视化（当前，已完成）”，无论可见标题是否因响应式布局隐藏。

**复现步骤**

1. 使用已完成多个步骤的学生账号登录。
2. 将视口调整为 390 × 844。
3. 查看横向课程大纲；可见内容只剩一排相同的绿色勾号。
4. 运行 `agent-browser snapshot -i`。
5. 观察 16 个步骤导航全部显示为相同的 `button "✓"`。

---

### ISSUE-006：教师端移动导航只剩无语义的 emoji 按钮

| 字段 | 值 |
|---|---|
| 严重程度 | High |
| 分类 | Accessibility / Responsive |
| URL | `http://127.0.0.1:5173/`（教师工作台，390 × 844 移动视口） |
| 复现视频 | N/A（静态存在） |
| 证据 | [移动端教师工作台](dogfood-output/5189134-20260729/screenshots/72-teacher-mobile-students.png)、[无障碍节点标注](dogfood-output/5189134-20260729/screenshots/73-teacher-mobile-nav-annotated.png) |

**描述**

教师工作台在 390 px 宽视口中把五个主导航项的可见文字隐藏，仅保留 📊、🏫、👥、📝、📢。
这些按钮没有 `aria-label`、`aria-labelledby` 或 `title`，无障碍树中相应名称也只剩 emoji，
分别显示为 `button "📊"` 等。仅凭 emoji 无法可靠表达“班级概览”“课程与作业”
“班级与学生”“报告评阅”“课堂公告”等业务目的，屏幕阅读器与语音控制用户难以确定目标页面。

预期在视觉标签折叠后仍保留完整、唯一的程序化名称，并暴露当前选中状态，例如
`aria-label="班级与学生"` 与 `aria-current="page"`。

**复现步骤**

1. 使用教师账号登录教师工作台。
2. 将视口调整为 390 × 844。
3. 观察主导航只显示五个 emoji 图标。
4. 运行 `agent-browser snapshot -i`。
5. 观察五个导航项只被识别为 `button "📊"`、`button "🏫"`、`button "👥"`、
   `button "📝"`、`button "📢"`，没有业务名称。

---

### ISSUE-007：教师移动端概览卡片撑宽主内容并隐藏评阅图例

| 字段 | 值 |
|---|---|
| 严重程度 | Medium |
| 分类 | Responsive / Visual |
| URL | `http://127.0.0.1:5173/`（教师 → 班级概览，390 × 844 移动视口） |
| 复现视频 | N/A（静态存在） |
| 证据 | [默认横向位置](dogfood-output/5189134-20260729/screenshots/75-teacher-mobile-overview-charts.png)、[横向滚至最右](dogfood-output/5189134-20260729/screenshots/76-teacher-mobile-overview-horizontal.png) |

**描述**

390 px 宽视口下，“成绩分布”和“评阅进度”仍保持双列布局。右侧评阅卡片中的图例超出卡片和
视口，使 `.teacher-main` 的 `clientWidth` 为 390 px、`scrollWidth` 为 427 px；默认位置看不到
“已评阅/待评阅”图例。只有将整个主内容横向滚到最右 37 px 后图例才出现，同时左侧标题、卡片和
后续图表又被整体裁掉。页面本身隐藏原生滚动条，用户也没有明显线索表明还可横向滚动。

预期移动端卡片改为单列，或让图表及图例在各自卡片内重排，不应让整个主内容产生横向溢出。

**复现步骤**

1. 使用教师账号打开“班级概览”。
2. 将视口调整为 390 × 844，并纵向滚动到“成绩分布/评阅进度”区域。
3. 观察右侧环形图的评阅图例在默认位置不可见。
4. 检查尺寸：`.teacher-main` 为 390/427 px（可视宽度/内容宽度）。
5. 将主内容横向滚动 37 px；图例出现，但页面左侧内容被整体裁掉。

---

### ISSUE-008：学生步骤刷新会重复请求相同的初始化数据

| 字段 | 值 |
|---|---|
| 严重程度 | Low |
| 分类 | Performance / Network |
| URL | `http://127.0.0.1:5173/?step=7` |
| 复现视频 | N/A（网络请求静态计数） |
| 证据 | [单次刷新资源计数](dogfood-output/5189134-20260729/screenshots/80-duplicate-api-evidence-readable.png) |

**描述**

清空网络日志后仅刷新一次已登录的步骤 7，前端在同一初始化阶段分别发出两次相同的
`GET /api/auth/me`、`GET /api/classroom/announcements`、`GET /api/indicators/schema` 和
`GET /api/indicators/country/2020`。其中国家指标响应约 98.8 KB、schema 约 9.7 KB，重复下载
增加约 108 KB 响应体及四次数据库/API 往返。`/api/classroom/progress` 的四次资源记录中还包含
状态写入，`/api/classroom/session` 的两次记录分别包含读取和同步，因此未将其简单认定为同类重复。

预期同一页面初始化所需的只读资源由共享查询/缓存去重，每个参数组合只发送一次。

**复现步骤**

1. 使用已登录学生会话打开步骤 7。
2. 清空浏览器请求日志和 ResourceTiming 条目。
3. 刷新页面并等待所有图表加载完成。
4. 查看 Fetch 请求；观察上述四个 GET URL 各出现两次且均返回 200。
5. ResourceTiming 汇总同样显示 `schema` 与 `country/2020` 各计数为 2。

---

### ISSUE-009：指标 API 失败后页面永久停留在加载状态且无法重试

| 字段 | 值 |
|---|---|
| 严重程度 | Medium |
| 分类 | Reliability / Error handling |
| URL | `http://127.0.0.1:5173/?step=7` |
| 复现视频 | [请求失败与恢复](dogfood-output/5189134-20260729/videos/issue-009-api-failure.webm) |
| 证据 | [持续加载 14 秒后](dogfood-output/5189134-20260729/screenshots/81-api-failure-infinite-loading.png)、[视频复现状态](dogfood-output/5189134-20260729/screenshots/82-issue009-api-failure-video-state.png) |

**描述**

拦截并中止 `GET /api/indicators/country/2020` 后刷新步骤 7，页面的两个数据区域持续显示
“加载 2020 年国家指标中…”。等待超过 14 秒后状态不变，页面没有错误说明、超时提示、
`role="alert"`、重试按钮或自动重试；浏览器请求日志确认两次重复请求都被中止。用户仍可操作
年份和标签页，却无法判断是数据为空、计算较慢还是网络已经失败。

解除拦截并刷新后图表可正常恢复，说明这是前端失败状态处理缺失。预期请求异常或超时后结束 loading，
展示可访问的错误信息与“重试”操作，同时保留已有筛选条件。

**复现步骤**

1. 使用学生账号打开步骤 7，并确认图表正常加载。
2. 中止匹配 `**/api/indicators/country/2020` 的网络请求。
3. 刷新页面。
4. 等待至少 14 秒。
5. 观察两个数据区始终停留在“加载”文案，且没有错误或重试入口。
6. 恢复请求并刷新，图表重新正常显示。

---

### ISSUE-010：报告页加载的累计布局偏移达到 0.26

| 字段 | 值 |
|---|---|
| 严重程度 | Low |
| 分类 | Performance / Visual stability |
| URL | `http://127.0.0.1:5173/?step=16`（768 × 1024） |
| 复现视频 | N/A（加载性能指标） |
| 证据 | [两次 vitals 结果摘要](dogfood-output/5189134-20260729/vitals-step16-summary.json)、[DevTools 加载 trace](dogfood-output/5189134-20260729/student-report-load-trace.json)、[加载完成状态](dogfood-output/5189134-20260729/screenshots/84-student-tablet-report.png) |

**描述**

在已登录会话中对步骤 16 连续运行两次 `agent-browser vitals --json`，累计布局偏移（CLS）均为
`0.26`，略高于 Core Web Vitals 的“较差”边界 0.25。两次最大的单次偏移均为 `0.2252`，
后续还有 `0.0159` 和 `0.0175`。页面速度本身良好：两次 FCP 为 124/132 ms、LCP 为
632/560 ms、TTFB 为 1.7/1.2 ms，因此主要问题是异步恢复课程、评阅与报告数据时没有预留稳定
布局，而不是服务端响应缓慢。

预期为异步区域预留尺寸或使用稳定骨架，使 CLS 降到 0.1 以下。

**复现步骤**

1. 使用已有完整报告和评阅结果的学生账号登录。
2. 将视口设为 768 × 1024，打开步骤 16。
3. 运行 `agent-browser vitals 'http://127.0.0.1:5173/?step=16' --json`。
4. 重复一次以排除偶发波动。
5. 观察两次 `cls.score` 均为 `0.26`，且最大偏移条目均为 `0.2252`。

---

### ISSUE-011：教师实验进度图把 32 个按钮嵌套在 `role="img"` 内

| 字段 | 值 |
|---|---|
| 严重程度 | Medium |
| 分类 | Accessibility / Interaction |
| URL | `http://127.0.0.1:5173/`（教师 → 班级概览） |
| 复现视频 | N/A（静态语义结构） |
| 证据 | [实验进度图交互节点标注](dogfood-output/5189134-20260729/screenshots/86-teacher-funnel-nested-interactive.png) |

**描述**

“实验进度：到达与完成”的 `.funnel-svg` 被声明为 `role="img"`，其内部却包含 32 个
`<g role="button" tabindex="0">`：步骤 1–16 的“到达”和“完成”各一组。交互控件不应嵌套
在被视为单一图片的父级中；部分辅助技术会把图片视为叶节点并忽略其后代按钮。
`agent-browser a11y`（axe-core 4.12.1）因此报告 serious-impact 的
`nested-interactive` 违规。虽然当前 Chromium 无障碍快照仍列出 32 个按钮，但该语义结构在
不同浏览器/屏幕阅读器组合中不可靠。

预期移除父 SVG 的 `role="img"`，改用由标题/说明命名的 `group`，或把每个数据点改为 SVG 外部
的原生按钮/链接，确保交互后代在所有辅助技术中保留。

**复现步骤**

1. 使用教师账号进入“班级概览”。
2. 定位“实验进度：到达与完成”图。
3. 运行 `agent-browser a11y --tags wcag2a,wcag2aa`。
4. 观察 `.funnel-svg` 被报告为 `nested-interactive` serious 违规。
5. 检查其语义：父节点为 `role="img"`，内部有 32 个可聚焦 `role="button"` 数据点。

---

## 通过项与正向观察

- 学生从空账号开始完整完成 16 步；15 个测验步骤均由服务端可信证据判定，步骤 16 由报告提交判定。
  最终教师列表稳定显示当前步 16、服务端验证 16/16、报告已评阅、96 分。
- 步骤 3–10 的国家、年份、行业、实体、指标、图表视角和网络节点筛选均可交互，状态能跨刷新恢复。
- 步骤 12 的基线 DID、带控制变量 DID、事件研究和 40 次安慰剂均真实运行；系统正确披露预趋势
  警告（`p=.012`）、置信区间和安慰剂经验 p 值（`.561`），没有把警告包装成因果证明。
- 步骤 13–15 的生产、长度和网络结果均包含系数、区间、聚类/支持度提示；内置 PanelOLS 系数
  对照通过。报告生成时重新执行并写入了可追溯的运行凭据，而不是仅拼接界面缓存。
- 教师评分表对空分数、101 分分别显示“请填写分数(0-100)”和“分数须为 0-100 的整数”；96 分与
  反馈提交后，教师概览、评阅列表和学生报告页三处一致。
- 学生请求教师 `/api/classroom/overview`、`/api/classroom/students` 返回 403；教师请求学生私有
  报告/进度端点也返回 403；匿名元数据与教师端点返回 401。登录字符串 `' OR 1=1 --` 被通用错误
  文案拒绝，没有泄露数据库信息。
- 一处学生会话退出后，同账号另一独立会话仍可刷新并看到 16/16 与 96 分，符合按 token 精确撤销。
- 刻意中止指标 API 后虽然触发 ISSUE-009，但解除拦截并刷新即可恢复；整轮测试未记录未捕获的
  JavaScript page error。
- 前端打印按钮在 headless Chrome 中可触发打印流程，没有崩溃；本轮未验证实体打印机和纸张分页。

## 性能、稳定性与可访问性

### 100 学生容量

容量脚本使用 100 个独立凭证，不复用共享账号；25 个学生额外执行 40 次安慰剂。测试主机只有
12 个逻辑 CPU，仍在 24.820 秒内通过全部项目：

| 操作 | 请求数 | p95 | 门槛 | 状态 |
|---|---:|---:|---:|---|
| 登录 | 100 | 0.430 s | 普通读取 ≤ 3 s | 100 × 200 |
| 元数据 | 100 | 0.186 s | ≤ 3 s | 100 × 200 |
| 步骤定义 | 100 | 0.093 s | ≤ 3 s | 100 × 200 |
| 课堂上下文 | 100 | 0.110 s | ≤ 3 s | 100 × 200 |
| 国家指标 | 100 | 0.195 s | ≤ 3 s | 100 × 200 |
| 原始账户切片 | 100 | 1.280 s | ≤ 3 s | 100 × 200 |
| 教学回归 | 100 | 8.504 s | ≤ 35 s | 100 × 200 |
| 40 次安慰剂 | 25 | 12.994 s | ≤ 50 s | 25 × 200 |
| 进度写入 | 100 | 0.112 s | ≤ 3 s | 100 × 200 |
| **完整场景** | — | **24.820 s** | **≤ 120 s** | **通过，0 失败** |

压测后 readiness 仍为 `ok`：pool size/available 均为 4，累计 checkout 439、queued 308、
`requests_errors=0`，liveness 同样为 `ok`。完整机器可读结果见
[capacity-100-result.json](dogfood-output/5189134-20260729/capacity-100-result.json)。

容量脚本边界也单独验证：

- 100 个请求配 50 个凭证时以非零码拒绝，并明确报告“只有 50 个账号”；
- `--students -1` 以非零码拒绝，要求范围为 50..100；
- 正式结果中的 `students=100`、`authenticated=100`、`failure_count=0`。

### 数据库池专项

- 主部署 pool max 4 下，同时发出 4 个 overview 与 4 个 students 请求，8 个状态均为 200，
  总耗时 109 ms。
- 单 worker、pool max 1 下重复相同的 8 请求，均为 200，总耗时 168 ms；四份学生列表都返回
  `verified_completed_count=16`、步骤 `[1..16]`、状态 `graded` 和 96 分。
- pool=1 测试后 health 显示 checkout 28、queued 13、`requests_errors=0`，直接覆盖了
  “持有外层连接时再次 checkout”可能造成的饥饿回归场景。
- 主服务最终 health 复查为 `ok`、`requests_waiting=0`、`requests_errors=0`；测试收敛后的空闲
  快照曾显示 pool size/available 4/4，最终 health 请求内采样为 3/2（探针本身仍占一次 checkout）。

### 浏览器性能与网络

- 步骤 16 两次 vitals 的 FCP 为 124/132 ms、LCP 为 632/560 ms、TTFB 为 1.7/1.2 ms，
  加载速度良好；CLS 两次均为 0.26，记录为 ISSUE-010。
- 单次步骤 7 刷新会重复下载只读初始化数据，记录为 ISSUE-008。
- 四份 HAR 均可被 JSON 解析，合计 1,991 个请求：
  - 教师：85 × 200、2 × 403（刻意越权测试）；
  - 主学生：532 × 200、2 × 403（刻意越权测试）；
  - 匿名：3 × 401（刻意未登录测试）；
  - 第二学生：1,360 × 200、7 × status 0（刻意离线及中止请求）。
- 没有非预期 4xx 或任何 5xx；HAR 含本地测试 token，已统一设为 `0600`，不应作为公开附件发布。

### 可访问性

axe-core 4.12.1（WCAG 2 A/AA）与手工键盘检查结论：

| 页面 | 自动审计摘要 | 对应问题 |
|---|---|---|
| 教师概览 | 3 violations、1 incomplete：对比度、无名称 select、嵌套交互 | ISSUE-001、002、011 |
| 教师建班/学生/作业/公告 | critical 的 `label` / `select-name` | ISSUE-001 |
| 学生步骤 3 | 5 个 critical `select-name`、serious 滚动区 | ISSUE-001、004 |
| 学生步骤 16 | 2 violations、1 incomplete：14 个对比度节点、1 个滚动区 | ISSUE-002、004 |
| 首次介绍层 | 手工 Tab 可逃到遮罩后的页面，背景仍在无障碍树 | ISSUE-003 |
| 390 px 导航 | 学生 16 个同名“✓”；教师 5 个仅 emoji | ISSUE-005、006 |

自动审计不能替代 NVDA/JAWS/VoiceOver 实机组合；当前 High 问题已足以判定无障碍验收不通过。

## 风险与建议

1. **发布前优先修复 4 个 High 无障碍问题。** 先统一表单 label 组件，修复介绍层的 dialog/focus
   管理，再为学生和教师移动导航提供不随视觉折叠消失的名称与当前状态。修复后用键盘、NVDA/Firefox
   和 VoiceOver/Safari 复验。
2. **为所有数据请求建立明确的 error/retry 状态。** ISSUE-009 会把真实网络故障伪装成永久计算；
   应使用超时、可访问 alert、保留筛选条件的重试，并避免重复请求放大故障。
3. **修复共享可访问性基础组件。** 统一提高 muted 文本对比度，让横向表格容器可聚焦并有焦点样式；
   把进度 SVG 从 `role="img"` 与嵌套按钮结构改为 group/原生控制。
4. **调整教师移动布局。** 390 px 下概览图卡应单列或在卡片内部重排，不能让整个主内容横向移动。
5. **去重初始化 Fetch 并稳定首屏骨架。** 共享 query/cache 可消除 ISSUE-008；为报告异步区域预留
   尺寸可将 ISSUE-010 的 CLS 从 0.26 降至 0.1 以下。
6. **在目标基础设施重跑容量验收。** 本地 12 核 loopback 结果显著低于所有门槛，但没有覆盖生产
   Nginx、TLS、校园 NAT、真实网络抖动和文档所述 64 核/16 worker 拓扑。上线前应使用相同 100
   独立账号脚本在目标机复跑，并保留 JSON 结果与服务指标。

发布建议：若范围仅为受控课堂、桌面鼠标操作，可在明确知悉上述问题的前提下试点；若发布标准包含
移动端或 WCAG 2 AA，则应在 ISSUE-001、003、005、006 修复并复验前阻止正式验收。

## 完成审计

- [x] 固定并记录被测 branch/commit，使用隔离的新数据库和独立测试账号。
- [x] 学生 1–16、教师初始化、评阅、成绩回流、步骤下钻均通过真实浏览器完成。
- [x] 匿名、跨角色、注入字符串、双会话、退出、离线和单 API 失败场景已覆盖。
- [x] 1440×900、768×1024、390×844 三档视口已覆盖。
- [x] 100 个精确账号容量验收通过，且 50 账号冒充 100、负数参数均被拒绝。
- [x] pool max 1 的嵌套证据读取并发回归通过。
- [x] 后端测试：`341 passed in 20.95s`。
- [x] 前端单测：`109 pass, 0 fail`。
- [x] TypeScript + Vite 生产构建：347 modules，构建成功。
- [x] production preflight、主服务 readiness/liveness 最终均为 `ok`。
- [x] 主库最终有 2 个账号、1 班、1 作业、1 公告、1 提交、1 提交版本、1 评分事件；
  15 个测验步骤可信证据加报告提交共同形成 16/16，状态 `graded`、分数 96。
- [x] 87 张截图、4 段 WebM、4 份 HAR、1 份 DevTools trace 和容量/vitals JSON 均存在；
  JSON/HAR/trace 可解析，证据目录约 125 MiB。
- [x] 四个浏览器会话未记录未捕获 page error；HAR 中无非预期错误和 5xx。
- [x] 容量与 pool=1 辅助服务已停止，主部署继续监听 `127.0.0.1:5173` 与 `:8000`。

限制：本轮只使用 Linux Headless Chrome，没有覆盖真实触控设备、Safari/Firefox、屏幕阅读器、
打印机驱动、Nginx/TLS 或跨主机网络；经济学结果使用系统内置 PanelOLS 对照与界面披露进行验证，
未另做一份独立论文级复现。

**最终结论：有条件通过。** 核心业务、数据一致性、鉴权、并发和容量均通过；11 个问题中无
Critical，但 4 个 High 无障碍/移动导航问题必须在无障碍正式发布前修复。
