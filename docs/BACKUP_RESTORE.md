# 教学数据库备份与隔离恢复演练

本手册用于验证 PostgreSQL 课堂记录能够恢复，并且恢复后的数据库仍满足当前应用 schema、只读
preflight 和历史产物引用契约。恢复演练**绝不直接指向课堂库**。

## 备份范围与责任边界

一份可用的课堂恢复集至少包含：

1. `scripts/backup_classroom.sh` 生成的 PostgreSQL custom archive 与同名 `.sha256`；
2. `data/artifacts/` 中当前版本、回滚版本以及全部课堂记录引用的内容寻址目录；
3. `data/processed` 指针所指版本；
4. 部署配置的离线副本，以及独立保管的认证/证据密钥轮换记录。

数据库 dump **不包含** OECD 原始 CSV、预计算产物、Nginx/systemd 配置或环境密钥。数据库内可能含
账号资料、口令哈希、审计日志和学生提交，因此备份必须加密、限制访问并设置符合学校政策的保留期。
不要把 dump、回执或真实 DSN 提交到 Git。

SHA-256 sidecar 只能发现意外损坏；能同时修改 archive 和 sidecar 的攻击者仍可伪造二者。生产备份还应
使用受控对象存储、不可变保留或独立签名提供真实性与防删除保护。

## 创建数据库备份

从受限的服务环境或秘密管理器加载 DSN，不要把带口令的 DSN 写进命令参数或 shell 历史：

```bash
export GVCSIM_PG_DSN='postgresql://USER:PASSWORD@127.0.0.1:5432/gvclab'
export GVCSIM_BACKUP_DIR=/secure-backups/gvcsim
scripts/backup_classroom.sh
```

脚本会以 `0600` 权限在目标文件系统内生成临时文件，通过 `pg_restore --list` 验证 custom archive，
计算 SHA-256，随后发布：

```text
classroom-YYYYMMDDTHHMMSSZ.dump
classroom-YYYYMMDDTHHMMSSZ.dump.sha256
```

sidecar 与 archive 应作为一组复制。移动后可在它们所在目录复核：

```bash
(cd /secure-backups/gvcsim && sha256sum -c classroom-YYYYMMDDTHHMMSSZ.dump.sha256)
```

`pg_dump` 提供数据库内的一致快照，但不会锁定本项目的文件产物。产物目录是不可变的；复制产物前应先
运行 `gvcsim artifact-prune` dry-run 取得数据库引用列表，并确保复制期间没有执行 `artifact-prune
--apply`。文件系统快照或带版本控制的对象存储优先于临时 `cp`。

## 创建隔离恢复目标

目标必须是新建空库，名称严格以 `_restore_drill` 结尾。不得复用测试库，更不得使用课堂库。下面只展示
本机示例；凭证仍应从秘密管理器载入：

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=alice PGPASSWORD='...'
createdb gvclab_20260809_restore_drill

export GVCSIM_RESTORE_DSN='postgresql://alice:PASSWORD@127.0.0.1:5432/gvclab_20260809_restore_drill'
export GVCSIM_RESTORE_DRILL_CONFIRM=gvclab_20260809_restore_drill
```

恢复脚本同时要求：

- 显式 DSN，拒绝嵌套 libpq service；
- 目标名和确认变量逐字相同；
- 目标没有其他连接、用户 schema、表、函数或自定义类型；
- 目标记录的 collation 版本与当前操作系统一致；若新建空库因系统升级不一致，只能在确认仍为空库后执行
  `ALTER DATABASE gvclab_20260809_restore_drill REFRESH COLLATION VERSION`，不得用刷新版本掩盖已有索引风险；
- archive 与 sidecar 均为普通文件且权限不宽于 `0600`；
- sidecar 只绑定当前 archive，SHA-256 匹配；
- `pg_restore --list` 能读取 archive。

它从不创建、清空、覆盖或删除数据库。

## 执行恢复演练

先把恢复集中的 `data/artifacts/` 放到候选主机，再运行：

```bash
mkdir -m 700 -p dogfood-output/backup-restore
uv run python scripts/restore_classroom_drill.py \
  /secure-backups/gvcsim/classroom-YYYYMMDDTHHMMSSZ.dump \
  --receipt dogfood-output/backup-restore/receipt.json
```

恢复使用 `--single-transaction --no-owner --no-acl`；任一 SQL 错误会回滚整个 restore。成功后脚本会：

1. 以目标 DSN 执行当前版本的只读 `gvcsim preflight`；
2. 核对 `gvcsim-teaching-db-v7`；
3. 记录 PostgreSQL、pg_dump/pg_restore 与数据库 collation 版本，并统计所有 public 表行数，但不导出行内容；
4. 枚举进度、报告、实验会话、提交与学习证据引用的 manifest；
5. 验证每个引用版本在本地 `data/artifacts/` 中存在且摘要有效；
6. 原子写入权限为 `0600`、且绝不覆盖旧文件的 JSON 回执。

回执不包含 DSN、口令、用户名或提交正文。恢复后的数据库会保留供人工抽查，不会自动删除。

## 人工验收与清理

至少检查：

```bash
GVCSIM_PG_DSN="$GVCSIM_RESTORE_DSN" uv run gvcsim preflight
jq '{schema_version, duration_seconds, table_counts, referenced_artifacts}' \
  dogfood-output/backup-restore/receipt.json
```

在隔离网络中使用只读抽样账号检查学生、manifest、提交和报告关联；不要在恢复库触发改密、评分或清理任务。
确认回执已归档后，由操作员再次核对数据库名并显式删除：

```bash
test "$GVCSIM_RESTORE_DRILL_CONFIRM" = gvclab_20260809_restore_drill
dropdb gvclab_20260809_restore_drill
unset GVCSIM_RESTORE_DSN GVCSIM_RESTORE_DRILL_CONFIRM PGPASSWORD
```

## 验收记录

每次正式发布前记录：

- backup 开始/结束 UTC 时间、archive SHA-256 和大小；
- PostgreSQL server 与 `pg_dump`/`pg_restore` 主版本；
- 恢复目标、恢复耗时、schema 版本和 preflight 结果；
- 所有历史 manifest 是否可恢复；
- 业务负责人批准的 RPO/RTO 与本次实测值；
- 清理恢复库的操作人和时间。

本地或 CI 合成库的演练只能验证机械流程，不能替代使用最新生产备份在受控环境中的发布验收。
