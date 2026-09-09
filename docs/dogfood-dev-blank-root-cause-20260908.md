# DF-DEV-01：开发模式多标签空白页定位

- 日期：2026-09-08；业务基线：`3bad3e7`。
- 承接：[第二批记录](dogfood-second-batch-20260908.md)。
- 本轮只做定位及隔离对照，没有修改认证、保存、React 或 Vite 业务配置，也没有提交、推送。

## 结论

**已定位空白页的直接原因和触发环境：浏览器运行所在机器的 `/tmp` 临时文件系统在多标签开发资源加载期间接近耗尽，Chromium 返回 `net::ERR_INSUFFICIENT_RESOURCES`，ESM 依赖未能加载，React 尚未启动，页面留下空 `#root`。**

这是本地浏览器测试环境的临时存储容量问题，不是目前已确认的认证组件或工作区同步缺陷。开发模式的多模块加载更容易触发；不能据此保证生产构建在同等资源枯竭时绝不会失败。

没有将所有历史 `CDP timed out` / `response channel closed` 逐项证明为同一个底层错误。本轮对空白页有明确网络、DOM、文件系统及反向对照证据；单独的旧 CDP 异常仍应保留原始记录。

## 关键证据

证据根：`dogfood-output/deep-3bad3e7-20260908/second/`。

### 1. 空白时不是 React 已经渲染了一个空结果

`dogfood_workspace_interleavings-probe2/cdp-1788884321052585387.json`：

- Chrome `152.0.7977.82`，三个标签均能响应独立 CDP 诊断的 `Runtime.evaluate`。
- 三个标签均为 `readyState=complete`、存在 `#root`、子元素数 0。
- 三个标签都没有 React 创建容器时设置的 `__reactContainer…` 标记。
- 初始化探针仍能运行定时观测；不是据此发现了主线程业务死循环。

DOM 就绪及 `errors=[]` 不代表 ESM 依赖加载成功；网络加载失败需要检查 Network 域，不能只看未捕获 JavaScript 异常。

### 2. 三次捕获到同一网络失败

| 执行 | 捕获的 `ERR_INSUFFICIENT_RESOURCES` 次数 | 说明 |
|---|---:|---|
| `probe3` | 34 | 包含 Script、Fetch、Ping 等请求 |
| `probe4` | 24 | 首个失败为 `/src/labs/steps/indicator-lab.tsx` |
| `probe5` | 32 | 首个失败为 `/src/labs/steps/viz/production.tsx` |

它们是 Chromium 的 `Network.loadingFailed`，`canceled=false`，不是后端返回的 HTTP 429/503，也不是测试故障代理针对旧保存请求的预设失败。失败涉及正常的 `/src/…` 模块，足以阻断入口模块求值。

完整请求路径、类型、错误和时间在各执行目录的 `tabs-*-network.jsonl`。记录不包含请求头、请求体或认证材料。

### 3. 失败瞬间的容量证据

| 执行 | `/tmp` 可用字节 | 约合 MiB |
|---|---:|---:|
| `probe4` | 3,493,888 | 3.33 |
| `probe5` | 7,241,728 | 6.91 |

采样在收到首个资源不足事件后立即触发，不是故意填满文件系统。采样是异步瞬时值，不能把这些数值解释成固定失败阈值。

- `/tmp` 是总容量约 3.8 GiB 的 tmpfs；浏览器退出后可用空间恢复到约 0.9–1.1 GiB，说明仅看事后 `df` 会漏掉峰值。
- `/dev/shm` 同时仍有约 3.8 GiB 可用，不能误写为 `/dev/shm` 已满。
- `probe4` 中浏览器/渲染器/网络服务的 FD 数约 27–222，软上限 524,288；没有发现 FD 上限耗尽。
- 首个失败时观察到的在途请求数分别为 20、41，不支持仅凭错误名就声称打到了数千请求的浏览器并发上限。
- 没有清理其他项目的 `/tmp` 文件、停止共享数据库或制造全局磁盘填充。

### 4. A–B–A–B 对照，再移除探针复核

唯一环境干预：将测试进程的 `TMPDIR` 指向权限 0700 的 `/root/.local/share/gvcsim-dev/browser-tmp`，该目录位于约有 45 GiB 可用空间的磁盘文件系统。没有改 UI 操作、断言、密码恢复逻辑、超时或推断门禁。

