# 步骤 2–5 指标说明与文献

步骤 2–5 在主要操作之后提供默认展开、可收起的“指标说明与相关文档”，可在页内预览 PDF，也可在新标签页打开；预览空白或加载失败时仍保留打开入口。

本组资料解释真实 ICIO 派生指标，不是步骤 10–14 的模拟数据规格。v12 没有改变步骤 2–5 的定义或算法，因此这四份课程说明 PDF 与原始文献不因回归换版而重写。模拟位置指数现也遵循前向长度／后向长度定义，但其数值来自模拟长度，不是本组资料中的真实观测；参见[技术手册](../../技术手册.md)。

| 步骤 | 课程说明源文件 | 同组资料 |
| --- | --- | --- |
| 2 总贸易流分解 | `trade.html` | 原始方法说明、WWZ 论文（英文、中文） |
| 3 生产分解 | `production.html` | 原始方法说明、Wang 等 GVC 参与度论文 |
| 4 生产长度与位置 | `length.html` | 原始方法说明、Wang 等生产长度论文 |
| 5 全球生产网络 | `network.html` | 原始方法说明、Brandes 介数论文、网络应用论文 |

- 课程说明按当前 OECD ICIO 2023 版 2016–2020 数据与代码口径校订；原始资料中的历史年份不代表本系统的数据范围。
- 全部 PDF 位于 `frontend/public/readings/`，元数据（标题、顺序、说明）在 `frontend/src/labs/steps/indicator/indicator-reading-library.tsx` 的 `INDICATOR_READINGS`。
- `scripts/build_indicator_readings.sh` 用本机 Chromium 从本目录 HTML 生成四份课程说明 PDF，并用 qpdf/jq 固定时间戳与 document ID，使相同源文件得到逐字节一致的 PDF；随后用 `pdftotext` 检查页数、关键文字，以及课程说明和原始说明转换件中是否残留错误的 Word/MathType 公式编号。
