# 公开 API 与事件约定

> 本文档由 `tests/contract/manifest.yaml` 生成；改动清单后运行
> `python scripts/generate_api_contract_doc.py` 再提交，生成校验测试会拦截未同步的漂移。

## Stable API — 已承担兼容责任；只允许向后兼容地增加端点、字段与事件类型（59 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|
| POST | `/api/v1/runs` | 201 |
| GET | `/api/v1/runs` | — |
| GET | `/api/v1/runs/{run_id}` | 404 |
| GET | `/api/v1/runs/{run_id}/state` | 404 |
| POST | `/api/v1/runs/{run_id}/pause` | 202 |
| POST | `/api/v1/runs/{run_id}/resume` | 202 |
| POST | `/api/v1/runs/{run_id}/stop` | 202 |
| POST | `/api/v1/runs/{run_id}/restart` | 202 |
| POST | `/api/v1/runs/{run_id}/steer` | 202 |
| POST | `/api/v1/runs/{run_id}/driver/op` | 404, 422, 503 |
| POST | `/api/v1/runs/{run_id}/export` | 404, 409 |
| GET | `/api/v1/runs/{run_id}/export/{task_id}` | 404 |
| POST | `/api/v1/runs/{run_id}/export/{task_id}/cancel` | 404 |
| GET | `/api/v1/runs/{run_id}/export/{task_id}/download` | 404, 409, 410 |
| GET | `/api/v1/runs/{run_id}/events` | 404, 422 |
| POST | `/api/v1/runs/{run_id}/sessions/{session_id}/pause` | 202 |
| POST | `/api/v1/runs/{run_id}/sessions/{session_id}/resume` | 202 |
| POST | `/api/v1/runs/{run_id}/sessions/{session_id}/stop` | 202 |
| POST | `/api/v1/runs/{run_id}/sessions/{session_id}/inject` | 202 |
| POST | `/api/v1/runs/{run_id}/sessions/{session_id}/send` | 202 |
| DELETE | `/api/v1/runs/{run_id}` | — |
| GET | `/api/v1/sessions` | — |
| GET | `/api/v1/sessions/{session_id}` | — |
| POST | `/api/v1/sessions/start` | 400 |
| POST | `/api/v1/sessions/stop-all` | — |
| POST | `/api/v1/sessions/{session_id}/stop` | 409 |
| POST | `/api/v1/sessions/{session_id}/pause` | 409 |
| POST | `/api/v1/sessions/{session_id}/play` | 409 |
| POST | `/api/v1/sessions/{session_id}/resume` | 400, 409 |
| PUT | `/api/v1/sessions/{session_id}/reviewer-mode` | 400 |
| PUT | `/api/v1/sessions/{session_id}/reviewer-task-goal` | 400 |
| POST | `/api/v1/sessions/{session_id}/restart` | 400, 409 |
| DELETE | `/api/v1/sessions/{session_id}` | 400, 500 |
| POST | `/api/v1/sessions/{session_id}/inject` | 409 |
| POST | `/api/v1/sessions/{session_id}/send` | 400, 409, 422 |
| GET | `/api/v1/config` | — |
| PUT | `/api/v1/config` | 400 |
| POST | `/api/v1/config/load-from-dir` | — |
| POST | `/api/v1/config/save` | — |
| GET | `/api/v1/project-config` | — |
| PUT | `/api/v1/project-config` | — |
| POST | `/api/v1/recent-dirs` | — |
| DELETE | `/api/v1/recent-dirs` | — |
| GET | `/api/v1/auth/status` | — |
| GET | `/api/v1/auth/keys` | — |
| POST | `/api/v1/auth/keys` | 400 |
| DELETE | `/api/v1/auth/keys/{provider_index}` | — |
| POST | `/api/v1/auth/activate` | — |
| POST | `/api/v1/auth/test` | — |
| POST | `/api/v1/auth/keys/{provider_index}/test` | — |
| POST | `/api/v1/auth/test-key` | 400 |
| GET | `/api/v1/auth/settings` | — |
| PUT | `/api/v1/auth/settings` | — |
| GET | `/api/v1/health` | — |
| GET | `/api/v1/pipeline` | — |
| GET | `/api/v1/sessions/{session_id}/pipeline` | — |
| GET | `/api/v1/usage` | — |
| GET | `/api/v1/events` | — |
| GET | `/api/v1/events/stream` | — |

