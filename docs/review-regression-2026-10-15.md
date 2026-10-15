# 步骤 10 至 14 回归页面深度审查

审查日期：2026-10-15。代码基线：`cc` / `11d9f64dff3ac40d5f11da91ff972f187b05da79`。数据为真实 OECD ICIO 2016–2020 产物，release `8565f226719d4179967f6372dbc7c49e`；教学面板 `step10-tariff-teaching-v13`，教学库 v15。

初次审查确认 **2 类 P2 页面问题、1 类 P3 输入边界问题**，随后按要求修复。178 个模型的独立复算没有发现数值差异，正常的默认模型、预设实验、因变量切换、保存恢复、CSV 和报告重算链路通过。

## 修复结果

- **RREG01 已修复。** 国家税况取自国家级 `taxed` 标识，服务业另注“服务业不加税”。步骤 10 和 15 根据已存选择重建展示标签，旧错误标签也能正确显示；不写回历史材料，不改变已有报告正文、指纹或提交状态。国家分类请求失败时暂不标注税况，并提供重试。
- **RREG02 已修复。** 步骤 11–14 的例子换算，以及步骤 10 的已记录例子回退请求，均有独立加载、错误与重试状态。重试只读取例子，不重新计算回归，不改动已存材料；回退数据缺行也会明确提示。
- **RREG03 已修复。** 会话写入前拒绝非有限或超出浮点范围的数值，PUT 返回 422，旧内容及版本不变。报告门禁和已存回归解析也防护溢出，旧畸形会话可读取并修正。PATCH 原本不支持，继续返回 405 且不落库。另覆盖有限但超 int64 的聚类数，避免 SciPy 将其转成 object 数组后抛错。

修复验证结果见文末。下文保留修复前的复现条件、根因及审查证据；其中源码行号对应上述基线。

## 修复前确认的问题

### RREG01 服务业例子把被加税国家标成未被加税

**P2，正常页面操作可触发。** 步骤 10 选择 `CHN 中国`、不选对照国家、行业 `D 电力燃气`。同一页面出现两种相互矛盾的说法：

- 五年趋势摘要正确写明“中国是被加税国家，但服务业不加税”。
- 本步报告材料却写成“例子：CHN 中国（未被加税）· D 电力燃气”。

保存完成后，步骤 15 的“你记录的材料”沿用这个错误标签。问题影响国家税况的教学解释，X 仍正确为 0；生成报告正文采用另一套国家分类逻辑，不应把此问题扩大成报告回归数字错误。

根因是 [shock-lab.tsx](../frontend/src/labs/steps/shock-lab.tsx) 第 226–229 行根据当前行业的 `teaching_tariff_rate_tau > 0` 推断整个国家是否被加税。服务业 τ 都为 0，即使该国货物被加税，也会得到“未被加税”。同文件的趋势摘要已经使用国家级分类区分这两种情况。[report-lab.tsx](../frontend/src/labs/steps/report-lab.tsx) 第 269、284 行直接显示已保存的 `material_label`。

修复方向：国家税况使用国家级 `taxed` 标识，行业是否免税另行表达；同时考虑已保存标签的展示更新，避免只修新记录、旧材料清单仍误标。

证据：

- [真实浏览器截图](../dogfood-output/regression-review-20261015/browser/finding-step10-service-label.png)
- [步骤 10 读数](../dogfood-output/regression-review-20261015/browser/step10-service.txt)
- [步骤 15 保存确认后的标签](../dogfood-output/regression-review-20261015/browser/step15-service-label.json)
- [独立组件复现](../dogfood-output/regression-review-20261015/frontend/service-country-label.json)

### RREG02 例子数据失败后展示静默消失

**P2，请求失败时可触发，分两条路径。**

步骤 11–14：默认回归结果成功加载后，如果 `/api/regression/teaching-panel` 的例子请求失败，国家×行业的换算段直接消失。页面没有加载失败提示，也没有重试该请求的入口。浏览器在步骤 14 阻断这一请求后，回归结论仍为 −40.56 个中心性原始单位，但 `exampleCount=0`、`alerts=[]`、`retryButtons=[]`；解除阻断并刷新后例子恢复。

