# 交付前一周：评审与测试计划

> 历史计划：冻结日期、测试数量、发布安排和证据仅对应下述基线，不是当前任务指令或验收结论。当前 v12 复验结果见[回归说明](regression-refactor-20261010.md)，部署按[DEPLOY.md](../DEPLOY.md)。

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

10-06 用演示账号 student38 在本地课堂（WSL API 真实 release + Vite 演示构建，内置浏览器 1440×1000）走完 15 步并提交、更新、再提交报告。

- [x] 页面挂载无控制台错误、无 4xx/5xx 请求（唯一的 409 是空反思时点生成报告的预期门禁响应）。开发模式下 `/api/auth/me`、`/api/meta`、`/api/steps` 各请求两次，是 React 严格模式的双重 effect，生产构建不会。
- [x] 默认国家／行业／年份与手册一致（步骤 1 默认记录 CHN·C27→USA·F 2020 Z 表；2–9 默认 CHN 对 USA；10 默认 CAN/MEX·C29）；步骤 6 切换对比国家后图表口径、材料与保存同步。
- [x] 报告材料自动记录：1–10 打开即齐全，11–14 运行回归后齐全；侧栏 15 行状态与任务卡一致。
- [x] 理解题：答错显示提示而不泄露答案，按钮保持可用且焦点留在按钮；答对显示解释并标记完成；刷新后保留。
- [x] 直接用 `?step=N` 进入每一步均正常；从 15 回到 6 改材料再回 15 显示"需更新"。
- [x] 介绍 5 页、15 步任务卡、回归三句话、报告正文抽读未见占位符、英文残留或错别字。
- [ ] 后退键、90%/110% 缩放未测（内置浏览器面板隐藏时无法截图），留给第 5 天在真实 Chrome 上补。

### 3.2 专项场景

- [x] 步骤 10–14：四项回归各运行一次，结果页三句话读数与报告汇总表一致（11：-0.55 pp；12：-0.34 pp；13：-0.018；14：-58.87，均"支持负向关联"）；并发与限流见下一条。
- [x] 同账号并发回归与限流：对已算过的结果，3 个并行请求和随后 12 个连续请求全部 200（199 ms 内返回），说明命中结果缓存的请求不计入单飞与限流；503 `account_work_inflight` 与 429 只在冷算时出现，由 `tests/test_rate_limit.py`、`tests/test_singleflight.py`、`tests/test_concurrency.py` 覆盖，演示站实测也确认过 503 行为。
- [x] 步骤 15：空反思时门禁"1 个步骤还有 3 项待补齐"且生成被 409 拦下；填三段后生成草稿→提交→回执对话框（焦点进入标题，关闭后回到触发按钮）→状态"待评阅"；提交后步骤 6 浏览不再改材料，点"改用当前图表"后 15 显示"需更新"、导出 PDF 禁用；"更新报告并提交"后报告写"学生选定的比较：CHN、KOR"。已评阅后的再生成确认由单测与第 4 天教师评分后再验。
- [ ] 打印 PDF 版式：local_ci 的 PDF 七列校验已通过；A4 纸张与分页需在真实 Chrome 上目视确认（第 5 天）。
- [x] 会话与认证脚本（10-06，真实 release，Linux 副本 `~/gvcsim/e2e/repo` + `gvclab_e2e`）：令牌过期恢复草稿、自行改密恢复草稿、三标签页冲突／撤销请求／换号全部通过（见 D-012）。
- [ ] 断网 30 秒后恢复（手工）。
- [x] 1200 px 最小宽度：步骤 1、6、14、15 页面无横向溢出（步骤 1 的宽表在自身滚动区内，符合设计）。
- [ ] Chrome、Edge、Firefox 最新版与 1920 px、缩放 90%/110%：需在你的机器上做（内置浏览器只能代表 Chromium 内核）。注意：内置浏览器里步骤 2–5 的指标说明 PDF 显示"当前浏览器无法内嵌显示这份 PDF"，是该面板没有 PDF 插件所致，真实 Chrome/Edge/Firefox 需各确认一次内嵌是否正常。
- [ ] 全新学生账号从零走完 15 步计时，记录每步耗时，作为课堂时长参考（建议由一位真实学生完成）。

## 4. 第 4 天（10-09）：教师端、并发与容量

### 4.1 教师端

10-06 以演示教师在本地课堂（tab 2）操作，学生端（tab 1，student38）配合验证。

