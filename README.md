# 供应链仿真系统(GVC Simulation Lab)

面向课堂的全球价值链(GVC)**教学实验系统**:基于全球投入产出数据库(OECD ICIO)
计算并可视化 GVC 指标,结合贸易政策冲击数据做实证回归,自动生成实验报告 ——
带学生走完 **数据 → 指标 → 回归 → 报告** 的完整实证闭环(17 个教学步骤)。

**数据边界**:OECD ICIO 2016–2020(77 经济体 × 45 行业)是系统中**唯一的真实数据**;
其余外部数据(政策冲击、宏观控制变量等)按真实来源的 schema 与量级**拟真 mock**,
真实数据到位时只需替换 loader(详见下文「数据边界与 Mock 策略」)。

需求与 17 步方案详见 [`供应链仿真系统_完整项目说明.md`](./供应链仿真系统_完整项目说明.md);
合并后的完成状态与后续增强项见 [`开发计划.md`](./开发计划.md);交互界面的完整设计原型见
[`prototype/`](./prototype/)(浏览器直接打开 `供应链仿真教学系统.dc.html` 即可预览)。

后端指标引擎、API、回归框架、报告生成,以及 17 步教学前端均已跑通真实数据
(OECD ICIO 2016–2020,77 国 × 45 行业)。指标字段与前端默认展示已对齐客户
资料中的贸易流分解、GVC 生产分解、GVC 长度/位置和生产网络指标命名;
客户给出的 1995–2018/2020 样例表只作为口径参考,不作为系统数据源。前端已按原型做成三栏教学布局
(课程大纲侧栏 + 主实验区 + 本步速览右栏 + 底部进度页脚),并为指标步骤(4-7)
加了交互式计算演示、为可视化步骤(8-11)加了可自选指标/图表的自由探索。
M1-M4 开发里程碑已全部合并完成。

**界面支持范围**:本系统定位为桌面端/宽屏课堂实验工具,不支持也不计划适配
移动端或窄屏浏览器;前端已移除面向窄屏的响应式/移动端适配样式。

## 快速开始

