# 供应链仿真系统（GVC Simulation Lab）

面向课堂的全球价值链教学实验系统。项目基于 OECD ICIO 计算 GVC 指标，提供数据质检、
政策冲击演示、可视化、面板回归和实验报告，形成“数据 → 指标 → 回归 → 报告”的 16 步课程。

> 数据说明：OECD ICIO 2016–2020（77 个经济体 × 45 个行业）是系统中的真实经济数据；
> 政策冲击、宏观控制变量和 HS↔ICIO 映射等外部数据为明确标注的拟真 Mock。
> 因此，回归结果只用于教学，不构成现实政策结论。

当前界面以 `frontend/` 和 `/api/steps` 为准，`prototype/` 仅保留早期静态设计参考。
界面主要面向桌面端和宽屏课堂环境。

## 功能概览

| 阶段 | 步骤 | 内容 |
|---|---:|---|
| 数据接入 | 1–3 | ICIO 表浏览、政策冲击演示、ICIO/冲击/控制变量质检 |
| 指标计算 | 4–7 | 贸易流分解、生产分解、生产长度、全球生产网络指标 |
| 可视化 | 8–11 | 网络图、分解图、长度图、热力图及指标自由探索 |
| 教学实证 | 12–15 | DID、双向固定效应、事件研究、控制变量与安慰剂检验 |
| 实验闭环 | 16 | 生成 Markdown 报告、打印/PDF、提交与教师评阅 |

指标模块包括：

- WWZ 总贸易核算：`DVAex`、`DVArt`、`DDC`、`FVA`、`FDC`、`taxsub`、`EXDVA`；
- WWYZ 生产分解：前向增加值与后向最终产品两个视角；
- WWYZ 生产长度：`PLv`、`PLy`、`Pos_TPL`、`GVCPs` 等指标；
- 网络指标：度、加权度、离心率、接近/调和中心性、介数和特征向量中心性。

指标同时提供国家级和国家–行业级结果。网络度类指标使用全部正流量边，路径类、介数和
特征向量中心性使用阈值化无权图；与客户 Gephi 全图口径的差异记录在基准对账报告中。

教师端提供班级与学生管理、学习进度、报告评阅和课堂公告。教学数据存入 PostgreSQL；
数据库不可用时，指标、回归、报告等核心实验仍可运行，课堂管理接口会返回降级提示。

## 快速开始

依赖：Python 3.13+、[uv](https://docs.astral.sh/uv/) 和 [Bun](https://bun.sh/)。

```bash
# 安装后端依赖
uv sync --locked --group dev

# 下载 OECD ICIO 原始数据；已有本地数据时可跳过
uv run gvcsim download --years 2016 2017 2018 2019 2020

# 生成指标、质检结果和回归面板
uv run gvcsim compute

# 可选：初始化教师面板使用的 PostgreSQL 教学数据库
uv run gvcsim classroom-init

# 启动 API：http://localhost:8000，接口文档位于 /docs
uv run gvcsim serve
```

另开终端启动前端：

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

前端默认运行在 `http://localhost:5173`，开发服务器会把 `/api` 代理到 FastAPI。

演示账号：

| 用户名 | 密码 | 角色 |
|---|---|---|
| `student` | `gvclab2026` | 学生 |
| `teacher` | `gvclab2026` | 教师 |

认证使用 PBKDF2 口令哈希和带过期时间的 HMAC 签名令牌。数据库可用时优先读取数据库账号；
数据库不可用时仅回退到上述演示账号。数据库连接可通过 `GVCSIM_PG_DSN` 配置。

## 数据与产物

| 数据或产物 | 说明 |
|---|---|
| `OECD_ICIO/` | OECD ICIO 原始 CSV，按需下载 |
| `data/processed/` | 各年指标、质检结果、网络边和跨年回归面板 |
| `data/shocks/` | 关税、制裁、出口管制拟真面板 |
| `reports/` | CLI 生成的实验报告和客户基准对账报告 |
| PostgreSQL | 账号、班级、进度、报告提交、评分和公告 |

外部 Mock 数据保持与真实来源相近的 schema、维度和量级，并通过独立质检。回归教学场景还可在
估计样本层切换 `clean`、`noisy` 和 `confounded`，用于展示测量误差和前趋势混杂。

如本地存在 `client-docs/` 客户样例，可运行：

```bash
uv run gvcsim benchmark
```

对账报告写入 `reports/client_benchmark.md`。客户样例与本项目使用的 ICIO 修订版本及网络建图
口径并不完全相同，因此对账结果用于检查量级和排序，不代表逐值一致。

## 架构

```text
OECD ICIO CSV
    │
    ▼
离线计算流水线（pymrio + NumPy + pandas + NetworkX）
    │
    ├── 指标与质检 CSV/JSON
    └── 国家级、国家–行业级回归面板
                │
                ▼
          FastAPI + CLI
                │
                ▼
          React + Vite 前端

PostgreSQL ──► 账号、班级、进度、提交与评阅
```

解析大表、矩阵求逆和指标计算集中在离线 `compute` 阶段。API 读取预计算产物，并按文件修改时间
缓存 CSV；回归和报告根据请求参数从面板产物中计算。

主要目录：

- `gvcsim/data/`：ICIO 加载、表浏览、质检、控制变量和行业映射；
- `gvcsim/indicators/`：贸易流、生产、长度和网络指标；
- `gvcsim/regression/`：回归设计、估计、推断和 PanelOLS 对照；
- `gvcsim/classroom/`：PostgreSQL 教学数据与课堂 API；
- `gvcsim/api.py`、`gvcsim/cli.py`：HTTP 与命令行入口；
- `frontend/src/`：学生实验界面、可视化、报告渲染和教师面板；
- `tests/`、`frontend/e2e/`：后端、前端和浏览器测试。

## 常用命令

```bash
uv run gvcsim validate --year 2018
uv run gvcsim regress --outcome trade
uv run gvcsim regress --outcome length --method event
uv run gvcsim regress --outcome production --method fe --controls
uv run gvcsim report --year 2020
uv run gvcsim compute --years 2018
uv run uvicorn gvcsim.api:app --reload
```

回归业务标识为 `trade`、`production`、`length` 和 `network`。默认样本是国家–行业级面板，
也可通过 CLI 或前端切换粒度、冲击类型、估计方法、控制变量、交互项和价格口径。

## 验证

后端：

```bash
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q
```

前端：

```bash
cd frontend
bun run test:unit
bun run build
bun run test:e2e
```

GitHub Actions 会执行后端检查、前端构建、浏览器 E2E 和真实 API 冒烟测试。

## 部署

示例服务器的 nginx、systemd、数据同步和数据库初始化流程记录在
[`DEPLOY_101.201.151.30.md`](./DEPLOY_101.201.151.30.md)。
