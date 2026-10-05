# 交付前一周：评审与测试计划

| 项目 | 内容 |
| --- | --- |
| 制定日期 | 2026-10-06 |
| 代码基线 | `c955e79`（分支 `cc`，工作树干净） |
| 数据基线 | OECD ICIO 2023 真实 release `01b87b87…`（本地 WSL 与演示站一致） |
| 交付日期 | 2026-10-13 |
| 现有自动化 | 后端 pytest 522 例（覆盖率门槛 85%）、前端 bun test 429 例、agent-browser 浏览器验收 5 个脚本、Gephi 基准、`scripts/local_ci.sh` 全量门禁 |

## 0. 原则与节奏

- **今天起功能冻结。** 只接受缺陷修复与文案／文档修正；任何改变指标数值、冲击语义、产物结构或题库的改动一律推到交付后。
- **问题分级。** P0 阻断交付（数据错误、丢数据、无法登录／提交、部署失败）；P1 交付前必修（流程卡顿、文案错误、手册与界面不一致）；P2 记入"已知问题与未验收项"随交付包说明。
- **问题登记。** 全部发现记入本文件末尾的问题清单，每条写复现步骤、分级、负责修复的提交号、验证方式。
- **每日收口。** 每天结束前跑一次快速门禁（见 1.1），保证主干始终可交付。
- **评审与测试分离。** 代码评审针对最近两天 34 个提交（10-05、10-06 重构了全部 15 步与报告材料记录）；测试针对整个系统，不只看改动处。

## 1. 第 1 天（10-06）：基线与门禁

### 1.1 快速门禁（每天收口都跑）

在 WSL `Ubuntu-24.04` 中执行，先 `source ~/gvcsim/dev.env`，`GVCSIM_PG_DSN` 必须指向一次性测试库（conftest 会删 `public` schema）。

```bash
uv run ruff format --check . && uv run ruff check . && uv run mypy && bash -n scripts/*.sh
uv run pytest --cov=gvcsim --cov-report=term-missing -q
cd frontend && bunx tsc --noEmit -p . && bun run test:unit && bun run build && bun run test:build-modes
```

- [x] 全部通过，记录提交号、耗时、覆盖率数字到问题清单上方的"证据记录"。（10-06 首轮 mypy 失败，D-001 修复后通过）
- [x] 失败项分级登记。

### 1.2 全量门禁 `scripts/local_ci.sh`

10-06 实测：WSL 只有 git、rsync、uv、psql、setsid；**缺 docker、bun、mvn、java、agent-browser、pdftotext**。bun 1.4.2 在 Windows 侧可用（前端门禁已用它跑通）。

- [x] WSL 内安装 `docker.io`（systemd 托管），`docker info` 通过。
- [x] WSL 内 `apt install openjdk-17-jdk-headless maven poppler-utils fonts-noto-cjk`；bun 1.4.2、Node 22.20、agent-browser 0.38.2（Chrome 154）装到 `~/.bun`、`~/.local/node`。
- [x] 运行 `scripts/local_ci.sh`：前三轮分别因 D-003、D-004、D-006、D-005 失败，第四轮全部通过；证据 `dogfood-output/local-ci/20261005T192922Z-679/`。
- [ ] 若 Docker 始终不可用：用 WSL 本机 PostgreSQL 的 `gvclab_test`、`gvclab_e2e` 两库，手工按脚本顺序执行各段。

### 1.3 基线盘点

- [x] 确认演示站 `101.201.151.30` 运行的提交与 HEAD 一致（c955e79，源文件与前端产物哈希抽样一致）。
- [ ] 与交付方确认：**交付环境**（客户主机还是演示站？域名、TLS、数据库位置）、**验收浏览器与版本**、**验收账号**（教师／学生各几个）、**真实 OECD 原始文件**由谁提供。这些决定第 4、6 天的工作量。

## 2. 第 2 天（10-07）：代码评审

### 2.1 近期变更评审（重点）

对象：`git log 324d3e6..HEAD`（技术手册基线之后的全部提交）。方法：`/code-review high`，10-06 已完成一轮（逐行、删除行为、跨文件调用、复用、简化、效率、修复深度、约定八个角度），结果见 D-007～D-012。关注点逐项结论：

