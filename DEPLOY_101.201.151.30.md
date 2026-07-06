# 101.201.151.30 部署记录

本文档记录本项目部署到 `root@101.201.151.30` 的实际过程。它不是通用部署手册,
路径、端口、IP、服务名均按当前服务器固定写死。

## 当前部署状态

- 访问地址: `http://101.201.151.30:6363/`
- API 文档: `http://101.201.151.30:6363/docs`
- 原 6363 静态服务: `http://101.201.151.30:8181/`(`/etc/nginx/conf.d/supply-chain-sim.conf`)
- SSH: `ssh root@101.201.151.30`
- 服务器项目目录: `/opt/oecd-icio-analysis`
- nginx 配置: `/etc/nginx/conf.d/gvcsim.conf`
- systemd 服务: `gvcsim-api.service`
- 后端监听: `127.0.0.1:18000`
- 前端静态文件: `/opt/oecd-icio-analysis/frontend/dist`
- 当前部署来源分支: `cc`
- 当前应用代码部署提交: `c501af5 Merge pull request #13 from YUxiangLuo/chore/medium-priority-hardening`

## 本地准备

先在本地完成前端构建和基础检查:

```bash
uv run pytest -q
cd frontend && bun run build
cd ..
```

如果本次改动涉及指标口径、冲击生成、控制变量、预计算流水线或原始数据,必须先在本地重算
`data/processed/`,再执行下面的 rsync,否则线上 API 会继续读取旧 CSV:

```bash
uv run gvcsim compute
```

把本地工作区同步到服务器。这里不传 `.git`、虚拟环境、node_modules、本地认证密钥、
测试/截图/报告等非运行内容:

```bash
rsync -az --delete --info=progress2 \
  --exclude='.git/' \
  --exclude='.venv/' \
  --exclude='.venv311/' \
  --exclude='frontend/node_modules/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.coverage' \
  --exclude='htmlcov/' \
  --exclude='frontend/.vite/' \
  --exclude='frontend/playwright-report/' \
  --exclude='frontend/test-results/' \
  --exclude='frontend/e2e/' \
  --exclude='frontend/playwright.config.ts' \
  --exclude='dogfood-output/' \
  --exclude='reports/' \
  --exclude='prototype/' \
  --exclude='tests/' \
  --exclude='data/.auth_secret' \
  ./ root@101.201.151.30:/opt/oecd-icio-analysis/
```

> ⚠️ **必须排除 `.venv311/`**。它是服务器上的运行时虚拟环境(systemd 的
> `ExecStart` 指向 `.venv311/bin/uvicorn`),本地并没有这个目录。若不排除,
> `--delete` 会把它整个删掉,服务一旦重启就起不来。首次部署时 `.venv311`
> 还不存在所以没暴露这个坑;之后每次同步都必须带上这条 exclude。
> (2026-07-05 曾因漏掉这条把线上 venv 删了,靠重建 `.venv311` 才恢复。)

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

API 冒烟测试。除 `/api/auth/login` 外,所有 `/api/*` 数据接口都需要 Bearer token。
这段适合 systemd 尚未启动时做本机验证;若 `18000` 已被 `gvcsim-api.service` 占用,
直接使用后面的 systemd/线上验证流程:

