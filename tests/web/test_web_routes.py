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

"""领域路由的行为断言（cancel-handoff 改判补发、探针/观测面）。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

import workflow_controller.api.session_api as session_api_module
from workflow_controller.api.event_api import EventAPI
from workflow_controller.api.session_api import SessionAPI, WorkflowSessionOperationError
from workflow_controller.core.orchestrator import SESSION_DRAIN_TIMEOUT_S
from workflow_controller.core.run_coordinator import (
    KILL_GRACE_S,
    STOP_DRAIN_TIMEOUT_S,
    SURROGATE_SNAPSHOT_TIMEOUT_S,
    SURROGATE_THREAD_DRAIN_S,
    TASK_CANCEL_EXIT_TIMEOUT_S,
)
from workflow_controller.web.app import ORCHESTRATOR_SHUTDOWN_TIMEOUT_S
from workflow_controller.web.routes import overview_routes, sessions_routes
from workflow_controller.web.routes.sessions_routes import cancel_handoff_session

if TYPE_CHECKING:
    from collections.abc import Callable


class _HandoffSession:
    """最小 session stub：仅覆盖收编路径触达的字段与 emit_outcome。"""

    def __init__(self) -> None:
        self.id = "s1"
        self.role = "handoff_agent"
        self.result: str | None = None
        self.loop_status = "yes"
        self.stop_reason: str | None = None
        self.emitted: list[tuple[str, str | None]] = []
        self.order: list[str] = []

    async def emit_outcome(self, kind: str) -> None:
        self.order.append("emit")
        self.emitted.append((kind, self.stop_reason))


def _request_with(orch) -> SimpleNamespace:
    # 真实 SessionAPI：补发经 api 面走，词表映射保持被测
    api = SimpleNamespace(session=SessionAPI(orch))
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(api=api)))


async def test_cancel_handoff_rewrites_outcome_to_failed() -> None:
    session = _HandoffSession()
    order = session.order
    pool = SimpleNamespace(
        get=lambda _sid: session,
        stop=AsyncMock(side_effect=lambda _sid: order.append("stop")),
        persist=AsyncMock(side_effect=lambda _s: order.append("persist")),
    )
    orch = SimpleNamespace(
        pool=pool,
        deactivate_session=AsyncMock(side_effect=lambda _s, **_kw: order.append("deactivate")),
    )

    resp = await cancel_handoff_session("s1", _request_with(orch))

    assert resp == {"ok": True}
    # 停用 → 停止 → 落名册 → 补发结局：pool.stop 已发 stopped（user_pause），
    # 改判 failed/user_cancel 是新的阶段事实，须在名册落定后补发
    assert order == ["deactivate", "stop", "persist", "emit"]
    assert session.emitted == [("failed", "user_cancel")]
    assert session.result == "fail"
    assert session.loop_status == "no"
    assert session.stop_reason == "user_cancel"


async def test_cancel_handoff_rejects_missing_or_non_handoff_session() -> None:
    missing = SimpleNamespace(pool=SimpleNamespace(get=lambda _sid: None))
    assert await cancel_handoff_session("s1", _request_with(missing)) == {
        "ok": False,
        "error": "Session not found",
    }

    plain = _HandoffSession()
    plain.role = "worker"
    orch = SimpleNamespace(pool=SimpleNamespace(get=lambda _sid: plain))
    assert await cancel_handoff_session("s1", _request_with(orch)) == {
        "ok": False,
        "error": "Not a handoff session",
    }


async def test_start_session_null_cli_wrapper_falls_back_to_project_default() -> None:
    """验证 null wrapper 回退项目默认。"""
    session = AsyncMock()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(api=SimpleNamespace(session=session))),
    )

    await sessions_routes.start_session(
        {"project_dir": "/proj", "prompt": "task", "cli_wrapper": None},
        request,
    )

    assert session.start.await_args.kwargs["cli_wrapper"] is None


async def test_start_session_legacy_thinking_false_maps_to_disabled() -> None:
    session = AsyncMock()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(api=SimpleNamespace(session=session))),
    )

    await sessions_routes.start_session(
        {"project_dir": "/proj", "reviewer_thinking_enabled": False},
        request,
    )

    reviewer = session.start.await_args.kwargs["reviewer"]
    assert reviewer.thinking_mode == "disabled"


async def test_start_session_passes_reviewer_max_tokens(monkeypatch) -> None:
    """验证新内核 reviewer max_tokens 覆盖项透传。"""
    session = AsyncMock()
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(api=SimpleNamespace(session=session))),
    )

    class NewReviewerOverrides:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    monkeypatch.setattr(sessions_routes, "_REVIEWER_START_SUPPORTS_MAX_TOKENS", True)
    monkeypatch.setattr(sessions_routes, "ReviewerStartOverrides", NewReviewerOverrides)
    await sessions_routes.start_session(
        {"project_dir": "/proj", "reviewer_max_tokens": 8192},
        request,
    )
    assert session.start.await_args.kwargs["reviewer"].max_tokens == 8192


_SESSION_ROUTES = (
    (sessions_routes.stop_session, "stop"),
    (sessions_routes.pause_session, "pause"),
    (sessions_routes.play_session, "play"),
    (sessions_routes.resume_session, "resume"),
    (sessions_routes.restart_session, "restart"),
    (sessions_routes.inject_prompt, "inject_prompt"),
    (sessions_routes.send_message, "send_message"),
)


async def _call_session_route(route_fn, method: str) -> None:
    exc = WorkflowSessionOperationError("s1", "r9")
    session = SimpleNamespace(**{meth: AsyncMock(side_effect=exc) for _, meth in _SESSION_ROUTES})
    state = SimpleNamespace(api=SimpleNamespace(session=session))
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    if method in ("inject_prompt", "send_message"):
        await route_fn("s1", {"text": "hi"}, request)
    else:
        await route_fn("s1", request)


@pytest.mark.parametrize("route_fn,method", _SESSION_ROUTES)
async def test_workflow_session_rejection_maps_409(route_fn, method) -> None:
    with pytest.raises(HTTPException) as ei:
        await _call_session_route(route_fn, method)

    assert ei.value.status_code == 409
    assert "/api/v1/runs/r9/sessions/s1" in ei.value.detail


async def test_send_restores_evicted_session_before_inject_and_resume() -> None:
    session = SimpleNamespace(state=SimpleNamespace(value="idle"))
    current = [None]
    steps: list[str] = []

    def restore(_sid: str):
        steps.append("restore")
        current[0] = session
        return session

    async def inject(_sid: str, _text: str):
        assert current[0] is session
        steps.append("inject")

    async def resume(_sid: str):
        assert current[0] is session
        steps.append("resume")

    orch = SimpleNamespace(
        affiliation=SimpleNamespace(resolve=lambda _sid: None),
        pool=SimpleNamespace(get=lambda _sid: current[0]),
        restore_session_from_store=restore,
        inject_prompt=inject,
        resume_session=resume,
    )
    assert await SessionAPI(orch).send_message("s1", "hello") is True
    assert steps == ["restore", "inject", "resume"]


def test_orchestrator_shutdown_timeout_covers_run_plane_worst() -> None:
    # 关停并发收尾：run 平面的耗时上界 = 单个卡死 run 的完整收尾（成员
    # 数按下界 5 计）。常量被调到低于该上界时测试必然失败——否则 run
    # 平面之后的 pool/插件/bus 收尾步骤会被 lifespan 的 wait_for 中途取消
    single_run_worst = (
        4 * STOP_DRAIN_TIMEOUT_S  # 排空窗 + 终态扫掠出生/spawn/kill 内三次排空
        + TASK_CANCEL_EXIT_TIMEOUT_S  # cancel 后任务退出等待（取消可被收尾路径吸收）
        + SURROGATE_THREAD_DRAIN_S  # 代办快照前在途驱动线程退出等待
        + SURROGATE_SNAPSHOT_TIMEOUT_S  # 代办快照
        + 5 * SESSION_DRAIN_TIMEOUT_S  # 逐成员 stop_session
        + KILL_GRACE_S  # 进程组 SIGTERM 宽限
    )
    assert single_run_worst < ORCHESTRATOR_SHUTDOWN_TIMEOUT_S


# ── 探针与观测面（providers / test-model / chain / health）───────────────


async def test_providers_prefers_configured_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        session_api_module,
        "list_opencode_providers",
        lambda: ([{"provider": "p", "models": ["m"]}], "p/default"),
    )
    orch = SimpleNamespace(config=SimpleNamespace(model="p/custom"))
    assert await sessions_routes.session_providers(_request_with(orch)) == {
        "providers": [{"provider": "p", "models": ["m"]}],
        "current_model": "p/custom",
    }


async def test_providers_falls_back_to_first_default_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        session_api_module,
        "list_opencode_providers",
        lambda: ([{"provider": "p", "models": ["m"]}], "p/default"),
    )
    orch = SimpleNamespace(config=SimpleNamespace(model=""))
    resp = await sessions_routes.session_providers(_request_with(orch))
    assert resp["current_model"] == "p/default"


async def test_test_model_rejects_invalid_model_format() -> None:
    request = _request_with(SimpleNamespace())
    resp = await sessions_routes.session_test_model({"model": "no-slash"}, request)
    assert resp == {"success": False, "error": "Invalid model format, use provider/model"}


async def test_chain_returns_payload_and_folds_errors() -> None:
    store = SimpleNamespace(
        get_handoff_chain=AsyncMock(return_value={"predecessors": ["a"], "successors": []})
    )
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(api=SimpleNamespace(event=EventAPI(store))))
    )

    assert await sessions_routes.get_session_chain("s1", request) == {
        "predecessors": ["a"],
        "successors": [],
    }

    store.get_handoff_chain = AsyncMock(side_effect=RuntimeError("db busy"))
    assert await sessions_routes.get_session_chain("s1", request) == {
        "error": "RuntimeError: db busy",
    }


async def test_health_shape_covers_hook_server_flag_and_session_count() -> None:
    running = SimpleNamespace(
        hook_server_active=True,
        pool=SimpleNamespace(list_sessions=lambda: [object(), object()]),
    )
    assert await overview_routes.health_check(_request_with(running)) == {
        "ok": True,
        "orchestrator": "running",
        "hook_server": True,
        "sessions": 2,
    }

    no_hook_server = SimpleNamespace(
        hook_server_active=False,
        pool=SimpleNamespace(list_sessions=lambda: []),
    )
    resp = await overview_routes.health_check(_request_with(no_hook_server))
    assert resp["hook_server"] is False
    assert resp["sessions"] == 0


# ── config 响应组合：内核段 + 装配期注入的领域配置段 ────────────────────────


def _provider(reads: list[dict], saves: list[dict]) -> SimpleNamespace:
    """领域段服务桩：记录读写调用。"""
    return SimpleNamespace(
        read_config_section=lambda: (
            reads.append({}),
            {"repo_url": "https://example.com/r.git", "snapshot_paths": []},
        )[1],
        validate_config_section=lambda partial: None,
        save_config_section=lambda partial: (
            saves.append(partial),
            {"repo_url": partial.get("repo_url", ""), "snapshot_paths": []},
        )[1],
    )


def _config_update_request(
    update: Callable[[dict], dict], provider: SimpleNamespace
) -> SimpleNamespace:
    """构造带 context_bay 领域段的 PUT /config 请求桩。"""
    api = SimpleNamespace(
        config=SimpleNamespace(update_config=update, restart_reviewer=AsyncMock(return_value=None))
    )
    return SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(api=api, config_section_providers={"context_bay": provider})
        )
    )


async def test_config_response_composes_domain_sections() -> None:
    """GET /config 在内核配置上组合领域段；无注入时不多出键。"""
    from workflow_controller.web.routes.config_routes import get_config

    api = SimpleNamespace(config=SimpleNamespace(get_config_dict=lambda: {"runtime": "opencode"}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(api=api)))
    resp = await get_config(request)
    assert resp == {"runtime": "opencode"}  # 无注入段：原样返回

    request.app.state.config_section_providers = {"context_bay": _provider([], [])}
    resp = await get_config(request)
    assert resp["context_bay"] == {"repo_url": "https://example.com/r.git", "snapshot_paths": []}


async def test_config_update_dispatches_domain_section() -> None:
    """PUT /config 把领域段分派给段所有者保存，内核更新不再收到领域段。"""
    from workflow_controller.web.routes.config_routes import update_config

    saves: list[dict] = []
    updates: list[dict] = []
    request = _config_update_request(
        lambda body: (updates.append(body), {"watchdog": {"enabled": True}})[1],
        _provider([], saves),
    )

    resp = await update_config(
        {"watchdog": {"enabled": True}, "context_bay": {"repo_url": "https://example.com/r.git"}},
        request,
    )
    assert saves == [{"repo_url": "https://example.com/r.git"}]  # 领域段已分派
    assert updates == [{"watchdog": {"enabled": True}}]  # 内核更新不再收到领域段
    assert resp["context_bay"]["repo_url"] == "https://example.com/r.git"


async def test_config_update_brand_name_syncs_swagger_title() -> None:
    """PUT /config 改品牌名：app.title 同步并作废 openapi 缓存，Swagger 标题免重启生效。"""
    from workflow_controller.web.routes.config_routes import update_config

    api = SimpleNamespace(
        config=SimpleNamespace(
            update_config=lambda body: {"brand_name": "Ascendbot"},
            restart_reviewer=AsyncMock(return_value=None),
        )
    )
    app = SimpleNamespace(
        state=SimpleNamespace(api=api),
        title="Workflow Controller",
        openapi_schema={"info": {"title": "Workflow Controller"}},
    )

    await update_config({"brand_name": "Ascendbot"}, SimpleNamespace(app=app))
    assert app.title == "Ascendbot"
    assert app.openapi_schema is None  # 缓存不作废则 /openapi.json 仍是旧标题

    # 非 brand 请求不触碰标题
    app2 = SimpleNamespace(
        state=SimpleNamespace(
            api=SimpleNamespace(
                config=SimpleNamespace(
                    update_config=lambda body: {"watchdog": {"enabled": True}},
                    restart_reviewer=AsyncMock(return_value=None),
                )
            )
        ),
        title="Workflow Controller",
        openapi_schema={"info": {"title": "Workflow Controller"}},
    )
    await update_config({"watchdog": {"enabled": True}}, SimpleNamespace(app=app2))
    assert app2.title == "Workflow Controller"
    assert app2.openapi_schema == {"info": {"title": "Workflow Controller"}}


async def test_config_update_domain_validation_error_rejects_before_kernel_persist() -> None:
    """PUT /config 领域段坏值：在内核落盘前拒绝，update_config（内含 save）不执行。"""
    from workflow_controller.web.routes.config_routes import update_config

    saves: list[dict] = []
    updates: list[dict] = []
    api = SimpleNamespace(
        config=SimpleNamespace(
            update_config=lambda body: (updates.append(body), {"watchdog": {"enabled": True}})[1],
            restart_reviewer=AsyncMock(return_value=None),
        )
    )
    bad_provider = SimpleNamespace(
        read_config_section=lambda: {},
        validate_config_section=lambda partial: (_ for _ in ()).throw(
            ValueError("上传配置校验失败")
        ),
        save_config_section=lambda partial: (saves.append(partial), {})[1],
    )
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(api=api, config_section_providers={"context_bay": bad_provider})
        )
    )

    with pytest.raises(HTTPException) as exc_info:
        await update_config(
            {"watchdog": {"enabled": True}, "context_bay": {"typo": 1}},
            request,
        )
    assert exc_info.value.status_code == 400
    assert "上传配置校验失败" in exc_info.value.detail
    assert updates == []  # 内核未更新（未落盘）
    assert saves == []  # 领域段未保存


async def test_config_update_kernel_validation_error_returns_400_and_skips_domain_save() -> None:
    """PUT /config 内核段坏值（赋值校验的 ValidationError）转 400，领域段不保存。"""
    from workflow_controller.config.settings import WatchdogConfig
    from workflow_controller.web.routes.config_routes import update_config

    saves: list[dict] = []

    def _kernel_rejects(body: dict) -> dict:
        # 与内核 update_config 同源：坏值触发赋值校验抛 pydantic ValidationError
        return WatchdogConfig.model_validate(body["watchdog"])

    request = _config_update_request(_kernel_rejects, _provider([], saves))

    with pytest.raises(HTTPException) as exc_info:
        await update_config(
            {
                "watchdog": {"subagent_timeout_seconds": "abc"},
                "context_bay": {"repo_url": "https://example.com/r.git"},
            },
            request,
        )
    assert exc_info.value.status_code == 400
    assert saves == []  # 内核校验失败在先，领域段不落盘