- [x] 报告材料自动记录：提交后 `materialLocked` 关闭自动写入，只能显式"改用当前图表"；自动保存会清掉 `material_chosen`；未发现未操作写入或重复材料。步骤 10 的例子完整性判断有漏洞（D-009）。
- [x] 步骤 6–9"全球位置"读法：全体相同读数时页面与报告同用"不分名次"，`ties` 缺省向后兼容；未发现渲染错误。
- [x] `dd4d9f6` 自动恢复：按步合并，只回放本页相对基线改过的步，同步同项冲突以服务器为准并有提示；bfcache 返回时清除副本；逻辑正确。但真实过期／改密／换号三条脚本不在门禁内（D-012）。
- [x] `492a3fc` 提交后材料命名：步骤 6–8 报告区分"学生选定"；已评阅报告再生成改为页内确认框，但确认前未置 busy（D-008）。
- [x] 报告表格换行（`c955e79`）：打印 PDF 七列校验在 local_ci 中通过（装中文字体后）。
- [x] 新增：报告指纹排除的视图键仍被渲染器读取（D-007）。

### 2.2 安全与运行保护评审

- [x] 安全评审（10-06，未发现高／中危，见证据记录；部署核对项 D-013）：认证令牌与 TTL、口令哈希、登录与回归限流、CORS 允许来源、路径与文件标识（`file_identity.py`、原始 ICIO 切片 `icio_browser.py` 的参数边界）、教师接口的角色校验、报告导出不含凭证与他人记录。
- [x] 复核 `deploy/nginx-gvcsim.conf` 与 `deploy/gvcsim-api.service`：CSP/HSTS/nosniff 齐全，`/readings/` 仅同源嵌入，`client_max_body_size 2m`，读超时 120 s，systemd 沙箱与只读数据路径；模板未设 `MemoryMax`（演示站单独加了），交付主机按内存补。
- [x] 日志中不输出口令、令牌、DSN：422 响应只回 loc/msg/type；`--no-access-log`；DSN 只在环境文件。

### 2.3 专业内容评审

- [x] 复跑 `scripts/review_statistics.py`（真实 release，2000 次重复）与 `scripts/gephi_golden/generate.sh --check`（local_ci 内）：四项 TWFE 系数与 linearmodels PanelOLS 之差 ≤1e-15，Gephi 逐字节一致。
- [ ] 抽查 3 个国家×行业×年份的指标，对照技术手册第 5–7 节公式手算或用 pandas 独立复算（增加值分解闭合、生产长度、网络指标）。
- [ ] 回归输出的文案不作因果解释、不冒充 OECD 指标（README 与手册的红线）。

## 3. 第 3 天（10-08）：学生端手工探索测试

环境：本地 WSL API（真实 release）+ Windows Vite，`VITE_DEMO_MODE=1`，另开演示站交叉验证。按《实验手册》逐步操作，手册即测试脚本。

### 3.1 15 步逐步检查表（每步都过）

- [ ] 页面挂载无控制台错误、无 4xx/5xx 请求。
- [ ] 默认国家／行业／年份与手册一致；切换后图表、表格、文案同步。
- [ ] 报告材料按手册所述自动记录，侧栏进度与保存状态正确。
- [ ] 理解题：正确／错误反馈、重复提交、刷新后保留。
- [ ] 刷新、后退、直接用 `?step=N` 进入、从步骤 15 跳回修改再回到 15。
- [ ] 文案：中文标点、单位、年份范围、无占位符或英文残留。

### 3.2 专项场景

- [ ] 步骤 10–14：运行回归、切换 Y、重复运行、同账号两标签页同时运行（预期 503 `account_work_inflight` 的友好提示）、限流触发提示。
- [ ] 步骤 15：材料不足时的门禁文案；生成→修改反思→再生成→提交→查看评分；提交后再生成的确认与评分清除；打印 PDF 版式（A4、表格换行、无提交遮罩）。
- [ ] 会话与认证：令牌过期后恢复草稿（`dogfood_token_expiry.py`）；自行改密后旧令牌失效（`dogfood_self_password_recovery.py`）；三标签页交错（`dogfood_workspace_interleavings.py`）；断网 30 秒后恢复。
- [ ] 浏览器矩阵：Chrome、Edge、Firefox 最新版，1200 px 最小宽度与 1920 px；缩放 90%/110%。
- [ ] 全新学生账号从零走完 15 步计时，记录每步耗时，作为课堂时长参考。

## 4. 第 4 天（10-09）：教师端、并发与容量

### 4.1 教师端

