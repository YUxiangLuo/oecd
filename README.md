# GVC Simulation Lab

基于 OECD ICIO 的 15 步全球价值链教学实验。后端预计算增加值贸易、生产长度、网络指标与教学回归面板；浏览器负责交互，PostgreSQL 按数据 release 保存账号、实验会话和报告。

- 步骤 1–9 使用 OECD ICIO 2023 版 2016–2020 年数据及派生指标。
- 步骤 10–14 使用教学关税面板 `step10-tariff-teaching-v13`：美国分两批（2018、2019 年）对货物加税，关税暴露 `X = 固定冲击前销往美国的出口份额 × 税率`。默认模型包含 X、L1.X、汇率变动、GDP 对数、贸易开放度，以及国家×行业和年份固定效应，主结果是当期＋滞后合计关联。每步的报告材料固定为本步默认 Y 的默认模型结果，条形图上的其他 Y 只能预览读数；学生可在选做的“改模型、对比”里点 7 个预设实验（3 个必看：去掉汇率变动、去掉 GDP 对数、去掉贸易开放度；4 个进阶）或自定义 X 滞后、8 项控制及固定效应，与默认模型和课程设定值对比、导出 CSV，每步可把一个模型放入报告附录。v13 的生成规则让去掉汇率变动、GDP 对数、贸易开放度或年份固定效应时，估计点按设计偏离设定值（贸易开放度约 4–9%，其余约 6–22%；去掉一个混杂后区间变宽，部分 Y 的区间仍含设定值），走势图下写明回归把第一批的变化拆成哪几部分；按设计几乎不变的改动（加人口／FDI、加 L2.X、国家×年份固定效应）中，国家×年份固定效应在选项旁写明原因，另两项留给学生对比后自己判断（预设问题只提问、不给答案）。关税、五项宏观控制与 Y 为课程生成，其余三项控制从 ICIO 派生，均有来源说明。模拟 GVC 位置指数等于模拟前向／后向长度之比，没有预设恒定线性系数；同家族核算恒等式逐行成立，美国和 ROW 不进入回归样本。
- 步骤 15 生成、提交实验报告，教师评阅。

PR59 审查修复的实现与验证边界见 [审查记录](docs/review-pr59-2026-10-12.md)末尾；历史容量结果不是修后生产吞吐保证。报告回归数字使用服务器结果，页面、总览和报告共享有界缓存与计算准入，只有成功且实际拥有的计算计次（报告最多 20 次）。标准误按国家聚类，CR1 自由度计入样本中固定效应哑变量矩阵的精确秩，不能直接与其他软件默认设置等同。

| 文档 | 内容 |
| --- | --- |
| [技术手册](技术手册.md) | 架构、计算方法、数据契约、接口、数据库、运行保护、测试与运维 |
| [DEPLOY.md](DEPLOY.md) | 当前版本部署、数据验证、全新教学库初始化与故障处理 |
| [实验手册 PDF](实验手册.pdf) | 学生操作指南；正文与重新生成方法见 [docs/student-manual](docs/student-manual/README.md) |
| [docs/indicator-readings](docs/indicator-readings/README.md) | 步骤 2–5 指标说明 PDF 的源文件与构建方法 |

当前部署的数据身份以 `data/processed/dataset.json` 为准，不在文档中固化“当前 release”。本次复核证据见 [2026-10-18 发布验证](benchmarks/release_verification_20261018.json)：绑定实际 release、原始输入、文件 SHA-256、代码及依赖，覆盖逐年输出 QC、回归输入 QC 和 17 个 Y ×（默认 + 7 预设）共 136 次库对照。验证命令如下；`--check` 会拒绝数据、代码或依赖已经变化的旧证据。

```bash
uv run gvcsim verify-release --out dogfood-output/release-verification.json
uv run gvcsim verify-release --check dogfood-output/release-verification.json
```

这项验证不包含完整 20,111 次模型网格、200 种子覆盖率、原始 ICIO 全量重算或生产容量。

**历史验证的适用范围：**`benchmarks/model_space_v13.json` 的 20,111 次估计属于旧 release `8565f226…`：7 种 X 组合 × 13 种固定效应组合 × 13 组代表性控制配置 × 17 个 Y，全部通过标准库对照。它不穷举工作台任意控制变量及滞后组合。`benchmarks/teaching_design_v13.json` 的 200 种子基准也绑定旧源面板。这些文件不能认证当前代码／release 已完整重跑；结论见 [历史模型空间核查](docs/regression-model-space-check-2026-10-14.md)。`shock_panel_v16.json` 同样保留为旧 release 的性能记录。

**2026-10-17 历史补验（release `88063fb4…`）：**[200 种子 × 17 个 Y](benchmarks/teaching_design_v13_20261017.json) 已完整重跑，逐种子估计、标准误和判定与历史记录完全一致；有预设 β 的累计区间覆盖率为 91.5%–95.5%，不是 95% 的保证。[36 种代表性设定 × 17 个 Y](benchmarks/model_space_v13_sample_20261017.json) 的 612 次估计全部通过库对照，未重跑完整 20,111 次网格；单次样本的设定值恢复仍有 9/165 项未通过原检查规则，明细保留，不能称为所有教学预期均通过。[contract 17 冲击面板性能](benchmarks/shock_panel_v17.json) 的单次冷请求约 340 ms、顺序热请求 p95 约 37 ms、8 并发热请求 p95 约 362 ms，均在脚本预算内；这是本机 TestClient 结果，不是生产容量或网络时延验收。这些记录仅适用于文件所绑定的数据与代码；后续发布必须重新验证。