- [x] 学期／班级：新建"D4 测试学期"，重名被 409 拦下且对话框保留输入；添加班级、重命名班级生效；归档后卡片只剩"重命名／恢复"，班级操作与导入入口隐藏；恢复后全部放开。归档无二次确认（可恢复，接受）。
- [x] 学生：单个创建时重复用户名、非法字符、短密码分别给出明确提示且对话框保留输入，焦点落到提示；成功创建后列表立即出现并带班级。名单批量创建：空行跳过，列表内重复学号、非法学号、缺列逐行报错；干净名单预览后必须先"下载账号清单"（含初始密码，本次拦截为内存读取，未落盘）才能"确认创建"，创建后班级人数即时更新。改姓名、改学号（重复学号被 409 拦下并指出占用者）、调班（可跨学期保留多条归属）、重置密码（短密码拦下）均通过。
- [x] 评阅：待评阅／已评阅／全部筛选与计数正确；未保存草稿离开触发 `window.confirm` 保护（刷新由 beforeunload 保护，脚本已验证）；另一位教师先通过接口评分后，本页提交被 409 拦下，提示"报告内容已更新，请重新加载后评阅"并保留草稿，"加载最新报告"后显示对方的分数与评语，再"更新评阅"成功，列表显示已评阅 93。学生再生成后评分清除见下一条。
- [x] 学生再生成已评阅报告：页内确认框写明会清除评分，确认后重新提交，学生端变"待评阅"，教师列表计数 2→3、得分清空。
- [x] 教师改密后旧会话失效由 local_ci 的教师 smoke 覆盖（改密＋旧密码失效，10-06 通过）；路由层教师／学生各自 `Depends` 鉴权已在安全评审核对。

### 4.2 并发与容量（在目标主机或演示站）

10-06 在 WSL（12 逻辑核）对真实 release 执行；目标主机未定，演示站（2 vCPU／1.6 GiB）未做停机基准。

- [x] `scripts/benchmark_shock_panel_v9.py`（本机，release 01b87b87，contract v15）：冷建索引 467 ms（预算 500）、8 并发冷 p95 906 ms（预算 1500）、warm 顺序 p95 107 ms（预算 500）、8 并发 warm p95 740 ms（预算 1500），全部通过；结果在 `dogfood-output/day4-capacity/shock_panel_benchmark.json`，未覆盖 `benchmarks/` 内的正式记录。目标主机确定后须按 DEPLOY.md 在该主机重跑。
- [x] `scripts/dogfood_http_edges.py --dev-server`（本机 e2e 栈）：登录限流第 9 次 429、超大非法体 422、静态回退、边界后 /health 均通过。
- [x] 50 学生并发（本机开发 API，hash 模式）：50 人同时登录、读会话、各取 5 个年份原始切片、各跑 4 项回归，650 个请求全部 200，无 5xx／503；API 驻留内存 960 MB 稳定。登录中位 1.2 s（PBKDF2 10 万轮×50 并发，CPU 受限，可接受）；回归中位 100 ms（命中缓存）；原始切片中位 11.5 s——根因是开发默认的 `hash` 文件身份模式每次请求都对原始 CSV 做 SHA-256（单次 420 ms），生产 systemd 模板与演示站均用 `notify` 模式（单次 13 ms），见 D-014。
- [x] 冷启动（本机，真实 release）：`preflight` 3.3 s；`serve` 启动到 `/health` 200 共 4.3 s；首次读取一个年份的原始表 1.4–2.1 s，此后同年切片 30 ms（notify）／520 ms（hash）。演示站 2 vCPU 上按经验约为 2–3 倍。

## 5. 第 5 天（10-10）：文档与交付物一致性

- [x] **实验手册**（10-06）：用本机 Chrome 154 按最终界面重拍全部 19 张图（三个一次性测试账号，学习记录经公开 API 准备）；前两轮发现步骤 9 抓到侧栏"材料保存中"瞬态，截图脚本改为每张图前等待侧栏保存完成后重拍。`screenshots.json` 基线更新为 f97c285 并写入新哈希，手册版本 2.3，重排导出 28 页 A4 PDF 无溢出，`tests/test_steps.py` 6 项通过。手册引用的按钮名逐一与源码核对一致。
- [x] **技术手册**：版本 1.3、日期与基线更新；第 8 节已含提交后材料锁定与"学生选定"规则，第 10 节接口表与路由一致；11.2 增补 10-06 实测容量参考，15.2 增补中文字体前置条件。
- [x] **README / DEPLOY.md**：README 补全 local_ci 依赖（Node、中文字体）；DEPLOY.md 增补 `notify`／`hash` 的实测性能差异与本地文件系统要求（D-014）、Nginx 分机部署时的来源 IP 与登录限流说明（D-013）。命令逐条实操留在第 6 天。
- [x] 指标说明 PDF：源 HTML 自 09-22 构建后未改（10-06 只改了 README），无需重建；阅读库内嵌在真实浏览器中的显示仍待你确认（第 3 天遗留）。
- [x] 文档中无内部 IP；README 中的 `gvclab2026` 是演示构建的公开默认口令，非生产凭证；LICENSE 与 OECD 条款声明齐全。

