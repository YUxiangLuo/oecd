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

`compute` 会直接重建 `data/processed/`，在成功计算并清空旧学习记录后最后写入 `dataset.json`。账号、班级和公告会保留；实验进度、会话、报告和提交会清空。

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

服务启动只检查成功标记、年份文件和必要跨年文件是否存在，不计算文件哈希，也不保留内容寻址历史。

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

PostgreSQL 保存账号、班级、公告及当前学习状态。使用 `pg_dump --format=custom` 备份；恢复到空数据库时使用 `pg_restore --single-transaction`，并通过 `uv run gvcsim preflight` 确认 schema 为 `gvcsim-teaching-db-v8`。`data/processed/` 不需要做版本备份，可通过 `uv run gvcsim compute` 从原始数据重建；成功标记为 `data/processed/dataset.json`。

## Gephi 外部基准

网络指标的 golden fixture 由 Gephi Toolkit 0.10.1 独立生成。安装 JDK 11+ 与 Maven 后运行 `scripts/gephi_golden/generate.sh --check`，可校验 `tests/fixtures/gephi_0_10_1_directed_reference.csv`，且不会修改工作区。该基准采用有向图；路径类中心性按无权最短路计算，边权只进入 weighted degree。

## 验证

```bash
uv run ruff check .
uv run mypy gvcsim
uv run pytest
cd frontend && bun test src && bun run build
```
