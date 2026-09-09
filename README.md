# GVC Simulation Lab

基于 OECD ICIO 的 15 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 按数据 release 保存账号、实验会话和报告。

完整的架构、功能、计算方法、接口和运维说明见 [技术手册](技术手册.md)，生产部署操作见 [DEPLOY.md](DEPLOY.md)。

学生上课操作可使用 [实验手册 PDF](实验手册.pdf)：按 15 步流程编排，包含实际操作截图、记录表和解释提示。[可编辑正文](实验手册.md)与[生成说明](docs/student-manual/README.md)一并保留。

## 支持范围

本项目只面向可信课堂，不是考试或高风险评测平台。客户端**只支持桌面端**：唯一维护和验收的界面基线是可视区域宽度至少 1200 px 的桌面浏览器。

项目采用固定的桌面布局，不实现也不接受手机、平板、窄屏窗口或其他非桌面尺寸的响应式断点、布局降级与交互适配；这些尺寸上的显示或操作问题不属于缺陷和维护范围。新增界面只需验证桌面基线，不得为非桌面尺寸增加专用 CSS、JavaScript 分支或测试矩阵。

系统刻意只保留以下闭环：

- 学生自由访问 15 个教学步骤，自动保存实验会话，生成并提交报告，查看教师评分。
- 教师创建学生账号、修改姓名/学号/密码，查看服务端判定的完成状态，批改报告。
- 步骤 1–14 由服务端重新判定固定理解题；步骤 15 还要求关键实验证据、估计或完整的不可推断诊断，以及学生原创分析。
- 每名学生在当前数据 release 中只有一份会话和一份报告。报告状态为草稿、待评阅或已评阅；已提交报告重新生成后自动重新提交并清空旧评分。

不提供班级、公告、账号停用、学生自行清空、到达进度、跨标签页自动合并、离线缓存、防作弊凭证或安全审计。登录使用最长 8 小时的 HMAC 签名令牌，并绑定当前数据 release 与账号认证版本；数据换版、本人改密或教师重置密码会立即使旧令牌失效。同时打开多个标签页时，陈旧标签页的写入会被 409 拒绝，用户必须显式载入服务器版本，不会静默覆盖。

密码验证与高成本回归均有单 worker 内的滑动窗口限制：默认每来源–用户名每分钟 10 次登录、每来源总计 120 次登录，每账号每分钟 12 次主回归和 4 次置换检验；超限返回 429 与 `Retry-After`。部署可通过 `GVCSIM_*_PER_MINUTE` 环境变量收紧，所有值必须为正整数。

50 人课堂默认使用 512 个连接名额、4 个计算名额及独立的 2 个原始表读取线程；CPU 与原始表任务分别最多接纳 64 项，排队超过 15 秒返回可重试的 503。同参数回归共享计算，最后一位等待者离开后回收无用任务。配置、内存代价与真实 HTTP 验证见[课堂并发修复验收](docs/classroom-concurrency-fixes-20260908.md)。

回归面板读取和报告同步工作同样受有界任务跟踪保护：取消等待不会提前释放仍在工作的普通线程名额，停机时先等待这些工作结束再关闭数据库池。报告只在准备阶段监听断连，落库阶段保留既有事务语义；二次确认与修复见[普通 I/O 取消边界](docs/classroom-io-cancellation-fixes-20260908.md)。

## 本地运行

需要 Python 3.13、uv、Bun 和 PostgreSQL。本文档不绑定任何固定 IP 或主机名：数据库、API 与前端代理的位置一律用连接串或环境变量给出，按你的实际环境填写。

```bash
uv sync
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
# 指向课程 PostgreSQL 实例：主机、端口、账号、口令按实际环境填写；
# 该角色需要建库权限，classroom-init 会在目标库不存在时自动创建
export GVCSIM_PG_DSN='postgresql://<用户名>:<口令>@<数据库主机>:5432/gvclab'
export GVCSIM_DEMO_MODE=1
export GVCSIM_BOOTSTRAP_PASSWORD='your-local-password'
uv run gvcsim classroom-init --reset
uv run gvcsim compute
uv run gvcsim serve --port 8000
```

