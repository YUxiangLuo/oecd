# 教师端深度审查

审查日期：2026-10-15。基线：`cc` / `681162e`。范围覆盖理解题配置、学期与班级、学生与进度、报告评阅，以及教师鉴权、口令管理、批量导入、数据库事务、并发操作和异常恢复。

初次审查确认 **4 项 P2、2 项 P3**，本次二次确认全部成立，现已修复并补充永久回归测试。以下六项保留基线问题、行号与原始证据，修复实现和最终验证见文末“二次确认与修复验收”。

## TBACK01 并发创建或修改可以保存重复学号

**P2。** 学号查重与写入不是原子操作。[management.py](../gvcsim/classroom/management.py) 第 179–184 行先查询是否已有学号，随后第 211–226 行创建账号；修改路径第 328–335 行也采用先查后写。[schema.py](../gvcsim/classroom/schema.py) 第 27 行的 `student_no` 没有唯一约束。

两个教师同时提交不同用户名、相同非空学号时，两次检查都可能认为学号空闲，随后两次请求都成功。已分别复现两个单建请求、两个修改请求，以及单建与批量导入并发。另以**无 monkeypatch、无延时屏障的 FastAPI TestClient 并发请求**连续运行 10 轮，使用真实 PostgreSQL，20 个请求全部返回 200，10 个学号各对应两个账号；这组请求经过完整接口，但不经过独立服务器网络。

这破坏了“学号标识一个学生”的现有规则，名单、搜索和再次导入无法可靠区分学生；不同账号下的学习记录不会自动归并。没有发现因此直接取得其他学生登录权限。应在同一事务内原子保证唯一性，让单建、修改和批量导入采用同一套约束。

证据：[无插桩并发结果](../dogfood-output/teacher-review-20261015/backend/number-race-no-instrumentation.json)、[并发单建](../dogfood-output/teacher-review-20261015/backend/number-race-create.json)、[并发修改](../dogfood-output/teacher-review-20261015/backend/number-race-update.json)、[单建与批量导入](../dogfood-output/teacher-review-20261015/backend/number-race-batch-versus-create.json)。

## TBACK02 学号与用户名冲突检查可被大小写绕过

**P2。** 登录用户名会归一为小写，但跨字段查重直接按原字符串比较。[management.py](../gvcsim/classroom/management.py) 第 189–192 行比较学号与用户名，第 213–215 行反向检查，第 268–274 行用于批量预览和创建，均未遵循登录名的大小写规则。

已确认以下路径：

- 已有登录用户名 `student`，为另一个账号创建或修改学号 `STUDENT`，接口返回 200。真实浏览器创建也成功。
- 已有学生学号 `Roster.A`，再创建用户名 `Roster.A`，后端将用户名存为 `roster.a` 并成功创建。
- 批量导入上述学号时，预览返回 `existing=[]`，提交也成功。

系统明确禁止学号占用其他账号的用户名，并要求批量导入识别既有学生；大小写转换让这项约束失效。应在跨字段比较时使用统一的登录名归一化规则，覆盖单建、修改、预览和批量提交；不能只修改前端提示。

证据：[创建](../dogfood-output/teacher-review-20261015/backend/case-login-create.json)、[修改](../dogfood-output/teacher-review-20261015/backend/case-login-update.json)、[反向冲突](../dogfood-output/teacher-review-20261015/backend/case-number-single.json)、[批量预览](../dogfood-output/teacher-review-20261015/backend/case-number-batch-preview.json)、[批量提交](../dogfood-output/teacher-review-20261015/backend/case-number-batch-commit.json)、[浏览器创建的两个账号](../dogfood-output/teacher-review-20261015/browser/finding-student-case-conflict.json)。

## TSTUDENT01 列表刷新失败会丢失弹窗草稿和导入回执

**P2。** [students.tsx](../frontend/src/teacher/students.tsx) 第 358–362 行和 [semesters.tsx](../frontend/src/teacher/semesters.tsx) 第 54 行在列表请求失败时直接返回错误页，卸载全部业务弹窗。草稿、生成的导入预览和导入完成状态都在弹窗的局部状态中，因此被清空。

组件和生产构建浏览器均复现：

