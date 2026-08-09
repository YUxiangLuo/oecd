# 供应链仿真系统（GVC Simulation Lab）

[![CI](https://github.com/YUxiangLuo/oecd/actions/workflows/ci.yml/badge.svg)](https://github.com/YUxiangLuo/oecd/actions/workflows/ci.yml)

基于 OECD ICIO 的全球价值链教学实验平台。系统把投入产出数据浏览、质量检查、GVC 指标计算、
交互式可视化、面板回归和实验报告串成一套 16 步课程流程。

当前数据范围为 OECD ICIO 2016–2020：77 个经济体、45 个行业。ICIO 原始表及由其计算的指标是
真实经济数据；政策冲击、模拟宏观控制和演示用 HS↔ICIO 映射会在界面中明确标为教学拟真数据。
回归结果用于练习研究设计和证据解释，不构成现实政策结论。

## 客户端支持范围

本项目仅面向桌面端教学环境，建议使用可视区域宽度至少为 1200 px 的桌面浏览器。项目不做手机、
平板或其他窄屏设备的移动端适配，也不保证这些设备上的布局与交互可用。

## 系统内容

| 阶段 | 步骤 | 内容 |
|---|---:|---|
| 数据接入 | 1–2 | 浏览 ICIO 的 `Z`、`Y`、`TLS`、`VA`、`OUT`，执行原始数据与控制变量质量检查 |
| 指标计算 | 3–6 | WWZ 贸易流分解、WWYZ 生产分解、生产长度与 Gephi-compatible 网络中心性 |
| 可视化分析 | 7–10 | 国家与国家–行业下钻、构成图、象限图、趋势图、排序图和有向网络图 |
| 冲击与回归 | 11–15 | 接入三类政策冲击；对贸易流、生产、长度和网络 outcome 运行 DID、双向固定效应、事件研究与稳健性检查 |
| 实验闭环 | 16 | 汇总指标与回归结果，生成 Markdown/PDF 报告并支持课堂提交、评阅 |

主要指标包括：

- WWZ 总贸易核算：`DVAex`、`DVArt`、`DDC`、`FVA`、`FDC`、`taxsub`；
- WWYZ 生产分解：纯国内、传统贸易、简单 GVC、复杂 GVC 的前向与后向分解；
- 生产长度与位置：`PLv`、`PLy`、`Pos_TPL`、`GVCPs`；
- 网络中心性：度、加权度、离心率、接近中心性、调和中心性、介数和特征向量中心性；
- 教学实证：国家级与国家–行业级面板、国家聚类标准误、控制变量、异质性和名义/实际值口径。

## 步骤完成规则

步骤 1–15 各有 1–3 道固定单选题，共 21 题。学生提交后立即看到逐题反馈，可不限次数重试；
本步全部答对即完成，不要求另行提交任何实验操作。只有全对时服务端才记录事件并签发不可见的
`quiz_id`，绑定账号、assignment、attempt、manifest、步骤、题库版本和最终答案，避免客户端
自行伪造完成度。

切片、筛选、对比、图表和最近一次回归会随实验自动保存。相应页面的当前状态用于恢复界面，
累计的观察与运行记录用于丰富最终报告；这些记录不影响步骤完成。第 16 步在前 15 步答题通过后
由服务端生成报告；报告只复估学生实际运行过且
具有可信 `run_id` 的回归，没有运行的步骤明确标为“未记录学生运行”，不会偷偷补跑默认模型。
详细契约见 [`docs/COURSE_COMPLETION.md`](./docs/COURSE_COMPLETION.md)。

课堂数据模型为 course run → assignment → enrollment → attempt；学生的会话、进度、答题、报告
与提交都挂在 attempt 之下，历史 attempt 保留为审计记录。

> **assignment 绑定数据版本。** `assignments.manifest_id` 固定指向某个产物版本，重算产物
> （`gvcsim compute`）后既有作业会立刻失配，学生的一切写入返回 409 且无法自行新建 attempt，
> 必须由教师新建绑定新 manifest 的作业。学期中途不要随手重算，详见部署文档的「数据发布」。

## Gephi-compatible 网络口径

预计算产物使用固定算法契约：

```text
schema_version: 3
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

# 计算逐年指标、网络指标、质检结果、回归面板和产物清单；fatal QC 默认中止发布
uv run gvcsim compute
```

若课程负责人已核实异常、记录原因并决定仅用于教学演示，才可显式运行
`uv run gvcsim compute --allow-qc-override`。override、失败项和披露要求会写入 manifest 与报告，
不会被当成“质检通过”。

ICIO 质检会独立保留原始 CSV 的 `OUT` 账户，分别复核 `OUT = Z行和 + Y行和` 与
`OUT = Z列和 + VA + TLS`；里昂惕夫系统以谱半径、条件数、逆残差和逆矩阵非负性判断。
负 VA 会作为行业指标定义域 warning 持续披露，但不会仅因某个 `A` 列和超过 1 而误判整年矩阵失效。

如果已有同版本的 `data/processed/`，可以直接启动服务。冲击面板、逐年指标、回归面板与 QC
都属于同一个原子产物集；`compute` 会先在 staging 中完整构建并校验，再把 `data/processed`
符号链接一次性切到 `data/artifacts/<manifest_id>/`。旧版本会保留用于审计与回滚，部分重算或损坏的
产物不会被静默使用。

### 2. 启动后端

```bash
export GVCSIM_PG_DSN='postgresql://USER:PASSWORD@127.0.0.1:5432/gvclab'
uv run gvcsim classroom-init
uv run gvcsim serve --reload
```

API 默认位于 `http://localhost:8000`，交互式文档位于 `http://localhost:8000/docs`。
`serve` 与 `preflight` 只读校验数据库 schema，不会自动建表或迁移；新建和升级数据库都必须先显式
运行 `gvcsim classroom-init`，以便把备份、迁移和服务启动拆成可审计的独立步骤。

正式课堂的并发配置不要照搬开发态单 worker。64 核、50–100 名学生的连接池、
多 worker、CPU admission、PostgreSQL 预算和可复现压测流程见
[`docs/CAPACITY_100_STUDENTS.md`](./docs/CAPACITY_100_STUDENTS.md)。

### 3. 启动前端

另开终端：

```bash
cd frontend
bun install --frozen-lockfile
bun run dev
```

访问 `http://localhost:5173`。Vite 会把 `/api` 代理到本地 FastAPI 服务。系统默认没有公开账号，
认证和 16 步会话都依赖 PostgreSQL；数据库不可用时认证会关闭，而不会回退到内置教师账号。

登录页默认是空表单。课堂演示可用**构建期**开关 `VITE_DEMO_MODE=1`（`bun run dev` 同样识别）
显示学生/教师快捷入口并预填演示口令；默认构建会把这段 UI 与口令常量一并 tree-shaking 掉，
因此生产产物里不含任何课堂凭证。

只在本机演示时，可显式开启演示播种并自行指定一次性密码：

```bash
export GVCSIM_PG_DSN='postgresql://USER:PASSWORD@127.0.0.1:5432/gvclab'
export GVCSIM_DEMO_MODE=1
export GVCSIM_BOOTSTRAP_PASSWORD="$(openssl rand -base64 24)"
uv run gvcsim classroom-init
```

这会播种 `student` 与 `teacher`，两者使用本次设置的密码。生产环境设置
`GVCSIM_ENV=production` 后会拒绝演示模式；生产环境必须分别设置至少 32 字节的
`GVCSIM_AUTH_SECRET` 与 `GVCSIM_EVIDENCE_SECRET`，不要复用同一密钥；完整安全配置见
[`deploy/gvcsim.env.example`](./deploy/gvcsim.env.example)。

正式环境首次初始化教师时，临时设置 `GVCSIM_INITIAL_TEACHER_PASSWORD`，再运行
`gvcsim classroom-init --teacher-username <管理员用户名> --teacher-name <显示名>`；成功后立即删除该变量。
教师首次登录后从顶栏选择「修改密码」轮换临时口令。修改成功会推进账号认证版本并撤销该账号在所有
浏览器中的既有会话，随后必须使用新密码重新登录；学生账号也可使用同一入口自助改密。

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
| `data/processed/` | 指向当前完整产物版本的原子符号链接 |
| `data/artifacts/<manifest_id>/` | 逐年指标、质检 JSON、教学冲击、网络边、回归面板与来源摘要 |
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

# 前后端已启动且已准备专用测试账号时，跑真实浏览器路由/请求 smoke
GVCSIM_BASE_URL=http://127.0.0.1:5173 \
GVCSIM_E2E_USERNAME=<测试学生> \
GVCSIM_E2E_PASSWORD=<测试口令> \
scripts/agent_browser_smoke.sh
```

GitHub Actions 在每次 push 上跑同一组检查(后端带 PostgreSQL 服务、前端构建与单测)。
`agent_browser_smoke.sh` 会在真实登录态下挂载学生端 1–16 步，并对浏览器错误和失败 API 请求做失败判定；
完整答题、回归和报告提交仍应在固定真实数据快照上执行夜间/发布前全流程审查。

## 使用边界

- 拟真政策冲击与模拟宏观控制适合教学，不应替代经审计的研究数据；
- DID、固定效应和事件研究结果只有在相应识别假设成立时才可作因果解释；
- 生产认证使用短期、可撤销且逐请求复查账号状态的令牌；访问令牌与答题/回归收据使用独立签名密钥，仍应通过 HTTPS 部署并妥善保护数据库与两类密钥；
- 当前服务器更新步骤见 [`DEPLOY_101.201.151.30.md`](./DEPLOY_101.201.151.30.md)。
