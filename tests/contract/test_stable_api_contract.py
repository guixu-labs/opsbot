# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""stable API 约定测试 — 路由面与 manifest 清单互锁，登记状态码逐条行为断言。"""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from workflow_controller.api.run_api import RunApiNotFoundError
from workflow_controller.api.session_api import WorkflowSessionOperationError
from workflow_controller.web.console import register_context_bay_router, register_domain_routes

from tests.contract.manifest import routes_by_class, self_owned_routes

# 桩改写：对假 CoreAPI 的某个子面方法注入抛错行为
CoreApiMutation = Callable[[SimpleNamespace], None]


def _reject(sub_api: str, method: str, exc: Exception) -> CoreApiMutation:
    """构造桩改写：让 api.<sub_api>.<method> 抛出 exc。"""

    def mutate(api: SimpleNamespace) -> None:
        getattr(getattr(api, sub_api), method).side_effect = exc

    return mutate


def _seed_export_task(
    task_id: str,
    run_id: str,
    *,
    status: str,
    zip_path: str | None = None,
) -> CoreApiMutation:
    """改写：向导出注册表登记一个任务，供进度/下载/取消端点行为断言。"""
    from workflow_controller.web.routes import runs_routes as rr

    def mutate(api: SimpleNamespace) -> None:
        getattr(rr, "_EXPORT_TASKS")[task_id] = {
            "run_id": run_id,
            "status": status,
            "done": 0,
            "total": 0,
            "error": None,
            "result": None,
            "zip_path": zip_path,
            "cancel": False,
            "done_at": None,
        }

    return mutate


def _refuse_export(reason: str) -> CoreApiMutation:
    """改写：让 run.export_refusal_reason 返回非空拒绝原因（导出 409）。"""

    def mutate(api: SimpleNamespace) -> None:
        api.run.export_refusal_reason.return_value = reason

    return mutate


def _fake_core_api() -> SimpleNamespace:
    """覆盖断言触达的 CoreAPI 面：各方法默认成功，由用例改写为抛错。"""
    run_record = SimpleNamespace(status="running")
    run = SimpleNamespace(
        create=AsyncMock(
            return_value=SimpleNamespace(run_id="r1", status="created", format="", kind="container")
        ),
        get_run=AsyncMock(return_value=SimpleNamespace(run_id="r1")),
        state=AsyncMock(return_value={}),
        pause=AsyncMock(return_value=run_record),
        resume=AsyncMock(return_value=run_record),
        restart=AsyncMock(return_value=run_record),
        stop=AsyncMock(return_value=run_record),
        steer=AsyncMock(return_value=None),
        request_driver_op=AsyncMock(return_value={}),
        export_run=AsyncMock(return_value={}),
        export_refusal_reason=MagicMock(return_value=None),
        fetch_events=AsyncMock(return_value=([], "6", 50)),
        pause_session=AsyncMock(return_value=None),
        resume_session=AsyncMock(return_value=None),
        stop_session=AsyncMock(return_value=None),
        inject_session=AsyncMock(return_value=None),
        send_session=AsyncMock(return_value=False),
    )
    session = SimpleNamespace(
        start=AsyncMock(return_value={"session_id": "s1"}),
        stop=AsyncMock(return_value=None),
        pause=AsyncMock(return_value=None),
        play=AsyncMock(return_value=None),
        resume=AsyncMock(return_value=None),
        restart=AsyncMock(return_value=None),
        inject_prompt=AsyncMock(return_value=None),
        send_message=AsyncMock(return_value=False),
        delete=AsyncMock(return_value={"ok": True}),
        set_session_reviewer_mode=AsyncMock(return_value=None),
        set_session_reviewer_task_goal=AsyncMock(return_value="新目标"),
    )
    config = SimpleNamespace(
        update_config=MagicMock(return_value={}),
    )
    auth = SimpleNamespace(
        set_keys_validated=AsyncMock(return_value={}),
        validate_candidate=AsyncMock(return_value={}),
    )
    return SimpleNamespace(run=run, session=session, config=config, auth=auth)


def _domain_routes_app(api: SimpleNamespace) -> FastAPI:
    """按生产装配注册自有领域路由（CoreAPI 用桩）。"""
    app = FastAPI()
    app.state.api = api
    register_domain_routes(app)
    return app


