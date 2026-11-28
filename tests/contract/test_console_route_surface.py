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

"""控制台路由面约定 — 控制台应用去掉自有领域路由后，必须与内核应用的路由面完全一致。

内核面端点逐条登记的清单与状态码断言住 axcor 仓（kernel_tests/contract）；
这里做结构比较，不需要跨仓读文件清单。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from fastapi import APIRouter, FastAPI

from workflow_controller.api.http.app import create_app as create_kernel_app
from workflow_controller.api.http.mounting import KERNEL_OPENAPI_TAGS, register_plugin_routers
from workflow_controller.web.app import create_app
from workflow_controller.web.console import OPENAPI_TAGS, assemble_console

from tests.contract.manifest import console_routes

_HTTP_METHODS = frozenset({"get", "post", "put", "delete", "patch", "head", "options", "trace"})


def _api_v1_surface(app: FastAPI) -> set[tuple[str, str]]:
    """应用在 /api/v1 下的正式路由面 {(方法, 路径)}，按 OpenAPI 路径表枚举。"""
    return {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        if path.startswith("/api/v1")
        for method in operations
        if method in _HTTP_METHODS
    }


def _plugin_router(path: str) -> APIRouter:
    """带单个 GET 路由的插件 router 桩。"""
    router = APIRouter()

    @router.get(path)
    async def handler() -> dict[str, str]:
        return {"ok": "1"}

    return router


def _plugin_api(routers: dict[str, Any]) -> SimpleNamespace:
    """CoreAPI.plugin 桩：list_plugins 给发现面名称，get_web_router 给 router。"""
    return SimpleNamespace(
        plugin=SimpleNamespace(
            list_plugins=lambda: [{"name": name} for name in routers],
            get_web_router=lambda name: routers.get(name),
        )
    )


async def test_console_surface_equals_kernel_surface_plus_console_routes(monkeypatch) -> None:
    """控制台应用（内核路由 + 插件路由 + context_bay + Insight 反代）在 /api/v1 下的路由面，
    去掉控制台自有端点后必须与内核应用完全一致；内核应用不含控制台自有端点。"""

    async def fake_detect() -> int:
        return 21025

    monkeypatch.setattr("workflow_controller.web.console.detect_insight_port", fake_detect)
    plugin_api = _plugin_api({"demo": _plugin_router("/api/demo/state")})

    console_app = create_app()
    console_app.state.api = MagicMock()
    console_app.state.api.plugin = plugin_api.plugin
    await assemble_console(console_app)

    kernel_app = create_kernel_app()
    register_plugin_routers(kernel_app, plugin_api)

    console_surface = _api_v1_surface(console_app)
    kernel_surface = _api_v1_surface(kernel_app)
    own = console_routes()
    assert own <= console_surface, f"控制台自有端点未挂载：{sorted(own - console_surface)}"
    assert kernel_surface.isdisjoint(own), (
        f"内核应用出现控制台自有端点：{sorted(kernel_surface & own)}"
    )
    assert console_surface - own == kernel_surface
    # 插件路由在两种应用上挂载一致（不在 /api/v1 前缀下，单独断言）
    assert "/api/demo/state" in console_app.openapi()["paths"]
    assert "/api/demo/state" in kernel_app.openapi()["paths"]


def test_console_openapi_tags_extend_kernel_tags() -> None:
    """Swagger 分组：内核路由域在前、控制台自有路由域在后，两边各自与路由域表一致。"""
    console_app = create_app()
    kernel_app = create_kernel_app()

    assert [tag["name"] for tag in console_app.openapi()["tags"]] == [
        tag["name"] for tag in OPENAPI_TAGS
    ]
    assert [tag["name"] for tag in kernel_app.openapi()["tags"]] == [
        tag["name"] for tag in KERNEL_OPENAPI_TAGS
    ]
    # 旧 /api/graph shim 端点不残留
    assert not [path for path in console_app.openapi()["paths"] if "/api/graph" in path]