`serve` 默认只监听本机回环地址。要让课堂上的其他机器访问，显式给出监听地址——`uv run gvcsim serve --host 0.0.0.0 --port 8000` 监听本机全部网卡（通配地址，不绑定任何固定 IP），或设置 `GVCSIM_BIND_HOST` 为指定的对外接口地址后照常启动。

开发前端可另开终端运行 `cd frontend && bun run dev`。Vite 默认把 `/api` 代理到本机回环地址的 8000 端口；API 位于其他任何主机或端口时，按实际位置设置 `GVCSIM_API_PROXY`（形式为 `http://<api主机>:<端口>`），dev 与 preview 共用这一配置。

课堂演示可用 `bun run build:demo` 替代 `bun run build`：演示构建内置 50 组学生凭证，兼容账号 `student` 使用基础口令（默认 `gvclab2026`），`student02`–`student50` 的口令依次在基础口令后追加 `-02`–`-50`；同一标签页刷新时会优先选择本轮未出现过的学生，轮完 50 组后才开启下一轮，且不会与上一轮最后一组立即重复。教师快捷账号仍为 `teacher` + 基础口令。基础口令可用 `VITE_DEMO_PASSWORD` 覆盖，并须与服务端 `GVCSIM_BOOTSTRAP_PASSWORD` 保持一致；服务端运行一次 `classroom-init` 会在不清空现有会话和报告的前提下幂等补齐或同步这些演示账号。普通生产构建不含这些凭证，相关代码与口令常量会在构建期被完全摇掉。

## 会话与数据库

当前教学库是 `gvcsim-teaching-db-v11`，不迁移旧版本。首次部署 v11 或新学期开始必须显式执行：

```bash
uv run gvcsim classroom-init --reset
```

这会清空全部旧账号、会话、报告和评分，并重建四张表：`schema_meta`、`accounts`、`experiment_sessions`、`reports`。会话与报告以 `(账号, release_id)` 隔离，口令轮换通过 `auth_version` 撤销既有令牌。当前学期使用题库 `course-quiz-v7` 和会话 `experiment-session-simple-v3`。

学生编辑在 800 ms 后自动保存；同一标签页同一时刻最多一个请求，在途编辑合并成最新快照。每次 PUT 携带该标签页最后确认的 `updated_at` 版本：另一标签页已先保存时，服务端返回 409 而不覆盖，并要求学生载入服务器版本后重新操作。普通网络失败则保留最新快照并显示“重试保存”。理解题完成、报告生成/提交和退出前会主动冲刷保存队列；浏览器突然关闭仍可能丢失最后 800 ms 的编辑。

登录校验服务暂时不可用时，页面保留登录信息并提供“重试连接”；令牌明确无效时仍退出。认证失效或退出时暂存的未保存内容，只允许同一账号、同一数据 release 重新登录后显式恢复。无法确认所属 release 的旧版暂存不提供恢复，以免把旧数据版本的学习记录写入新版本。自行改密成功退出前也会暂存尚未同步的内容。载入服务器版本期间若又有本地编辑，系统会保留新编辑并要求再次明确载入。

## 数据发布

原始表位于 `OECD_ICIO/`，固定产物入口是 `data/processed`。`compute` 只在 API 已停止的维护窗口运行：它在 `data/.processed-releases/` 的暂存目录完成计算与诊断，为每个普通文件生成 SHA-256、字节数和 CSV/JSON 结构清单，完整校验并 `fsync` 后才通过相对符号链接原子切换。v14 产物同时要求完整性与数学有效性：文件哈希、结构、键覆盖、有限性和来源绑定失败，以及逆矩阵稳定性、计算恒等式或聚合一致性失败，都阻断发布。源账户误差同时超过 1 Million USD 和 1% 时也阻断发布；容差内舍入、负 VA/TLS、份额超出常见范围与回归设计限制仍作为经济诊断披露，不通过裁剪负值掩盖；接近稳定性边界但未越过失败阈值的警告也保留。所有检查写入 QC 产物、`dataset.json` 和实验报告。成功后保留当前与上一发布供故障回滚；更旧发布清理失败只输出警告。构建或发布校验失败不会改变旧入口。

