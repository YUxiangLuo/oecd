# 64 核服务器 / 50–100 名学生并发容量手册

## 验收目标

本配置面向一台 64 CPU 核的 Linux 服务器、单 PostgreSQL 实例和 50–100 个
独立学生账号。验收场景不是“100 个静态页面连接”，而是全班同时：

1. 登录并恢复课程上下文；
2. 浏览指标与 ICIO 原始表切片；
3. 每人运行一次教学回归；
4. 25% 学生同时运行 40 次安慰剂；
5. 写入各自的学习进度。

通过标准：

- 所有请求均为预期的 2xx，不出现连接池耗尽、500 或计算排队 429；
- 普通读取 p95 ≤ 3 秒；
- 回归 p95 ≤ 35 秒；
- 安慰剂 p95 ≤ 50 秒；
- 100 人完整场景 ≤ 120 秒。

这些是部署验收门槛，不代表每堂课都应该制造极端同步点击。

## 容量模型

| 层级 | 基准值 | 全机上限 | 作用 |
| --- | ---: | ---: | --- |
| Uvicorn worker | 16 | 16 进程 | 利用多核并隔离单 worker 故障 |
| AnyIO 默认同步线程 | 16 / worker | 256 | 承接同步 API、文件读取、鉴权和数据库等待；不承接 CPU 排队 |
| CPU 计算线程 | 最多 16 / worker | 全机最多 16 个在途 permit | 仅在取得跨进程 permit 后运行 NumPy/SciPy |
| PostgreSQL pool | 1–4 / worker | 16–64 连接 | 复用连接，并在池满时有界等待 |
| CPU permit | — | 16 | 防止 NumPy/SciPy 任务同时把 64 核打满 |
| 计算 admission | — | 128 请求 | 容纳 100 名学生，禁止无界排队 |
| BLAS/OpenMP | 2 / 任务 | 通常 ≤ 32 线程 | 避免 worker × BLAS 的线程爆炸 |

回归占 1 个 CPU permit；安慰剂和报告复估各占 2 个。因此最坏情况下可以同时
运行 16 个普通回归，或 8 个较重任务，混合负载的 permit 总和始终不超过 16。
等待者通过跨进程 FIFO 票据排队，只有队首可尝试一次性取得所需 permit；
后来的 1-permit 回归不能绕过正在等待的 2-permit 安慰剂或报告。票据和槽锁
都位于 `/run/gvcsim`，同机的全部 worker 共享；worker 崩溃时内核自动释放锁，
下一位会清除其残留票据。

此实现针对单台 64 核服务器。若横向扩展到多台应用服务器，`flock` 不再是全局
协调器，必须换成 PostgreSQL/Redis 等跨主机 admission controller。

## 并发安全保证

- PostgreSQL schema 首次迁移继续由事务 advisory lock 串行化。
- 学生会话写入继续按 attempt advisory lock 串行化，两个标签页不会覆盖。
- 登录滑动窗口存于 PostgreSQL v6；同一 `IP + username` 的 8 次精确预算和
  同一 IP 全部用户名共享的 400 次总预算都在 16 个 worker 上原子计数。
  轮换 username 不能制造无界数据库写入，旧记录最多保留限流窗口的 4 倍。
- 每个数据库池都有 `max_size`、`max_waiting` 和 checkout timeout；不会在
  流量尖峰中无限创建连接或无限排队。
- Bearer 会话数据库复查从 ASGI 事件循环转入有界线程池，慢数据库不会阻塞
  整个 worker 的事件循环。
- `/health/live` 是原生异步端点，不占用上述同步线程令牌；线程池饱和不会制造
  假性 liveness 失败。
- 回归、安慰剂和报告使用异步 CPU 队列；最长 90 秒的 permit 等待不会占用
  AnyIO 默认线程令牌。真正的 NumPy/SciPy 计算在独立限流器中执行，避免挤占
  鉴权、数据库切片和 readiness 所需的同步线程。
- 大 CSV 和原始 ICIO 列切片的首次读取在每个 worker 内 single-flight，
  避免冷缓存并发重复解析。
- 计算队列满或等待超时时返回 `429`、稳定错误码和 `Retry-After`；已取得的
  文件锁、admission 槽和 CPU permit 在异常路径都会释放。
- 加权任务按 FIFO 获得开始资格，不通过“先占一部分 permit 再等剩余 permit”
  来实现公平，因此多个 2-permit 任务之间不会形成部分占有死锁。

## 生产配置

复制并填写 [`deploy/gvcsim.env.example`](../deploy/gvcsim.env.example)，安装
[`deploy/gvcsim-api.service`](../deploy/gvcsim-api.service) 和
[`deploy/nginx-gvcsim.conf`](../deploy/nginx-gvcsim.conf)。

关键环境变量：

