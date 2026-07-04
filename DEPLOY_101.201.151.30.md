# 101.201.151.30 部署记录

本文档记录本项目部署到 `root@101.201.151.30` 的实际过程。它不是通用部署手册,
路径、端口、IP、服务名均按当前服务器固定写死。

## 当前部署状态

- 访问地址: `http://101.201.151.30:8081/`
- API 文档: `http://101.201.151.30:8081/docs`
- SSH: `ssh root@101.201.151.30`
- 服务器项目目录: `/opt/oecd-icio-analysis`
- nginx 配置: `/etc/nginx/conf.d/gvcsim.conf`
- systemd 服务: `gvcsim-api.service`
- 后端监听: `127.0.0.1:18000`
- 前端静态文件: `/opt/oecd-icio-analysis/frontend/dist`
- 当前部署来源分支: `codex/icio-controls-regression`
- 当前部署来源提交: `69527d3 Add ICIO controls to regression workflow`

## 本地准备

先在本地完成前端构建和基础检查:

```bash
uv run pytest -q
cd frontend && bun run build
cd ..
```

把本地工作区同步到服务器。这里不传 `.git`、虚拟环境、node_modules 和本地认证密钥:

```bash
rsync -az --delete --info=progress2 \
  --exclude='.git/' \
  --exclude='.venv/' \
  --exclude='frontend/node_modules/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache/' \
  --exclude='frontend/.vite/' \
  --exclude='data/.auth_secret' \
  ./ root@101.201.151.30:/opt/oecd-icio-analysis/
```

说明:

- `data/.auth_secret` 不同步,服务器首次登录时会自动生成自己的 HMAC token 密钥。
- `OECD_ICIO/` 和 `data/processed/` 已同步到服务器,因此线上 API 不需要现场重新 `compute`。
- 本次同步后的服务器目录约 `1.3G`。

## Python 运行环境

服务器已有 `uv`,但本次尝试 `uv sync --no-dev --frozen` 时卡在 Python 3.13 科学计算包 wheel
缓存解包阶段。最终采用 Debian 系统 Python 3.11 运行服务。项目代码已验证可在该环境下跑 API。

先安装 venv 支持:

```bash
ssh root@101.201.151.30
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y python3.11-venv
```

创建运行环境并安装 Python 3.11 兼容依赖:

```bash
cd /opt/oecd-icio-analysis
rm -rf .venv .venv311
python3 -m venv .venv311

.venv311/bin/python -m pip install -U pip wheel \
  -i https://pypi.tuna.tsinghua.edu.cn/simple

.venv311/bin/python -m pip install --only-binary=:all: \
  numpy==2.3.5 \
  pandas==2.3.3 \
  openpyxl \
  pymrio \
  networkx \
  fastapi \
  uvicorn \
  linearmodels \
  -i https://pypi.tuna.tsinghua.edu.cn/simple

.venv311/bin/python -m pip install --ignore-requires-python --no-deps -e . \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

API 冒烟测试:

```bash
cd /opt/oecd-icio-analysis
(.venv311/bin/uvicorn gvcsim.api:app --host 127.0.0.1 --port 18000 \
  > /tmp/gvcsim-smoke.log 2>&1 & echo $! > /tmp/gvcsim-smoke.pid)

sleep 5
curl -fsS http://127.0.0.1:18000/api/meta
curl -fsS http://127.0.0.1:18000/api/regression/options

kill "$(cat /tmp/gvcsim-smoke.pid)"
cat /tmp/gvcsim-smoke.log
```

## systemd 服务

写入 `/etc/systemd/system/gvcsim-api.service`:

```ini
[Unit]
Description=GVC Simulation Lab FastAPI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/oecd-icio-analysis
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/oecd-icio-analysis/.venv311/bin/uvicorn gvcsim.api:app --host 127.0.0.1 --port 18000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动并设为开机自启:

```bash
systemctl daemon-reload
systemctl enable --now gvcsim-api.service
systemctl status gvcsim-api.service --no-pager -l
```

## nginx 配置

写入 `/etc/nginx/conf.d/gvcsim.conf`:

```nginx
server {
    listen 8081;
    server_name _;

    root /opt/oecd-icio-analysis/frontend/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:18000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
    }

    location = /docs {
        proxy_pass http://127.0.0.1:18000/docs;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /openapi.json {
        proxy_pass http://127.0.0.1:18000/openapi.json;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

应用 nginx 配置:

```bash
nginx -t
systemctl reload nginx
```

## 线上验证

从本地验证公网访问:

```bash
curl -fsSI http://101.201.151.30:8081/
curl -fsS http://101.201.151.30:8081/api/regression/options
curl -fsSI http://101.201.151.30:8081/docs
```

验证登录:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"username":"student","password":"gvclab2026"}' \
  http://101.201.151.30:8081/api/auth/login
```

验证一次国家级加控制变量回归:

```bash
curl -fsS --max-time 90 \
  -H 'Content-Type: application/json' \
  -d '{"step":13,"granularity":"国家级","method":"双重差分 (DID)","control_mode":"ICIO 派生控制变量"}' \
  http://101.201.151.30:8081/api/regression/run
```

本次部署验证结果:

- `/` 返回 `200 OK`
- `/api/regression/options` 返回 `200 OK`,包含 `control_modes`
- `/docs` 返回 `200 OK`
- `student / gvclab2026` 登录返回 `200 OK`
- 国家级加控制变量回归返回 `200 OK`
- `benchmark.backend = linearmodels.PanelOLS`
- `benchmark.passed = true`

## 运维命令

查看服务:

```bash
ssh root@101.201.151.30
systemctl status gvcsim-api.service --no-pager -l
journalctl -u gvcsim-api.service -f
```

重启后端:

```bash
systemctl restart gvcsim-api.service
```

重载 nginx:

```bash
nginx -t && systemctl reload nginx
```

确认端口:

```bash
ss -ltnp | grep -E ':(8081|18000)'
```

## 更新部署

以后如果要重新部署同一个 IP,按当前做法:

1. 在本地完成测试和前端构建。
2. 用上面的 `rsync` 命令同步到 `/opt/oecd-icio-analysis/`。
3. 如果 Python 依赖没有变化,只需要:

```bash
ssh root@101.201.151.30
systemctl restart gvcsim-api.service
nginx -t && systemctl reload nginx
```

如果 Python 依赖变化,重新执行本文档的 Python 运行环境安装命令。
