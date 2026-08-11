# GVC Simulation Lab

基于 OECD ICIO 的 16 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 保存账号、实验会话和当前报告。

## 客户端支持范围

本项目仅面向桌面端宽屏课堂教学环境，建议使用可视区域宽度至少为 1200 px 的桌面浏览器。
项目不支持也不计划适配手机、平板或其他窄屏设备，不保证这些设备上的布局与交互可用；
移动端或窄屏显示问题不属于项目缺陷或维护范围。

## 本地运行

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

`compute` 是维护窗口操作：先停止 API，再运行计算。它会在 `data/.processed-releases/` 的同文件系统新目录中完成全部计算、写入 `dataset.json` 并校验，然后通过相对符号链接原子切换固定入口 `data/processed`。切换成功后自动清空实验进度、会话、报告和提交，账号、班级和公告保留；上一份发布目录会保留，不会在本次计算中删除。登录令牌绑定签发时的数据发布身份，因此服务恢复后旧页面会退出登录，不能把清空前的会话或进度重新写回。

文件指针切换与 PostgreSQL 清理之间由 `data/.processed-publication.json` 恢复日志协调。清理普通失败时入口会回滚到旧发布，但服务仍会因恢复日志而拒绝就绪。排除数据库故障后，在维护窗口执行：

```bash
uv run gvcsim compute --recover-pending
```

恢复命令会校验待发布目录、重新原子切换入口、幂等清理学习记录并删除恢复日志。不要通过手工删除日志绕过恢复。

开发前端可另开终端运行：

```bash
cd frontend
bun run dev
```

## 简化后的系统边界

本系统面向 20–50 人的可信课堂局域网，不是考试或高风险评测平台。

- 步骤 1–15 的完成条件是保存的答案经服务端重新判分全部正确；不签发答题凭证。
- 第 16 步报告还要求一条 ICIO 单元格观察、一次至少包含两个对象或两条观测的指标比较、一份有效回归，以及学生填写的研究问题、证据解释和局限反思。
- 回归响应直接保存到实验会话；报告读取保存的设计与结果，不再次估计。
- 每个学生只有一份当前会话、当前报告和当前提交；重新提交覆盖旧提交并清空评分。
- 会话由服务器保存整份 JSON，最后一次写入生效。没有离线缓存、revision 合并或多标签页冲突解决。
- 登录使用 8 小时 HMAC 签名令牌，不建服务端登录会话、不做登录限流或安全审计。退出仅删除浏览器令牌。
- 保留密码哈希、令牌签名、角色检查、参数化 SQL 和输入长度限制。

这些取舍意味着：知道正确答案的客户端可以直接提交答案；已签发令牌在到期前不能即时撤销；同时打开多个标签页可能互相覆盖。它们是可信课堂部署的已接受限制。

## 数据与产物

原始表位于 `OECD_ICIO/`。固定产物目录 `data/processed/` 包含：

- `indicators_country_<year>.csv`
- `indicators_industry_<year>.csv`
- `network_edges_<year>.csv`
- `export_exposure_<year>.csv`
- `panel_country.csv` 与 `panel_industry.csv`
- 质检 JSON、控制变量和教学冲击面板
- 成功标记 `dataset.json`

新生成的 `dataset.json` 使用产物契约 v2：内嵌每个顶层 CSV/JSON 的 SHA-256、字节数、类型，以及 CSV 列/行数或 JSON 顶层形状/条目数。构建发布、恢复和 preflight 都会完整复核清单；频繁的 `/health` 仅在解析后的发布目录及其全部顶层文件状态均未变化时复用成功校验，指针切换或文件变化都会触发重新校验。升级期间仍允许读取没有 `artifact_contract_version` 和 `artifacts` 的旧 `dataset.json`，但它只执行原有的存在性检查；带清单却缺版本、版本未知或 v2 清单不完整时一律拒绝，不会静默降级。固定入口背后使用不可变发布目录，并保留上一份发布以支持失败回滚；部署服务还把版本目录挂载为只读。当前阶段不提供长期历史清理或内容寻址归档。

## 数据库 v8

v8 不迁移旧课堂记录，升级时显式重建：

```bash
uv run gvcsim classroom-init --reset
```

仅有八张表：`schema_meta`、`classes`、`accounts`、`step_progress`、`experiment_sessions`、`reports`、`submissions`、`announcements`。

## 2026 秋学期重置

本学期使用题库 `course-quiz-v4` 和会话 `experiment-session-simple-v2`。发布时必须重新运行 `uv run gvcsim compute`；计算成功后会清空旧实验会话、步骤进度、报告与提交，但保留账号、班级和公告。不要把旧学期的学习记录恢复到本学期。

## 数据、许可与教学边界

项目原创代码、文档和界面适用根目录 [LICENSE](LICENSE) 的“All rights reserved”声明，当前没有授予开源许可。第三方软件和数据仍适用各自的许可与权利边界，仓库中的声明不会将它们重新许可。

正式指标基于 OECD ICIO 2023 release 的 2016–2020 表。使用、引用或再分发前应检查 [OECD ICIO 数据集页面](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html)、[OECD Terms & Conditions](https://www.oecd.org/en/about/terms-conditions.html) 和 [2023 方法文档](https://doi.org/10.1787/5a5d0665-en)。原始数据、下载日志和 `data/processed/` 不进入 Git；完整面板或可逆明细向仓库外分发前，应再次核对下载时适用的条款并保留来源、版本和访问日期。

政策冲击、HS→ICIO crosswalk、宏观控制、GDP 平减指数以及 CI 合成表包含教学 mock。由它们得到的回归和报告结论不能冒充官方统计或研究结论。任何导出物都不得包含数据库凭证、认证密钥或学生记录。

## 备份与恢复

PostgreSQL 保存账号、班级、公告及当前学习状态。部署提供 `gvcsim-backup.timer`，每天调用 `scripts/backup_classroom.sh`，内部使用 `pg_dump --format=custom` 生成 dump 和 SHA-256 完成标记；发布、`compute` 或 schema 破坏性操作前还必须同步完成一次备份。建议保留至少 30 份每日备份、保存加密异地副本，并每月用 `scripts/restore_classroom_drill.py` 恢复到隔离空库验证。详细安装和操作步骤见 [DEPLOY.md](DEPLOY.md)。

恢复使用 `pg_restore --single-transaction`，并通过 `uv run gvcsim preflight` 确认 schema 为 `gvcsim-teaching-db-v8`。`data/processed/` 是指向当前不可变发布的固定入口，可通过 `uv run gvcsim compute` 从原始数据重建；成功标记为 `data/processed/dataset.json`。发布恢复日志存在时必须先运行 `uv run gvcsim compute --recover-pending`，preflight 不会自动猜测跨存储状态。

## Gephi 外部基准

网络指标的 golden fixture 由 Gephi Toolkit 0.10.1 独立生成。安装 JDK 11+ 与 Maven 后运行 `scripts/gephi_golden/generate.sh --check`，可校验 `tests/fixtures/gephi_0_10_1_directed_reference.csv`，且不会修改工作区。该基准采用有向图；路径类中心性按无权最短路计算，边权只进入 weighted degree。

## 验证

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy gvcsim
uv run pytest
cd frontend && bun test src && bun run build
```