步骤 10：已有 CAN/AUS/C29 例子，改选样本外的 USA。当前请求返回后，页面应继续展示已保存的例子；如果这个回退请求失败，整块例子与趋势消失。材料卡仍提示“已记录的例子保持不变”，但没有说明例子展示加载失败，也没有重试入口。真实浏览器与组件测试都复现了这条路径。

根因：

- [regression.tsx](../frontend/src/regression.tsx) 第 154–171 行把 `exampleQuery` 的所有非成功状态变成空数组，没有呈现其 `error` 或 `retry`。
- [shock-lab.tsx](../frontend/src/labs/steps/shock-lab.tsx) 第 266–278 行读取 `recordedQuery`，但第 492–494 行仅显示当前 `query` 的加载与失败状态。
- [useAsync](../frontend/src/labs/shared.tsx) 有 `online` 事件重试，但网络保持在线时的临时请求失败不会自动产生该事件。

修复方向：分别呈现例子请求和回退请求的加载、失败与重试状态，保留已有回归结果和报告材料。重试范围应限于失败的数据请求。

证据：

- [步骤 14 故障断言](../dogfood-output/regression-review-20261015/browser/example-request-failure.json)及[截图](../dogfood-output/regression-review-20261015/browser/finding-step14-example-request-failure.png)
- [步骤 10 回退故障断言](../dogfood-output/regression-review-20261015/browser/recorded-example-failure.json)及[截图](../dogfood-output/regression-review-20261015/browser/finding-step10-recorded-example-failure.png)
- [组件复现日志](../dogfood-output/regression-review-20261015/frontend/repro-runner.log)

### RREG03 超大整数可使步骤 10 会话持续读取失败

**P3，仅畸形或手工构造的已认证请求触发，正常 UI 不产生这种值。** 向步骤 10 的 `teaching_observation.teaching_export_share_w` 提交合法 JSON 整数 `10**400`：

1. `PUT /api/classroom/session` 返回 500。
2. 无效数值已经保存到 PostgreSQL。
3. 随后的 `GET /api/classroom/session` 持续返回 500，影响该账号当前 release 的实验恢复。

本轮直接读取隔离数据库中的版本号，再提交合法记录后恢复为 200。同类超大整数放入步骤 11 的系数字段也会导致 500，但发生在入库前，后续 GET 仍为 200。

根因是 [session.py](../gvcsim/session.py) 第 30–41 行只对浮点数检查有限性，接受任意大小的整数；[report_gate.py](../gvcsim/report_gate.py) 第 308–310 行将整数转换为 `float` 时未处理 `OverflowError`；[classroom/routes.py](../gvcsim/classroom/routes.py) 第 245–250 行已经保存会话，随后才构建包含 gate 的响应。[report_saved_run.py](../gvcsim/report_saved_run.py) 第 111–112 行存在同类转换。

修复方向：数值域和有限性在写入前校验，对超范围值返回 422；校验失败保留旧会话。补充断言“无效保存后 GET 仍成功”，不能只检查 PUT 的状态码。

证据：[输入边界结果](../dogfood-output/regression-review-20261015/api/numeric-boundary.json)、[复现脚本](../dogfood-output/regression-review-20261015/api/probe_numeric_boundary.py)。脚本会重建其显式指定的独占临时库 schema，重放前须遵循同目录 `commands.txt`。

## 修复前审查测试结果

