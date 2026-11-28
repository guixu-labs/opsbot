# 控制台自有 HTTP 路由约定

> 本文档由 `tests/contract/manifest.yaml` 生成；改动清单后运行
> `python scripts/generate_api_contract_doc.py` 再提交，生成校验测试会拦截未同步的漂移。

> 内核面端点（`/api/v1` 下的 Session、Run、Auth、Config、Plugins、Overview、SSE、Watchdog）、
> SSE 事件名与告警词表的约定住 axcor 仓的 `docs/api-contract.md`；控制台应用复用同一份路由实现，
> 约定测试要求控制台应用的正式路由面去掉下列自有端点后与内核应用完全一致。

## Stable API — 已承担兼容责任；只允许向后兼容地增加端点、字段与事件类型（0 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|

## Experimental API — 较新或后续迁移/删除的面，不承诺兼容（4 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|
| POST | `/api/v1/insight/import` | — |
| GET | `/api/v1/insight/status` | — |
| POST | `/api/v1/sessions/{session_id}/upload-to-context-bay` | — |
| GET | `/api/v1/sessions/{session_id}/upload-progress/{task_id}` | — |

## Internal API — 内核/控制台内部装配面，不对消费者承诺（0 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|
