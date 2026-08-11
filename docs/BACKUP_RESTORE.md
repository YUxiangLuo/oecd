# 备份与恢复

PostgreSQL 保存账号、班级、公告及当前学习状态。用 `pg_dump --format=custom` 备份，用 `pg_restore --single-transaction` 恢复到空数据库，并确认 schema 为 `gvcsim-teaching-db-v8`。

`data/processed` 不需要版本备份；它由 `uv run gvcsim compute` 从原始数据重新生成。成功标记是 `data/processed/dataset.json`。

恢复脚本 `scripts/restore_classroom_drill.py` 只核对 v8 表和行数，不再枚举历史 manifest。