| 检查 | 本轮结果 |
| --- | --- |
| API、会话、报告、缓存、并发、输入边界现有测试 | 466 项通过，19 个模块 |
| 数值与教学回归现有测试 | 68 项通过，与上述模块不重复 |
| 前端相关现有测试 | 286 项通过，11 个文件；TypeScript 检查通过 |
| 新增缺陷复现测试 | 3 项按预期失败，分别确认 RREG01 和 RREG02 的两条路径 |
| 独立数值复算 | 178 个模型一致，生产库对照也全部通过 |
| 数据契约核验 | 113 项通过 |
| 浏览器矩阵 | 57 条记录：4 个默认结果、28 个预设实验、17 个 Y、4 次窄窗口检查、4 次刷新恢复；矩阵无失败 |
| CSV | 四步均实际下载；每份 31 行，含 UTF-8 BOM、同 Y 对照列与课程设定值 |
| 报告 API 链路 | 23 个 TestClient/ASGI 请求全部 200；四组默认结果、四个自定义模型、生成与提交通过 |
| 无障碍自动审计 | 五页 axe-core 4.12.1 检查均 0 条确认违规；每页仍有 1 类 SVG 文字对比度待人工判断，未据此宣称完整 WCAG 通过 |

### 数值与数据

真实教学面板包含 16,000 行、3,200 个国家×行业单位、75 个国家。独立核查了 2016 年 ICIO 对美出口份额 w、第一批 14 国与第二批 23 国、38 个未加税国家、X/L1.X/L2.X 的日历年对应，以及原始指标列未被改写。

178 个模型包括：17 个 Y 的默认模型、13 类固定效应 × 7 类 X 滞后组合的 91 个全控制混合滞后模型，以及 70 个随机混合控制模型。独立实现采用稀疏显式虚拟变量、LSMR 投影、QR 回归和手工国家聚类 CR1，对照系数、标准误、p 值、区间、累计系数及其标准误、R²、F 和 Root MSE。

| 默认 Y | 原始累计系数 | 页面中 X 每高 1 个百分点的读数 |
| --- | ---: | --- |
| 外国增加值项占比 | −0.551798 | −0.55 个百分点 |
| 复杂 GVC 生产份额 | −0.392352 | −0.39 个百分点 |
| 前向 GVC 段长度 | −1.827494 | −0.0183 个长度单位 |
| 加权总度 | −4055.765350 | −40.56 个中心性原始单位 |

零效应 Y 的区间包含 0，页面显示“方向不确定”；位置指数为前后向长度之比，工作台不为它提供固定线性设定值。份额分解、加权总度恒等式、三组走势与分解也通过核验。本轮为覆盖性抽样，没有重跑历史 20,111 个模型的完整矩阵。

证据：[数值摘要](../dogfood-output/regression-review-20261015/numeric/numeric-summary.json)、[逐模型结果](../dogfood-output/regression-review-20261015/numeric/numeric-results.json)、[数据核查](../dogfood-output/regression-review-20261015/numeric/data-integrity.json)。独立实现保存在同目录 `review_numeric.py`、`review_data.py`。

### 页面与保存

浏览器使用 agent-browser，访问本轮源码的 Vite 开发服务器与独立 FastAPI 服务，数据库为本轮新建的隔离库。检查宽度为 1440 和 1000 像素。

除矩阵外，还检查了样本外 USA、服务业 X=0、取消全部 X、仅 L2.X、国家×年份固定效应吸收控制、无固定效应的常数项，以及替代 Y 请求失败。替代 Y 失败时原有保护正确：显示错误，隐藏结果表和 CSV，禁用依赖该默认结果的计算，并可切回本步 Y。

查看了五页窄窗口截图、四步结果表，以及步骤 14 的图表、自定义表单和 CSV 按钮。步骤 14 的多模型表格在 1000 像素宽度下需要局部横向滚动，实测能滚到最右列：容器宽 688、内容宽 972、最大 `scrollLeft=284`，文档宽度保持 1000。未把这种预期滚动当作截断缺陷。

步骤 15 在自动保存确认前短暂显示旧材料清单也未列为缺陷：它读取服务器确认快照，页面有“保存后将重新核对材料”等状态，保存成功后自动更新，报告生成前会等待保存完成。

证据：[浏览器矩阵](../dogfood-output/regression-review-20261015/browser/matrix-results.json)、[CSV 核对](../dogfood-output/regression-review-20261015/browser/csv-summary.json)、[替代 Y 故障保护](../dogfood-output/regression-review-20261015/browser/alternate-y-failure.json)。同目录保存截图、axe 输出和可重放的 `matrix.py`、`audit.py`；这些脚本使用本轮临时账号和端口，重放需先建立对应隔离环境。

