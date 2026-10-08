# GVC Simulation Lab

基于 OECD ICIO 的 15 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 按数据 release 保存账号、实验会话和报告。

- 步骤 1–9 使用 OECD ICIO 2023 版 2016–2020 年数据及派生指标。
- 步骤 10–14 使用教学关税面板 `step10-tariff-teaching-v6`：关税暴露 `X = 固定冲击前销往美国的出口份额 × 税率`，四个家族各有一个默认 Y 和若干同家族可选 Y（与步骤 6–9 的指标一一对应），固定为国家×行业级连续强度 TWFE。X 与 Y 由课程生成，不是 OECD 指标，学生界面和报告各有一句简短说明；同家族 Y 之间的核算恒等式逐行成立，加征关税的市场（美国）不在回归样本中。
- 步骤 15 生成、提交实验报告，教师评阅。

| 文档 | 内容 |
| --- | --- |
| [技术手册](技术手册.md) | 架构、计算方法、数据契约、接口、数据库、运行保护、测试与运维 |
| [DEPLOY.md](DEPLOY.md) | 生产主机上的部署、数据发布、回滚、新学期重置与备份恢复命令 |
| [实验手册 PDF](实验手册.pdf) | 学生操作指南；正文与重新生成方法见 [docs/student-manual](docs/student-manual/README.md) |
| [docs/indicator-readings](docs/indicator-readings/README.md) | 步骤 2–5 指标说明 PDF 的源文件与构建方法 |

## 支持范围

只面向可信课堂，不是考试或高风险评测平台；不提供公告、账号停用、防作弊或安全审计。客户端**只支持桌面浏览器**，建议可视区域宽度 1200 px 以上；1000–1200 px 时布局收紧并保证关键按钮可见，窄于 1000 px 时提示放宽窗口。不为手机、平板增加响应式断点或测试矩阵，这些尺寸上的问题不属于缺陷。

## 本地运行

需要 Python 3.13、uv、Bun 和 PostgreSQL。连接串、主机和端口按实际环境填写。

```bash
uv sync
cd frontend && bun install --frozen-lockfile && bun run build && cd ..
# 该角色需要建库权限；目标库不存在时 classroom-init 会创建它，空库无需 --reset
export GVCSIM_PG_DSN='postgresql://<用户名>:<口令>@<数据库主机>:5432/gvclab'
export GVCSIM_DEMO_MODE=1
export GVCSIM_BOOTSTRAP_PASSWORD='your-local-password'
uv run gvcsim classroom-init
uv run gvcsim compute
GVCSIM_FILE_CACHE_MODE=notify uv run gvcsim serve --port 8000   # 多人使用时用 notify，见技术手册 11.2
```

- 原始表放在 `OECD_ICIO/`，产物入口为 `data/processed`；生产环境用 `GVCSIM_RAW_DATA_DIR`、`GVCSIM_DATA_DIR` 指向代码目录外的持久目录。
- `serve` 默认只监听本机回环地址；课堂局域网访问用 `--host 0.0.0.0` 或设置 `GVCSIM_BIND_HOST`。
- 前端开发：`cd frontend && bun run dev`。Vite 把 `/api` 代理到本机 8000 端口，其他位置用 `GVCSIM_API_PROXY=http://<api主机>:<端口>`。
- 演示构建 `bun run build:demo` 内置 50 组学生快捷登录（`student`，`student02`–`student50` 的口令为基础口令加 `-02`–`-50`）和教师 `teacher`。基础口令默认 `gvclab2026`，可用 `VITE_DEMO_PASSWORD` 覆盖，须与服务端 `GVCSIM_BOOTSTRAP_PASSWORD` 一致；服务端运行一次 `classroom-init` 即可幂等补齐这些账号。普通构建不含这些凭证。

## 三个独立生命周期

| 操作 | 命令 | 教学库 |
| --- | --- | --- |
| 代码部署 | 更新代码、重建前端、重启 API | 保留 |
| 数据发布 | 维护窗口内运行 `compute`，原子切换 release | 保留；会话和报告按 `(账号, release_id)` 自动隔离，旧令牌失效 |
| 新学期清场 | 备份后 `classroom-init --reset` | **清空**全部账号、会话、报告和评分 |

普通代码部署和数据换版绝不执行 `--reset`。`compute` 只处理数据，不连接教学库。

## 测试与检查

**`tests/conftest.py` 会删除目标数据库的 `public` schema。** 运行 pytest 前必须把 `GVCSIM_PG_DSN` 指向专用的一次性测试库，不得使用课堂库或开发库。

```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest -q                       # 指向测试库
cd frontend && bunx tsc --noEmit -p . && bun run test:unit
```

完整本地检查 `scripts/local_ci.sh` 在临时目录复制源码、生成合成 OECD release，并启动一次性 PostgreSQL 容器，依次运行 Gephi 基准、后端静态检查与覆盖率测试、前端构建与单测、学生／教师浏览器验收（agent-browser）。需要 Docker、uv、Bun、Node（agent-browser 的运行时）、JDK 17+、Maven、agent-browser、`pdftotext` 和一套中文字体（如 `fonts-noto-cjk`）；产物留在忽略目录 `dogfood-output/local-ci/`。仓库没有 GitHub Actions，发布前手动运行。

## 数据与许可

项目原创代码、文档和界面适用 [LICENSE](LICENSE) 的“All rights reserved”声明。正式指标基于 OECD ICIO 2023 版 2016–2020 表；关税冲击、HS→ICIO 示例、宏观控制和 CI 合成表为教学 mock，不能冒充官方统计或研究结论。使用、引用或再分发前请核对 [OECD ICIO 数据集页面](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html)、[OECD Terms & Conditions](https://www.oecd.org/en/about/terms-conditions.html) 与 [2023 方法文档](https://doi.org/10.1787/5a5d0665-en)。导出物不得包含数据库凭证、认证密钥或学生记录。
