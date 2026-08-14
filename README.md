# GVC Simulation Lab

基于 OECD ICIO 的 16 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 按数据 release 保存账号、实验会话和报告。

## 支持范围

本项目只面向可信课堂，不是考试或高风险评测平台。客户端**只支持桌面端**：唯一维护和验收的界面基线是可视区域宽度至少 1200 px 的桌面浏览器。

项目采用固定的桌面布局，不实现也不接受手机、平板、窄屏窗口或其他非桌面尺寸的响应式断点、布局降级与交互适配；这些尺寸上的显示或操作问题不属于缺陷和维护范围。新增界面只需验证桌面基线，不得为非桌面尺寸增加专用 CSS、JavaScript 分支或测试矩阵。

系统刻意只保留以下闭环：

- 学生自由访问 16 个教学步骤，自动保存实验会话，生成并提交报告，查看教师评分。
- 教师创建学生账号、修改姓名/学号/密码，查看服务端判定的完成状态，批改报告。
- 步骤 1–15 由服务端重新判定固定理解题；步骤 16 还要求关键实验证据、有效回归和学生原创分析。
- 每名学生在当前数据 release 中只有一份会话和一份报告。报告状态为草稿、待评阅或已评阅；已提交报告重新生成后自动重新提交并清空旧评分。

不提供班级、公告、账号停用、学生自行清空、到达进度、跨标签页冲突解决、离线缓存、防作弊凭证或安全审计。登录使用最长 8 小时的 HMAC 签名令牌，并绑定当前数据 release 与账号认证版本；数据换版、本人改密或教师重置密码会立即使旧令牌失效。同时打开多个标签页可能互相覆盖，这是可信课堂的已接受限制。

## 本地运行

需要 Python 3.13、uv、Bun 和 PostgreSQL。

```bash
uv sync
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
export GVCSIM_PG_DSN='postgresql://alice:111111@127.0.0.1:5432/gvclab'
export GVCSIM_DEMO_MODE=1
export GVCSIM_BOOTSTRAP_PASSWORD='your-local-password'
uv run gvcsim classroom-init --reset
uv run gvcsim compute
uv run gvcsim serve --port 8000
```

开发前端可另开终端运行 `cd frontend && bun run dev`。

## 会话与数据库

当前教学库是 `gvcsim-teaching-db-v10`，不迁移旧版本。首次部署 v10 或新学期开始必须显式执行：

```bash
uv run gvcsim classroom-init --reset
```

这会清空全部旧账号、会话、报告和评分，并重建四张表：`schema_meta`、`accounts`、`experiment_sessions`、`reports`。会话与报告以 `(账号, release_id)` 隔离，口令轮换通过 `auth_version` 撤销既有令牌。当前学期使用题库 `course-quiz-v6` 和会话 `experiment-session-simple-v2`。

学生编辑在 800 ms 后自动保存；同一时刻最多一个请求，在途编辑合并成最新快照。失败后保留最新快照并显示“重试保存”。理解题完成、报告生成/提交和退出前会主动冲刷保存队列；浏览器突然关闭仍可能丢失最后 800 ms 的编辑。

## 数据发布

原始表位于 `OECD_ICIO/`，固定产物入口是 `data/processed`。`compute` 只在 API 已停止的维护窗口运行：它在 `data/.processed-releases/` 的暂存目录完成计算与 QC，为每个普通文件生成 SHA-256、字节数和 CSV/JSON 结构清单，完整校验并 `fsync` 后才通过相对符号链接原子切换。成功后保留当前与上一发布供故障回滚；更旧发布清理失败只输出警告。构建或校验失败不会改变旧入口。

生产环境通过 `GVCSIM_RAW_DATA_DIR` 和 `GVCSIM_DATA_DIR` 把这两个位置指向代码目录之外的持久目录；本地开发不设置时仍使用上述仓库内默认值。

`compute` 只处理数据，绝不连接或重置教学数据库。生产部署随后显式执行 `classroom-init --reset`，清空并重建教学数据库；因此账号、会话、报告、评分和旧令牌都不会跨部署保留。

`dataset.json` 保存不可省略的 `release_id`、契约版本、年份、生成时间、课程发布、数据来源、QC 摘要、网络算法和完整产物清单。固定产物包括逐年指标/网络/QC、国家与国家–行业面板、控制变量、冲击面板及 QC 文件；旧格式会直接被预检拒绝。

## 数据、许可与教学边界

项目原创代码、文档和界面适用根目录 [LICENSE](LICENSE) 的“All rights reserved”声明。正式指标基于 OECD ICIO 2023 release 的 2016–2020 表；政策冲击、HS→ICIO crosswalk、宏观控制、GDP 平减指数和 CI 合成表含教学 mock，结果不能冒充官方统计或研究结论。

使用、引用或再分发前请检查 [OECD ICIO 数据集页面](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html)、[OECD Terms & Conditions](https://www.oecd.org/en/about/terms-conditions.html) 和 [2023 方法文档](https://doi.org/10.1787/5a5d0665-en)。任何导出物不得包含数据库凭证、认证密钥或学生记录。

## 运维与验证

精简远程部署流程见 [DEPLOY.md](DEPLOY.md)。生产部署使用停机维护窗口：停止 API 后，以 `gvcsim` 服务账号依次计算数据、清空并重建教学数据库、执行预检，再启动 API。`scripts/backup_classroom.sh` 使用 `pg_dump --format=custom` 生成带 SHA-256 完成标记的原子备份，`deploy/gvcsim-backup.timer` 每日触发；恢复前必须先校验摘要、`pg_restore --list`，并在隔离空库演练。

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy gvcsim
uv run pytest
cd frontend && bun test src && bun run build
```

Gephi 0.10.1 独立基准可用 `scripts/gephi_golden/generate.sh --check` 校验；该基准采用有向图，路径类中心性按无权最短路计算，边权只进入 weighted degree。