### 报告与服务端边界

通过公开 API 路径准备完整材料，四个回归步骤各保存一个自定义模型，并故意篡改浏览器快照中的系数。清空计算缓存后生成报告，四组默认结果与原 API 完全一致，自定义模型系数也一致，伪造数值没有进入报告。随后提交成功，状态为 `pending`，完成 15 步，`report_current=true`。

该隔离运行的冷报告生成耗时 4.265 秒，只代表本机这一个案例，不代表生产并发吞吐。证据：[API 链路及耗时](../dogfood-output/regression-review-20261015/api/real-release-journey.json)、[报告文本](../dogfood-output/regression-review-20261015/api/real-release-report.txt)。

## 复验入口与范围

前端三个缺陷复现用例可运行：

```bash
bash dogfood-output/regression-review-20261015/frontend/run-repros.sh
```

修复前基线为 3 fail；针对这些缺陷的正式回归测试现已纳入前端测试集。该历史脚本会覆盖原始复现日志，修复后的验收优先运行正式测试。后端精确命令、隔离库要求及脚本顺序见 `dogfood-output/regression-review-20261015/api/commands.txt`。所有数据库测试都使用独占一次性库，没有操作现有课堂库。

初次审查未执行完整 `scripts/local_ci.sh`，其浏览器证据来自开发构建，报告全链路证据来自 ASGI/API；没有把它们描述成一次完整的真人答题到教师评分的浏览器旅程。初次测试日志和截图位于忽略目录 `dogfood-output/regression-review-20261015/`。修复后的完整检查与页面复验单列于下。

## 修复后验证（2026-10-15）

正式测试新增 11 项前端用例和 45 项后端参数化用例，覆盖国家分类、历史标签不写回、已提交报告不变、例子请求失败与恢复、溢出请求不落库，以及旧坏记录读取与修复。

| 检查 | 修复后结果 |
| --- | --- |
| 前端全量单元测试 | 1,018 项通过，93 个文件 |
| 后端全量测试 | 1,282 项通过，覆盖率 91.61%（门槛 85%） |
| 静态与构建 | Ruff、格式、mypy、Shell 语法、TypeScript、普通及演示模式构建、Gephi golden 对照通过 |
| 完整本地 CI 浏览器检查 | 学生 smoke、报告生成/提交与教师评分、15 步纯 UI 课程旅程、教师管理 smoke 全部通过 |
| 真实 OECD 数据浏览器复验 | 步骤 11–14 均完成请求阻断→错误提示→独立重试→例子恢复；结论和材料保持不变。步骤 10 的已记录例子回退也通过 |
| 历史服务业标签 | 新登录读取旧错误标签，步骤 10 和 15 都正确显示被加税国家及服务业免税；会话内容和版本不变，无同步冲突 |
| 真实 HTTP 输入边界 | 步骤 10 读数及步骤 11 系数各测试正负 `10**400`：4 次 PUT 均 422，后续 GET 均 200，内容及版本不变 |

`bash scripts/local_ci.sh` 完整通过，使用当前源码快照、一次性 PostgreSQL 17 和合成数据；真实 OECD 故障复验使用另一独立数据库与 Vite 开发构建。临时服务及数据库均已清理。没有执行生产部署或多人负载验收。

完整 CI 日志为 `dogfood-output/regression-fixes-20261015/local-ci.log`，浏览器证据为 `dogfood-output/local-ci/20261015T092927Z-214244/`。

修复后的真实数据证据位于 `dogfood-output/regression-fixes-20261015/`：`retry_checks.py` / `regression-retry.json` / `recorded-retry.json`、`legacy_checks.py` / `legacy-label.json`、`http_numeric.py` / `http-numeric.json`，并保存了错误重试和标签修正截图。脚本使用本轮一次性账号、端口及数据库，重放前需重建隔离环境。
