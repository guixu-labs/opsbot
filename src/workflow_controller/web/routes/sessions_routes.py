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

"""Session 领域路由 — 生命周期、控制、导入、提示与指令族。"""

from __future__ import annotations

import asyncio
import functools
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, HTTPException, Request

from workflow_controller.api.session_api import (
    ReviewerStartOverrides,
    WorkflowSessionOperationError,
)
from workflow_controller.web.routes.common import get_core_api

if TYPE_CHECKING:
    from collections.abc import Callable

router = APIRouter()


def _session_op(route: Callable[..., Any]) -> Callable[..., Any]:
    """session 路由共用：workflow 成员拒绝直通 → 409（detail 携带指路文案）。"""

    @functools.wraps(route)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await route(*args, **kwargs)
        except WorkflowSessionOperationError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return wrapper


@router.get("/sessions")
async def list_sessions(request: Request) -> list[dict[str, Any]]:
    sessions = await asyncio.to_thread(get_core_api(request).session.list_sessions)
    return [s.__dict__ for s in sessions]


@router.get("/sessions/opencode")
async def list_opencode_sessions(
    request: Request, directory: str = "", limit: int = 200
) -> dict[str, Any]:
    """List opencode sessions from opencode DB for import UI."""
    try:
        sessions = get_core_api(request).session.list_opencode_sessions(directory=directory)
        return {"sessions": sessions}
    except Exception as e:
        return {"error": str(e), "sessions": []}


@router.post("/sessions/import")
async def import_session(request: Request) -> dict[str, Any]:
    """Import an opencode session into Workflow Controller."""
    body = await request.json()
    oid = body.get("opencode_session_id")
    if not oid:
        return {"error": "Missing opencode_session_id", "success": False}
    try:
        sid = await get_core_api(request).session.import_opencode_session(oid)
        return {"success": True, "session_id": sid}
    except Exception as e:
        return {"error": str(e), "success": False}


# ── Claude Code import ─────────────────────────────────────────────


@router.get("/sessions/claude")
async def list_claude_sessions(request: Request, directory: str = "") -> dict[str, Any]:
    """List Claude Code sessions for import UI."""
    try:
        sessions = await asyncio.to_thread(
            get_core_api(request).session.list_claude_sessions, directory
        )
        return {"sessions": sessions}
    except Exception as e:
        return {"error": str(e), "sessions": []}


@router.post("/sessions/import-claude")
async def import_claude_session(request: Request) -> dict[str, Any]:
    """Import a Claude Code session into Workflow Controller."""
    body = await request.json()
    sid = body.get("session_id")
    directory = body.get("directory", "")
    if not sid:
        return {"error": "Missing session_id", "success": False}
    try:
        ops_id = await get_core_api(request).session.import_claude_session(sid, directory=directory)
        return {"success": True, "session_id": ops_id}
    except Exception as e:
        return {"error": str(e), "success": False}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request) -> dict[str, Any]:
    s = await asyncio.to_thread(get_core_api(request).session.get_session, session_id)
    if s is None:
        return {"error": "session not found"}
    return s.__dict__


