# GVC Simulation Lab

基于 OECD ICIO 的 16 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 保存账号、实验会话和当前报告。

## 本地运行

```bash
uv sync
cd frontend && npm install && npm run build && cd ..
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
npm run dev
```

## 简化后的系统边界

本系统面向 20–50 人的可信课堂局域网，不是考试或高风险评测平台。

- 步骤 1–15 的完成条件是保存的答案经服务端重新判分全部正确；不签发答题凭证。
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

## 验证

```bash
uv run ruff check .
uv run mypy gvcsim
uv run pytest
cd frontend && bun test src && npm run build
```

部署说明见 [DEPLOY_101.201.151.30.md](DEPLOY_101.201.151.30.md)，完成度契约见 [docs/COURSE_COMPLETION.md](docs/COURSE_COMPLETION.md)。
