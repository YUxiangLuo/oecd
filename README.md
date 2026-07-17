# 供应链仿真系统（GVC Simulation Lab）

[![CI](https://github.com/YUxiangLuo/oecd/actions/workflows/ci.yml/badge.svg)](https://github.com/YUxiangLuo/oecd/actions/workflows/ci.yml)

基于 OECD ICIO 的全球价值链教学实验平台。系统把投入产出数据浏览、质量检查、GVC 指标计算、
交互式可视化、面板回归和实验报告串成一套 16 步课程流程。

当前数据范围为 OECD ICIO 2016–2020：77 个经济体、45 个行业。ICIO 原始表及由其计算的指标是
真实经济数据；政策冲击、模拟宏观控制和演示用 HS↔ICIO 映射会在界面中明确标为教学拟真数据。
回归结果用于练习研究设计和证据解释，不构成现实政策结论。

## 系统内容

| 阶段 | 步骤 | 内容 |
|---|---:|---|
| 数据接入 | 1–3 | 浏览 ICIO 的 `Z`、`Y`、`TLS`、`VA`、`OUT`，接入政策冲击并执行质量检查 |
| 指标计算 | 4–7 | WWZ 贸易流分解、WWYZ 生产分解、生产长度与 Gephi-compatible 网络中心性 |
| 可视化分析 | 8–11 | 国家与国家–行业下钻、构成图、象限图、趋势图、排序图和有向网络图 |
| 回归教学 | 12–15 | 贸易流、生产、长度和网络四类 outcome；支持 DID、双向固定效应、事件研究与安慰剂检验 |
| 实验闭环 | 16 | 汇总指标与回归结果，生成 Markdown/PDF 报告并支持课堂提交、评阅 |

主要指标包括：

- WWZ 总贸易核算：`DVAex`、`DVArt`、`DDC`、`FVA`、`FDC`、`taxsub`；
- WWYZ 生产分解：纯国内、传统贸易、简单 GVC、复杂 GVC 的前向与后向分解；
- 生产长度与位置：`PLv`、`PLy`、`Pos_TPL`、`GVCPs`；
- 网络中心性：度、加权度、离心率、接近中心性、调和中心性、介数和特征向量中心性；
- 教学实证：国家级与国家–行业级面板、国家聚类标准误、控制变量、异质性和名义/实际值口径。

## Gephi-compatible 网络口径

预计算产物使用固定算法契约：

```text
schema_version: 2
network_algorithm: gephi-compatible-directed-unweighted-positive-v1
```

- 有限正流量构成有向边；行业网络保留正自环；
- 度和加权度保留入向、出向及合计值；
- 最短路径沿出边、按无权图计算；介数使用精确、未归一化 Brandes；
- 特征向量中心性复现 Gephi 的入边语义和固定 100 次迭代；
- 11 个公开字段由 Gephi Toolkit 0.10.1 的 golden export 回归测试守护；
- 前端的 Top 边阈值只控制网络图展示，不参与中心性计算。

国家图由跨国中间品与最终品贸易构成，不含国内边。当前数据下国家图是完全图，因此国家级介数
恒为 0；网络枢纽分析和网络回归使用具有节点差异的完整全球国家×行业图。与 Gephi 对比时必须使用
相同节点、正边、自环和 directed/unweighted/unnormalized 设置。

因为国家图是完全图，度、入/出度、离心率、接近、调和与特征向量、介数这些**无权**中心性对所有
国家取同一常数（度恒为 152、介数恒为 0），没有横截面区分度。因此这些字段带 `country_degenerate`
标记，界面在国家级粒度隐藏它们、只保留能区分国家的加权度（=贸易量），完整无权中心性只在
国家–行业级展示；网络回归也只允许国家–行业级（见 `gvcsim/regression/design.py`）。

## 快速开始

需要 Python 3.13、[uv](https://docs.astral.sh/uv/) 和 [Bun](https://bun.sh/)。

### 1. 安装依赖并准备数据

```bash
uv sync --locked --group dev

# 新环境需要先下载原始 ICIO；已有 OECD_ICIO/ 时可跳过
uv run gvcsim download --years 2016 2017 2018 2019 2020

# 计算逐年指标、网络指标、质检结果、回归面板和产物清单
uv run gvcsim compute
```

如果已有同版本的 `data/processed/` 与 `data/shocks/`，可以直接启动服务。API 会校验
`artifact_manifest.json` 的算法版本和文件摘要，旧版本、部分重算或损坏的产物不会被静默使用。

### 2. 启动后端

```bash
uv run gvcsim serve --reload
```

API 默认位于 `http://localhost:8000`，交互式文档位于 `http://localhost:8000/docs`。

### 3. 启动前端

另开终端：

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

访问 `http://localhost:5173`。Vite 会把 `/api` 代理到本地 FastAPI 服务。

| 身份 | 用户名 | 密码 | 用途 |
|---|---|---|---|
| 学生 | `student` | `gvclab2026` | 完成 16 步实验并提交报告 |
| 教师 | `teacher` | `gvclab2026` | 班级、学生、公告和报告评阅 |

演示账号不依赖 PostgreSQL。课堂管理、进度保存和报告评阅需要 PostgreSQL：

```bash
export GVCSIM_PG_DSN='postgresql://USER:PASSWORD@127.0.0.1:5432/gvclab'
uv run gvcsim classroom-init
```

`classroom-init --reset` 会清空全部教学表，只应在确认不保留课堂数据时使用。

## 常用命令

```bash
# 检查单年原始表与会计恒等式
uv run gvcsim validate --year 2019

# 只重算指定年份；不传 --years 时计算本地全部年份
uv run gvcsim compute --years 2019 2020

# 四类教学回归
uv run gvcsim regress --outcome trade --method did
uv run gvcsim regress --outcome production --method fe --controls
uv run gvcsim regress --outcome length --method event
uv run gvcsim regress --outcome network --granularity industry

# 生成报告；不传年份时使用最新产物年份
uv run gvcsim report --year 2020
```

网络 outcome 只支持 `industry`，因为国家完全图的介数没有横截面差异。

## 数据流与目录

```text
OECD ICIO ──> 质检与指标流水线 ──> 带版本清单的预计算产物 ──> FastAPI ──> React 教学界面
                                      │                 ├──> 回归与报告
政策冲击与控制变量 ────────────────────┘                 └──> PostgreSQL 课堂功能（可选）
```

| 路径 | 内容 |
|---|---|
| `OECD_ICIO/` | 下载的 OECD ICIO 原始文件 |
| `data/processed/` | 逐年指标、质检 JSON、网络展示边、回归面板与 `artifact_manifest.json` |
| `data/shocks/` | 教学政策冲击面板 |
| `gvcsim/` | 指标流水线、FastAPI、回归、报告和课堂后端 |
| `frontend/` | React 19、TypeScript、Vite 教学界面 |
| `tests/` | 后端测试与 Gephi golden fixture |

原始数据、预计算结果、报告、数据库凭证和认证密钥都不会提交到 Git。

## 验证

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q

cd frontend
bun run test:unit
bun run build
```

GitHub Actions 在每次 push 上跑同一组检查(后端带 PostgreSQL 服务、前端构建与单测)。
浏览器端没有自动化测试:界面行为靠人工在真实服务上核对。

## 使用边界

- 拟真政策冲击与模拟宏观控制适合教学，不应替代经审计的研究数据；
- DID、固定效应和事件研究结果只有在相应识别假设成立时才可作因果解释；
- 内置账号和 12 小时签名令牌面向课堂演示，公网部署应补充 HTTPS、限流、审计和正式身份系统；
- 当前服务器更新步骤见 [`DEPLOY_101.201.151.30.md`](./DEPLOY_101.201.151.30.md)。