- [ ] 学期／班级：创建、改名、归档、归档后禁止新增与接收学生，恢复后放开。
- [ ] 学生：单个创建、名单批量创建（重复学号、空行、非法字符、超长、CSV 编码）、改姓名学号、重置密码、调整归属。
- [ ] 评阅：按分组筛选、打开报告、评分与反馈草稿保护（刷新、切换学生、过期）、两位教师同时评同一份报告的版本冲突、学生再生成报告后评分清除的提示。
- [ ] 教师改密后旧会话失效；教师不能访问学生接口以外的数据。

### 4.2 并发与容量（在目标主机或演示站）

- [ ] `scripts/benchmark_shock_panel_v9.py` 针对待交付 release 跑冷启动、顺序、8 并发 warm p95，记录写入 `benchmarks/`。
- [ ] `scripts/dogfood_http_edges.py` 用一次性账号探测部署站的 HTTP 边界。
- [ ] 50 个学生账号脚本化同时登录、浏览 5 个年份原始表、各运行一次回归，观察 API 内存（演示站上限 1.4 GiB，已知浏览全部年份后驻留 800–900 MB）、PostgreSQL 连接数、nginx 错误日志。
- [ ] 重启 API 后首个请求的 preflight 时间与 `/health` 恢复时间。

## 5. 第 5 天（10-10）：文档与交付物一致性

- [ ] **实验手册**：截图基线是 `49d019e`，之后已有十余个改动界面的提交（步骤 6–9、报告页、自动恢复）。按 `docs/student-manual/README.md` 重拍受影响截图，更新 `screenshots.json`，重排并导出 PDF，核对页码表与 `tests/test_steps.py` 哈希。
- [ ] **技术手册**：基线 `324d3e6` 更新为交付提交；逐节核对第 3（操作流程）、8（报告材料）、10（接口）、15（测试）节与代码一致；版本号与日期。
- [ ] **README / DEPLOY.md**：每条命令在干净环境实际执行一遍（结合第 6 天），占位符说明清楚；"支持范围"与"不在范围"表述与交付合同一致。
- [ ] 指标说明 PDF（`docs/indicator-readings`）重建一次，确认阅读库内嵌打开正常。
- [ ] 文档中无内部 IP、口令、个人账号；LICENSE 与 OECD 条款声明齐全。

## 6. 第 6 天（10-11）：部署演练与数据生命周期

在一台干净 Linux 虚拟机（或清空的演示站镜像）上，只依据 DEPLOY.md 操作：

- [ ] 主机 bootstrap → `uv sync --frozen` → 前端 `bun run build`（普通构建，不含演示凭证）→ 环境文件 → nginx + TLS → systemd 服务与备份定时器。
- [ ] 真实原始文件 `compute` 全程计时与峰值内存（本地记录约 10 分钟、1.9 GB），`preflight` 通过，首位教师创建。
- [ ] 数据换版：`scripts/dogfood_release_roundtrip.py` A→B→A，确认会话与报告按 `release_id` 隔离、旧令牌失效、回滚可用。
- [ ] 发布中断：`scripts/dogfood_publication_faults.py`，确认不会留下半成品 release。
- [ ] 备份与恢复：触发一次 `gvcsim-backup.service`，在隔离库恢复并核对校验文件；记录恢复耗时。
- [ ] 新学期 `classroom-init --reset` 只在测试库演练，确认备份先行的提示与结果。
- [ ] 非 Chrome 浏览器通过 HTTPS 登录；`GVCSIM_ALLOWED_ORIGINS` 配错时的表现。

## 7. 第 7 天（10-12）：收尾与打包

- [ ] 复验全部 P0/P1 修复，关闭问题清单；P2 整理为"已知问题与未验收项"。
- [ ] 最终一次 `scripts/local_ci.sh` 与第 1.1 节快速门禁，证据归档。
- [ ] 若有代码改动，重新同步两本手册的代码基线与截图（第 5 天流程的增量）。
- [ ] 打 tag（如 `v1.0.0`），导出 `git archive`，附锁文件与普通生产构建产物。
- [ ] 按技术手册 16.2 组装交付包：源码与构建产物；两本手册、部署手册、环境配置项说明；原始输入哈希、release manifest、QC 与来源说明；教师初始化与账号交接记录（口令走受限渠道）；自动化测试结果、浏览器截图、性能记录；备份文件、校验文件、恢复演练记录、回滚资料。
- [ ] 更新演示站到交付提交（如约定），记录部署时间与提交号。

## 8. 分工建议

