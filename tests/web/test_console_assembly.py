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

"""Console 装配顺序回归：插件路由必须先于 SPA catch-all 生效。"""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter, FastAPI

from workflow_controller.web.console import (
    assemble_console,
    include_router_before_catchall,
    register_context_bay_router,
)

if TYPE_CHECKING:
    from pathlib import Path


def _route_paths(app: FastAPI) -> list[str]:
    return [getattr(route, "path", "<no-path>") for route in app.router.routes]


def _plugin_router(path: str) -> APIRouter:
    """带单个 GET 路由的插件 router 桩。"""
    router = APIRouter()

    @router.get(path)
    async def handler() -> dict[str, str]:
        return {"ok": "1"}

    return router


async def _insight_port_without_probing() -> int:
    return 21025


def _console_app_with_startup_plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FastAPI:
    """按生产装配路径组装控制台：伪 dist 让 SPA catch-all 生效，启动期装载一个插件。"""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    monkeypatch.setattr("workflow_controller.web.spa._frontend_dist", lambda: dist)
    # detect_insight_port 以 console 模块内的引用被调用，补丁须打在该模块上
    monkeypatch.setattr(
        "workflow_controller.web.console.detect_insight_port", _insight_port_without_probing
    )

    app = FastAPI()
    # CANN 领域路由装配需要 CoreAPI
    app.state.api = MagicMock()
    app.state.api.plugin.list_plugins.return_value = [{"name": "demo"}]
    app.state.api.plugin.get_web_router.return_value = _plugin_router("/plugin-at-boot")
    return app


def test_runtime_toggle_router_registered_before_spa_catchall() -> None:
    app = FastAPI()

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> dict[str, str]:
        return {"spa": full_path}

    include_router_before_catchall(app, _plugin_router("/plugin-runtime"))

    paths = _route_paths(app)
    assert paths.index("/plugin-runtime") < paths.index("/{full_path:path}")


async def test_assemble_console_keeps_plugin_router_before_spa_catchall(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    app = _console_app_with_startup_plugin(monkeypatch, tmp_path)
    await assemble_console(app)  # type: ignore[arg-type]

    paths = _route_paths(app)
    assert paths.index("/plugin-at-boot") < paths.index("/{full_path:path}")
    assert getattr(app.state, "plugin_routers") == {"demo"}
    assert app.state.insight_port == 21025
    assert "/insight/{path:path}" in paths
    assert "/api/v1/insight/status" in paths  # CANN 领域暂存路由随装配挂载


async def test_runtime_plugin_router_precedes_catchall_and_dedupes_by_name(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """运行期注册回调：前插于 catch-all 之前，同名插件不重复注册。"""
    app = _console_app_with_startup_plugin(monkeypatch, tmp_path)
    await assemble_console(app)  # type: ignore[arg-type]
    register = app.state.register_runtime_plugin_router

    register("late", _plugin_router("/late-a"))
    register("late", _plugin_router("/late-b"))  # 同名：忽略

    paths = _route_paths(app)
    assert paths.index("/late-a") < paths.index("/{full_path:path}")
    assert "/late-b" not in paths
    assert getattr(app.state, "plugin_routers") == {"demo", "late"}


def test_register_context_bay_router_failure_fails_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """装配失败必须向上抛出终止启动，不得吞异常静默丢掉 CANN 端点。"""

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("service build failed")

    monkeypatch.setattr(
        "workflow_controller.web.context_bay.service.ContextBayConsoleService", boom
    )
    app = FastAPI()
    app.state.api = MagicMock()
    with pytest.raises(RuntimeError):
        register_context_bay_router(app)


def test_register_context_bay_router_exposes_config_section_provider() -> None:
    """装配同时注册领域配置段服务：配置路由与 SSE 经它组合领域段。"""
    app = FastAPI()
    app.state.api = MagicMock()
    register_context_bay_router(app)
    provider = app.state.config_section_providers["context_bay"]
    assert provider.read_config_section() == {"repo_url": "", "snapshot_paths": []}
