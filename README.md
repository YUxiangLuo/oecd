# 供应链仿真系统(GVC Simulation Lab)

基于全球投入产出数据库(OECD ICIO)计算并可视化全球价值链(GVC)指标,结合贸易政策
冲击数据做实证回归,自动生成实验报告 —— 形成 **数据 → 指标 → 回归 → 报告** 的完整闭环。

需求与 17 步方案详见 [`供应链仿真系统_完整项目说明.md`](./供应链仿真系统_完整项目说明.md);
交互界面的完整设计原型见 [`prototype/`](./prototype/)(浏览器直接打开
`供应链仿真教学系统.dc.html` 即可预览)。

本仓库是该系统的**开发起点**:后端指标引擎、API、回归框架、报告生成与一个最小可用
前端均已跑通真实数据(OECD ICIO 2016–2020,77 国 × 45 行业)。

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

不起前端也能用 CLI 走完全流程:

```bash
uv run gvcsim validate --year 2018    # 步骤3:数据质检
uv run gvcsim regress --step 13       # 步骤13-16:演示回归(默认国家–行业级)
uv run gvcsim regress --step 13 --granularity country   # 国家级粒度
uv run gvcsim report --year 2020      # 步骤17:生成 reports/experiment_report_2020.md
uv run pytest                         # 测试(30 个,含 API 集成测试)
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
│   │   ├── tradeflow.py          #   步骤4:贸易流分解(DVA/FVA、前向/后向参与度)
│   │   ├── production.py         #   步骤5:生产分解(纯国内/传统贸易/简单/复杂GVC,国家+行业双粒度)
│   │   ├── length.py             #   步骤6:长度分解(上游度及国内/跨境段)
│   │   └── network.py            #   步骤7:生产网络中心性(度/介数/特征向量,国家+行业双粒度)
│   ├── regression/
│   │   ├── design.py             #   步骤12:回归设计(粒度/冲击/方法 → 面板/个体/聚类/方程)
│   │   └── panel.py              #   步骤13-16:双向固定效应 + 聚类稳健标准误(纯numpy)
│   ├── report.py                 #   步骤17:自动生成 Markdown 实验报告
│   ├── pipeline.py               #   预计算流水线:原始表 → 质检 → 指标 → 面板
│   ├── steps.py                  #   17 步元数据(与原型一致,前端渲染用)
│   ├── api.py                    #   FastAPI:面板/质检/可视化/回归/报告全部接口
│   └── cli.py                    #   gvcsim 命令行入口
├── frontend/                     # React + Vite + TS 最小前端(bun)
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
                              └─ pipeline.build_panel() → panel_sector.csv(行业级,回归默认)
                                                          panel_country.csv(冲击按出口额加权聚合)
                                                              │
              FastAPI(gvcsim/api.py,只读预计算产物)◀──────┘
                    │                         │
          frontend/(17步教学界面)    regression / report(按需在请求内运行)
```

设计要点:

- **重计算离线化**:解析 66MB 大表与矩阵求逆只在 `compute` 时发生一次,API 只读
  CSV/JSON 产物,毫秒级响应。
- **指标全部向量化**:`IcioArrays` 一次性把 IO 系统切成 numpy 块(全球逆矩阵 B、
  各国国内逆 L_rr、出口向量等),77×77 国家对的前向参与度矩阵一次算完,
  每年全套指标约 1 分钟。
- **回归引擎零依赖**:双向固定效应用迭代去均值 + OLS + 聚类 sandwich 标准误,
  纯 numpy 实现,便于教学展示;将来可无缝换成 `linearmodels.PanelOLS`(接口已隔离)。
- **回归默认国家–行业级**:个体 = 国家×行业(~3,465 个),固定效应吸收行业异质性,
  标准误按国家聚类(同国各行业共享政策冲击,残差组内相关);国家级粒度仍可选。
- **冲击数据拟真 mock**:按 2018–2020 真实事件逐条编码(232 钢铝、301 四批清单、
  各方反制、空客案),税率量级参考 PIIE/Bown 统计,再乘以风格化的出口暴露度
  (流向加征方的出口份额),覆盖全部 77 经济体 × 45 行业。