# (方法, 文档路径, 登记码) → (请求路径, 请求体, 桩改写)；与文档登记的码集互锁
_STATUS_CASES: dict[
    tuple[str, str, int], tuple[str, dict[str, Any] | None, CoreApiMutation | None]
] = {
    ("POST", "/api/v1/runs", 201): ("/api/v1/runs", {}, None),
    ("GET", "/api/v1/runs/{run_id}", 404): (
        "/api/v1/runs/r0",
        None,
        _reject("run", "get_run", RunApiNotFoundError("r0")),
    ),
    ("GET", "/api/v1/runs/{run_id}/state", 404): (
        "/api/v1/runs/r0/state",
        None,
        _reject("run", "state", RunApiNotFoundError("r0")),
    ),
    ("GET", "/api/v1/runs/{run_id}/events", 404): (
        "/api/v1/runs/r0/events",
        None,
        _reject("run", "fetch_events", RunApiNotFoundError("r0")),
    ),
    ("GET", "/api/v1/runs/{run_id}/events", 422): (
        # 422 由 core 的 ValueError 映射产生；cursor 在路由层不校验，不带该 query
        "/api/v1/runs/r1/events",
        None,
        _reject("run", "fetch_events", ValueError("cursor")),
    ),
    ("POST", "/api/v1/runs/{run_id}/driver/op", 404): (
        "/api/v1/runs/r0/driver/op",
        {"op": "go"},
        _reject("run", "request_driver_op", RunApiNotFoundError("r0")),
    ),
    ("POST", "/api/v1/runs/{run_id}/driver/op", 422): ("/api/v1/runs/r1/driver/op", {}, None),
    ("POST", "/api/v1/runs/{run_id}/driver/op", 503): (
        "/api/v1/runs/r1/driver/op",
        {"op": "go"},
        _reject("run", "request_driver_op", RuntimeError("driver down")),
    ),
    ("POST", "/api/v1/runs/{run_id}/export", 404): (
        "/api/v1/runs/r0/export",
        None,
        _reject("run", "get_run", RunApiNotFoundError("r0")),
    ),
    ("POST", "/api/v1/runs/{run_id}/export", 409): (
        "/api/v1/runs/r1/export",
        None,
        _refuse_export("隐式 run 不支持导出"),
    ),
    ("GET", "/api/v1/runs/{run_id}/export/{task_id}", 404): (
        "/api/v1/runs/r1/export/missing",
        None,
        None,
    ),
    ("POST", "/api/v1/runs/{run_id}/export/{task_id}/cancel", 404): (
        "/api/v1/runs/r1/export/missing/cancel",
        None,
        None,
    ),
    ("GET", "/api/v1/runs/{run_id}/export/{task_id}/download", 404): (
        "/api/v1/runs/r1/export/missing/download",
        None,
        None,
    ),
    ("GET", "/api/v1/runs/{run_id}/export/{task_id}/download", 409): (
        "/api/v1/runs/r1/export/t1/download",
        None,
        _seed_export_task("t1", "r1", status="running"),
    ),
    ("GET", "/api/v1/runs/{run_id}/export/{task_id}/download", 410): (
        "/api/v1/runs/r1/export/t2/download",
        None,
        _seed_export_task("t2", "r1", status="done", zip_path="/nonexistent/bundle.zip"),
    ),
    ("POST", "/api/v1/sessions/start", 400): (
        "/api/v1/sessions/start",
        {"project_dir": "/p"},
        _reject("session", "start", ValueError("bad dir")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/stop", 409): (
        "/api/v1/sessions/s1/stop",
        None,
        _reject("session", "stop", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/pause", 409): (
        "/api/v1/sessions/s1/pause",
        None,
        _reject("session", "pause", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/play", 409): (
        "/api/v1/sessions/s1/play",
        None,
        _reject("session", "play", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/resume", 400): (
        "/api/v1/sessions/s1/resume",
        None,
        _reject("session", "resume", RuntimeError("not pausable")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/resume", 409): (
        "/api/v1/sessions/s1/resume",
        None,
        _reject("session", "resume", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("PUT", "/api/v1/sessions/{session_id}/reviewer-mode", 400): (
        "/api/v1/sessions/s1/reviewer-mode",
        {"mode": "x"},
        _reject("session", "set_session_reviewer_mode", ValueError("bad mode")),
    ),
    ("PUT", "/api/v1/sessions/{session_id}/reviewer-task-goal", 400): (
        "/api/v1/sessions/s1/reviewer-task-goal",
        {"task_goal": " "},
        _reject("session", "set_session_reviewer_task_goal", ValueError("blank goal")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/restart", 400): (
        "/api/v1/sessions/s1/restart",
        None,
        _reject("session", "restart", ValueError("cannot restart")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/restart", 409): (
        "/api/v1/sessions/s1/restart",
        None,
        _reject("session", "restart", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("DELETE", "/api/v1/sessions/{session_id}", 400): (
        "/api/v1/sessions/s1?clean_reconstruct=bogus",
        None,
        None,
    ),
    ("DELETE", "/api/v1/sessions/{session_id}", 500): (
        "/api/v1/sessions/s1",
        None,
        _reject("session", "delete", RuntimeError("cleanup failed")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/inject", 409): (
        "/api/v1/sessions/s1/inject",
        {"text": "hi"},
        _reject("session", "inject_prompt", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/send", 400): (
        "/api/v1/sessions/s1/send",
        {"text": "hi"},
        _reject("session", "send_message", ValueError("no session")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/send", 409): (
        "/api/v1/sessions/s1/send",
        {"text": "hi"},
        _reject("session", "send_message", WorkflowSessionOperationError("s1", "r9")),
    ),
    ("POST", "/api/v1/sessions/{session_id}/send", 422): (
        "/api/v1/sessions/s1/send",
        {"text": ""},
        None,
    ),
    ("PUT", "/api/v1/config", 400): (
        "/api/v1/config",
        {},
        _reject("config", "update_config", ValueError("bad value")),
    ),
    ("POST", "/api/v1/auth/keys", 400): (
        "/api/v1/auth/keys",
        {},
        _reject("auth", "set_keys_validated", ValueError("empty key")),
    ),
    ("POST", "/api/v1/auth/test-key", 400): (
        "/api/v1/auth/test-key",
        {},
        _reject("auth", "validate_candidate", ValueError("bad key")),
    ),
}

# 202 受理族：run 组控与成员控制，受理即返回；请求路径用具体 session_id，
# 占位符字面量会被路径参数原样绑定，不反映真实输入
_ACTION_INPUTS = (
    ("pause", "pause", None),
    ("resume", "resume", None),
    ("stop", "stop", None),
    ("restart", "restart", None),
    ("steer", "steer", {"message": "转向"}),
    ("sessions/{session_id}/pause", "sessions/s1/pause", None),
    ("sessions/{session_id}/resume", "sessions/s1/resume", None),
    ("sessions/{session_id}/stop", "sessions/s1/stop", None),
    ("sessions/{session_id}/inject", "sessions/s1/inject", {"prompt": "hi"}),
    ("sessions/{session_id}/send", "sessions/s1/send", {"prompt": "hi"}),
)
_STATUS_CASES.update(
    (
        ("POST", f"/api/v1/runs/{{run_id}}/{doc_tail}", 202),
        (f"/api/v1/runs/r1/{request_tail}", body, None),
    )
    for doc_tail, request_tail, body in _ACTION_INPUTS
)


def test_self_owned_route_surface_interlocks_with_manifest() -> None:
    """生产装配后的正式路由面必须与清单三分类并集完全一致。"""
    app = FastAPI()
    app.state.api = _fake_core_api()
    register_domain_routes(app)
    register_context_bay_router(app)
    actual: set[tuple[str, str]] = set()
    for route in app.router.routes:
        if not (isinstance(route, APIRoute) and route.path.startswith("/api/v1")):
            continue
        for method in sorted(route.methods - {"HEAD"}):
            actual.add((method, route.path))
    documented = self_owned_routes()
    undocumented = actual - documented
    missing = documented - actual
    assert not undocumented and not missing, (
        f"未登记端点={sorted(undocumented)}，缺失端点={sorted(missing)}"
    )


def test_status_cases_cover_documented_stable_codes() -> None:
    """stable 登记的每个状态码都有行为用例，用例也不得多出登记。"""
    documented = {
        (method, path, code)
        for (method, path), codes in routes_by_class()["stable"].items()
        for code in codes
    }
    missing = documented - set(_STATUS_CASES)
    extra = set(_STATUS_CASES) - documented
    assert not missing and not extra, f"缺用例={sorted(missing)}，多用例={sorted(extra)}"


@pytest.mark.parametrize(
    ("method", "code", "request_path", "body", "mutate"),
    [(method, code, *case) for (method, _path, code), case in sorted(_STATUS_CASES.items())],
    ids=[f"{method}-{path}-{code}" for method, path, code in sorted(_STATUS_CASES)],
)
def test_documented_status_code_stays_pinned(
    method: str,
    code: int,
    request_path: str,
    body: dict[str, Any] | None,
    mutate: CoreApiMutation | None,
) -> None:
    """按登记状态码发真实请求：错误映射或受理码漂移即红。"""
    api = _fake_core_api()
    if mutate is not None:
        mutate(api)
    client = TestClient(_domain_routes_app(api))
    assert client.request(method, request_path, json=body).status_code == code