1. 学生列表刷新尚未完成时，打开“添加学生”并填写用户名、姓名。刷新失败后，弹窗无确认消失。点击重试，弹窗重新出现，但所有字段为空。
2. 学生页或学期页批量创建成功后，自动刷新的列表请求失败。已添加学生的成功回执和“再次下载账号清单”入口消失；重试列表恢复后，弹窗回到空白名单。

组件测试另外覆盖学期数据刷新失败时丢失批量预览。账号实际已创建，创建前强制下载的账号清单仍然存在，**不是全部密码永久丢失**；问题是草稿未经确认丢失，以及导入成功后的界面误导老师从空白名单重新开始。

应让列表错误与业务弹窗独立呈现，或将草稿、预览和完成回执提升到不会被刷新错误卸载的位置。

证据：[组件复现与正常对照](../dogfood-output/teacher-review-20261015/students/recovery-repro.log)、[三个真实浏览器复现](../dogfood-output/teacher-review-20261015/browser/finding-student-dialog-loss.json)、[丢失草稿截图](../dogfood-output/teacher-review-20261015/browser/finding-student-draft-disappeared.png)、[批量导入回执消失截图](../dogfood-output/teacher-review-20261015/browser/finding-import-receipt-fault-import-student.png)。

## TREPORT01 冲突报告重载期间丢失未保存评阅保护

**P2。** [reports.tsx](../frontend/src/teacher/reports.tsx) 第 271–281 行在重载或失败时卸载 `GradeView`，第 350–353 行的清理函数随之清除全局离开保护。父组件仍持有未保存草稿，却没有继续保护它；错误页第 276 行的返回按钮也直接离开。

实际操作：输入 91 分和评语，另一窗口先保存评分，使本页保存收到真实 409；点击“载入最新报告”，让请求挂起或失败。此时点击“学生与进度”不再弹出离开确认，`beforeunload` 保护也失效。重新打开报告时只剩服务器已保存的评分和评语，原来的 91 分与本地评语丢失。

挂起和失败两种状态均有组件失败用例及真实浏览器复现。对照确认：普通编辑时离开会提示；重载成功会保留草稿，并明确展示另一处已保存的评阅，允许主动采用。问题限定于重载中和重载失败后的保护空档。

应由持有草稿的父组件持续负责离开保护，错误页返回和侧栏跳转遵循相同规则。

证据：[组件验收](../dogfood-output/teacher-review-20261015/reports/independent.log)、[组件直接丢失记录](../dogfood-output/teacher-review-20261015/reports/guard-loss-observed.json)、[真实 409 后的浏览器复现](../dogfood-output/teacher-review-20261015/browser/finding-report-draft-loss.json)、[重载失败截图](../dogfood-output/teacher-review-20261015/browser/finding-report-reload-failed.png)。

## TBACK03 非法题库文本返回服务器错误

**P3。** [quizzes.py](../gvcsim/quizzes.py) 第 514–519 行只检查文本类型、长度和空白，未拒绝 NUL 或未配对 Unicode surrogate，随后 [quiz_config.py](../gvcsim/classroom/quiz_config.py) 第 64–65 行写入 JSONB 失败。

在有效版本的题干或选项中放入 U+0000 或 U+D800，四种协议输入均使 `PUT /api/classroom/quizzes/1` 返回 500，而不是明确的 422 输入错误。浏览器通过输入事件注入 NUL 后保存也复现通用服务错误。事务正确回滚，题库和版本均保持不变。应在输入校验阶段定位非法字段并拒绝；未配对 surrogate 属于协议边界，不声称普通键盘可以直接输入。

证据：[题干 NUL](../dogfood-output/teacher-review-20261015/backend/quiz-text-prompt-NUL.json)、[题干 surrogate](../dogfood-output/teacher-review-20261015/backend/quiz-text-prompt-surrogate.json)、[四种输入测试](../dogfood-output/teacher-review-20261015/backend/quiz-text-tests.log)、[浏览器与未写入核对](../dogfood-output/teacher-review-20261015/browser/finding-quiz-nul.json)。

## TSTUDENT02 单个学生表单的 Unicode 长度规则不一致

**P3。** [students.tsx](../frontend/src/teacher/students.tsx) 第 63–70 行使用 UTF-16 `.length`，而批量导入和后端按 Unicode 码点计数。31 个 `𠮷` 是 31 个字符，却被单个学生表单判定为超过 60 个字符；批量解析及后端创建、更新模型均接受。浏览器修改姓名也得到相同错误。

