# 步骤 2–5 指标说明 PDF

本目录保存课程 PDF 的可审阅 HTML 源文件。内容依据委托方提供的 DOCX、指标表和论文整理，并按当前项目的 OECD ICIO 2023 edition、2016–2020 数据契约校订。

对应关系：

- `trade.html`：步骤 2，总贸易流分解；
- `production.html`：步骤 3，GVC 生产分解；
- `length.html`：步骤 4，生产长度与位置；
- `network.html`：步骤 5，全球生产网络。

运行 `scripts/build_indicator_readings.sh` 使用本机 Chromium 生成四份课程说明 PDF，再由 qpdf/jq 固定易变的时间戳与 document ID，保证相同源文件得到逐字节一致的 PDF。脚本同时使用 `pdftotext` 检查页数、关键文字，并检查课程说明和四份委托方原始说明转换件是否残留错误的 Word/MathType 公式编号。

委托方提供的原始 DOCX 转换件和论文 PDF 同时放在 `frontend/public/readings/`，供课程页面直接预览。四张历史 CSV/XLSX 指标表也按原格式提供下载；它们仅供复现与历史对照，不替换当前 OECD ICIO 2023 数据。
