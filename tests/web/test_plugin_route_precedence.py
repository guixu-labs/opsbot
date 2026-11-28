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

"""插件路由与 Insight 反代的次序：未装载插件的专有端点由禁用应答接住，运行期启用的插件路由前插到反代之前。"""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from workflow_controller.api.http.mounting import register_kernel_routes, register_plugin_routers
from workflow_controller.web.console import include_router_before_catchall
from workflow_controller.web.insight import mount_insight_proxy

# breather 插件未装载时 /api/breather/state 的禁用应答
DISABLED_BREATHER_STATE = {
    "pending": False,
    "finalizing": False,
    "stop_armed": False,
    "force_pending": False,
    "pending_session_id": "",
    "active_subagents": [],
}


def test_routes_without_plugin_report_disabled() -> None:
    """插件未装载时专有端点由控制台响应，不误转发给 Insight。"""
    app = FastAPI()
    register_kernel_routes(app)
    register_plugin_routers(app, SimpleNamespace(plugin=SimpleNamespace(list_plugins=lambda: [])))
    app.state.insight_port = 1  # 关闭的端口：反代确定性地连接失败
    mount_insight_proxy(app)
    client = TestClient(app, base_url="http://127.0.0.1")

    state = client.get("/api/breather/state")

    assert state.status_code == 200
    assert state.json() == DISABLED_BREATHER_STATE
    assert client.post("/api/breather/cancel", json={"session_id": "s1"}).status_code == 409
    assert client.post("/api/breather/handoff", json={"session_id": "s1"}).status_code == 409


def test_runtime_plugin_route_precedes_insight_proxy() -> None:
    app = FastAPI()
    app.state.insight_port = 1
    mount_insight_proxy(app)
    router = APIRouter()

    @router.get("/api/breather/state")
    async def state() -> dict[str, bool]:
        return {"plugin": True}

    include_router_before_catchall(app, router)
    response = TestClient(app, base_url="http://127.0.0.1").get("/api/breather/state")
    assert response.status_code == 200
    assert response.json() == {"plugin": True}