```bash
GVCSIM_DB_POOL_MIN_SIZE=1
GVCSIM_DB_POOL_MAX_SIZE=4
GVCSIM_DB_POOL_TIMEOUT_SECONDS=5
GVCSIM_DB_POOL_MAX_WAITING=64
GVCSIM_THREAD_TOKENS=16

GVCSIM_RUNTIME_DIR=/run/gvcsim
GVCSIM_CPU_CONCURRENCY=16
GVCSIM_CPU_QUEUE_SIZE=128
GVCSIM_CPU_ACQUIRE_TIMEOUT_SECONDS=90

GVCSIM_LOGIN_WINDOW_SECONDS=300
GVCSIM_LOGIN_MAX_ATTEMPTS=8
GVCSIM_LOGIN_IP_MAX_ATTEMPTS=400

OMP_NUM_THREADS=2
OPENBLAS_NUM_THREADS=2
MKL_NUM_THREADS=2
NUMEXPR_NUM_THREADS=2
```

systemd 模板启动参数：

```text
--workers 16 --limit-concurrency 64 --backlog 2048 --graceful-timeout 180 --no-access-log
```

`--limit-concurrency` 是每 worker 上限，不是全机上限；真正限制 CPU 密集任务
的是跨进程 permit。systemd 会先执行 `gvcsim preflight`，在父进程启动前验证
ASGI 导入、生产安全配置、完整产物、共享锁目录和 PostgreSQL；预检失败会让
unit 失败并进入 systemd 的 `RestartSec`/`StartLimit`，不会留下 Uvicorn 父进程
不断重生失败 worker。

Nginx 与压测客户端的单请求 timeout 均为 180 秒。模板的端到端预算为
`90 秒排队 + 50 秒重任务 + 40 秒余量 = 180 秒`；调整排队或执行预算时必须
同步调整反向代理及客户端，禁止让已获准计算在代理断开后继续“成功”。

PostgreSQL 至少应满足：

```text
max_connections >= workers × pool_max + 20
```

基准值为 `16 × 4 + 20 = 84`，推荐设置 150，为管理连接、备份和 autovacuum
保留余量。修改后通过 `SHOW max_connections` 核对。不要把 pool 调到 8 而仍
保留 100 的 PostgreSQL 默认上限。

建议同时核对：

```bash
sysctl net.core.somaxconn
systemctl show gvcsim-api.service -p TasksMax -p LimitNOFILE
curl -fsS http://127.0.0.1:18000/health/live
curl -fsS http://127.0.0.1:18000/health
```

`/health/live` 只检查 worker 存活；`/health` 会检查 artifact、数据库 schema、
连接池和当前 CPU/admission 使用量。

## 数据库迁移

本次 schema 为 `gvcsim-teaching-db-v6`，从 v3、v4、v5 都有事务内迁移路径。
上线前必须备份，再运行：

```bash
uv run gvcsim classroom-init
```

v6 只新增登录限流表，不改写课堂记录。旧版程序会拒绝未知的 v6 schema，所以
数据库升级是前向迁移：不要在迁移后直接启动旧二进制。需要代码回滚时应保留
新版本数据库兼容代码，或从已验证备份切换到隔离恢复库。

## 100 人可复现验收

使用名称以 `_loadtest` 结尾的专用数据库，禁止对课堂库运行 `--reset`：

```bash
export GVCSIM_LOADTEST_DSN='postgresql://USER:PASSWORD@127.0.0.1:5432/gvclab_loadtest'
export GVCSIM_LOADTEST_PASSWORD="$(openssl rand -base64 24)"

uv run python scripts/provision_load_test.py \
  --dsn "$GVCSIM_LOADTEST_DSN" \
  --password "$GVCSIM_LOADTEST_PASSWORD" \
  --students 100 --reset
```

让被测服务指向该数据库并以目标 worker/permit 配置启动。生产数据 artifact
只读，因此可复用；课堂记录必须使用专用 load-test 库。

```bash
uv run python scripts/load_test_100_students.py \
  --base-url http://127.0.0.1:18000 \
  --users-file data/loadtest-users.json \
  --students 100 \
  --json-output data/loadtest-result.json
```

脚本以 100 个独立账号获取 token，不会用一个共享账号掩盖数据库写竞争。返回
非零退出码表示任一请求失败或 p95/总时长越过门槛。JSON 结果可以作为发布附件，
但凭证文件只能保留在权限 0600 的本地 `data/` 目录。provision 脚本会先以
0600 创建同目录临时文件，完整写入并同步后再原子替换目标；中断不会留下
公开可读的半份新凭据。

## 调优规则

- CPU 长时间低于 60% 且排队增长：先把 `CPU_CONCURRENCY` 从 16 调到 20，
  每次只改一个参数并重跑 100 人验收。
- CPU 接近 100%、load average 持续上涨或 p95 变差：减少 CPU permits，不能
  通过增加 worker 解决。
- `requests_waiting` 持续增长但 CPU 空闲：检查慢 SQL、锁等待和 pool 配置；
  确认 PostgreSQL 连接预算后再增加每 worker pool。
- admission 经常达到 128：先查前端重复请求或异常重试；不要直接取消队列上限。
- 校园 NAT 下登录被 Nginx 拒绝：确认使用新版 `5r/s + burst 120` 模板。
  应用层的 `IP + username` 精确预算与 per-IP 总预算应分别调优；不要通过移除
  per-IP 总预算来容纳更多学生。

每次修改 worker、pool、BLAS 或 CPU permit 后，都必须重新运行 100 人脚本。