影响包含补充平面字符的姓名、学号边界；密码长度的计数单位也与后端不一致。应统一计数规则，保留已有规范化流程。

证据：[组件及后端模型对照](../dogfood-output/teacher-review-20261015/students/findings.json)、[浏览器错误](../dogfood-output/teacher-review-20261015/browser/finding-unicode-name.json)、[截图](../dogfood-output/teacher-review-20261015/browser/finding-unicode-name.png)。

## 初次审查已通过的验证

| 范围 | 结果 |
| --- | --- |
| 前端教师、共享报告及认证测试 | 去重后 171 项通过：学生与学期组 54、报告/题库/工作台/renderer 组 89、密码/鉴权/API 组 32，已扣除工作台重复的 4 项 |
| 后端相关既有测试 | 194 项通过，覆盖鉴权、教师管理、批量导入、报告事务、题库版本、名称与输入边界 |
| 新增独立接受测试 | 28 项通过、21 项缺陷断言失败；失败归纳为上述 6 项问题，不与正常通过混为一谈 |
| 权限边界 | 全部 15 个教师 API 的匿名和学生访问，30 次拒绝检查通过且无副作用 |
| 生产构建 | `bun run build` 的 TypeScript 与 Vite 构建通过 |
| 生产构建浏览器正常矩阵 | 41 条有结构化记录的检查通过：学生/学期 10、报告 8、题库 18、口令/进度/提交版本 5 |
| 浏览器故障确认 | 3 种弹窗状态丢失、2 种评分草稿保护失效、大小写冲突、Unicode 姓名和题库 NUL 边界均复现 |
| 界面与键盘 | 独立 20 项检查通过；1440×1000 和 1000×900 下无外层或 main 横向溢出 |
| 自动无障碍 | 14 次 axe 检查，0 个确认违规；incomplete 单列 |
| 运行异常 | 主操作浏览器及独立无障碍会话未捕获 JavaScript 异常均为 0 |

正常管理验证涵盖学期新建、规范化重复名拒绝、班级新建与改名、归档确认/取消/恢复、归档不删除学生、学生创建与重复账号错误保留、姓名学号修改、跨班转移，以及学期、未分班、班级和搜索筛选。批量导入实际下载账号清单、创建账号，随后使用清单中的密码登录成功，开头的零保留。

报告验证使用真实 OECD ICIO 2016–2020 release `8565f226719d4179967f6372dbc7c49e`。先通过学生 API 完成可报告的材料和四步回归，生成三份真实报告，其中两份提交、一份保留草稿。确认教师列表只显示已提交报告，0 分、100 分可保存，101 分被前端拒绝且不写入；未修改评分不能重复提交。真实并发评分触发 409，正常重载保留草稿；“改用这份评阅”和连续评阅下一份正常。学生提交后修改研究问题，教师仍看到已提交版本和明确提示，不会误评未提交的新内容。

题库逐步浏览全部 14 个步骤，核对题目数量。保存前取消、编辑时离开取消、恢复默认仅改变本地草稿、真实版本冲突保留草稿及确认载入最新均通过。改题只改变目标步骤版本；已提交学生完成数从 15 变为 14，但材料和报告原样保留；未提交报告保留内容并标记需要更新。并行编辑不同步骤不会互相覆盖，同一步的过期版本被拒绝。

学生重置密码后，旧密码和旧 bearer token 都失效，新密码中的首尾空格被保留；教师修改自己的密码后登出，旧密码及旧 token 被拒绝，新密码可重新登录且初始密码提示消失。学生表中全部 56 行的完成进度和分数与认证 API 一致。管理响应未泄漏密码哈希、盐或 `auth_version`。

