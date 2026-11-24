# 仓库约定

## 规则

- git commit 信息不携带 Co-Authored-By 等 agent 协作信息
- 发行包共享 `workflow_controller` PEP 420 命名空间：`workflow_controller/` 与 `workflow_controller/web/` 不携带 `__init__.py`，包内子目录的 `__init__.py` 随包维护
- 升级 axcor 依赖时，更新 `pyproject.toml` 中内核及插件的 Git 标签和 `axcor.lock` 中的 `axcor_sha`，执行 `uv lock`，确认 `uv.lock` 解析出的提交均与 `axcor_sha` 一致；CI 打包会校验该标签的 axcor Release 已发布（非 draft）且 7 个 wheel 均带 SHA-256，因此必须先发布 axcor Release，再升级本仓标签
- 注释是代码的补充，只有代码不能自表达的信息才需要注释；计划后续移除的过渡代码，其注释必须包含「删除」并说明何时可删
- 新增类或函数应有单行简洁注释
- 测试只保留必要用例；命名须易读，不限于单词；删除无用与冗余代码
- 前端选型使用 Vue + Naive UI

## 质量门禁

```bash
uv sync
uv run ruff format --check . && uv run ruff check .
uv run lint-imports --no-cache
uv run codespell $(git ls-files '*.md')
uv run pytest -q
```