| 顺序 | 执行 | 临时目录 | 结果 |
|---|---|---|---|
| A | `probe4` | 默认 `/tmp` | 失败；24 次资源不足 |
| B | `probe-disk1` | 独立磁盘目录 | 2 轮完整流程通过；观察器未捕获网络失败 |
| A | `probe5` | 默认 `/tmp` | 再次失败；32 次资源不足 |
| B | `probe-disk2` | 独立磁盘目录 | 2 轮完整流程通过；观察器未捕获网络失败 |
| 去探针复核 | `disk-clean1` | 独立磁盘目录 | 去掉初始化探针、诊断 Vite 插件和持续 CDP 网络观察器，2 轮仍全部通过 |

**合计六轮完整的该辅助流程通过**，每轮均包括 `SYNC-03-three-tabs` 和 `AUTH-01-revoked-request-and-account-switch`；即 12 条通过的 case 记录。它们不是六次从零完成 15 步主旅程。

`disk-clean1` 没有持续网络观察器，所以只报告业务脚本通过，不写成独立验证了“零网络错误”。

## 调查方法与边界

- 浏览器始终由 `agent-browser` 启动和操作；截图仍由它取得。
- 初始化脚本只观察导航、资源和 React 根的元信息，不预填课程记录、不读取答案、不修改认证状态。
- 诊断 Vite 插件仅运行在拥有的临时 18762 服务：记录去掉查询参数的路径/HTTP 状态，并接收观测 beacon。没有修改常驻 5173 或课堂部署。
- Node CDP 客户端连接的是该 `agent-browser` 的浏览器，用于诊断和网络观察，没有另起 Playwright 浏览器。失败后的诊断还尝试过 debugger pause/resume；没有取得可用暂停栈，不能据此报告某个函数死循环。
- `probe1`、`probe2` 等失败均保留，没有只挑通过的重跑。`probe3` 的第一轮完整通过、第二轮失败，也被保留。
- 明确没有拿生产预览通过证明开发故障“不存在”。

**底层边界**：没有做系统调用跟踪，因此不把某个具体 `fallocate`、Mojo 共享内存或缓存分配分支写成已经实测。`TMPDIR` 干预能覆盖测试运行器和浏览器临时路径；仅凭外层环境变量也不能断言 Chrome 子进程一定保留同名环境变量。

供进一步底层核对的同版 Chromium 源码：

- [url_loader.cc](https://github.com/chromium/chromium/blob/d04cdb24d67b081f6cf80200ffc5233f44b61109/services/network/url_loader.cc)：数据管道创建失败可返回该错误。
- [network_context.h](https://github.com/chromium/chromium/blob/d04cdb24d67b081f6cf80200ffc5233f44b61109/services/network/network_context.h)：也存在独立的加载器数量上限。

源码只说明错误可能来源，不能替代以上运行时及对照证据。

## 后续处理建议

1. **后续本机 dogfood 的所有 `agent-browser` 命令统一使用上述独立 `TMPDIR`**，包括启动、截图、诊断和关闭；不要在同一测试中混用临时目录环境。
2. 开始多标签测试前检查浏览器临时目录所在文件系统，而不只是 `/dev/shm` 或 RAM。
3. 不以清理不属于本轮的 `/tmp` 数据、增大等待时限、改认证 reload 或放松恢复断言解决此问题。
4. 用户真实桌面浏览器使用的是其本机临时存储；这里的 VM `/tmp` 结论不能直接套用到远端桌面浏览器。
5. 继续余下 dogfood 时保留对资源加载错误的关注。此定位不代表整个测试计划已经完成。

私有运行器已提供 `disk` 后缀的隔离对照模式，例如使用未占用的新后缀：

```bash
.venv/bin/python /root/.local/share/gvcsim-dev/run-second.py \
  dogfood_workspace_interleavings.py disk-next-unique
```

这是测试环境选项，不是产品代码修复。机器摘要为 `df-dev-01-root-cause/summary.json`；该目录的 `scripts/` 保留本轮诊断脚本快照，未复制 `dev.env` 或凭证。

## 收尾

- 临时 18761、18762 已关闭，持续 CDP 观察器已退出，测试浏览器已关闭。
- 常驻开发 8001/5173 继续运行，原课堂 8000 未重启；两套后端 `/health` 均为 HTTP 200。
- 检查时曾误用 `/api/health` 得到 401，随后改用实际公开健康路由 `/health`；前者不算服务故障。
- 业务代码未改，未提交或推送；独立测试目录与证据保留。
