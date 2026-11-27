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

"""Web 组合根：配置、日志、内核 boot、Console 装配调用与关停。"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from workflow_controller.web.console import OPENAPI_TAGS, assemble_console, register_domain_routes

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

log = logging.getLogger(__name__)

_config_path: Path = Path("workflow-controller-config.yaml")

# 关停超时须覆盖单个卡死 run 的全路径最坏耗时（关停并发收尾，多 run 不
# 串行累加）：排空窗与终态扫掠的四段排空等待、任务/线程退出等待、代办
# 快照、逐成员停（成员数按下界 5 计）与 SIGTERM 宽限 ≈ 84s，再加其后
# pool/插件/bus 收尾余量。各段上界只有卡死才会占满，正常关停远小于此值。
ORCHESTRATOR_SHUTDOWN_TIMEOUT_S = 120.0


def _hook_port_from_environment() -> int | None:
    """读取 Web CLI 传入的 Hook Server 端口，reload 子进程经环境继承。"""
    raw_port = os.environ.get("WORKFLOW_CONTROLLER_HOOK_PORT")
    if not raw_port:
        return None
    try:
        return int(raw_port)
    except ValueError as exc:
        raise RuntimeError("WORKFLOW_CONTROLLER_HOOK_PORT must be an integer") from exc


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """FastAPI 生命周期：启动装配内核与 Console，退出关停内核。"""
    from workflow_controller.api.core_api import boot
    from workflow_controller.config.settings import DEFAULT_BRAND_NAME, AppConfig

    cfg = AppConfig.from_yaml(_config_path) if _config_path.exists() else AppConfig()

    # Swagger /docs 与 /openapi.json 标题随部署品牌（openapi 按请求惰性生成，
    # 启动期赋值即对首个请求生效）；空/纯空白回落默认，与配置写入口径一致。
    app.title = cfg.brand_name.strip() or DEFAULT_BRAND_NAME

    from workflow_controller.logging_config import configure_logging

    # web log 写启动目录的 .workflow-controller/(与 cmd_web 的 echo 一致),不随 yaml 的
    # project_dir / 各 session 的 cwd 变——否则 cmd_web 报的路径 ≠ 实际写的路径,
    # 用户 grep 不到日志(web 多 session,日志该在一个固定位置)。
    # CLI --log-level 通过 WORKFLOW_CONTROLLER_LOG_LEVEL 环境变量传入（reload 子进程继承）。
    log_level = os.environ.get("WORKFLOW_CONTROLLER_LOG_LEVEL", cfg.log_level)
    configure_logging(Path.cwd(), level=log_level)

    # CLI --settings-dir 同样经 env 穿透（reload 子进程会重新 import 本模块，
    # 模块级状态不可靠）；空值回落 platformdirs 默认（与 core_api.boot 一致）。
    settings_dir = (
        Path(os.environ["WORKFLOW_CONTROLLER_SETTINGS_DIR"])
        if os.environ.get("WORKFLOW_CONTROLLER_SETTINGS_DIR")
        else None
    )

    # sse_starlette 的 AppStatus.should_exit 是模块级单例，SIGTERM 置 True 后
    # 永不复位。uvicorn reload 竞态下 worker 收到 shutdown 信号却活了下来
    # （连续文件变化触发重入 reload），残留 True 的 worker 此后所有 SSE 连接
    # 被 _listen_for_exit_signal 立即取消 → "ASGI callable returned without
    # completing response"、页面有框架无数据。lifespan startup 完成意味着本
    # worker 正式服务，exit 标志必须复位。
    try:
        from sse_starlette.sse import AppStatus as _SseAppStatus

        _SseAppStatus.should_exit = False
    except Exception:
        log.warning("sse_starlette AppStatus 复位失败（残留 worker 的 SSE 可能被立即取消）")

    orchestrator, api = await boot(
        cfg,
        _config_path,
        settings_dir=settings_dir,
        hook_port=_hook_port_from_environment(),
    )
    app.state.api = api
    # 仅作为组合根与 Console 装配器的输入保留；路由处理器不得读取。
    app.state.orchestrator = orchestrator

    await assemble_console(app, orchestrator)

    log.info("%s Web API started on project_dir=%s", app.title, cfg.project_dir)
    yield
    try:
        await asyncio.wait_for(orchestrator.shutdown(), timeout=ORCHESTRATOR_SHUTDOWN_TIMEOUT_S)
    except TimeoutError:
        log.warning("Orchestrator shutdown timed out — forcing exit")
    await asyncio.sleep(0.5)  # allow cancelled tasks to clean up


def create_app() -> FastAPI:
    """创建 Workflow Controller Web 应用：中间件、领域路由与生命周期。"""
    from workflow_controller.config.settings import DEFAULT_BRAND_NAME

    app = FastAPI(
        # 启动后由 lifespan 按 workflow-controller-config.yaml 的 brand_name 覆盖，此处仅覆盖启动间隙。
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

    register_domain_routes(app)

    return app