| 工作 | 可由 Claude 自主完成 | 需要你决定或提供 |
| --- | --- | --- |
| 1.1 快速门禁、2.1 代码评审、2.2 安全评审、2.3 数值复算 | 是 | — |
| 1.2 全量门禁 | 是 | 启动 Docker Desktop |
| 3、4.1 手工探索测试 | 本地与演示站可自动化操作 | Edge／Firefox 需在你的机器上验证 |
| 4.2 容量测试 | 脚本化 | 目标主机访问权限 |
| 5 文档同步 | 是 | 最终定稿审读 |
| 6 部署演练 | 命令与脚本准备 | 干净虚拟机、域名、证书、原始文件 |
| 7 打包 | 是 | tag 名、交付渠道 |

## 证据记录

| 日期 | 提交 | 检查项 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 10-06 | c955e79 | ruff format / ruff check / bash -n | 通过 | WSL，140 文件 |
| 10-06 | c955e79 | mypy | **失败**，6 处 | 见问题 D-001，修复后通过 |
| 10-06 | c955e79 | pytest --cov（gvclab_test，真实 release） | 807 通过，覆盖率 90.37%，324 s | WSL，/mnt/c 下运行 |
| 10-06 | c955e79 | tsc / bun test:unit / build / test:build-modes | 475 通过，构建与模式边界通过 | Windows bun 1.4.2；一条 React act() 警告，见 D-002 |
| 10-06 | c955e79+D-001 | 报告相关 5 个测试模块 | 109 通过 | 验证重命名未改行为 |
| 10-06 | HEAD | 演示站 101.201.151.30 与 HEAD 一致性 | 一致 | 抽样 4 个源文件 SHA-256 相同，前端 CSS 产物哈希相同，/health ok |
| 10-06 | 324d3e6..HEAD | 代码评审（/code-review high，8 个角度） | 8 项发现 | D-007（P1）、D-008～D-010（P2）、D-011（整洁）、D-012（覆盖） |
| 10-06 | HEAD | 安全评审（认证、角色、限流、CORS、输入、代理、Markdown、nginx/systemd） | 未发现高／中危 | 令牌 HMAC-SHA256 绑定账号／auth_version／release 并带过期；口令 PBKDF2-HMAC-SHA256 10 万轮加盐，常量时间比较，未知用户也做哑哈希；教师／学生路由各自 Depends 鉴权；生产禁用 demo 与占位密钥；uvicorn `proxy_headers` 只信任 127.0.0.1；react-markdown `skipHtml`；nginx CSP/HSTS，/docs 拒绝；systemd 沙箱。待交付环境核对项见 D-013 |
| 10-06 | release 01b87b87 | `scripts/review_statistics.py --replications 2000` | 四项回归 PanelOLS 对照全部通过（系数差 ≤1.8e-12，n=16220，76 簇，support ok）；覆盖率实验 0.9395（MC 95% 区间 0.928–0.949，标称 0.95） | `dogfood-output/statistics-review-20261006/`（已忽略目录）；覆盖率略低于标称属该教学 DGP 的已知特征，报告文案已标注"标称 95% 近似区间" |
| 10-06 | 1663120 | 快速门禁复跑（ruff、mypy、pytest --cov、tsc、bun test） | 808 后端通过（覆盖率 90.36%），478 前端通过 | D-007～D-010 修复后 |
| 10-06 | c955e79+D-001…D-006 | `scripts/local_ci.sh` 全量门禁 | **全部通过**，522 s | WSL + Docker 临时 PostgreSQL 17 + 合成 release；Gephi 逐字节一致；807 后端、475 前端；学生 smoke（15 步无浏览器／API 错误、无 WCAG A/AA 违规）、完整提交评阅流程（含 PDF 七列）、纯界面 15 步课程、教师 smoke 均通过。证据 `dogfood-output/local-ci/20261005T192922Z-679/` |

## 问题清单

