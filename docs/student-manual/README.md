# 学生实验手册维护说明

- 成品：[实验手册.pdf](../../实验手册.pdf)，A4，28 页，24 张实际操作截图。
- 可编辑正文：[实验手册.md](../../实验手册.md)，`<!-- page -->` 为显式分页点。
- 截图：[screenshots](screenshots/)，由 agent-browser 从独立示例课堂取得。
- 来源记录：[screenshots.json](screenshots.json)，包含代码、数据版本、截图尺寸及 SHA-256。
- 排版与导出脚本位于 `frontend/scripts/`，使用已有前端依赖，不修改业务页面。

学生登录后，可通过左侧“课程大纲”下方的“实验手册 PDF”入口在新标签页阅读、下载或打印。前端直接引用仓库根目录的 PDF，Vite 会将它作为带内容指纹的静态资源打入生产和演示构建。构建环境需要保留这份源 PDF；更新手册后重新构建前端即可发布新版本。

## 重新生成

需要 Bun、前端锁定依赖、agent-browser／Chrome，以及中文字体（制作环境使用思源黑体 CN）。从仓库根目录执行：

```bash
bun install --cwd frontend --frozen-lockfile
bun run frontend/scripts/build-student-manual.ts
```

另开终端，仅提供生成文档所在目录：

```bash
python3 -m http.server 4191 --bind 127.0.0.1 \
  --directory dogfood-output/student-manual-20260907/render
```

回到仓库根目录导出：

```bash
bun run frontend/scripts/export-student-manual.ts \
  'http://127.0.0.1:4191/实验手册.html'
```

导出器使用 agent-browser 建立文档会话，并在同一会话中执行明确指定 CSS 页面尺寸的 PDF 打印命令。这样保留 A4、背景、文字标签及书签，不使用 CLI 通用 PDF 命令的默认 Letter 纸张。

## 更新时核对

1. 实际打开对应页面操作，再用 agent-browser 截图。截图中只使用示例账号，不包含密码、真实学生信息或后台凭证。
2. 同步正文中的按钮名、条件、截图说明和数据口径；不要以新说明解释不匹配的旧截图。
3. 若增减页面，更新正文导航表页码和本说明中的总页数。
4. 更新截图清单，核对 PDF 中的分页、字体、图像、正文和报告状态。
5. 文档截图中的报告评分仅用于说明流程；它不构成正式评分标准。

可用以下工具复核导出文件：

```bash
pdfinfo 实验手册.pdf
pdffonts 实验手册.pdf
qpdf --check 实验手册.pdf
pdftotext -layout 实验手册.pdf /tmp/gvcsim-student-manual.txt
```

本次制作已通过学生 15 步、报告提交和示例教师评阅，当前四类关税基准均保留 `invalid_design` 诊断。截图为整个页面或由浏览器直接截取的操作区，业务画面未经替换。
