# 网络指标 golden fixture 生成器（真实 Gephi Toolkit）

本目录用**真实的 Gephi Toolkit 0.10.1** 重新生成并校验

```
tests/fixtures/gephi_0_10_1_directed_reference.csv
```

这份 CSV 是 `gvcsim/indicators/network.py` 全部 11 个网络指标字段的外部基准。
测试 `tests/test_indicators.py::test_all_network_fields_match_gephi_0_10_1_golden_export`
用它逐字段核对我们的实现。

## 为什么需要它

在此之前，fixture 只是一份提交进仓库的 CSV，没有任何脚本或文档记录它是怎么来的。
这带来一个隐患：如果基准是照着 `network.py` 自己算出来反填的，那“golden 测试”就是
**循环论证**——只能防止未来改坏，防不了一开始就理解错 Gephi 的语义。

本生成器消除这个隐患：它**只依赖 Gephi 官方 toolkit，不引用任何 gvcsim 代码**
（见 `pom.xml` 的唯一依赖 `org.gephi:gephi-toolkit`）。因此它是 `network.py` 的
**独立预言机（oracle）**，测试对齐的是 Gephi 的真实输出，而非我们实现自身。

当前 git 中的 fixture 已用本生成器验证为与真实 Gephi 输出**逐字节一致**：

```
sha256  4c8acefb6d82aa4d30cbf3fff3a490e8c241d18de13ddc2a0629756d9f8c9bb9
```

## 用法

前置：JDK 11+、Maven、可访问 Maven Central（首次运行会下载 toolkit 及 NetBeans 依赖，
约数十 MB，之后走本地 `~/.m2` 缓存）。

```bash
# 校验：生成到临时文件并与 git 中的 fixture diff，不改动工作区（CI/评审用）
scripts/gephi_golden/generate.sh --check

# 重新生成：直接写回 fixture（升级 toolkit 或有意更新基准时用）
scripts/gephi_golden/generate.sh
```

在最新 Arch Linux + OpenJDK 26 + Maven 3.9 上验证通过；toolkit 本身面向 Java 11，
无需为此单独安装旧 JDK。

## 参考图与计算口径

节点 A–E，6 条有向边（含权重），与 `test_indicators.py` 里的邻接矩阵**逐一对应**：

| 边 | 权重 |
|---|---|
| A→A（正自环） | 5 |
| A→B | 2 |
| B→C | 3 |
| C→A | 4 |
| A→D | 7 |
| B→D | 1 |

刻意覆盖：正自环、非对称边、不同边权、汇点 D（出度 0）、隔离点 E。

统计口径（与 fixture 文件名及 `network_algorithm` 契约一致——
`gephi-compatible-directed-unweighted-positive-v1`）：

| 指标 | Gephi 统计 | 配置 |
|---|---|---|
| degree / indegree / outdegree | `Degree` | 自环入出各计一次 |
| weighted degree / in / out | `WeightedDegree` | 用边权求和 |
| Eccentricity / closness / harmonic / betweenness | `GraphDistance` | `setDirected(true)`、`setNormalized(false)` |
| eigencentrality | `EigenvectorCentrality` | `setDirected(true)`、`setNumRuns(100)` |

要点：`GraphDistance` 的最短路是**无权 BFS**（`d = d + 1`，源码里不读边权），
所以边权只进入 weighted degree，距离/介数/接近度一律按跳数。CSV 里的列名
（含 `betweenesscentrality`、`closnesscentrality`、`harmonicclosnesscentrality`
这些拼写）就是 Gephi 内部列 ID 的原样。

## 在 Gephi 桌面版手工复现（无需 toolkit）

1. 新建工程，`Data Laboratory` 里按上表建 5 个节点、6 条**有向**边并填 `Weight`；
2. `Statistics` 面板依次运行 Average Degree、Avg. Weighted Degree、
   Network Diameter（勾选 Directed、**取消** Normalize）、Eigenvector Centrality
   （勾选 Directed、迭代数 100）；
3. `Data Laboratory` 导出节点表为 CSV。数值应与本 fixture 一致。

## 升级基准（换 toolkit 版本时）

1. 改 `pom.xml` 里的 `gephi.toolkit.version`；
2. 把 fixture 文件、`test_indicators.py` 与本文中的版本号/`sha256` 一并更新；
3. 跑 `generate.sh` 重新生成，再跑 `uv run pytest tests/test_indicators.py -q`
   确认 `network.py` 仍与新基准吻合（不吻合说明该版本 Gephi 改了语义，需评估）。
