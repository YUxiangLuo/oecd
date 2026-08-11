# 单机课堂部署

目标：一台 Linux 主机、PostgreSQL、Nginx、单个 Uvicorn worker，支持约 20–50 名课堂用户。

## 目录

- 应用：`/opt/gvcsim/current`
- 固定数据：`/opt/gvcsim/current/data/processed`
- 环境文件：`/etc/gvcsim.env`
- 服务模板：`deploy/gvcsim-api.service`

## 全新部署

```bash
cd /opt/gvcsim/current
uv sync --frozen
cd frontend && npm ci && npm run build && cd ..
install -m 0640 deploy/gvcsim.env.example /etc/gvcsim.env
```

填写 `GVCSIM_PG_DSN` 和至少 32 字节的 `GVCSIM_AUTH_SECRET`，然后重建 v8 数据库并计算固定产物：

```bash
uv run gvcsim classroom-init --reset
uv run gvcsim compute
test -f data/processed/dataset.json
uv run gvcsim preflight
```

当前 schema 必须是 `gvcsim-teaching-db-v8`。`compute` 会删除旧 `data/processed` 后直接写入，并清空学习记录；失败时不会留下 `dataset.json`，健康检查返回 503。

## 启动

```bash
sudo install -m 0644 deploy/gvcsim-api.service /etc/systemd/system/gvcsim-api.service
sudo install -m 0644 deploy/nginx-gvcsim.conf /etc/nginx/conf.d/gvcsim.conf
sudo systemctl daemon-reload
sudo systemctl restart gvcsim-api nginx
curl -fsS http://127.0.0.1:18000/health
```

服务固定一个 worker；数据库池为 1–8 个连接；回归、安慰剂和报告共享 4 个进程内计算槽。没有跨进程协调、登录限流、manifest 或历史制品目录。

## 更新数据

```bash
sudo systemctl stop gvcsim-api
cd /opt/gvcsim/current
uv run gvcsim compute
uv run gvcsim preflight
sudo systemctl start gvcsim-api
```

这会保留账号、班级和公告，并清空实验会话、进度、报告和提交。