**v14 升级要求：** 出口改为直接加总外国中间品与最终需求，避免“总和减国内和”的浮点尾差把结构性零出口变成有效的 0% 份额。真实小额贸易与负最终需求不设阈值裁剪。旧 v13 回归基表可能已持久化错误零值，因此新代码拒绝旧契约；必须在独立数据目录完整重算并验收新的 release 后再安排部署，不能只改前端、改旧 CSV 或改元数据版本号。保留旧代码/数据供回滚，旧会话与报告仍绑定原 release；不重置教学库。

宏观教学模拟生成器 v2 明确保留 ICIO 的经济规模：`(max(SVA,0)+1) × 10^6 × 国家系数 × 时间系数`，其中 SVA 和加一项的单位是百万美元，两个系数无量纲；人口由该模拟美元金额除以模拟人均美元收入得到。这是明确校准的教学数据，仍不是 WDI/IMF 观测 GDP 或人口，且禁止进入公开主回归。

生产环境通过 `GVCSIM_RAW_DATA_DIR` 和 `GVCSIM_DATA_DIR` 把这两个位置指向代码目录之外的持久目录；本地开发不设置时仍使用上述仓库内默认值。

文件缓存默认使用 `GVCSIM_FILE_CACHE_MODE=hash`：每次按内容 SHA-256 判定身份，缓存解析读取与摘要一致的字节快照，不把 `ctime_ns` 当作唯一版本。systemd 只读本地部署模板显式启用 `notify`，以同步文件变更通知避免热请求反复扫描大表；监听不可用或文件系统不受支持时回退哈希。`notify` 仅适用于运行期不可变的数据，不能监控 mmap／原始块设备写入；不满足此前提时保留 `hash`。两种模式的成本、限制和测试见[文件缓存修复](docs/file-cache-identity-fixes-20260908.md)。

`compute` 只处理数据，绝不连接或重置教学数据库。代码部署、数据发布与教学数据库重建是三个独立生命周期：普通代码部署和数据换版不得执行 `classroom-init --reset`；只有首次建库或明确的新学期清场才允许在备份后执行该破坏性命令。账号可跨代码/数据部署保留，会话与报告则由 `(账号, release_id)` 自动隔离，数据换版也会使旧令牌失效。

`dataset.json` 保存不可省略的 `release_id`、契约版本、年份、生成时间、课程发布、数据来源、QC 摘要、网络算法和完整产物清单；还逐年绑定原始 ICIO 文件名、字节数与内容 SHA-256。`preflight`、`/health` 和 `/api/db/*` 都会拒绝与 active release 不一致的原始字节。固定产物包括逐年指标/网络/QC、国家与国家–行业面板、控制变量、冲击面板及 QC 文件；旧格式会直接被预检拒绝。

## 数据、许可与教学边界

项目原创代码、文档和界面适用根目录 [LICENSE](LICENSE) 的“All rights reserved”声明。正式指标基于 OECD ICIO 2023 release 的 2016–2020 表；政策冲击、HS→ICIO crosswalk、宏观控制、GDP 平减指数和 CI 合成表含教学 mock，结果不能冒充官方统计或研究结论。