## 6. 第 6 天（10-11）：部署演练与数据生命周期

10-06 在 WSL 新建的干净 Ubuntu 24.04.5 发行版 `gvcsim-deploy`（Docker `ubuntu:24.04` 根文件系统导入，systemd 启用，root 操作）上，只依据 DEPLOY.md 逐块执行。WSL 特有干扰：两个发行版共享网络命名空间，演练库 PostgreSQL 落在 5433 端口，连接串按此调整；WSL 会在无会话时自动关停发行版并重生成 /etc/hosts，用常驻会话和 `generateHosts=false` 处理。这两点与真实主机无关。

- [x] 主机 bootstrap：apt 装 PostgreSQL 16、Nginx 1.24、OpenSSL；uv 0.12 与受管 Python 3.13（apt 无 3.13，记 D-016）；bun 1.4.2。服务账号（nologin 路径错误，记 D-015）、持久目录、角色与库、`git clone` 到 `/opt/gvcsim/current`、`uv sync --frozen`、普通前端构建、环境文件（随机 DSN 口令与 32 字节密钥）、原始 CSV 0640、自签 TLS 代替 ACME、Nginx 模板替换域名后 `nginx -t` 通过、systemd 单元与备份定时器全部按文档完成。**首页 500**：`useradd` 建的 `/opt/gvcsim` 为 0750，www-data 无法读取 dist（D-017，P1，文档已补 `chmod 0751`）。
- [x] 首次发布：`compute` 真实 5 年数据 13.3 分钟（12 核 WSL，峰值 RSS 约 930 MB），发布门禁全部通过，release `857c70d6`；`classroom-init` 建首位教师；`preflight` 通过；`systemctl start` 后 5 s 内 `/health` 就绪；HTTPS 健康、HTTP→HTTPS 301、`/docs` 403、HSTS/CSP/nosniff 响应头齐全；教师经 HTTPS 登录并建号；原始切片首次 0.96 s、随后 26 ms（notify 模式生效，ext4）；回归 0.39 s。注意：单元启用后主机重启会在首个 release 之前拉起 API，preflight 失败 5 次后进入 start-limit，首次发布后 `systemctl start` 前可能需要 `systemctl reset-failed`。
- [x] 数据换版（10-06，开发库 WSL，`gvclab_e2e`）：`scripts/dogfood_release_roundtrip.py` 以真实 release 01b87b87 为 A、合成 release e0f456b5 为 B 做 A→B→A 两轮，均通过：两版数据确实不同、账号保留、两个 release 上的报告评分各自保留（41／42）、换回 A 后原令牌重新有效。证据 `dogfood-output/day6-roundtrip-*/`。
- [x] 发布中断（开发库 WSL，合成 release，`CI=true GVCSIM_CI_SYNTHETIC=1`）：`dogfood_publication_faults.py` 的 artifact、manifest、fsync、promote、before_switch、after_switch、cleanup、cleanup_denied、readonly、diskfull、concurrent 11 个阶段各 1–2 次全部通过：切换前中断保留旧 release、切换后中断保留新 release、锁均释放、旧 release 始终可校验。注意 cleanup_denied 一类用权限模拟的阶段必须在 ext4 上跑，放在 Windows 盘（DrvFs）会假失败。证据 `dogfood-output/day6-publication-faults*/`。
- [x] 备份与恢复（演练库）：`systemctl start gvcsim-backup.service` 产出 dump + sha256（0600，属主 gvcsim），`sha256sum -c` 与 `pg_restore --list` 通过；隔离库 `gvcsim_restore_drill` 恢复 1 s 内完成，`schema_meta` 为 `gvcsim-teaching-db-v12`，账号数与源库一致。文档的演练块以应用角色 `createdb` 会被拒（D-019，已改为 postgres 建库并指定属主）。
- [x] 普通代码部署块、release 回滚块（对当前 release 自身执行：校验、符号链接原子替换、preflight、启动、健康）均按文档原样通过。
- [x] 新学期重置（演练库）：先备份再 `classroom-init --reset`，重置后旧学生 401、新教师 200；备份目录累计 3 组 dump+sha256。
- [x] `GVCSIM_ALLOWED_ORIGINS`：配置来源的预检 200 并带 `access-control-allow-origin`；陌生来源预检 400 且不带该头；简单请求不带 CORS 头。
- [ ] 非 Chrome 浏览器通过 HTTPS 登录：需你在真实浏览器上做（自签证书的演练站或交付站）。

