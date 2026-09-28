# 学生实验手册维护说明

- 成品：[实验手册.pdf](../../实验手册.pdf)，学生操作版 1.8，A4，28 页，18 张实际操作截图。
- 可编辑正文：[实验手册.md](../../实验手册.md)，`<!-- page -->` 为显式分页点。
- 截图：[screenshots](screenshots/)，由 agent-browser 从独立示例课堂取得。
- 来源记录：[screenshots.json](screenshots.json)，包含代码、数据版本、截图尺寸及 SHA-256。
- 排版与导出脚本位于 `frontend/scripts/`，使用已有前端依赖，不修改业务页面。

学生登录后，可通过左侧“课程大纲”下方的“实验手册 PDF”入口在新标签页阅读、下载或打印。前端直接引用仓库根目录的 PDF，Vite 会将它作为带内容指纹的静态资源打入生产和演示构建。构建环境需要保留这份源 PDF；更新手册后重新构建前端即可发布新版本。

## 重新生成

需要 Bun、前端锁定依赖、agent-browser／Chrome，以及中文字体（本次制作使用 Noto Sans CJK SC）。从仓库根目录执行：

```bash
bun install --cwd frontend --frozen-lockfile
bun run frontend/scripts/build-student-manual.ts
```

另开终端，仅提供生成文档所在目录：

```bash
python3 -m http.server 4191 --bind 127.0.0.1 \
  --directory dogfood-output/student-manual/render
```

回到仓库根目录导出：

```bash
bun run frontend/scripts/export-student-manual.ts \
  'http://127.0.0.1:4191/实验手册.html'
```

导出器使用 agent-browser 建立文档会话，并在同一会话中执行明确指定 CSS 页面尺寸的 PDF 打印命令。这样保留 A4、背景、文字标签及书签，不使用 CLI 通用 PDF 命令的默认 Letter 纸张。

## 更新时核对

1. 在独立 PostgreSQL 实例和数据副本中验证实际学生流程，再用 agent-browser 截图。若使用 `agent_browser_full_journey.sh`，须明确记录它通过公开 API 预填学习记录、再由浏览器完成报告和教师流程，不能称为纯 UI 旅程。截图只使用独立测试账号，不包含密码、真实学生信息或后台凭证。
2. 同步正文中的按钮名、条件、截图说明和数据口径；不要以新说明解释不匹配的旧截图。
3. 若增减页面，更新正文导航表页码和本说明中的总页数。
4. 更新截图清单，核对 PDF 中的分页、字体、图像、正文和报告状态。顶层 `baseline_commit`、`code_state`、`data_release` 记录共同来源；逐图记录文件 SHA-256 与 `data_sources`。工作区有未提交修改时，必须在 `code_state` 中说明，不能声称截图只对应该提交。
5. 文档截图中的报告评分仅用于说明流程；它不构成正式评分标准。

可用以下工具复核导出文件：

```bash
pdfinfo 实验手册.pdf
pdffonts 实验手册.pdf
qpdf --check 实验手册.pdf
pdftotext -layout 实验手册.pdf /tmp/gvcsim-student-manual.txt
```

## 1.8 版更新（2026-09-28）

同步 `step10-tariff-teaching-v2` 的 0%、0%、10%、10%、10% 税率路径和四项结果示例；明确生产指标本次区间没有覆盖预设值，不能为覆盖真值而挑选结果。刷新步骤 10、贸易回归、写作和报告四张图，其余 14 张保留原始来源。新图来自独立本地 v2 release `cd50de1bfe9945d6b5280d73bad1640d` 和合成学生账号：公开 API 准备学习记录，随后用 agent-browser 验证界面、重新生成报告并截图，不是纯 UI 旅程。代码为逐图记录的基线加未提交 v2 修改；逐图指纹与版本覆盖顶层历史默认值。

## 1.7 版更新（2026-09-24）

补充标称 95% 近似聚类区间的有限样本限制和极小 p 值读法。图 14 使用 `d53966987ec484f65e71367cffac282599bff308` 加本轮未提交的统计教学修复，经 agent-browser 从已有完整课程记录的独立测试学生重新截图；不是从新账号开始的完整旅程。其余 17 张保留逐图原始来源。

## 1.6 版更新（2026-09-24）

同步模拟 Y 的解释、生成样本与回归样本的区分，以及 2020 年现价／疫情期外推说明。图 9、12、14 使用 `0d8759e` 加本轮未提交修复重新截图，其余 15 张保留原有来源。新截图来自独立临时课堂数据库：公开 API 准备学习记录，再经 agent-browser 验证和截图，不能称为纯 UI 旅程。逐图代码基线及哈希覆盖顶层旧基线，见 `screenshots.json`。

## 1.5 版截图基线

2026-09-22 的 1.5 版统一重拍正文全部 18 张图，浏览器视口为 1280×960；其中材料缺项、已提交和已评分三图只截取状态组件，便于在纸上阅读，其余为完整视口。业务代码基线为 [5312bd0](https://github.com/YUxiangLuo/oecd/commit/5312bd0733cd5ee6f4b8051c2e979d4f7c8f8f02)，采集期间只修改文档，未修改业务代码。使用独立本地课堂和 OECD ICIO release `40c6a5d0d5d94084961a2dca04b9b260`；步骤 10–14 的 X/Y 仍为教学模拟。

主要步骤、报告正文及 93 分评阅图来自已完成 15 步纯浏览器旅程的独立账号；材料缺项、写作和待评阅状态另用辅助账号准备，部分记录通过公开 API 填入。不能将全部截图统称为纯 UI 旅程。每图的来源类别、哈希和数据边界见 `screenshots.json`；旧版未引用图片不再列入当前来源清单，历史说明可查 Git 历史。

完整后端测试另用该隔离实例中的第二个数据库及单独数据副本。`tests/conftest.py` 会重置 schema；不能只设置 `GVCSIM_PG_DSN_TEST`，必须确认测试进程实际使用的 `GVCSIM_PG_DSN` 不指向课堂库或浏览器流程库。
