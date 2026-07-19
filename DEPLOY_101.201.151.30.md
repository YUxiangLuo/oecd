# 101.201.151.30 生产部署与回滚

本指南使用非 root 服务账号、HTTPS、不可变 release、共享数据目录和部署前数据库备份。生产环境不提供公开演示账号，也不会在 PostgreSQL 故障时回退到内置教师账号。

> **本文描述的是目标架构，当前主机尚未迁移到位。** 截至最后一次更新，
> `101.201.151.30` 上跑的仍是早期演示布局：应用在 `/opt/oecd-icio-analysis`、以 root 运行、
> 入口是 **HTTP `:6363`**、`/etc/gvcsim.env` 只有 `GVCSIM_PG_DSN`、systemd unit 也仍指向旧路径
> （`deploy/gvcsim-api.service` 里的沙箱化 unit 指向 `/opt/gvcsim/current` 与 `gvcsim` 账号，
> **直接安装会起不来**）。
>
> 在完成「一次性主机准备」之前，下面的 release 事务无法照搬。承载真实学生数据前必须先补齐：
> 迁到 `/opt/gvcsim/` 布局、建服务账号、配 HTTPS、把 `GVCSIM_ENV` 设为 `production` 并生成两把
> 独立密钥。演示期间以 `GVCSIM_ENV=development` + `GVCSIM_DEMO_MODE=1` 运行，登录页会明文提示
> 演示口令——这套配置**不得**用于对外环境。

## 目录与拓扑

```text
/opt/gvcsim/
  current -> releases/<release-id>
  releases/<release-id>/       只读代码、虚拟环境、前端 dist
  shared/data/                 原始/处理数据与本地开发密钥（生产不用文件密钥）
  shared/reports/
/etc/gvcsim.env                root:gvcsim 0640
/var/backups/gvcsim/           PostgreSQL custom-format 备份，0700
nginx :443 -> 127.0.0.1:18000 -> gvcsim-api.service
```

DNS 应把正式域名指向 `101.201.151.30`。若只能使用 IP，仍应配置受信任证书；不得让学生密码和 Bearer token 经明文 HTTP 传输。

## 一次性主机准备

```bash
sudo useradd --system --home /opt/gvcsim --shell /usr/bin/nologin gvcsim
sudo install -d -o root -g root -m 0755 /opt/gvcsim /opt/gvcsim/releases /opt/gvcsim/.staging
sudo install -d -o gvcsim -g gvcsim -m 0750 /opt/gvcsim/shared/data /opt/gvcsim/shared/reports
sudo install -d -o root -g root -m 0700 /var/backups/gvcsim

sudo install -o root -g gvcsim -m 0640 deploy/gvcsim.env.example /etc/gvcsim.env
sudo install -o root -g root -m 0644 deploy/gvcsim-api.service /etc/systemd/system/gvcsim-api.service
sudo install -o root -g root -m 0644 deploy/nginx-gvcsim.conf /etc/nginx/conf.d/gvcsim.conf
```

编辑 `/etc/gvcsim.env`：

- `GVCSIM_ENV=production`；
- `GVCSIM_PG_DSN` 使用权限受限的应用数据库用户；
- `GVCSIM_AUTH_SECRET` 使用 `openssl rand -base64 48` 生成，至少 32 字节；
- `GVCSIM_EVIDENCE_SECRET` 另行生成至少 32 字节，不能与认证密钥复用；轮换它会使既有学习证据收据失效，必须作为受控数据迁移处理；
- `GVCSIM_ALLOWED_ORIGINS` 只列正式 HTTPS 域名；同源 nginx 部署不需要通配符；
- `GVCSIM_DEMO_MODE=0`；
- 不设置 `GVCSIM_BOOTSTRAP_PASSWORD`。

首次安装没有任何公开教师账号。完成下面的首个 release 构建并建立 `current`
链接后，临时设置至少 12 位的 `GVCSIM_INITIAL_TEACHER_PASSWORD`，执行：

```bash
sudo -u gvcsim bash -lc '
  set -a; . /etc/gvcsim.env; set +a
  cd /opt/gvcsim/current
  .venv/bin/gvcsim classroom-init --teacher-username admin --teacher-name "课程管理员"
'
```

创建成功后立即从 `/etc/gvcsim.env` 删除该临时变量。后续教师由已授权管理员创建，
日常迁移只运行不带教师参数的 `classroom-init`。

然后配置证书并检查配置：

```bash
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable gvcsim-api.service nginx
```

## 构建 release

在可信构建机完成所有检查，不在生产机上构建前端：