## 7. 第 7 天（10-12）：收尾与打包

- [x] P0/P1 全部关闭：D-001、D-003、D-004、D-005（638ec8c）、D-007（1663120）、D-017（0ad6d45）；已知问题（D-002、D-011、D-013、D-014、D-018）与未验收项整理在 [docs/delivery-v1.0.0.md](delivery-v1.0.0.md)。
- [x] 最终一次 `scripts/local_ci.sh`（10-06，含 ruff／mypy／覆盖率／前端／Gephi）：首轮因 D-020 在 11 s 中止，修复门禁脚本后全部通过：808 后端、478 前端、学生 smoke、完整提交评阅、15 步纯界面课程、教师 smoke；证据 `dogfood-output/local-ci/20261005T212652Z-4799/`。
- [x] 第 5 天之后业务代码未变（只有 `scripts/local_ci.sh` 与文档），截图无需重拍；技术手册代码基线改为标签 `v1.0.0`。
- [x] 标签 `v1.0.0` 打在 `acf691a`（注释标签，未推送）；`git archive v1.0.0` 源码包与从标签树构建的普通生产前端产物已生成。
- [x] 交付包 `dogfood-output/delivery-v1.0.0/`（忽略目录）：`gvcsim-v1.0.0-src.tar.gz`、`gvcsim-v1.0.0-frontend-dist.tar.gz`、`docs/`（两本手册、DEPLOY、README、LICENSE、交付说明、评审记录、deploy 模板）、`data/`（原始 CSV SHA-256、开发机 release 01b87b87 的 dataset 与 QC JSON）、`evidence/`（最终 local_ci、统计复核、第 3／4／6 天脚本结果、演练主机日志与备份校验文件，不含数据库转储）、`SHA256SUMS`。账号与口令不在包内。
- [x] 演练主机按 DEPLOY.md"普通代码部署"块升级到 `v1.0.0`：备份、`uv sync --frozen`、前端构建、preflight、启动后 5 s 健康，首页 200，教师接口 200。
- [x] 已推送 `cc` 分支（c955e79..b2e50b7）与标签 `v1.0.0` 到 origin。
- [x] 演示站 101.201.151.30 于 2026-10-06 05:44（服务器时间）更新到 `v1.0.0`（acf691a，演示构建）：API 重启后 11 s 健康。随后首页与静态资源 500 约 1 分钟：我的发布包以 mktemp 目录为根打包，解包时把 `/opt/gvcsim/app` 自身改成 0700，nginx 无法穿过；`chmod 0755` 后恢复，首页、手册 PDF、讲义 PDF、前端包、演示学生登录、会话与切片均正常。教训与 D-017 同源：发布后必须检查首页而不只是 `/health`。

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
| 10-06 | 1663120 | 第 3 天专项脚本（令牌过期、本人改密、三标签页交错） | 全部通过 | `dogfood-output/day3-recovery/`，`gvclab_e2e` |
| 10-06 | 1663120 | 学生端 15 步手工探索（student38，本地课堂） | 通过；无控制台错误；无新缺陷 | 详见 3.1/3.2 勾选项；未覆盖：真实浏览器矩阵、缩放、打印目视、断网 |
| 10-06 | v1.0.0 | 最终全量门禁 `scripts/local_ci.sh` | 全部通过（808 后端、478 前端、四段浏览器验收） | `dogfood-output/local-ci/20261005T212652Z-4799/`；首轮因 D-020 中止 |
| 10-06 | f0745d6 | 第 6 天干净主机部署演练（WSL `gvcsim-deploy`，Ubuntu 24.04.5） | bootstrap、首次发布、代码部署、回滚、备份恢复、重置、CORS 全部按 DEPLOY.md 跑通；发现文档缺陷 D-015、D-016、D-017（P1）、D-019 | release 857c70d6；演练库保留在 WSL 中供第 7 天复验 |
| 10-06 | f0745d6 | 数据换版往返、发布中断 11 阶段（开发库 WSL） | 全部通过 | `dogfood-output/day6-roundtrip-*/`、`day6-publication-faults*/` |
| 10-06 | f97c285 | 实验手册 2.3 重拍 19 图、重排导出；技术手册 1.3；README／DEPLOY 增补 | `tests/test_steps.py` 6 通过；PDF 28 页 A4 无溢出 | 截图脚本新增侧栏保存等待 |
| 10-06 | 1663120 | 教师端手工走查（学期／班级／学生／批量建号／评阅／冲突／评分清除） | 通过；无新缺陷 | 详见 4.1 勾选项 |
| 10-06 | 1663120 | 容量：冲击面板基准、HTTP 边界、50 人并发、冷启动 | 基准四项全部在预算内；650 请求无错误；RSS 960 MB 稳定 | `dogfood-output/day4-capacity/`；发现 hash 模式切片慢，记 D-014（部署核对项） |
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
| D-014 | 10-06 | P2（部署核对） | `GVCSIM_FILE_CACHE_MODE` | 原始切片在默认 `hash` 模式下每请求重算原始 CSV 的 SHA-256（420 ms/次，50 人并发时中位 11.5 s），`notify` 模式 13 ms/次。模板与演示站已设 notify，但 notify 只在本地 ext4/XFS/Btrfs/tmpfs 生效，NFS、9p 等会静默回退到 hash | 交付主机核对：数据目录在本地文件系统且环境文件含 `GVCSIM_FILE_CACHE_MODE=notify`；写进 DEPLOY.md 的检查项（第 6 天） | 第 4 天容量测试 |
| D-017 | 10-06 | **P1（文档／部署）** | `DEPLOY.md` bootstrap | 在干净 Ubuntu 24.04 上照抄文档部署后首页 500：`useradd --create-home` 把 `/opt/gvcsim` 建成 0750，Nginx 的 www-data 无法穿过该目录读取 `frontend/dist`（error.log：`stat() ... Permission denied` 并进入 try_files 重定向循环）；`/health`、`/api` 不受影响，容易漏测 | 文档增加 `chmod 0751 /opt/gvcsim`（0ad6d45）；演练库已修复并验证首页、资源、讲义 PDF 均 200 | 第 6 天干净主机演练 |
| D-018 | 10-06 | P3（噪音） | `deploy/gvcsim-api.service`、DEPLOY.md 的 `runuser --preserve-environment` 块 | 服务以 `ProtectSystem=strict` 运行且 HOME=/opt/gvcsim 只读，matplotlib 每次启动报 "created a temporary cache directory"；运维命令块保留 root 的 HOME，libpq 还会提示 `/root/.postgresql/postgresql.crt: Permission denied` | 交付后处理：单元加 `Environment=MPLCONFIGDIR=/tmp/gvcsim-mpl`，命令块用 `env HOME=/opt/gvcsim` | 第 6 天 |
| D-019 | 10-06 | P2（文档） | `DEPLOY.md` 备份与恢复演练 | 演练块以 `PGUSER=gvcsim` 执行 `createdb gvcsim_restore_drill`，但按文档创建的应用角色没有 CREATEDB 权限，照抄即 `permission denied to create database` | 文档改为由 `postgres` 超级用户 `createdb --owner=gvcsim`（0ad6d45） | 第 6 天 |
| D-015 | 10-06 | P2（文档） | `DEPLOY.md` bootstrap | `useradd --shell /usr/bin/nologin`：Ubuntu 24.04 的 nologin 在 `/usr/sbin/nologin`，照抄会得到 shell 不存在的告警 | 已改为 `/usr/sbin/nologin`（0ad6d45） | 第 6 天干净主机演练 |
| D-016 | 10-06 | P2（文档） | `DEPLOY.md` bootstrap | 只写"安装 Python 3.13"，但 Ubuntu 24.04 apt 没有 3.13；演示站与演练都用 uv 受管解释器 | 已补充 uv 安装方式与 `UV_PYTHON_INSTALL_DIR` 约定（0ad6d45） | 第 6 天 |
| D-020 | 10-06 | P2（门禁健壮性） | `scripts/local_ci.sh` | 第 7 天最终门禁 11 s 即失败：`agent-browser doctor` 因 Chrome-for-Testing CDN（googlechromelabs.github.io）不可达而返回非零，门禁随之中止，尽管本机 Chrome 可正常启动；受限网络下门禁不可用 | 只以 doctor 的"Headless launch"结果为准，CDN／云服务探测不再阻断（v1.0.0 提交） | 第 7 天 |
| D-012 | 10-06 | P2（覆盖） | `scripts/dogfood_token_expiry.py`、`dogfood_self_password_recovery.py`、`dogfood_workspace_interleavings.py` | 自动恢复草稿改版后，这三条真实过期／改密／换号脚本不在 local_ci 内，合并恢复路径只有 mock API 单测 | 10-06 在 WSL 对 `gvclab_e2e` 全部跑通：令牌 10 s 自然过期 2 次恢复、本人改密 2 次恢复、三标签页冲突＋撤销请求＋换号 2 轮通过；证据 `dogfood-output/day3-recovery/` | 已关闭 |