@router.post("/sessions/start")
async def start_session(body: dict[str, Any], request: Request) -> dict[str, Any]:
    api = get_core_api(request)
    project_dir = (body.get("project_dir") or "").strip()
    if not project_dir:
        return {"error": "project_dir is required"}
    prompt = (body.get("prompt") or "").strip() or None
    runtime = (body.get("runtime") or "").strip() or None
    cli_wrapper = body.get("cli_wrapper")
    cli_wrapper = cli_wrapper.strip() if isinstance(cli_wrapper, str) else None
    model = (body.get("model") or "").strip() or None
    reviewer_model = (body.get("reviewer_model") or "").strip() or None
    provider_index = body.get("provider_index")
    reviewer_provider_index = body.get("reviewer_provider_index")
    reviewer_enabled = body.get("reviewer_enabled")
    reviewer_thinking_budget_tokens = body.get("reviewer_thinking_budget_tokens")
    reviewer_thinking_mode = body.get("reviewer_thinking_mode")
    legacy_thinking_enabled = body.get("reviewer_thinking_enabled")
    if reviewer_thinking_mode in (None, "") and isinstance(legacy_thinking_enabled, bool):
        reviewer_thinking_mode = "enabled" if legacy_thinking_enabled else "disabled"
    system_prompt = (body.get("system_prompt") or "").strip() or None
    evaluator = (body.get("evaluator") or "").strip() or None
    max_iterations = body.get("max_iterations")
    reviewer_task_goal = (body.get("reviewer_task_goal") or "").strip() or None
    reviewer_kwargs = {
        "model": reviewer_model,
        "task_goal": reviewer_task_goal,
        "provider_index": reviewer_provider_index,
        "enabled": reviewer_enabled,
        "thinking_mode": reviewer_thinking_mode,
        "thinking_budget_tokens": reviewer_thinking_budget_tokens,
    }
    reviewer_kwargs["max_tokens"] = body.get("reviewer_max_tokens")
    try:
        return await api.session.start(
            project_dir,
            prompt=prompt,
            runtime=runtime,
            model=model,
            cli_wrapper=cli_wrapper,
            system_prompt=system_prompt,
            evaluator=evaluator,
            max_iterations=max_iterations,
            provider_index=provider_index,
            reviewer=ReviewerStartOverrides(**reviewer_kwargs),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/sessions/stop-all")
async def stop_all_sessions(request: Request) -> dict[str, Any]:
    await get_core_api(request).session.stop_all()
    return {"ok": True}


@router.post("/sessions/{session_id}/stop")
@_session_op
async def stop_session(session_id: str, request: Request) -> dict[str, Any]:
    await get_core_api(request).session.stop(session_id)
    return {"ok": True}


@router.post("/sessions/{session_id}/pause")
@_session_op
async def pause_session(session_id: str, request: Request) -> dict[str, Any]:
    await get_core_api(request).session.pause(session_id)
    return {"ok": True}


@router.post("/sessions/{session_id}/play")
@_session_op
async def play_session(session_id: str, request: Request) -> dict[str, Any]:
    await get_core_api(request).session.play(session_id)
    return {"ok": True}


@router.post("/sessions/{session_id}/resume")
@_session_op
async def resume_session(session_id: str, request: Request) -> dict[str, Any]:
    try:
        await get_core_api(request).session.resume(session_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.put("/sessions/{session_id}/reviewer-mode")
async def set_session_reviewer_mode(
    session_id: str,
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    mode = str(body.get("mode", ""))
    try:
        await get_core_api(request).session.set_session_reviewer_mode(session_id, mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "mode": mode}


@router.put("/sessions/{session_id}/reviewer-task-goal")
async def set_session_reviewer_task_goal(
    session_id: str,
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    """更新会话当前生效的 reviewer 任务目标，回显保存后的值。"""
    task_goal = body.get("task_goal")
    if not isinstance(task_goal, str):
        raise HTTPException(status_code=400, detail="task_goal must be a string")
    try:
        stored = await get_core_api(request).session.set_session_reviewer_task_goal(
            session_id, task_goal
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "task_goal": stored}


@router.post("/sessions/{session_id}/restart")
@_session_op
async def restart_session(session_id: str, request: Request) -> dict[str, Any]:
    try:
        await get_core_api(request).session.restart(session_id)
    except WorkflowSessionOperationError:
        raise  # ValueError 子类：放行给 _session_op 映射 409
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/sessions/{session_id}/cancel-handoff")
async def cancel_handoff_session(session_id: str, request: Request) -> dict[str, Any]:
    """取消 handoff 会话并改判为失败。"""
    return await get_core_api(request).session.cancel_handoff_session(session_id)


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    request: Request,
    clean_reconstruct: str | None = None,
) -> dict[str, Any]:
    """Remove a session: stop worker, clean declared stage artifacts, drop from
    pool, delete events. (统一走 SessionAPI.delete，与 stop/pause 等路由一致。)

    Query params：
    - ``clean_reconstruct=workflow_controller|all``：重建 session 磁盘清理范围（默认不清）。
      ``all`` rmtree 整个 target_cwd，前端须二次确认后传。
    """
    if clean_reconstruct is not None and clean_reconstruct not in ("workflow_controller", "all"):
        raise HTTPException(
            status_code=400,
            detail="clean_reconstruct must be 'workflow_controller', 'all', or omitted",
        )
    try:
        result = await get_core_api(request).session.delete(
            session_id,
            clean_reconstruct=clean_reconstruct,
        )
        return result
    except ValueError as e:
        # SessionAPI.delete 入参校验——HTTP 路径上方已拦截，此处理论不会到达。
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"{type(e).__name__}: {e}",
        ) from e


@router.post("/sessions/{session_id}/inject")
@_session_op
async def inject_prompt(session_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    await get_core_api(request).session.inject_prompt(session_id, body["text"])
    return {"ok": True}


@router.post("/sessions/{session_id}/send")
@_session_op
async def send_message(session_id: str, body: dict[str, Any], request: Request) -> dict[str, Any]:
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(422, "text is required")
    try:
        resumed = await get_core_api(request).session.send_message(session_id, text)
    except WorkflowSessionOperationError:
        raise
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "resumed": resumed}


# ── subagent system-prompt hint (opencode overlay) ───────────────────────


@router.get("/sessions/{session_id}/subagent-hint")
async def get_subagent_hints(session_id: str, request: Request) -> dict[str, Any]:
    return {"hints": get_core_api(request).session.get_subagent_hints(session_id)}


@router.post("/sessions/{session_id}/subagent-hint")
async def register_subagent_hint(
    session_id: str,
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    subagent_type = (body.get("subagent_type") or "").strip()
    hint = body.get("hint") or ""
    if not subagent_type:
        return {"error": "subagent_type is required"}
    if not hint.strip():
        return {"error": "hint is required"}
    await get_core_api(request).session.register_subagent_hint(session_id, subagent_type, hint)
    return {"ok": True}


@router.delete("/sessions/{session_id}/subagent-hint/{subagent_type}")
async def clear_subagent_hint(
    session_id: str,
    subagent_type: str,
    request: Request,
    index: int | None = None,
) -> dict[str, Any]:
    """Clear one hint (``index`` given) or all for the subagent_type."""
    return await get_core_api(request).session.clear_subagent_hint(session_id, subagent_type, index)


@router.delete("/sessions/{session_id}/subagent-hint")
async def clear_all_subagent_hints(
    session_id: str,
    request: Request,
) -> dict[str, Any]:
    return await get_core_api(request).session.clear_subagent_hint(session_id, None)


@router.get("/sessions/{session_id}/agents")
async def list_session_agents(session_id: str, request: Request) -> dict[str, Any]:
    """Subagent types available in this session's project (.opencode/agents)."""
    return {"agents": get_core_api(request).session.list_subagent_types(session_id)}


# ── project-dir-keyed hints (pre-session, main Dashboard) ───────────────
# Operate on the project directory directly (no session_id needed) so hints
# can be registered before any session exists. Transferred into the session
# on start_session_with_config.


@router.get("/project/agents")
async def list_project_agents(project_dir: str, request: Request) -> dict[str, Any]:
    """Subagent types with an on-disk def in <project_dir>/.opencode/agents."""
    return {"agents": get_core_api(request).session.list_project_agent_types(project_dir)}


@router.get("/project/subagent-hint")
async def get_project_hints(project_dir: str, request: Request) -> dict[str, Any]:
    return {"hints": get_core_api(request).session.get_project_hints(project_dir)}


@router.post("/project/subagent-hint")
async def register_project_hint(
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    project_dir = (body.get("project_dir") or "").strip()
    subagent_type = (body.get("subagent_type") or "").strip()
    hint = body.get("hint") or ""
    if not project_dir:
        return {"error": "project_dir is required"}
    if not subagent_type:
        return {"error": "subagent_type is required"}
    if not hint.strip():
        return {"error": "hint is required"}
    get_core_api(request).session.register_project_hint(project_dir, subagent_type, hint)
    return {"ok": True}


@router.delete("/project/subagent-hint/{subagent_type}")
async def clear_project_hint(
    subagent_type: str,
    project_dir: str,
    request: Request,
    index: int | None = None,
) -> dict[str, Any]:
    """Clear one hint (``index`` given) or all for the subagent_type."""
    cleared = get_core_api(request).session.clear_project_hint(project_dir, subagent_type, index)
    return {"cleared": cleared}


@router.delete("/project/subagent-hint")
async def clear_all_project_hints(
    project_dir: str,
    request: Request,
) -> dict[str, Any]:
    cleared = get_core_api(request).session.clear_project_hint(project_dir, None)
    return {"cleared": cleared}


# ── global session instructions (opencode `instructions` overlay) ───────
# Global instructions appended to ALL agents' system prompts (worker + every
# subagent) via the opencode `instructions` config section. Complementary to
# per-type subagent hints: one registration reaches every agent.


@router.get("/sessions/{session_id}/instructions")
async def get_session_instructions(session_id: str, request: Request) -> dict[str, Any]:
    return {"instructions": get_core_api(request).session.get_session_instructions(session_id)}


@router.post("/sessions/{session_id}/instructions")
async def register_session_instruction(
    session_id: str,
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    instruction = body.get("instruction") or ""
    if not instruction.strip():
        return {"error": "instruction is required"}
    await get_core_api(request).session.register_session_instruction(session_id, instruction)
    return {"ok": True}


@router.delete("/sessions/{session_id}/instructions")
async def clear_session_instructions(
    session_id: str,
    request: Request,
    index: int | None = None,
) -> dict[str, Any]:
    """Clear one instruction (``index`` given) or all for the session."""
    return await get_core_api(request).session.clear_session_instruction(session_id, index)


# ── project-dir-keyed global instructions (pre-session, main Dashboard) ──


@router.get("/project/instructions")
async def get_project_instructions(project_dir: str, request: Request) -> dict[str, Any]:
    return {"instructions": get_core_api(request).session.get_project_instructions(project_dir)}


@router.post("/project/instructions")
async def register_project_instruction(
    body: dict[str, Any],
    request: Request,
) -> dict[str, Any]:
    project_dir = (body.get("project_dir") or "").strip()
    instruction = body.get("instruction") or ""
    if not project_dir:
        return {"error": "project_dir is required"}
    if not instruction.strip():
        return {"error": "instruction is required"}
    get_core_api(request).session.register_project_instruction(project_dir, instruction)
    return {"ok": True}


@router.delete("/project/instructions")
async def clear_project_instructions(
    project_dir: str,
    request: Request,
    index: int | None = None,
) -> dict[str, Any]:
    """Clear one instruction (``index`` given) or all for the project."""
    cleared = get_core_api(request).session.clear_project_instruction(project_dir, index)
    return {"cleared": cleared}


@router.get("/sessions/{session_id}/chain")
async def get_session_chain(session_id: str, request: Request) -> dict[str, Any]:
    """查 session 的完整交接谱系（前驱 + 后继）。"""
    try:
        return await get_core_api(request).event.get_handoff_chain(session_id)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


@router.get("/session/providers")
async def session_providers(request: Request) -> dict[str, Any]:
    """opencode provider 清单与当前模型（Session 卡片数据源）。"""
    return get_core_api(request).session.providers_snapshot()


@router.post("/session/test-model")
async def session_test_model(body: dict[str, Any], request: Request) -> dict[str, Any]:
    """用 opencode.jsonc 里的 key 实测模型连通性。"""
    return await get_core_api(request).session.test_model((body.get("model") or "").strip())
