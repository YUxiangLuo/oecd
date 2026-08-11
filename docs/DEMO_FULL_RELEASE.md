# 完整发布

完整发布只有代码、v8 数据库和固定产物三部分：

```bash
uv sync --frozen
cd frontend && npm ci && npm run build && cd ..
uv run gvcsim classroom-init --reset
uv run gvcsim compute
uv run gvcsim preflight
sudo systemctl restart gvcsim-api
```

没有 manifest ID、版本目录或 artifact prune。发布前如需保留账号数据，先备份 PostgreSQL；`classroom-init --reset` 会删除全部课堂数据。普通数据重算仅清空学习记录并保留账号、班级与公告。