```bash
git status --short --branch
uv sync --locked --group dev
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest --cov=gvcsim --cov-report=term-missing -q

cd frontend
bun install --frozen-lockfile
bun run test:unit
bun run build          # 生产构建：不要设置 VITE_DEMO_MODE
cd ..
```

前端有一个**构建期**演示开关 `VITE_DEMO_MODE=1`：开启后登录页会显示学生/教师快捷入口
并预填演示口令，仅供课堂演示。默认构建会把这段 UI 与口令常量一并 tree-shaking 掉，
发布前可自查：

```bash
grep -rl "gvclab2026" frontend/dist/ && echo "❌ 演示口令进入产物，请用默认构建重新发布"
```

release id 应同时含 Git commit 和 UTC 时间，例如：

```bash
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
release_dir="/opt/gvcsim/releases/$release_id"
upload_dir="/var/tmp/gvcsim-upload-$release_id"
build_dir="/opt/gvcsim/.staging/$release_id"

ssh deploy@101.201.151.30 "install -d -m 0700 '$upload_dir'"
rsync -az --delete \
  --exclude='.git/' --exclude='.venv/' --exclude='frontend/node_modules/' \
  --exclude='data/' --exclude='OECD_ICIO/' --exclude='reports/' \
  ./ "deploy@101.201.151.30:$upload_dir/"
```

上传目录归 `deploy` 所有，只用于接收文件。先由 root 把内容复制到服务账号可写的
构建目录，再以 `gvcsim` 安装锁定依赖并连接共享数据：

```bash
ssh deploy@101.201.151.30 "sudo bash -lc '
  set -euo pipefail
  case \"$upload_dir\" in /var/tmp/gvcsim-upload-*) ;; *) exit 64;; esac
  case \"$build_dir\" in /opt/gvcsim/.staging/*) ;; *) exit 64;; esac
  test ! -e \"$build_dir\"
  install -d -o gvcsim -g gvcsim -m 0750 \"$build_dir\"
  rsync -a --delete --chown=gvcsim:gvcsim \"$upload_dir/\" \"$build_dir/\"
  rm -rf -- \"$upload_dir\"
'"

ssh deploy@101.201.151.30 "sudo -u gvcsim bash -lc '
  set -euo pipefail
  cd $build_dir
  uv sync --locked
  ln -s /opt/gvcsim/shared/data data
  ln -s /opt/gvcsim/shared/reports reports
'"
```

如果 release 包含原始数据浏览，还应将 `OECD_ICIO` 放入 `shared/data` 外的独立只读目录，并在 release 中建立明确符号链接。不要让 `rsync --delete` 指向共享数据目录。

依赖安装和链接完成后，root 移除整个 release 的写权限，再原子移入只读 releases
目录。`gvcsim` 服务账号不能改写或替换已经封存的 release：

```bash
ssh deploy@101.201.151.30 "sudo bash -lc '
  set -euo pipefail
  case \"$build_dir\" in /opt/gvcsim/.staging/*) ;; *) exit 64;; esac
  case \"$release_dir\" in /opt/gvcsim/releases/*) ;; *) exit 64;; esac
  test -d \"$build_dir\"
  test ! -e \"$release_dir\"
  chown -R root:root \"$build_dir\"
  chmod -R a-w \"$build_dir\"
  mv -T \"$build_dir\" \"$release_dir\"
'"
```

## 部署事务

### 1. 备份并校验

```bash
ssh deploy@101.201.151.30 "sudo bash -lc '
  set -a; . /etc/gvcsim.env; set +a
  GVCSIM_BACKUP_DIR=/var/backups/gvcsim $release_dir/scripts/backup_classroom.sh
'"
```

在继续前执行输出中的 `sha256sum -c`。数据库 schema 更新必须走兼容迁移；日常部署不得使用 `classroom-init --reset`。

### 2. 迁移新 release

```bash
ssh deploy@101.201.151.30 "sudo -u gvcsim bash -lc '
  set -a; . /etc/gvcsim.env; set +a
  cd $release_dir
  .venv/bin/gvcsim classroom-init
'"
```

迁移应满足“先扩展、后切换、最后清理”的向后兼容策略。若迁移失败，不切换 `current`。

### 3. 原子切换并健康检查

```bash
ssh deploy@101.201.151.30 "sudo bash -lc '
  set -euo pipefail
  ln -sfn $release_dir /opt/gvcsim/current.next
  mv -Tf /opt/gvcsim/current.next /opt/gvcsim/current
  systemctl restart gvcsim-api.service
  nginx -t
  systemctl reload nginx
  systemctl is-active --quiet gvcsim-api.service
  curl -fsS http://127.0.0.1:18000/health
'"
```

外部验证：

```bash
BASE=https://gvcsim.example.edu
curl -fsSI "$BASE/"
curl -fsS "$BASE/health"
```