## Experimental API — 较新或后续迁移/删除的面，不承诺兼容（28 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|
| GET | `/api/v1/sessions/{session_id}/subagent-hint` | — |
| POST | `/api/v1/sessions/{session_id}/subagent-hint` | — |
| DELETE | `/api/v1/sessions/{session_id}/subagent-hint/{subagent_type}` | — |
| DELETE | `/api/v1/sessions/{session_id}/subagent-hint` | — |
| GET | `/api/v1/project/subagent-hint` | — |
| POST | `/api/v1/project/subagent-hint` | — |
| DELETE | `/api/v1/project/subagent-hint/{subagent_type}` | — |
| DELETE | `/api/v1/project/subagent-hint` | — |
| GET | `/api/v1/sessions/{session_id}/instructions` | — |
| POST | `/api/v1/sessions/{session_id}/instructions` | — |
| DELETE | `/api/v1/sessions/{session_id}/instructions` | — |
| GET | `/api/v1/project/instructions` | — |
| POST | `/api/v1/project/instructions` | — |
| DELETE | `/api/v1/project/instructions` | — |
| GET | `/api/v1/sessions/{session_id}/agents` | — |
| GET | `/api/v1/project/agents` | — |
| GET | `/api/v1/sessions/opencode` | — |
| POST | `/api/v1/sessions/import` | — |
| GET | `/api/v1/sessions/claude` | — |
| POST | `/api/v1/sessions/import-claude` | — |
| GET | `/api/v1/session/providers` | — |
| POST | `/api/v1/session/test-model` | — |
| GET | `/api/v1/list-directory` | — |
| POST | `/api/v1/insight/import` | — |
| GET | `/api/v1/insight/status` | — |
| POST | `/api/v1/sessions/{session_id}/upload-to-context-bay` | — |
| GET | `/api/v1/sessions/{session_id}/upload-progress/{task_id}` | — |
| GET | `/api/v1/sessions/{session_id}/chain` | — |

## Internal API — 内核/控制台内部装配面，不对消费者承诺（9 条）

| 方法 | 路径 | 登记状态码 |
|---|---|---|
| GET | `/api/v1/plugins` | — |
| POST | `/api/v1/plugins/{name}/toggle` | — |
| POST | `/api/v1/plugins/install` | — |
| GET | `/api/v1/plugins/{name}/config` | — |
| PUT | `/api/v1/plugins/{name}/config` | — |
| GET | `/api/v1/plugins/breather/builtin-instructions/{kind}` | 404 |
| POST | `/api/v1/plugins/breather/template` | 400 |
| POST | `/api/v1/sessions/{session_id}/cancel-handoff` | — |
| GET | `/api/v1/sessions/{session_id}/watchdog/alerts` | — |

## SSE 事件名（9 个）

`claude_event`、`session_update`、`pipeline_update`、`usage_update`、`config_update`、`auth_update`、`handoff_update`、`loop_update`、`server_reload`

## 告警事件词表（3 个）

`fault.subagent_timeout`、`fault.file_stall`、`fault.keyword_detected`

## 事件行与 payload 字段

| payload 行 | 顶层字段 | 来源 |
|---|---|---|
| events_row | `id`、`session_id`、`iteration`、`timestamp`、`event_type`、`data`、`run_id`、`context` | session/events.py（Event.to_dict） |
| run_events_row | `id`、`run_id`、`context`、`timestamp`、`event_type`、`data` | store/event_store.py（_row_to_run_event） |
| event_info | `rowid`、`session_id`、`event_type`、`iteration`、`timestamp`、`data`、`run_id`、`context` | api/event_api.py |
| session_outcome | `session_id`、`kind`、`stop_reason`、`last_error`、`result_digest`、`iteration`、`context` | session/events.py（SessionOutcome.to_payload） |
| config_update | `brand_name`、`project_dir`、`skills_path`、`agents_path`、`hook_server`、`reviewer`、`sessions`、`watchdog`、`recent_dirs`；另按已装配领域配置段动态追加键，如 context_bay | api/config_api.py + web/routes/common.py（段组合） |
| fault_alert | `alert_id`、`rule`、`severity`、`session_id`、`message`、`agent_id`、`agent_type`、`started_at`、`elapsed_seconds`、`threshold_seconds`、`file_path`、`stall_count`、`keyword`、`timestamp` | watchdog/state.py（Alert.to_dict） |
