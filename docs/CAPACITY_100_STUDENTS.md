# 小型课堂容量说明

当前部署目标是 20–50 名可信课堂用户：单 Uvicorn worker、PostgreSQL 1–8 个连接、4 个进程内 CPU 计算槽。超出这个规模前应先压测，而不是增加多 worker 与跨进程锁。

关键配置只有 DSN、HMAC 密钥、8 小时令牌期限、允许来源和线程数，见 `deploy/gvcsim.env.example`。

`/health/live` 仅证明进程存活；`/health` 检查 `dataset.json`、固定年度文件和 PostgreSQL `gvcsim-teaching-db-v8`。
