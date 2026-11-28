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

"""Console 装配：内核路由与插件路由的挂载（复用 axcor）、Context Bay 领域路由、Insight 反代与 SPA。"""

from __future__ import annotations

import functools
import logging
from typing import TYPE_CHECKING, Any

from workflow_controller.api.http.mounting import KERNEL_OPENAPI_TAGS, register_plugin_routers
from workflow_controller.web.insight import detect_insight_port, mount_insight_proxy
from workflow_controller.web.spa import mount_spa

if TYPE_CHECKING:
    from fastapi import FastAPI

log = logging.getLogger(__name__)

# ── 控制台自有路由域与 Swagger 分组（单一来源）──────────────────────
# URL 前缀、Swagger tag 与中文描述集中在此表；/docs 与 /openapi.json 的
# 展示顺序、OPENAPI_TAGS 均由它派生。路由模块不再声明前缀与 tags，新增领域
# 只改这里一行：漏登 / 拼错会在装配期立即报错，而不是静默漂移。
# 只依赖 CoreAPI 的路由域住 axcor 的 api/http（KERNEL_DOMAIN_ROUTES，内核应用
# 与本控制台共用）；这里只登记需要领域包、Insight 或前端资源的路由。
# (模块名, 前缀, tag, 中文描述)
CONSOLE_DOMAIN_ROUTES: tuple[tuple[str, str, str, str], ...] = (
    ("context_bay", "/api/v1", "context_bay", "insight 导入与 Context Bay 上传"),
)

# Swagger 分组（/docs 与 /openapi.json）：内核路由域在前、控制台自有路由域在后，
# 描述各自由路由域表派生，不另行维护第二份。
OPENAPI_TAGS: list[dict[str, str]] = [
    *KERNEL_OPENAPI_TAGS,
    *[
        {"name": tag, "description": description}
        for _, _, tag, description in CONSOLE_DOMAIN_ROUTES
    ],
]

# 模块名 → (前缀, tag)，装配期查表；重复登记在导入期即报错。
_MOUNT_BY_MODULE: dict[str, tuple[str, str]] = {}
for _name, _prefix, _tag, _description in CONSOLE_DOMAIN_ROUTES:
    if _name in _MOUNT_BY_MODULE:
        raise ValueError(f"CONSOLE_DOMAIN_ROUTES 重复登记模块：{_name}")
    _MOUNT_BY_MODULE[_name] = (_prefix, _tag)


def register_context_bay_router(app: FastAPI) -> None:
    """注册 CANN 领域暂存路由（上传/导入），前缀与分组取自 CONSOLE_DOMAIN_ROUTES。

    CANN 上传/导入是核心交付面，装配失败不降级：异常向上抛出终止启动。
    """
    from workflow_controller.web.context_bay.routes import build_router as build_context_bay_router
    from workflow_controller.web.context_bay.service import ContextBayConsoleService

    prefix, tag = _MOUNT_BY_MODULE["context_bay"]
    service = ContextBayConsoleService(app.state.api)
    router = build_context_bay_router(service)
    app.include_router(router, prefix=prefix, tags=[tag])
    # 注册领域配置段服务：配置路由与 SSE 经它组合领域段
    providers = getattr(app.state, "config_section_providers", None)
    if providers is None:
        providers = {}
        app.state.config_section_providers = providers
    providers["context_bay"] = service


async def assemble_console(app: FastAPI) -> None:
    """启动期 Console 装配：探测 insight 端口，按序注册插件、领域与反代、SPA 路由。

    须在 ``app.state.api`` 就位后调用；内核路由已由 ``register_kernel_routes`` 挂好，
    本函数只叠加控制台自有的部分。
    """
    app.state.insight_port = await detect_insight_port()
    register_plugin_routers(app, app.state.api)
    # 内核安装的运行期回调直接追加路由；控制台随后挂 SPA catch-all，运行期启用的
    # 插件 router 必须前插到 catch-all 之前，故换成控制台版本
    app.state.register_runtime_plugin_router = functools.partial(
        register_runtime_plugin_router, app
    )
    register_context_bay_router(app)
    mount_insight_proxy(app)
    mount_spa(app)


def register_runtime_plugin_router(app: FastAPI, name: str, router: Any) -> None:
    """运行期注册插件 router（前插于 SPA catch-all 之前），同名只注册一次。"""
    if name in app.state.plugin_routers:
        return
    include_router_before_catchall(app, router)
    app.state.plugin_routers.add(name)


def include_router_before_catchall(app: FastAPI, router: Any) -> None:
    """运行期把 router 注册到 SPA catch-all 之前。

    启动期 ``app.include_router`` 发生在 SPA 挂载之前，router 天然排在
    catch-all 前。但运行期 Settings 里 toggle 启用插件时，``app.include_router``
    把 router **追加**到 ``app.router.routes`` 末尾——排在已注册的 catch-all
    ``@app.get("/{full_path:path}")`` 之后。Starlette 按注册顺序匹配，GET 请求
    会被 catch-all 截胡返回 404，永远到不了 plugin router（catch-all 只注册了
    GET，故 POST 不受影响——这是诊断该问题的鉴别性特征）。本函数先
    ``include_router``，再把本次新增的全部路由从末尾移到首个 catch-all Route
    之前。

    用 ``n_before`` 记录 include 前的长度，按长度批量前移——不依赖 FastAPI
    是否把 router 包成单个 ``_IncludedRouter``（0.141+）或逐条 append Route
    （0.136），也不依赖 ``_mark_routes_changed``（0.141+ 才有）。若运行环境有
    该内部方法则调用刷新路由缓存，否则跳过。
    """
    from starlette.routing import Route

    n_before = len(app.router.routes)
    app.include_router(router)
    routes = app.router.routes
    added = routes[n_before:]  # 本次新增的全部条目（1 或 N）

    catchall_idx = next(
        (
            i
            for i, r in enumerate(routes)
            if isinstance(r, Route) and r.path in ("/api/breather/{path:path}", "/{full_path:path}")
        ),
        None,
    )
    if catchall_idx is not None and added:
        del routes[n_before:]  # 从末尾摘除新增的条目
        for r in reversed(added):  # 逆序插入，保持原相对顺序
            routes.insert(catchall_idx, r)
        # 0.141+ 有内部路由缓存刷新方法；0.136 无此方法，直接改 routes 即生效。
        refresh = getattr(app.router, "_mark_routes_changed", None)
        if refresh is not None:
            refresh()
