# 供应链仿真系统(GVC Simulation Lab)

基于全球投入产出数据库(OECD ICIO)计算并可视化全球价值链(GVC)指标,结合贸易政策
冲击数据做实证回归,自动生成实验报告 —— 形成 **数据 → 指标 → 回归 → 报告** 的完整闭环。

需求与 17 步方案详见 [`供应链仿真系统_完整项目说明.md`](./供应链仿真系统_完整项目说明.md);
交互界面的完整设计原型见 [`prototype/`](./prototype/)(浏览器直接打开
`供应链仿真教学系统.dc.html` 即可预览)。

本仓库是该系统的**开发起点**:后端指标引擎、API、回归框架、报告生成与 17 步教学
前端(步骤8-16 已达原型设计形态)均已跑通真实数据(OECD ICIO 2016–2020,77 国 × 45 行业)。

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
`POST /api/auth/login` / `GET /api/auth/me`);数据接口暂不强制鉴权,
真实部署时用 `auth.verify_token` 加 Bearer 依赖即可。

不起前端也能用 CLI 走完全流程:

```bash
uv run gvcsim validate --year 2018    # 步骤3:数据质检
uv run gvcsim regress --step 13       # 步骤13-16:演示回归(默认国家–行业级 + DID)
uv run gvcsim regress --step 14 --method event          # 事件研究(动态效应+前趋势)
uv run gvcsim regress --step 13 --method fe             # 双向固定效应(强度法)
uv run gvcsim regress --step 13 --controls              # 加入 ICIO 派生国家-年份控制变量
uv run gvcsim regress --step 13 --granularity country   # 国家级粒度
uv run gvcsim report --year 2020      # 步骤17:生成 reports/experiment_report_2020.md
uv run pytest                         # 测试(57 个,含 API 集成测试)
```

## 目录结构

```
├── gvcsim/                       # 后端包
│   ├── config.py                 #   路径与年份配置
│   ├── data/
│   │   ├── loader.py             #   步骤1:pymrio 下载/解析 OECD ICIO
│   │   └── quality.py            #   步骤3:结构化质检(维度/缺失值/会计恒等式/矩阵性质)
│   ├── shocks.py                 #   步骤2:政策冲击数据接入(拟真演示面板:全经济体、行业异质)
│   ├── indicators/
│   │   ├── core.py               #   共享底座:IcioArrays(向量化的矩阵切块)
│   │   ├── tradeflow.py          #   步骤4:KWW 风格贸易流分解(DVA/RDV/DDC/FVA/FDC/PDC)
│   │   ├── production.py         #   步骤5:WWYZ 生产分解(纯国内/传统贸易/简单/复杂GVC)
│   │   ├── length.py             #   步骤6:长度分解(上游度及国内/跨境段)
│   │   └── network.py            #   步骤7:生产网络中心性(度/介数/特征向量,国家+行业双粒度)
│   ├── regression/
│   │   ├── design.py             #   步骤12:回归设计(粒度/冲击/方法 → 面板/个体/聚类/方程)
│   │   └── panel.py              #   步骤13-16:DID / 事件研究 / 双向FE + 聚类稳健标准误 + PanelOLS 对照
│   ├── report.py                 #   步骤17:自动生成 Markdown 实验报告
│   ├── pipeline.py               #   预计算流水线:原始表 → 质检 → 指标 → 面板
│   ├── steps.py                  #   17 步元数据(与原型一致,前端渲染用)
│   ├── auth.py                   #   登录认证(演示账号,PBKDF2 + HMAC 签名令牌)
│   ├── api.py                    #   FastAPI:认证/面板/质检/冲击/可视化/回归/报告全部接口(CSV 按 mtime 缓存)
│   └── cli.py                    #   gvcsim 命令行入口
├── frontend/                     # React + Vite + TS 前端(bun);login.tsx 登录页、
│                                 #   intro.tsx 登录后交互式系统介绍、viz.tsx 步骤8-11
│                                 #   富可视化 + 事件研究/森林系数图(纯 SVG,零图表库依赖)、
│                                 #   teach.tsx + regteach.ts + regression.tsx 步骤12-16
│                                 #   讲解卡片体系与回归实验台(设计确认 + 运行 + 结果动态解读)
├── tests/                        # 合成小矩阵验证指标数学性质;回归系数恢复;API 集成
├── prototype/                    # 完整 UI 设计原型(最终形态参考,勿改)
├── data/processed/               # 预计算产物(gitignore;由 gvcsim compute 生成)
├── data/shocks/                  # 冲击数据(自动生成的拟真演示面板,country×sector×year)
├── reports/                      # 自动生成的实验报告(gitignore)
├── OECD_ICIO/                    # 原始数据(gitignore)
└── download_icio.py / validate_icio.py / gvc_indicators.py
                                  # 原型阶段的验证脚本(已被 gvcsim 包取代,保留作参照)
```

## 架构与数据流