依赖:[uv](https://docs.astral.sh/uv/)(Python 3.13+)、[bun](https://bun.sh)(前端)。

```bash
# 1. 安装后端依赖
uv sync --group dev

# 2. 下载原始数据(约 66MB/年;本地已有 2016–2020 则跳过)
uv run gvcsim download --years 2016 2017 2018 2019 2020

# 3. 预计算指标与回归面板(全量约 1 分钟,产物写入 data/processed/)
uv run gvcsim compute

# 4. 启动 API(http://localhost:8000,交互文档在 /docs)
uv run gvcsim serve

# 5. 另开终端,启动前端(http://localhost:5173,/api 自动代理到 8000)
cd frontend && bun install && bun run dev
```

登录演示账号(登录页已预填,点登录即可;登录后有可跳过的交互式系统介绍):

| 账号 | 密码 | 角色 |
|---|---|---|
| `student` | `gvclab2026` | 同学(学生身份) |
| `teacher` | `gvclab2026` | 老师(教师身份) |

认证是真实实现(PBKDF2 口令哈希 + HMAC 签名令牌,12 小时有效,
`POST /api/auth/login` / `GET /api/auth/me`);除登录与令牌校验外,
所有 `/api/*` 数据接口均强制 Bearer 鉴权。

不起前端也能用 CLI 走完全流程:

```bash
uv run gvcsim validate --year 2018    # 步骤3:数据质检
uv run gvcsim regress --step 13       # 步骤13-16:演示回归(默认国家–行业级 + DID)
uv run gvcsim regress --step 14 --method event          # 事件研究(动态效应+前趋势)
uv run gvcsim regress --step 13 --method fe             # 双向固定效应(强度法)
uv run gvcsim regress --step 13 --controls              # 加入 ICIO 派生国家-年份控制变量
uv run gvcsim regress --step 13 --macro-controls        # 加入 WDI/IMF 风格模拟宏观控制
uv run gvcsim regress --step 13 --interaction           # 加入冲击×基期GVC参与度交互项
uv run gvcsim regress --step 13 --controls --real       # 金额类控制变量切换为实际值口径
uv run gvcsim regress --step 13 --granularity country   # 国家级粒度
uv run gvcsim report --year 2020      # 步骤17:生成 reports/experiment_report_2020.md
uv run pytest                         # 后端测试(含 synthetic compute 与 API 集成)
uv run ruff check . && uv run ruff format --check . && uv run mypy
cd frontend && bun run build && bun run test:e2e
```

## 目录结构

```
├── gvcsim/                       # 后端包
│   ├── config.py                 #   路径与年份配置
│   ├── data/
│   │   ├── loader.py             #   步骤1:pymrio 下载/解析 OECD ICIO
│   │   ├── icio_browser.py       #   步骤1:原始表按需切片浏览(z/y/accounts)
│   │   ├── quality.py            #   步骤3:结构化质检(ICIO/冲击/控制变量)
│   │   └── controls.py           #   ICIO 派生 + WDI/IMF 风格 mock 国家-年份控制变量
│   ├── shocks.py                 #   步骤2:政策冲击数据接入(拟真演示面板:全经济体、行业异质)
│   ├── indicators/
│   │   ├── core.py               #   共享底座:IcioArrays(向量化的矩阵切块)
│   │   ├── tradeflow.py          #   步骤4:贸易流分解,输出 EXDVA/DVAex/DVArt/DDC/FVA/FDC/taxsub 字段
│   │   ├── production.py         #   步骤5:WWYZ 生产分解,输出客户资料 SVA/VA/FGY 字段
│   │   ├── length.py             #   步骤6:长度/位置指标,输出 PLv/PLy/Pos_TPL/GVCPs 字段
│   │   └── network.py            #   步骤7:Gephi 风格网络中心性(度/入度/出度/加权度/路径中心性)
│   ├── regression/
│   │   ├── design.py             #   步骤12:回归设计(粒度/冲击/方法 → 面板/个体/聚类/方程)
│   │   └── panel.py              #   步骤13-16:DID / 事件研究 / 双向FE + 聚类稳健标准误 + PanelOLS 对照
│   ├── report.py                 #   步骤17:自动生成 Markdown 实验报告
│   ├── pipeline.py               #   预计算流水线:原始表 → 质检 → 指标 → 面板
│   ├── steps.py                  #   17 步元数据(与原型一致,前端渲染用)
│   ├── auth.py                   #   登录认证(演示账号,PBKDF2 + HMAC 签名令牌)
│   ├── api.py                    #   FastAPI:认证/面板/质检/冲击/可视化/回归/报告全部接口(CSV 按 mtime 缓存)
│   └── cli.py                    #   gvcsim 命令行入口
├── frontend/                     # React + Vite + TS 前端(bun);App.tsx 三栏布局外壳、
│                                 #   login.tsx 登录页、intro.tsx 登录后交互式系统介绍、
│                                 #   labs.tsx 步骤1-11/17 实验面板、demos.tsx 步骤4-7 计算演示
│                                 #   (拆解恒等式校验 + 网络中心性算法)、viz.tsx 富可视化
│                                 #   (网络/堆叠/长度/热力 + 排序/散点/趋势 + 事件研究/森林图,纯 SVG)、
│                                 #   teach.tsx + regteach.ts + regression.tsx 步骤12-16 讲解卡与回归台
├── tests/                        # 合成小矩阵、synthetic compute、回归/API 集成测试
├── prototype/                    # 完整 UI 设计原型(最终形态参考,部署时排除)
├── data/processed/               # 预计算产物(gitignore;由 gvcsim compute 生成)
├── data/shocks/                  # 冲击数据(自动生成的拟真演示面板,country×industry×year)
├── reports/                      # 自动生成的实验报告(gitignore;部署时排除)
└── OECD_ICIO/                    # 原始数据(gitignore;按需同步到服务器)
```

## 架构与数据流

```
OECD_ICIO/*.csv ──pymrio──▶ pipeline.compute_year()
                              ├─ quality.run_all()      → data/processed/qc_<year>.json
                              ├─ tradeflow / production
                              │  length / network       → indicators_{country,industry}_<year>.csv
                              │                           network_edges_<year>.csv
                              └─ pipeline.build_panel() → controls_country.csv(ICIO 派生控制变量)
                                                          qc_controls.json / qc_shocks.json
                                                          panel_industry.csv(行业级,回归默认)
                                                          panel_country.csv(冲击按出口额加权聚合)
                                                              │
              FastAPI(gvcsim/api.py,只读预计算产物,按 mtime 缓存)◀──────┘
                    │                         │
          frontend/(17步教学界面,     regression / report(按需在请求内运行)
          支持 ?step=N 深链;步骤2 有
          事件时间线 + 冲击面板浏览)
```

设计要点:

- **重计算离线化**:解析 66MB 大表与矩阵求逆只在 `compute` 时发生一次,API 只读
  CSV/JSON 产物,毫秒级响应。
- **指标全部向量化**:`IcioArrays` 一次性把 IO 系统切成 numpy 块(全球逆矩阵 B、
  各国国内逆 L_rr、出口向量、最终吸收份额等),BM/WWYZ 聚合分解与网络指标
  都在离线 `compute` 阶段完成。
- **回归引擎双轨校验**:教学主引擎使用迭代去均值 + OLS + 聚类 sandwich 标准误
  的透明 numpy 实现;同时用 `linearmodels.PanelOLS` 对政策系数做标准库对照。
  对照“通过/失败”只针对政策系数;标准误差异受聚类小样本修正与自由度处理影响,
  在界面和报告中仅作参考展示。
- **稳健性控制变量**:从现有 ICIO 指标派生国家-年份控制变量(增加值规模/增长、
  出口规模/增长、出口强度、制造业/服务业增加值份额),支持步骤12-17
  展示"基准模型 vs 加控制变量模型";另有 WDI/IMF 风格宏观 mock(GDP、人口、
  人均收入、汇率变动、FDI 流入)。GDP 平减指数 mock 支持名义/实际口径切换;
  金额指数只表示相对基期变化,不是真实官方平减值。
- **回归默认国家–行业级**:个体 = 国家×行业(排除 ROW 后约 3,420 个),固定效应吸收行业异质性,
  标准误按国家聚类(同国各行业共享政策冲击,残差组内相关);国家级粒度仍可选。
  ROW 作为世界其他地区聚合账户仍保留在指标计算中以保证 ICIO 闭合,但默认不进入政策回归样本。
- **三种估计方法共用一个 within-OLS 核心**:默认 DID(处理组=曾受冲击个体,
  处理期=各个体首次冲击年 `G_i` 起,不再使用全局共同 T0);事件研究使用
  `k = year - G_i` 的个体事件时间,并以 k=-1 为优先基期做平行趋势检验;
  双向FE(强度法)保留连续冲击强度的用法。
- **冲击数据拟真 mock**:关税冲击按 2018–2020 真实事件逐条编码(232 钢铝、
  301 四批清单、各方反制、空客案),税率量级参考 PIIE/Bown 统计;出口暴露度由
  OECD ICIO 双边流向计算。制裁清单与出口管制按 OFAC/BIS 实体清单风格生成
  国家-行业-年份强度列,三类冲击均覆盖全部 77 经济体 × 45 行业。
- **可测性**:指标模块吃 `IcioArrays` 而非 pymrio 对象,单元测试用手工构造的
  2 国 × 2 行业与 3 国循环小系统验证数学恒等式(BM 毛出口闭合、WWYZ 四段加总=GDP、
  封闭经济跨境项=0、v′B=1 等)。

## 17 步实现状态

| 阶段 | 步骤 | 状态 |
|---|---|---|
| 一、数据接入 | 1 数据库选型 | ✅ OECD ICIO,pymrio 下载解析已验证,原始表可在线切片浏览 |
| | 2 政策冲击数据 | ✅ 关税/制裁/出口管制三类拟真面板(全经济体×行业异质,事件级编码),前端有事件时间线+三类面板浏览,并加入 HS 清单税率→ICIO 行业平均冲击的映射工作流演示 |
| | 3 数据质检 | ✅ ICIO 5 项结构化检查 + 冲击面板质检(维度对齐、值域、时间线、treated 标记、处理组覆盖比例),CLI/API/前端共用 |
| 二、指标计算 | 4 贸易流分解 | ✅ Borin-Mancini source-based 聚合分解,并输出客户资料字段 EXDVA/DVAex/DVArt/DDC/FVA/FDC/taxsub;前端实时校验六项加总=毛出口 |
| | 5 生产分解 | ✅ WWYZ 四段分解,输出 SVA/VA/FGY 客户字段,恒等式经测试验证,国家+行业双粒度 |
| | 6 长度分解 | ✅ 生产长度与位置指标,输出 PLv/PLy/Pos_TPL/GVCPs 客户字段;拆解演示实时校验 PLv=PLv_D+PLv_RT+PLv_GVC |
| | 7 网络指标 | ✅ Gephi 风格度/入度/出度/加权度/离心率/接近中心性/调和中心性/介数/特征向量中心性,国家+行业双粒度 |
| 三、可视化 | 8–11 | ✅ 招牌图(网络图/生产堆叠条/长度双段条/中心性热力表)+ 自由探索:自选指标、排序条形图、X×Y 散点图、2016–2020 趋势折线、Top-N/选国家,均带表格视图与悬停 tooltip;网络图支持节点大小/颜色编码、边权阈值与点击节点明细;自由探索支持国家级/行业下钻 |
| 四、回归 | 12 设计确认 | ✅ 交互式设计台:粒度/三类冲击/方法/被解释变量选择卡 → 即时方程与面板/个体/聚类摘要(GET /api/regression/design) |
| | 13–16 四组回归 | ✅ 讲解卡片体系(概念/公式/陷阱/自检/小结)+ 模型设定卡 + 控制变量切换(ICIO 派生 / 模拟宏观)+ 名义/实际口径切换 + clean/noisy/confounded 教学场景 + 系数表/森林图/事件研究图 + PanelOLS 对照 + DID 安慰剂检验 + 按结果自动生成的中文解读;默认 DID(个体FE+按国聚类SE),基于演示冲击数据 |
| 五、闭环 | 17 实验报告 | ✅ Markdown 报告自动生成;步骤17 可吸收前端选择的粒度/冲击/方法/控制/交互项/价格口径并生成对应回归表;前端提供浏览器打印/另存 PDF 导出 |

## 数据边界与 Mock 策略

系统的既定前提:**除 OECD ICIO 之外,其余数据一律 mock**,但要尽可能模拟现实。

| 数据 | 性质 | 现状 |
|---|---|---|
| OECD ICIO 2016–2020 | ✅ 真实 | pymrio 下载的官方 CSV,所有指标由此计算 |
| 登录认证 | ✅ 真实实现 | PBKDF2 + HMAC 签名令牌(账号是演示账号) |
| 关税冲击面板 | 🎭 拟真 mock | 按 2018–2020 真实事件逐条编码(232 钢铝、301 四批清单、各方反制、空客案),税率量级参考 PIIE/Bown,出口暴露度由 OECD ICIO 双边流向计算 |
| 制裁清单 | 🎭 拟真 mock | OFAC SDN/二级制裁风格实体事件(RUSAL、俄罗斯能源金融限制、涉疆实体),聚合为 `sanction_shock` |
| 出口管制清单 | 🎭 拟真 mock | BIS 实体清单风格事件(华为、SMIC),聚合为 `export_control_shock` |
| 宏观控制变量 | 🔁 ICIO 派生 + 🎭 拟真 mock | 从已算指标派生国家-年份控制变量;另有 WDI/IMF 风格模拟宏观控制(GDP、人口、人均收入、汇率变动、FDI 流入) |
| 平减指数 / 汇率 | 🎭 拟真 mock | GDP 平减指数与通胀率支持实际值口径;汇率变动率在模拟宏观控制中提供 |
| HS↔ICIO 行业映射表 | 🎭 拟真 mock | HS 2 位章→ICIO 商品相关行业一对多权重映射,步骤2 演示 301 清单如何折算到行业平均税率 |

Mock 的质量标准(schema 对齐真实来源、量级锚定公开统计、维度全覆盖、时间线完整、
诚实标注、过质检)与逐项落地计划见 [`开发计划.md`](./开发计划.md) 第二节。
每个 mock 的 loader 接口就是将来真实数据的接入点:例如接入真实 PIIE 面板时,
只需让 `shocks.load_shocks()` 返回同结构的 `country×industry×year` 面板。
回归教学场景不重写底层冲击 CSV:步骤13–16 在估计样本层确定性注入
`noisy` 测量误差或 `confounded` 前趋势混杂,用于课堂演示稳健性检验为何必要。

## 方法论说明(诚实告知)

- 贸易流分解采用 Borin-Mancini (2019) source-based 出口国视角:毛出口闭合到
  客户资料字段 DVAex、DVArt、DDC、FVA、FDC、taxsub,并派生 EXDVA。
  当前输出国家级与国家–行业级聚合结果,不输出 exporter-importer-sector 双边矩阵明细。
- 生产分解采用 Wang-Wei-Yu-Zhu (2017) 四类生产活动口径:纯国内、传统贸易、
  简单 GVC、复杂 GVC;四段加总恒等于 GDP,由单元测试保证。
- 长度分解保留 Antràs-Chor 上游度口径(距最终需求的平均生产阶段数),
  输出客户资料字段 PLv、PLv_D、PLv_RT、PLv_GVC、PLy、PLy_D、PLy_RT、
  PLy_GVC、Pos_TPL、GVCPs。当前数据库固定为 OECD ICIO 2016–2020,
  不切换到客户样例的 1995–2018 数据库。
- 回归的 p 值使用聚类数对应的 t(G−1) 小样本校正;DID 页面可随机指派
  伪处理组生成安慰剂系数分布,并保持原始首次处理年份(cohort)分布。
  冲击变量是演示数据,所有回归结果**只用于验证系统链路,不构成研究结论**。

主要参考文献(实现口径的学术出处):

- Borin & Mancini (2019), *Measuring What Matters in Global Value Chains and
  Value-Added Trade*, World Bank PRWP —— 步骤4 贸易流精确分解(BM source-based)。
- Koopman, Wang & Wei (2014), *Tracing Value-Added and Double Counting in Gross
  Exports*, AER —— 步骤4 贸易流分解的经典基准。
- Wang, Wei, Yu & Zhu (2017), *Measures of Participation in Global Value
  Chains and Global Business Cycles*, NBER WP 23222 —— 步骤5 生产分解(WWYZ)。
- Antràs, Chor, Fally & Hillberry (2012), *Measuring the Upstreamness of
  Production and Trade Flows*, AER P&P;Antràs & Chor (2018) —— 步骤6 上游度/长度。
- Bown (2021) 与 PIIE 中美关税追踪 —— 步骤2 拟真冲击面板的税率量级与时间线原型。

## 开发完成状态与后续增强项

M1-M4 feature 已全部合并到主开发线,仍坚持不超出既有 17 步、"除 ICIO 外全部 mock"
的前提。逐项验收记录见 [`开发计划.md`](./开发计划.md):

1. **M1 数据层补全**:出口暴露度已改由 ICIO 真实双边流向计算;关税/制裁/
   出口管制三类 mock、冲击面板质检、HS↔ICIO 映射工作流演示均已接入。
2. **M2 指标与可视化深化**:网络图交互升级与国家–行业级下钻已完成;
   贸易流分解升级为 Borin-Mancini 精确公式。
3. **M3 回归层补全**:三类冲击、WDI/IMF 风格宏观控制 mock、GDP 平减指数、
   名义/实际口径切换、冲击×基期 GVC 参与度交互项已接入回归设计;
   clean/noisy/confounded 三套教学场景、t(G−1) 小样本推断与 DID 安慰剂检验已接入。
4. **M4 闭环与工程**:报告参数化、前端打印/PDF 导出、API Bearer 鉴权与 CI 已完成。

合并后剩余的按需增强项:

- 方法扩展:可选补充 Antràs-Chor 下游度、wild cluster bootstrap 等教学增强。
- 真实外部数据接入:保持为本计划外事项;现有 mock loader 是未来替换点。

明确不做:移动端/窄屏适配。前端按桌面端三栏教学布局维护,建议在宽屏浏览器中使用。

## 开发常用命令

```bash
uv run pytest -q                          # 全部测试
uv run gvcsim compute --years 2018        # 只重算某一年
uv run uvicorn gvcsim.api:app --reload    # 带热重载起 API
cd frontend && bun run build              # 前端类型检查 + 构建
```

GitHub Actions 已配置 `.github/workflows/ci.yml`,推送或 PR 时运行
`uv run pytest -q` 与 `bun run build`。

## 部署

已部署到示例服务器,过程与运维命令(nginx + systemd + rsync 同步)记录在
[`DEPLOY_101.201.151.30.md`](./DEPLOY_101.201.151.30.md)。该文档按当前服务器
固定写死路径/端口/IP,更新部署时照其中的 rsync + `systemctl restart` 步骤即可
(注意:同步命令必须排除服务器运行时的 `.venv311/`;若指标/面板口径或数据源变化,
需先重跑 `uv run gvcsim compute` 并同步新的 `data/processed/`)。
