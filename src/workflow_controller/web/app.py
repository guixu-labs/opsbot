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

"""Web 组合根：内核 boot、Console 装配调用与关停；启动输入与生命周期复用内核实现。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from workflow_controller.api.http.app import (
    load_boot_context,
    prepare_logging,
    reset_sse_exit_flag,
    shutdown_orchestrator,
)
from workflow_controller.api.http.mounting import register_kernel_routes
from workflow_controller.config.settings import DEFAULT_BRAND_NAME
from workflow_controller.web.console import OPENAPI_TAGS, assemble_console

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """FastAPI 生命周期：启动装配内核与 Console，退出关停内核。

    控制台保留自己的组合根与 ``boot()`` 调用；启动输入解析、日志准备、SSE
    退出标志复位与关停复用内核 ``api/http/app.py`` 的实现。
    """
    from workflow_controller.api.core_api import boot

    context = load_boot_context()
    # Swagger /docs 与 /openapi.json 标题随部署品牌（openapi 按请求惰性生成，
    # 启动期赋值即对首个请求生效）；空/纯空白回落默认，与配置写入口径一致。
    app.title = context.config.brand_name.strip() or DEFAULT_BRAND_NAME
    prepare_logging(context)
    reset_sse_exit_flag()

    orchestrator, api = await boot(
        context.config,
        context.config_path,
        settings_dir=context.settings_dir,
        hook_port=context.hook_port,
    )
    app.state.api = api

    await assemble_console(app)

    log.info("%s Web API started on project_dir=%s", app.title, context.config.project_dir)
    try:
        yield
    finally:
        await shutdown_orchestrator(orchestrator)


def create_app() -> FastAPI:
    """创建 Workflow Controller Web 应用：中间件、内核路由与生命周期。

    控制台自有路由（Context Bay）、Insight 反代与 SPA 在 lifespan 的 Console
    装配里挂载，排在内核路由与插件路由之后。
    """
    app = FastAPI(
        # 启动后由 lifespan 按配置的 brand_name 覆盖，此处仅覆盖启动间隙。
        title=DEFAULT_BRAND_NAME,
        version="0.1.0",
        description="通用 AI Agent 调度框架 Web UI",
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Export-Members", "X-Export-Relations", "X-Export-Complete"],
    )

    register_kernel_routes(app)

    return app