证据入口：[前端学生侧测试](../dogfood-output/teacher-review-20261015/students/findings.json)、[前端报告侧测试](../dogfood-output/teacher-review-20261015/reports/summary.json)、[认证前端测试](../dogfood-output/teacher-review-20261015/validation/auth-ui-tests.log)、[后端汇总](../dogfood-output/teacher-review-20261015/backend/summary.json)、[生产构建](../dogfood-output/teacher-review-20261015/validation/build.log)、[学生学期矩阵](../dogfood-output/teacher-review-20261015/browser/academic-matrix.json)、[报告矩阵](../dogfood-output/teacher-review-20261015/browser/report-matrix.json)、[题库矩阵](../dogfood-output/teacher-review-20261015/browser/quiz-matrix.json)、[题库对学生的影响](../dogfood-output/teacher-review-20261015/browser/quiz-student-impact.json)、[口令与最终核对](../dogfood-output/teacher-review-20261015/browser/final-matrix.json)、[无障碍与截图](../dogfood-output/teacher-review-20261015/a11y/summary.json)。

## 覆盖限制与环境

报告列表存在待规模压测的性能优化点：[records.py](../gvcsim/classroom/records.py) 第 200、317 行返回完整 `markdown` 和 `provenance`，而侧栏角标和报告列表均不用这两个字段，打开正文另取详情。两份真实报告的列表响应为 309,538 B，删除这两个字段后为 989 B，冗余占 99.68%。切入报告页还会分别为角标和列表发起请求。本机连续 10 次的中位时延为 23.92 ms，未见当前小样本明显卡顿，因此未列为确认 P2；尚未测试部署压缩、大班规模或并发教师访问。[测量证据](../dogfood-output/teacher-review-20261015/backend/report-list-payload.json)

教师间共享管理域是现有数据模型，没有把不同教师能管理相同学生误报为越权。教师报告界面没有专门 PDF 导出入口或对应 API，本次检查共享报告 renderer，未将未承诺的导出功能列为缺陷。

axe 的 incomplete 包括需要人工判定的 `aria-prohibited-attr` 和渐变背景等对比度项目；没有测试真实屏幕阅读器，不能据此宣称完整 WCAG 合规。没有重跑底层经济数值 oracle、完整 `scripts/local_ci.sh`、生产部署或大规模负载验收。

后端单元与独立接口测试使用真实 PostgreSQL 和 FastAPI TestClient，产物身份由既有隔离夹具固定；浏览器使用独立服务器、真实生产构建及真实 OECD 产物。故障注入只改变请求到达/失败时序；真实评分和题库冲突通过正常接口制造，没有伪造成功响应或报告数字。

测试中校正了脚本的中文 CSS 选择器、控件实际标签、清空搜索与下载定位方式；NUL 不能通过操作系统 argv 传递，改用浏览器输入事件注入。服务器首次启动尚未监听时的种子请求已在就绪后重试。上述脚本和环境失败与产品缺陷分开记录，原始日志保留。截图、日志和临时复现源文件位于忽略目录 `dogfood-output/teacher-review-20261015/`。

初次审查结束后，已关闭两个审查浏览器会话和 API/preview 服务，删除浏览器与后端测试专用数据库，移除源码目录中的临时复现测试。现有课堂数据库未被使用。[总汇总](../dogfood-output/teacher-review-20261015/summary.json)

## 二次确认与修复验收

六项问题在未修改的基线上全部再次复现：学生侧独立验收 11 通过 / 6 失败，报告侧 9 通过 / 2 失败，后端 8 通过 / 13 失败。失败原因与初次审查一致，未依据猜测直接修改。

| 问题 | 修复与永久回归覆盖 |
| --- | --- |
| TBACK01 | 所有账户身份检查与写入共享 PostgreSQL 事务级 advisory lock，覆盖单建、修改学号、批量导入、CLI 教师创建及 demo 同步；检查到提交/回滚保持原子。8 种受控真实 PostgreSQL 竞争验证只有一个成功方，批量失败不留下部分账号或分班记录。 |
| TBACK02 | 学号与用户名使用一致的 ASCII 大小写比较规则；保留学号显示原文、空学号和本人用户名例外。覆盖单建、修改、批量预览/提交、CLI 及 demo 回滚。 |
| TSTUDENT01 | 列表请求失败保留最近成功的数据及原弹窗实例；错误和重试显示在当前弹窗内，明确数据可能过时。草稿、班级选择、预览密码和成功回执不被清空；重复失败及恢复后的账号清单内容一致，创建只执行一次。 |
| TREPORT01 | 持有草稿的 ReportView 负责离开保护的生命周期，重载中或失败时不清除；错误页返回也需确认。测试取消/确认离开、重试、晚响应隔离、采用服务端评阅、保存及下一份。 |
| TBACK03 | 题库所有持久化文本字段复用合法文本校验，NUL 及未配对高/低 surrogate 返回 422，题库及版本不变；合法多语言文本、换行和 tab 仍可保存。 |
| TSTUDENT02 | 姓名、学号规范化后按 Unicode 码点计数；密码按原文码点计数，不裁剪首尾空格。覆盖各字段上下界、补充平面字符及规范化后长度。 |