使用、引用或再分发前请检查 [OECD ICIO 数据集页面](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html)、[OECD Terms & Conditions](https://www.oecd.org/en/about/terms-conditions.html) 和 [2023 方法文档](https://doi.org/10.1787/5a5d0665-en)。任何导出物不得包含数据库凭证、认证密钥或学生记录。

## 运维与验证

代码部署、数据发布和新学期清场必须分开执行：普通代码/数据部署不得清空教学库，只有已备份且明确的新学期清场才允许 `classroom-init --reset`。`scripts/backup_classroom.sh` 使用 `pg_dump --format=custom` 生成带 SHA-256 完成标记的原子备份，`deploy/gvcsim-backup.timer` 每日触发并默认保留 90 组已完成备份；恢复前必须先校验摘要、`pg_restore --list`，并在隔离空库演练。远程部署与三生命周期操作手册见 [DEPLOY.md](DEPLOY.md)。

**测试隔离：** `tests/conftest.py::teaching_db` 会删除目标数据库的 `public` schema。运行 pytest 前必须将 `GVCSIM_PG_DSN` 指向专门的一次性测试库；不得使用课堂库或保留测试证据的开发库。数据库进程故障测试还需独立 PGDATA/端口，发布损坏测试需另一份数据副本，不能停止共享 PostgreSQL 或破坏当前 release。

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy gvcsim
uv run pytest
cd frontend && bun run test:unit && bun run build
```

本机浏览器测试使用 `agent-browser`。多标签开发模式若出现空白页或 `ERR_INSUFFICIENT_RESOURCES`，先检查浏览器临时目录所在文件系统的剩余空间；必要时为整轮测试设置位于有足够空间的磁盘上的私有 `TMPDIR`，启动、截图和关闭命令保持同一环境。不要靠延长等待或清理其他项目的临时文件掩盖资源不足。

阶段性测试计划、逐批报告和环境排查日志不作为长期文档维护；历史记录可从 Git 查询，本地产物继续放在忽略的 `dogfood-output/`。API 预填的辅助流程、纯浏览器主旅程、单元回归和容量测试分别记录，不能互相替代或据此宣称所有范围已验收。

Gephi 0.10.1 独立基准可用 `scripts/gephi_golden/generate.sh --check` 校验；该基准采用有向图，路径类中心性按无权最短路计算，边权只进入 weighted degree。

CI 的桌面浏览器验收分两层：`agent_browser_smoke.sh` 快速挂载学生 1–15 步与教师关键交互；`agent_browser_full_journey.sh` 通过公开 API 构造一份当前 release 的完整学习记录，再由真实浏览器完成报告生成、提交和教师评分，防止各自通过的组件在完整状态机中断链。两个脚本都以 `GVCSIM_BASE_URL` 指定被测站点地址，不写死任何主机。完整旅程在设置 `GVCSIM_E2E_ARTIFACT_DIR` 时还会通过浏览器打印 PDF，并用独立的 `pdftotext` 检查四类指标对照表七列均未被截断；本地需安装 Poppler（Debian/Ubuntu：`poppler-utils`），CI 已包含此依赖。

冲击面板性能验收在有效 active v14 release 完成最终重算后运行：

```bash
# 对照只读本地生产部署；运行期间不得改写原始输入或 release。
GVCSIM_FILE_CACHE_MODE=notify \
GVCSIM_BENCHMARK_USERNAME=student GVCSIM_BENCHMARK_PASSWORD='…' \
  uv run python scripts/benchmark_shock_panel_v9.py
```

脚本在进程内完成 release 校验并经由正常登录中间件访问 `/api/shocks/panel`，记录 release/shock contract、单请求冷索引、8 请求并发冷启动、warm sequential 与 8-concurrent p95，并对照 500ms/1.5s 预算；不经过网络，因此无需也不接受目标主机配置。正式数据发布必须通过该门槛；v14 正式部署前需生成新的当前契约验收记录；`benchmarks/shock_panel_v13.json` 和更早的 `benchmarks/shock_panel_v12.json`、`benchmarks/shock_panel_v11.json`、`benchmarks/shock_panel_v10.json`、`benchmarks/shock_panel_v9.json` 与 `benchmarks/shock_panel_preliminary_v3.json` 仅保留作历史记录。每次正式数据换版仍必须重新运行当前版本的验收，不能沿用旧 release 的结果。