```
OECD_ICIO/*.csv ──pymrio──▶ pipeline.compute_year()
                              ├─ quality.run_all()      → data/processed/qc_<year>.json
                              ├─ tradeflow / production
                              │  length / network       → indicators_{country,sector}_<year>.csv
                              │                           network_edges_<year>.csv
                              └─ pipeline.build_panel() → controls_country.csv(ICIO 派生控制变量)
                                                          panel_sector.csv(行业级,回归默认)
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
  各国国内逆 L_rr、出口向量、最终吸收份额等),KWW/WWYZ 聚合分解与网络指标
  都在离线 `compute` 阶段完成。
- **回归引擎双轨校验**:教学主引擎使用迭代去均值 + OLS + 聚类 sandwich 标准误
  的透明 numpy 实现;同时用 `linearmodels.PanelOLS` 对政策系数做标准库对照。
- **稳健性控制变量**:从现有 ICIO 指标派生国家-年份控制变量(增加值规模/增长、
  出口规模/增长、出口强度、制造业/服务业增加值份额),支持步骤12-17
  展示"基准模型 vs 加控制变量模型"。金额指数只表示相对基期变化,不是真实平减值。
- **回归默认国家–行业级**:个体 = 国家×行业(~3,465 个),固定效应吸收行业异质性,
  标准误按国家聚类(同国各行业共享政策冲击,残差组内相关);国家级粒度仍可选。
- **三种估计方法共用一个 within-OLS 核心**:默认 DID(处理组=曾受冲击个体,
  处理期=首个冲击年起,利用冲击数据自带的时间线识别因果);事件研究给出动态效应
  路径并以 k=-1 为基期做平行趋势检验;双向FE(强度法)保留连续冲击强度的用法。
- **冲击数据拟真 mock**:按 2018–2020 真实事件逐条编码(232 钢铝、301 四批清单、
  各方反制、空客案),税率量级参考 PIIE/Bown 统计,再乘以风格化的出口暴露度
  (流向加征方的出口份额),覆盖全部 77 经济体 × 45 行业。
- **可测性**:指标模块吃 `IcioArrays` 而非 pymrio 对象,单元测试用手工构造的
  2 国 × 2 行业与 3 国循环小系统验证数学恒等式(KWW 毛出口闭合、WWYZ 四段加总=GDP、
  封闭经济跨境项=0、v′B=1 等)。

## 17 步实现状态

| 阶段 | 步骤 | 状态 |
|---|---|---|
| 一、数据接入 | 1 数据库选型 | ✅ OECD ICIO,pymrio 下载解析已验证 |
| | 2 政策冲击数据 | 🟡 拟真演示面板(全经济体×行业异质,事件级编码),前端有事件时间线+面板浏览;待接 PIIE/WTO/GTA |
| | 3 数据质检 | ✅ 5 项结构化检查,CLI/API 共用 |
| 二、指标计算 | 4 贸易流分解 | ✅ KWW 风格聚合分解(DVA/RDV/DDC/FVA/FDC/PDC),国家+行业双粒度 |
| | 5 生产分解 | ✅ WWYZ 四段分解,恒等式经测试验证,国家+行业双粒度 |
| | 6 长度分解 | ✅ Antras-Chor 上游度 + 国内/跨境段拆分,国家+行业双粒度 |
| | 7 网络指标 | ✅ 度/介数/特征向量中心性,国家+行业双粒度(行业级介数为抽样近似) |
| 三、可视化 | 8–11 | ✅ 交互网络图(区域聚类+悬停高亮)/生产结构堆叠条/长度双段条/中心性热力表,均带表格视图与悬停 tooltip |
| 四、回归 | 12 设计确认 | ✅ 交互式设计台:粒度/冲击/方法/被解释变量选择卡 → 即时方程与面板/个体/聚类摘要(GET /api/regression/design) |
| | 13–16 四组回归 | 🟡 讲解卡片体系(概念/公式/陷阱/自检/小结)+ 模型设定卡 + 控制变量切换 + 系数表/森林图/事件研究图 + PanelOLS 对照 + 按结果自动生成的中文解读;默认 DID(个体FE+按国聚类SE),基于演示冲击数据 |
| 五、闭环 | 17 实验报告 | 🟡 Markdown 报告自动生成(回归为行业级,含基准/加控制并列表);PDF 导出待做 |

## 方法论说明(诚实告知)

- 贸易流分解已升级为 KWW 风格聚合口径:毛出口闭合到 DVA、返回国内增加值(RDV)、
  国内重复计算(DDC)、外国增加值(FVA)、外国重复计算(FDC)与纯重复计算(PDC),
  并派生前向/后向/总 GVC 参与度。当前输出国家级与国家–行业级聚合结果,
  不输出 exporter-importer-sector 双边矩阵明细。
  **注意仍是近似实现**:重复计算部分按买方节点"未来跨境期望"的启发式折算,
  最终吸收地用马尔可夫吸收链近似,并非 KWW/Borin-Mancini 的精确公式;
  五项加总=毛出口的闭合恒等式由单元测试保证,但论文级精度仍需替换为
  KWW (2014) / Borin-Mancini (2019) 完整分解。
- 生产分解采用 Wang-Wei-Yu-Zhu (2017) 四类生产活动口径:纯国内、传统贸易、
  简单 GVC、复杂 GVC;四段加总恒等于 GDP,由单元测试保证。
- 回归的 p 值用正态近似(国家数 77 足够大);冲击变量是演示数据,
  所有回归结果**只用于验证系统链路,不构成研究结论**。

## 路线图(建议的下一步)

1. **接入真实冲击数据**(步骤2 转正):用官方 PIIE 关税面板 + 官方 HS↔ISIC/ICIO
   行业映射表替换当前手工编码的拟真事件表(`shocks.py` 的 loader 返回同结构
   country×sector×year 面板即可)—— 项目说明文档 4.2 节明确指出行业映射是最容易
   被低估工作量的一环。
2. **宏观控制变量与平减指数**:World Bank WDI / CEPII / IMF IFS,按国家-年份 merge 进面板。
3. **报告导出 PDF**(pandoc 或前端打印样式)。

## 开发常用命令

```bash
uv run pytest -q                          # 全部测试
uv run gvcsim compute --years 2018        # 只重算某一年
uv run uvicorn gvcsim.api:app --reload    # 带热重载起 API
cd frontend && bun run build              # 前端类型检查 + 构建
```