| 编号 | 发现日期 | 分级 | 位置 | 复现步骤 | 修复提交 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| D-001 | 10-06 | P1（门禁失败） | `gvcsim/report_observed.py` 步骤 6–9 图表小节 | `uv run mypy`：`context` 变量先存文案字符串，后复用存图表上下文字典，6 处类型错误 | 638ec8c（文案变量改名 `scope`） | mypy 通过；报告测试 109 通过 |
| D-002 | 10-06 | P2 | 前端单测 `NetworkTrend` | `bun run test:unit` 输出一条未包裹 act() 的状态更新警告，不影响通过 | 未修 | — |
| D-003 | 10-06 | P1（门禁失败） | `scripts/gephi_golden/pom.xml` | Ubuntu 24.04 自带 Maven 3.8.7 + JDK 17 下编译报 "Source option 5 is no longer supported"：pom 未声明源级别 | 638ec8c（加 `maven.compiler.source/target=11`） | Gephi 基准逐字节一致 |
| D-004 | 10-06 | P1（门禁失败） | `.gitattributes` / `tests/fixtures/*.csv` | Windows 检出（autocrlf）把 Gephi fixture 转成 CRLF，与 Linux 工具的 LF 输出逐字节比较失败；数值本身一致 | 638ec8c（fixtures 固定 `eol=lf`） | 同上 |
| D-005 | 10-06 | P1（门禁失败） | `scripts/agent_browser_course_journey.py` 步骤 6–8 | 脚本仍点击 096211a 已删除的"沿用这组比较对象"按钮；界面已改为首次打开自动沿用并自动记录。说明 096211a 之后未跑过 local_ci | 638ec8c（改为等待自动记录） | 纯界面课程 15 步通过 |
| D-006 | 10-06 | P2（环境） | WSL 验收环境 / `scripts/local_ci.sh` | 无中文字体时 Chrome 打印 PDF 丢字（"步骤"→"骤"、"教学"→"教 "），PDF 七列校验假失败 | 装 `fonts-noto-cjk`；local_ci.sh 增加中文字体前置检查（638ec8c） | 全量门禁通过 |
| D-007 | 10-06 | P1 | `gvcsim/classroom/records.py:43` 报告指纹 | `_VIEW_ONLY_KEYS` 排除了 slice/year/country/chart/drill，但 `report_render.py:45`（步骤 1 无 year/table 时回退打印 slice）和 `:95`（has_snapshot 用 year/chart/drill 决定是否出现小节）仍读取这些键：报告内容可变而状态仍显示"当前" | 1663120：渲染器只打印记录材料，不再读取 slice 与视图键；新增测试断言视图键变化不改变报告文本 | 代码评审（high）；后端 808 通过，覆盖率 90.36% |
| D-008 | 10-06 | P2 | `frontend/src/labs/steps/report-lab.tsx:290` | `generate()` 先 `await askRegenerate()` 再置 busy，已评阅报告上双击"重新生成"会覆盖第一个 resolver，首个 Promise 永久挂起 | 1663120：确认框打开期间持有 `operationRef`，取消时释放；新增双击测试 | 代码评审；前端 478 通过 |
| D-009 | 10-06 | P2 | `frontend/src/labs/steps/shock-lab.tsx:696` | `complete` 只要求每国有任意一行，但 `recordExample` 需要末年行；缺末年时会把已保存的例子覆盖成无 `teaching_observation` 的记录 | 1663120：`complete` 要求两国都有末年行；新增缺末年测试 | 代码评审；前端 478 通过 |
| D-010 | 10-06 | P2 | `frontend/src/labs/steps/db-lab.tsx:290` | `codePlainName` 对无中文名的行业代码返回代码本身，表头下方重复显示代码 | 1663120：无名称时返回 undefined；新增测试 | 代码评审；前端 478 通过 |
| D-011 | 10-06 | P3（整洁） | `db-lab.tsx:856`、`auto-comparison.tsx:117` | 用 `.replace("浏览", …)` 改写共享文案常量；`login.tsx:197` 用 `notice.includes("失效")` 决定样式；`network-ranking.tsx:58` 同一 `rankText` 调三次 | 交付后处理 | 代码评审 |
| D-013 | 10-06 | P2（部署） | `gvcsim/cli.py:113` | `forwarded_allow_ips` 写死为 `127.0.0.1`。DEPLOY.md 允许 Nginx 与 API 分机部署，此时所有学生的来源 IP 都变成 Nginx 的地址，登录来源限流（默认 120 次/分）会把全班当作一个来源，课堂集中登录时可能整体 429 | 交付环境若同机部署则无影响；分机部署需改为可配置或在 DEPLOY.md 写明 | 安全评审 |
| D-012 | 10-06 | P2（覆盖） | `scripts/dogfood_token_expiry.py`、`dogfood_self_password_recovery.py`、`dogfood_workspace_interleavings.py` | 自动恢复草稿改版后，这三条真实过期／改密／换号脚本不在 local_ci 内，合并恢复路径只有 mock API 单测 | 第 3 天专项场景手工跑一遍 | 代码评审 |