此前 v12 的本地验收 release 为 `be37a7cfe40444f09749a77a276f45a3`：4,743 个分层选择的模型通过标准库对照；独立复算 364 个案例中 352 个成功估计、12 个一致拒绝，无超容差差异；四类报告案例完成生成、提交与重新读取检查。详见 [v12 历史规格与验证边界](docs/regression-refactor-20261010.md)。历史 review 和评估只适用于其注明的基线，不是生产容量验收。

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
- 当前开发教学库 schema 为 `gvcsim-teaching-db-v15`（会话契约 `experiment-session-simple-v4`：步骤 11–14 只保存 `run` 和一个 `experiment`），新增独立于数据 release 的系统统一题库快照，不考虑历史数据库或系统兼容；每次部署使用全新教学库，空库初始化或显式 `classroom-init --reset` 重建。保存接口预算为规范化 UTF-8 JSON 300000 字节，PUT/PATCH 应答只含 `updated_at` 与学习状态，不回传 `session`（见技术手册）。
- 教师可在“理解题”配置步骤 1–14：每步 1–3 道判断／单选题，单选 2–4 个选项，默认共 24 题。保存仅变更本步版本，无实质变化不变版；“恢复默认”把当前默认题目填进编辑区，点“保存并生效”后才生效。改题不删除实验材料或已提交报告，未提交报告需重新生成。`scripts/seed_full_journey.py` 仅支持服务器当前默认版本与公开题目，使用学生 workspace 核对，不需要教师口令或读取私有答案。
- `serve` 默认只监听本机回环地址；课堂局域网访问用 `--host 0.0.0.0` 或设置 `GVCSIM_BIND_HOST`。
- 前端开发：`cd frontend && bun run dev`。Vite 把 `/api` 代理到本机 8000 端口，其他位置用 `GVCSIM_API_PROXY=http://<api主机>:<端口>`。
- 演示构建 `bun run build:demo` 内置 50 组学生快捷登录（`student`，`student02`–`student50` 的口令为基础口令加 `-02`–`-50`）和教师 `teacher`。基础口令默认 `gvclab2026`，可用 `VITE_DEMO_PASSWORD` 覆盖，须与服务端 `GVCSIM_BOOTSTRAP_PASSWORD` 一致；服务端运行一次 `classroom-init` 即可幂等补齐这些账号。普通构建不含这些凭证。

## 部署约定

只支持当前版本，每次部署采用“停止 API → 更新代码和认证密钥 → 重建数据 release 并验证 → `classroom-init --reset` 创建全新教学库 → 预检启动”。账号、题库修改、会话、报告及评分均清空，首位教师与学生账号重新建立。普通服务重启不会清库。具体命令见 [DEPLOY.md](DEPLOY.md)。

数据在暂存目录完成完整性检查后原子发布，成功后仅保留当前 release；不提供历史迁移、自动备份、恢复或版本回滚。`compute` 本身不访问数据库。重建 release 与轮换认证密钥可防止上一部署的令牌和浏览器暂存材料套用到新库。

学生端只支持一个用户在一个标签页编辑，不提供多窗口／多设备协作或自动合并。浏览选择和未记入报告的模型表单仅在本标签页 `sessionStorage` 中按账号＋release 恢复；正式材料、理解题结果和分析文字自动保存到服务器。旧记录中的浏览设置首次读取时转为本地设置，后续作业请求不再携带它们。`sessionStorage` 另存最新待保存作业及未确认请求，用于刷新和断网恢复，不是永久备份。保存队列先确认未完成请求再发送新内容；服务端仍保留版本检查与重复请求确认，防止刷新前的旧请求覆盖新作业。报告生成、提交和教师评分保护保持独立。

## 测试与检查

**`tests/conftest.py` 会删除目标数据库的 `public` schema。** 数据库测试必须显式设置 `GVCSIM_PG_DSN_TEST` 为专用的一次性测试库；如另设 `GVCSIM_PG_DSN`，两者的主机、端口、库名和用户必须相同。只允许显式本机 IP（127.0.0.1 或 ::1）、端口、用户和以 `_test` 结尾的库名；禁止 service/hostaddr 隐式重定向。生产环境始终拒绝重置，没有 override。名字本身不能保证安全，仍须确认该库可销毁，不得使用课堂库或开发库。

```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest -q                       # 指向测试库
cd frontend && bunx tsc --noEmit -p . && bun run test:unit
```

完整本地检查 `scripts/local_ci.sh` 在临时目录复制源码、生成合成 OECD release，并启动一次性 PostgreSQL 容器，依次运行 Gephi 基准、后端静态检查与覆盖率测试、前端构建与单测、学生／教师浏览器验收（agent-browser）。需要 Docker、uv、Bun、Node（agent-browser 的运行时）、JDK 17+、Maven、agent-browser、`pdftotext` 和一套中文字体（如 `fonts-noto-cjk`）；产物留在忽略目录 `dogfood-output/local-ci/`。仓库没有 GitHub Actions，发布前手动运行。

## 数据与许可

项目原创代码、文档和界面适用 [LICENSE](LICENSE) 的“All rights reserved”声明。正式指标基于 OECD ICIO 2023 版 2016–2020 表；关税冲击、HS→ICIO 示例、宏观控制和 CI 合成表为教学 mock，不能冒充官方统计或研究结论。使用、引用或再分发前请核对 [OECD ICIO 数据集页面](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html)、[OECD Terms & Conditions](https://www.oecd.org/en/about/terms-conditions.html) 与 [2023 方法文档](https://doi.org/10.1787/5a5d0665-en)。导出物不得包含数据库凭证、认证密钥或学生记录。
