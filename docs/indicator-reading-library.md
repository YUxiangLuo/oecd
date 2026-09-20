# 步骤 2–5 指标文献组件

课程页面在各步主要操作之后提供一个默认折叠的“延伸阅读 · 指标相关文章”区域。展开后可在当前页面预览 PDF，也可在新标签页打开。

当前 `frontend/public/readings/` 已包含委托方提供材料及据其校订的课程说明：

1. 每步第一份 PDF 是按当前 OECD ICIO 2023 edition 数据与代码口径校订的课程说明；
2. 委托方 DOCX 已转换为 PDF，并与其提供的论文一起保留在同一步骤中；
3. 委托方提供的四张历史指标表按原格式提供下载，并明确标注为历史对照资料，不替换当前课程数据；
4. HTML 源文件位于 `docs/indicator-readings/`，运行 `scripts/build_indicator_readings.sh` 可确定性重建四份课程说明并检查四份原始说明转换件；
5. `frontend/src/labs/steps/indicator/indicator-reading-library.tsx` 的 `INDICATOR_READINGS` 和 `INDICATOR_DATA_ATTACHMENTS` 维护资料元数据；
6. 阅读材料仍是可选项，不影响步骤完成。

组件始终提供“新标签页打开 PDF”，并在内嵌预览下显示恢复提示；不支持浏览器内嵌 PDF、预览空白或文件加载失败时，学生仍有明确的打开和求助路径。

当前步骤 2 与步骤 5 各提供四份 PDF，步骤 3 与步骤 4 各提供三份 PDF。