使用专门的部署探针账号检查登录、`/api/meta`、当前 assignment/manifest、步骤 1 切片和回归 design。不要把固定教师密码写入部署脚本。

## 数据发布

> ⚠️ **重算产物会使在读作业整体锁死。** 这是本系统最容易踩的运维陷阱，先读完本节再执行
> `gvcsim compute`。学期中途重算前必须先安排好作业切换，否则全班会瞬间无法提交任何证据。

新的指标或政策输入必须在构建机完整生成并验证：

```bash
uv run gvcsim compute            # fatal QC 会中止发布；确需教学演示才加 --allow-qc-override
uv run pytest -q tests/test_artifacts.py tests/test_quality.py tests/test_synthetic_compute.py
```

manifest 必须覆盖原始 ICIO 摘要、处理 CSV、政策冲击、事件定义、crosswalk、Git commit 与锁文件摘要。

### 投放产物

`compute` 产出的是 `data/artifacts/<manifest_id>/` 整套版本，`data/processed` 只是指向它的
符号链接。因此**不能** `rsync data/processed/`（带尾斜杠会跟随链接、把内容摊成实体目录，
下次切换版本时不再是原子操作）。正确做法是先同步版本目录，再切链接：

```bash
manifest_id=$(uv run python -c 'from gvcsim.artifacts import manifest_id; print(manifest_id())')

rsync -az "data/artifacts/$manifest_id/" \
  "$SERVER:/opt/gvcsim/shared/data/artifacts/$manifest_id/"
rsync -az --delete data/shocks/ "$SERVER:/opt/gvcsim/shared/data/shocks/"

ssh "$SERVER" "sudo -u gvcsim ln -sfn 'artifacts/$manifest_id' /opt/gvcsim/shared/data/processed"
```

旧版本目录保留用于审计与回滚，确认无作业仍绑定后再清理。

### 作业与 manifest 的绑定（必读）

每个 assignment 在 `assignments.manifest_id` 上**固定绑定**一个数据版本，学生的每一次证据写入
都要经过 `_attempt_scope` 校验。切换产物后该字段不会自动跟随，于是：

- 症状：所有学习证据、回归运行与报告生成返回 **409**（`事件不属于当前 assignment/manifest`）；
- 学生**无法自救**——`start_new_attempt` 同样以「没有与当前 manifest 匹配的开放作业」拒绝；
- 只有教师能恢复：新建一个绑定新 manifest 的 assignment（`POST /api/classroom/assignments`），
  或在维护窗口内更新既有作业的绑定。

发布前后各查一次作用域，确认没有落空：

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/classroom/context" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["assignment_manifest_id"], d["manifest_mismatch"])'
# 期望：<新 manifest_id> False
```

同一机制也会让**测试库**失配：若开发机的 `gvclab_test` 里留有绑定旧 manifest 的作业，
`pytest` 会出现若干 `assert 409 == 200`（集中在 `tests/test_api.py` 的回归用例）。这不是代码
缺陷，重置测试库即可：

```bash
GVCSIM_PG_DSN=...gvclab_test GVCSIM_DEMO_MODE=1 GVCSIM_BOOTSTRAP_PASSWORD=... \
  .venv/bin/gvcsim classroom-init --reset
```

## 回滚

记录切换前的 `/opt/gvcsim/current` 目标。应用回滚只切换到一个已验证、且能读取当前数据库 schema 和 assignment manifest 的 release：

```bash
previous_release=/opt/gvcsim/releases/REPLACE_WITH_VERIFIED_RELEASE
ssh deploy@101.201.151.30 "sudo bash -lc '
  set -euo pipefail
  test -x $previous_release/.venv/bin/gvcsim
  ln -sfn $previous_release /opt/gvcsim/current.next
  mv -Tf /opt/gvcsim/current.next /opt/gvcsim/current
  systemctl restart gvcsim-api.service
  curl -fsS http://127.0.0.1:18000/health
'"
```

若必须恢复数据库，先停止 API，在一个新建的恢复数据库中运行 `pg_restore --list` 和试恢复，核对后再切换 DSN。不要直接覆盖唯一生产库。

## 审计与日常运维

```bash
sudo systemctl status gvcsim-api.service --no-pager -l
sudo journalctl -u gvcsim-api.service --since today
sudo find /var/backups/gvcsim -maxdepth 1 -type f -name '*.dump' -printf '%TY-%Tm-%Td %TT %s %p\n'
```

至少监控：登录失败/限流、401/403/5xx、报告生成失败、manifest stale、QC override、教师评分和 assignment 变更。备份需定期在隔离数据库做恢复演练；只生成但从未恢复验证的 dump 不能视为可用备份。