```bash
set -euo pipefail
cd /opt/oecd-icio-analysis
(.venv311/bin/uvicorn gvcsim.api:app --host 127.0.0.1 --port 18000 \
  > /tmp/gvcsim-smoke.log 2>&1 & echo $! > /tmp/gvcsim-smoke.pid)
cleanup() {
  kill "$(cat /tmp/gvcsim-smoke.pid)" 2>/dev/null || true
  cat /tmp/gvcsim-smoke.log
}
trap cleanup EXIT

sleep 5
TOKEN=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"username":"student","password":"gvclab2026"}' \
  http://127.0.0.1:18000/api/auth/login \
  | .venv311/bin/python -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18000/api/auth/me
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18000/api/meta
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18000/api/regression/options

cleanup
trap - EXIT
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
    listen 6363;
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

从本地验证公网访问。首页和 `/docs` 不需要 token;除登录外的 `/api/*` 数据接口必须携带 Bearer token:

```bash
set -euo pipefail
BASE=http://101.201.151.30:6363
curl -fsSI "$BASE/"
curl -fsSI "$BASE/docs"

TOKEN=$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"username":"student","password":"gvclab2026"}' \
  "$BASE/api/auth/login" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/auth/me"
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/regression/options"
```

在同一个 shell 中继续验证一次国家级加控制变量回归,并检查当前 benchmark 字段:

```bash
curl -fsS --max-time 90 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"step":13,"granularity":"国家级","method":"双重差分 (DID)","control_mode":"ICIO 派生控制变量"}' \
  "$BASE/api/regression/run" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("n_obs=", r["result"]["n_obs"], "n_clusters=", r["result"]["n_clusters"], "coef_check_passed=", r["benchmark"]["coef_check_passed"], "se_check_mode=", r["benchmark"]["se_check_mode"])'
```

2026-07-05 更新部署验证结果:

- 公开端口已从 `8081` 改为 `6363`
- 原 `6363` 静态服务已迁移到 `8181`
- `http://101.201.151.30:6363/` 返回 `200 OK`
- `/api/regression/options` 携带 Bearer token 返回 `200 OK`,包含 `control_modes`
- `/docs` 返回 `200 OK`
- `http://101.201.151.30:8181/` 返回 `200 OK`
- `http://101.201.151.30:8081/` 已关闭
- `student / gvclab2026` 登录返回 `200 OK`
- 国家级加控制变量回归返回 `200 OK`
- 回归样本量 `n_obs = 385`,聚类数 `n_clusters = 77`
- `benchmark.backend = linearmodels.PanelOLS`
- 旧版 benchmark 通过字段为 `true`;当前版本应检查 `benchmark.coef_check_passed = true`
- agent-browser 打开公网登录页无页面错误

2026-07-06 更新部署(源 `cc` @ `7f554ac`,含可视化易用性 + 行业级 GVC 参与度口径修复):

- 已按本文档 rsync + `systemctl restart` + `nginx reload` 流程重新部署
- 因参与度口径为破坏性变更,已先本地 `uv run gvcsim compute` 重算 `data/processed/` 再同步
- 首页 / `/docs` 返回 `200 OK`,`student / gvclab2026` 登录 `200 OK`
- 国家级 DID + ICIO 控制回归 `200 OK`:`n_obs = 385`、`n_clusters = 77`;旧版 benchmark 通过字段为 `true`,当前版本应检查 `benchmark.coef_check_passed = true`
- 线上行业级参与度已修复:CHN 2020 共 45 行业中 25 个有值、20 个置空(非主力出口部门),
  最大总参与度 `≈ 1.006`(旧版曾达 `1e15` 的爆表值已消失)

2026-07-06 再次更新部署(源 `cc` @ `7a50956`,可视化步骤 8-11 主题化探索 + 教学文案对齐 + review 修复):

- 纯前端 + 后端文案改动,**无需** `uv run gvcsim compute`;按 rsync + `systemctl restart` + `nginx reload` 重新部署
- 首页 / `/docs` `200 OK`,`student / gvclab2026` 登录 `200 OK`
- `/api/steps` 已返回对齐后的步骤文案(步8「GVC 定位图…」、步11「枢纽地图…」)
- 步骤 8 默认落在 GVC 定位象限图,标签集为 招牌/象限/构成/排序/散点/表格,右栏「本步目标」与默认视图一致

2026-07-06 再次更新部署(源 `cc` @ `c501af5`,中优先级工程加固 + 控制变量质检 + CI/E2E):

- 部署前本地验证通过:`ruff format --check`、`ruff check`、`mypy`、`pytest -q`(86 passed)、前端 `bun run build` 与 Playwright 最小 E2E
- 因新增 `qc_controls.json` 产物,已先本地重跑 `uv run gvcsim compute`,再同步 `data/processed/`
- 按新版 rsync 排除规则同步代码与前端 dist;服务器侧已清理 `dogfood-output/`、`prototype/`、`tests/`、`reports/`、`frontend/e2e/` 等非运行内容
- 已执行 `systemctl restart gvcsim-api.service` 与 `nginx -t && systemctl reload nginx`,服务状态 `active`
- 首页 / `/docs` 返回 `200 OK`,`student / gvclab2026` 登录与 `/api/auth/me` 返回 `200 OK`
- `/api/qc/controls` 返回 5 项控制变量质检且全部通过
- `/api/regression/options` 携带 Bearer token 返回 `200 OK`,包含控制变量与价格口径选项
- 国家级 DID + ICIO 控制回归 `200 OK`:`n_obs = 385`、`n_clusters = 77`、`benchmark.coef_check_passed = true`、`se_check_mode = informational`,且 benchmark 不再返回旧字段 `passed`

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
ss -ltnp | grep -E ':(6363|8181|18000)'
```

## 更新部署

以后如果要重新部署同一个 IP,按当前做法:

1. 在本地完成测试和前端构建;若指标/面板口径或数据源有变化,先运行 `uv run gvcsim compute`。
2. 用上面的 `rsync` 命令同步到 `/opt/oecd-icio-analysis/`。
3. 如果 Python 依赖没有变化,只需要:

```bash
ssh root@101.201.151.30
systemctl restart gvcsim-api.service
nginx -t && systemctl reload nginx
```

4. 执行上面的“线上验证”区块。若部署提交发生变化,同步更新本文档顶部的
   “当前应用代码部署提交”,并按日期追加验证结果。

如果 Python 依赖变化,重新执行本文档的 Python 运行环境安装命令。