- **可测性**:指标模块吃 `IcioArrays` 而非 pymrio 对象,单元测试用手工构造的
  2 国 × 2 行业小系统验证数学恒等式(分解加总=GDP、封闭经济跨境项=0、v′B=1 等)。

## 17 步实现状态

| 阶段 | 步骤 | 状态 |
|---|---|---|
| 一、数据接入 | 1 数据库选型 | ✅ OECD ICIO,pymrio 下载解析已验证 |
| | 2 政策冲击数据 | 🟡 拟真演示面板(全经济体×行业异质,事件级编码);待接 PIIE/WTO/GTA |
| | 3 数据质检 | ✅ 5 项结构化检查,CLI/API 共用 |
| 二、指标计算 | 4 贸易流分解 | ✅ 简化版 KWW(见下方方法论说明),国家+行业双粒度 |
| | 5 生产分解 | ✅ 简化版 WWYZ 四段分解,恒等式经测试验证,国家+行业双粒度 |
| | 6 长度分解 | ✅ Antras-Chor 上游度 + 国内/跨境段拆分,国家+行业双粒度 |
| | 7 网络指标 | ✅ 度/介数/特征向量中心性,国家+行业双粒度(行业级介数为抽样近似) |
| 三、可视化 | 8–11 | 🟡 最小版(排序数据表);富图表(网络图/堆叠条形图)按原型逐步实现 |
| 四、回归 | 12 设计确认 | ✅ 设计选项 → 面板/个体/聚类/方程;支持国家级与国家–行业级双粒度 |
| | 13–16 四组回归 | 🟡 默认国家–行业级(个体FE+按国聚类SE),端到端链路已通,基于演示冲击数据 |
| 五、闭环 | 17 实验报告 | 🟡 Markdown 报告自动生成(回归为行业级);PDF 导出待做 |

## 方法论说明(诚实告知)

- 贸易流分解沿用原型阶段验证过的**简化版**方法:忽略增加值"出国转一圈又回来"的往返项,
  不是完整的 Koopman-Wang-Wei (2014) 分解。国家排序与数量级可靠
  (2018 年结果:卢森堡/斯洛伐克/越南后向参与度最高,文莱/俄罗斯/沙特前向最高,
  哈萨克斯坦/新加坡/中国上游度最高,与文献和项目说明 1.5 节一致),
  论文级精度需替换为 KWW / Borin-Mancini 完整分解。
- 生产分解为 Wang-Wei-Yu-Zhu (2017) 框架的简化实现,"复杂 GVC"取余项;
  四段加总恒等于 GDP,由单元测试保证。
- 回归的 p 值用正态近似(国家数 77 足够大);冲击变量是演示数据,
  所有回归结果**只用于验证系统链路,不构成研究结论**。

## 路线图(建议的下一步)

1. **接入真实冲击数据**(步骤2 转正):用官方 PIIE 关税面板 + 官方 HS↔ISIC/ICIO
   行业映射表替换当前手工编码的拟真事件表(`shocks.py` 的 loader 返回同结构
   country×sector×year 面板即可)—— 项目说明文档 4.2 节明确指出行业映射是最容易
   被低估工作量的一环。
2. **宏观控制变量与平减指数**:World Bank WDI / CEPII / IMF IFS,按国家-年份 merge 进面板。
3. **富可视化**(步骤8-11 对齐原型):交互式网络图、堆叠条形图、中心性热力表。
4. **DID / 事件研究**:利用冲击数据自带的宣布/生效时间线,替换当前的双向固定效应演示。
5. **报告导出 PDF**(pandoc 或前端打印样式)。

## 开发常用命令

```bash
uv run pytest -q                          # 全部测试
uv run gvcsim compute --years 2018        # 只重算某一年
uv run uvicorn gvcsim.api:app --reload    # 带热重载起 API
cd frontend && bun run build              # 前端类型检查 + 构建
```