另外，真实浏览器发现新增错误提示会让短窗口中的添加学生弹窗超出上下边界。已限制弹窗高度并让正文纵向滚动，标题和关闭按钮持续可见；这是异常恢复界面的配套修正。

没有修改教学库 schema 版本或重写现有课堂数据，也不会自动合并历史重复账号。身份写入采用单一锁，避免跨字段或反向批次的多锁顺序死锁；单建、批量及教师创建的密码派生在身份锁外完成。本次未处理报告列表冗余载荷这一待压测的优化点。

| 最终验证 | 结果 |
| --- | --- |
| 新增永久回归测试 | 73 项：学生与学期 20、报告 9、后端身份 22、题库文本 22 |
| 全部前端单元测试 | `bun run test:unit`：1,096 项通过，0 失败 |
| 后端受影响范围 | 295 项不同测试通过；包含鉴权、课堂管理、并发、CLI、名称与输入边界、批量导入、身份、题库、P0 和路由适配 |
| 原独立验收 | 学生 17、报告 11、后端保留的 18 项全部通过；原 3 项在身份检查之后设置 Barrier 的并发用例会与正确串行锁互等，因此改由上述 8 种 PostgreSQL 门闩竞争测试覆盖，没有宣称原 21 项脚本原样全过 |
| 类型、静态检查与构建 | ruff、mypy（74 个源文件）、`bun run test:build-modes` 通过；弹窗 CSS 调整后再次 `bun run build` 通过。Vite 保留既有大于 500 kB 的分块体积提示，无构建失败 |
| 真实 HTTP 并发 | 独立服务连续 10 轮双请求，无延时注入：10 次成功、10 次 409，每个学号仅一个账号 |
| agent-browser 核心验收 | 13 项通过：正常建学期/班级、失败重试保留草稿与焦点、31 个 `𠮷` 姓名创建、大小写冲突拒绝、两个页面的成功回执和下载内容、真实 409 后挂起/失败的离开保护与草稿恢复、采用服务端评阅和实际评分保存、题库 NUL 422 后正常保存及恢复默认 |
| agent-browser 布局验收 | 4 项通过：1280×577、1000×900、1440×1000 下错误弹窗在视口内；键盘 Tab 可到达可见且可点击的提交按钮；短窗口批量回执可重试并再次下载相同清单 |
| 浏览器异常 | 最终会话 JavaScript 异常 0；错误注入后的请求错误按预期显示 |

永久测试见 [students-refresh.test.tsx](../frontend/src/teacher/students-refresh.test.tsx)、[reports-reload-guard.test.tsx](../frontend/src/teacher/reports-reload-guard.test.tsx)、[test_student_identity.py](../tests/test_student_identity.py)、[test_quiz_config.py](../tests/test_quiz_config.py)。

新证据位于忽略目录 `dogfood-output/teacher-fixes-20261015/`：[后端汇总](../dogfood-output/teacher-fixes-20261015/backend/summary.json)、[前端全量测试](../dogfood-output/teacher-fixes-20261015/validation/frontend-unit.log)、[构建边界](../dogfood-output/teacher-fixes-20261015/validation/build-modes.log)、[最终构建](../dogfood-output/teacher-fixes-20261015/validation/final-build.log)、[浏览器核心验收](../dogfood-output/teacher-fixes-20261015/browser/acceptance.json)、[短窗口与键盘](../dogfood-output/teacher-fixes-20261015/browser/modal-layout.json)、[真实 HTTP 并发](../dogfood-output/teacher-fixes-20261015/browser/http-concurrency.json)。

本轮仍使用独立一次性 PostgreSQL 数据库和真实 OECD 报告。验收后关闭浏览器、API/preview 服务并删除测试数据库，未使用现有课堂库。未运行完整 `scripts/local_ci.sh`、生产部署或大规模负载验收；本次提交不含部署动作。
