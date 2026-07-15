# 供应链仿真系统（GVC Simulation Lab）

基于 OECD ICIO 的全球价值链教学实验系统，覆盖数据浏览与质检、GVC 指标计算、可视化、
面板回归和实验报告。

OECD ICIO 2016–2020（77 个经济体 × 45 个行业）为真实经济数据；政策冲击、宏观控制变量
和 HS↔ICIO 映射为明确标注的拟真数据。回归结果仅用于教学，不构成现实政策结论。

## 功能

- WWZ 总贸易流分解：`DVAex`、`DVArt`、`DDC`、`FVA`、`FDC`、`taxsub`；
- WWYZ 生产分解与生产长度：`PLv`、`PLy`、`Pos_TPL`、`GVCPs` 等；
- Gephi-compatible 全球生产网络指标；
- DID、双向固定效应、事件研究、控制变量、安慰剂检验与 PanelOLS 实现对照；
- 16 步教学界面、Markdown/PDF 报告和 PostgreSQL 课堂管理。

网络计算使用有向无权 Gephi 语义：所有正流量均为边，保留正自环；路径沿出边计算；介数
采用未归一化的精确 Brandes；特征向量中心性使用入边和固定 100 次迭代。国家图保持当前
“跨国中间品 + 最终品、不含国内边”的定义，因此在现有数据上是完全图，介数恒为 0；国家
指标仍如实输出，网络回归与枢纽分析只使用存在节点差异的全球国家×行业图。

## 快速开始

依赖 Python 3.13+、[uv](https://docs.astral.sh/uv/) 和 [Bun](https://bun.sh/)。

```bash
uv sync --locked --group dev
uv run gvcsim download --years 2016 2017 2018 2019 2020  # 已有原始数据可跳过
uv run gvcsim compute
uv run gvcsim serve
```

另开终端启动前端：

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

前端默认位于 `http://localhost:5173`，API 位于 `http://localhost:8000`。演示账号为
`student / gvclab2026` 和 `teacher / gvclab2026`。教师功能需要 PostgreSQL，可用
`uv run gvcsim classroom-init` 初始化，并通过 `GVCSIM_PG_DSN` 配置连接。

## 数据与目录

- `OECD_ICIO/`：OECD ICIO 原始 CSV；
- `data/processed/`：逐年指标、质检、网络边、回归面板与算法版本清单；
- `data/shocks/`：教学用政策冲击面板；
- `gvcsim/`：计算、API、回归、报告和课堂后端；
- `frontend/`：React 教学界面与可视化；
- `tests/`、`frontend/e2e/`：后端、前端和浏览器测试。

常用命令：

```bash
uv run gvcsim validate --year 2019
uv run gvcsim regress --outcome trade
uv run gvcsim regress --outcome network --granularity industry
uv run gvcsim report --year 2020
```

## 验证

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q

cd frontend
bun run test:unit
bun run build
bun run test:e2e
```

服务器更新流程见 [`DEPLOY_101.201.151.30.md`](./DEPLOY_101.201.151.30.md)。
