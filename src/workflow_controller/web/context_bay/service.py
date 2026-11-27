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

"""CANN 上传与 insight 导入领域服务（Console 暂存）。

经 CoreAPI 访问内核（转录定位、配置段存储端口）；领域包拆出时随暂存包
整体迁出，届时本模块删除。
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

from pydantic import ValidationError

from workflow_controller.api.session_api import WorkflowSessionOperationError
from workflow_controller.transcript import TranscriptSource, resolve_transcript_source
from workflow_controller.web.context_bay.config import (
    SECTION_NAME,
    ContextBayConfig,
    _valid_section_values,
    load_global_upload_config,
    load_upload_config,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from workflow_controller.api.core_api import CoreAPI


logger = logging.getLogger(__name__)


def _same_repo(a: str, b: str) -> bool:
    """两 URL 是否指向同一仓库：忽略 userinfo（注入的凭据）比较 scheme/host/port/path。

    path 去 .git 后缀、显式默认端口（https:443/http:80）归一为省略——仅差
    这两种写法仍是同仓，环境变量凭据不被误判忽略。解析失败（超范围/非数字
    端口、畸形括号）按非同仓处理：环境变量地址被安全忽略，回落原仓地址。
    """

    def _identity(url: str) -> tuple[str, str, int, str] | None:
        try:
            u = urlsplit(url)
            port = u.port or 0
            host = u.hostname or ""
        except ValueError:
            return None
        is_default_scheme_port = (u.scheme == "https" and port == 443) or (
            u.scheme == "http" and port == 80
        )
        if is_default_scheme_port:
            port = 0
        return u.scheme, host, port, u.path.rstrip("/").removesuffix(".git")

    ia, ib = _identity(a), _identity(b)
    return ia is not None and ib is not None and ia == ib


def _resolve_push_url(repo_url: str) -> str:
    """push 地址：环境变量仅在指向同一仓库时作为注入凭据的 URL 生效，否则沿用
    原仓地址（凭据交本机 git 助手）——防止为官方仓设的凭据地址劫持自建仓快照。
    """
    push_url = os.environ.get("WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "").strip()
    if push_url and _same_repo(push_url, repo_url):
        return push_url
    return repo_url


def _find_cpx_capture(root: Path, session_id: str) -> Path | None:
    """单个根目录下按后缀探测 cpx 捕获文件；探测失败的后缀跳过。"""
    for suffix in (".jsonl", ".jsonl.gz", ".jsonl.7z"):
        path = root / f"cpx-{session_id}{suffix}"
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def resolve_cpx_session_path(session_id: str, env: dict[str, str] | None = None) -> Path | None:
    """定位 cpx 捕获的 Claude 会话文件。"""
    if not session_id or Path(session_id).name != session_id:
        return None
    effective_env = {**os.environ, **(env or {})}
    roots: list[Path] = []
    configured = effective_env.get("CANNBOT_PROXY_DIR", "").strip()
    if configured:
        roots.append(Path(configured).expanduser())
    home = effective_env.get("HOME", "").strip()
    if home:
        roots.extend(
            (
                Path(home) / ".context-insight" / "proxy",
                Path(home) / ".cannbot-insight" / "proxy",
            )
        )
    roots.extend(
        (
            Path.home() / ".context-insight" / "proxy",
            Path.home() / ".cannbot-insight" / "proxy",
        )
    )
    seen: set[Path] = set()
    for root in roots:
        root = root.resolve()
        if root in seen:
            continue
        seen.add(root)
        found = _find_cpx_capture(root, session_id)
        if found is not None:
            return found
    return None


_CPX_CAPTURE_RUNTIMES = {"claude_sdk", "claude_code", "claude_cli", "codex_cli"}


def _is_cpx_wrapped_session(context: dict[str, Any], runtime: str) -> bool:
    """cpx 包装的会话：转录源改读捕获文件而非原生目录。"""
    return context.get("cli_wrapper") == "cpx" and runtime in _CPX_CAPTURE_RUNTIMES


def _locate_cpx_source(
    sdk_session_id: str,
    context: dict[str, Any],
    verb: str,
    runtime: str,
) -> TranscriptSource | dict[str, Any]:
    """定位 cpx 捕获文件：失败返回错误响应 dict，成功返回 claude-jsonl 转录源。"""
    capture_path = resolve_cpx_session_path(
        sdk_session_id,
        context.get("env_overrides"),
    )
    if capture_path is None:
        message = (
            f"Codex cpx 捕获文件不存在（未回退原生 rollout）: {sdk_session_id}"
            if runtime == "codex_cli"
            else f"Claude Code session file not found: {sdk_session_id}"
        )
        return {
            "error": message,
            "ok": False,
        }
    if verb == "上传" and capture_path.suffix in {".gz", ".7z"}:
        return {
            "error": f"压缩 cpx 捕获仅支持 Insight 导入，暂不支持 Context Bay 上传：{capture_path}",
            "ok": False,
        }
    return TranscriptSource("claude-code", "claude-jsonl", capture_path)


async def _git(*args: str) -> tuple[int, str]:
    """静音跑 git 子进程，返回 (returncode, stderr)。"""
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    return proc.returncode or 0, stderr.decode("utf-8", errors="replace") if stderr else ""


def _export_upload_db(
    set_progress: Callable[..., None],
    *,
    source_type: str,
    source_path: str,
    sdk_session_id: str,
) -> str:
    """导出 session 到 insight 七表 .db（export 段 5-40），返回 .db 路径。"""
    set_progress("export", 10)
    from workflow_controller.context_bay_exporter import export_session_to_context_bay_db

    db_path = export_session_to_context_bay_db(
        source_type=source_type,
        source_path=source_path,
        session_id=sdk_session_id,
    )
    set_progress("export", 40)
    return db_path


def _collect_snapshot_sources(
    cwd: str,
    snapshot_paths: list[str],
    set_progress: Callable[..., None],
) -> list[tuple[Path, str]]:
    """收集 cwd 下存在的 snapshot_paths 产物为 (源路径, 仓内名) 列表（collect 段 42-45）。"""
    set_progress("collect", 42)
    cwd_path = Path(cwd).resolve()
    sources: list[tuple[Path, str]] = []
    for sp in snapshot_paths:
        sp = sp.strip()
        if not sp:
            continue
        src = (cwd_path / sp).resolve()
        if not src.exists():
            continue
        tail = sp.rstrip("/").split("/")[-1] if sp.rstrip("/") not in (".", "./") else src.name
        sources.append((src, tail))
    set_progress("collect", 45)
    return sources


async def _prepare_upload_repo(
    repo_url: str, tmp_root: Path, set_progress: Callable[..., None]
) -> Path:
    """clone Context Bay 仓（clone 段 50-70）；失败则本地 init + 关联远端。"""
    set_progress("clone", 50)
    repo_dir = tmp_root / "repo"
    clone_rc, _ = await _git("clone", "--depth", "5", repo_url, str(repo_dir))
    if clone_rc != 0:
        repo_dir.mkdir(parents=True, exist_ok=True)
        await _git("init", str(repo_dir))
        await _git("-C", str(repo_dir), "remote", "add", "origin", repo_url)
    set_progress("clone", 70)
    return repo_dir


def _copy_upload_artifacts(
    repo_dir: Path,
    safe_name: str,
    context_bay_db_path: str,
    sources: list[tuple[Path, str]],
    set_progress: Callable[..., None],
) -> None:
    """复制 .db 与产物到 repo/<safe_name>/（copy 段 75-85）。"""
    import shutil

    set_progress("copy", 75)
    target_dir = repo_dir / safe_name
    target_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(context_bay_db_path, target_dir / Path(context_bay_db_path).name)
    for src, name in sources:
        dst = target_dir / name
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(
                src,
                dst,
                dirs_exist_ok=False,
                ignore=shutil.ignore_patterns(".git"),
                ignore_dangling_symlinks=True,
            )
        else:
            shutil.copy2(src, dst)
    set_progress("copy", 85)


async def _commit_and_push(
    repo_dir: Path,
    commit_msg: str,
    repo_url: str,
    set_progress: Callable[..., None],
) -> None:
    """git add/commit/push（commit 段 88-92、push 段 94 起；push 地址可经环境变量
    注入凭据，其余交本机 git 凭据助手）。push 失败依次重试 main/master，仍失败抛 RuntimeError。
    """
    set_progress("commit", 88)
    await _git("-C", str(repo_dir), "add", "-A")
    await _git("-C", str(repo_dir), "commit", "-m", commit_msg)
    set_progress("commit", 92)
    set_progress("push", 94)
    push_url = _resolve_push_url(repo_url)
    await _git("-C", str(repo_dir), "remote", "set-url", "origin", push_url)
    push_rc, push_err = await _git("-C", str(repo_dir), "push", "origin", "HEAD")
    if push_rc != 0:
        for branch in ("main", "master"):
            branch_rc, _ = await _git("-C", str(repo_dir), "push", "-u", "origin", branch)
            if branch_rc == 0:
                break
        else:
            raise RuntimeError(f"git push 失败：{push_err[-500:]}")


def _mark_upload_done(
    set_progress: Callable[..., None], safe_name: str, context_bay_db_path: str
) -> None:
    """记录上传完成进度（含仓内目录与 db 文件名）并落日志。"""
    db_filename = Path(context_bay_db_path).name
    set_progress(
        "done",
        100,
        folder=safe_name,
        dbFilename=db_filename,
        message=f"已上传到 {safe_name}/{db_filename}",
    )
    logger.info("upload-to-context-bay: done, folder=%s, db=%s", safe_name, db_filename)


def _cleanup_upload_files(tmp_root: Path | None, context_bay_db_path: str | None) -> None:
    """清理临时 repo 与导出的 .db（best-effort，失败静默）。"""
    import shutil

    if tmp_root is not None:
        shutil.rmtree(tmp_root, ignore_errors=True)
    if context_bay_db_path:
        with suppress(OSError):
            Path(context_bay_db_path).unlink(missing_ok=True)


class ContextBayConsoleService:
    """insight 导入与 context_bay 后台上传的编排服务（含进度追踪）。"""

    def __init__(self, core_api: CoreAPI) -> None:
        self._api = core_api
        self._upload_progress: dict[str, dict[str, Any]] = {}
        self._upload_tasks: dict[str, asyncio.Task[None]] = {}

    # ── insight 导入 ─────────────────────────────────────────────────────

    @staticmethod
    def insight_status(insight_port: int) -> dict[str, Any]:
        """探测本机 insight 端口是否可连。"""
        import socket

        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            result = sock.connect_ex(("localhost", insight_port))
            sock.close()
            return {"running": result == 0, "port": insight_port}
        except Exception:
            return {"running": False, "port": insight_port}

    async def import_to_insight(self, session_id: str, insight_port: int) -> dict[str, Any]:
        """把 session 转录导入 cannbot-insight；claude/codex 空 cwd 显式报错。"""
        import httpx

        located = self._locate_source(session_id, verb="insight 导入")
        if isinstance(located, dict):
            return located
        sdk_session_id, _, _, source_info = located

        insight_url = f"http://localhost:{insight_port}/api/ingest/import-file"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    insight_url,
                    json={
                        "source": source_info.kind,
                        "sessionId": sdk_session_id,
                        "filePath": str(source_info.path),
                    },
                )
                response.raise_for_status()
                result = response.json()
                return {
                    "ok": True,
                    "sessionId": sdk_session_id,
                    "insightUrl": f"/insight/run/solo:{quote(sdk_session_id, safe='')}",
                    "imported": result.get("imported", False),
                    "dbPath": str(source_info.path),
                }
        except httpx.ConnectError:
            return {
                "error": f"Cannot connect to cannbot-insight at localhost:{insight_port}. "
                "Make sure it's running (use --insight flag when starting workflow-controller web).",
                "ok": False,
            }
        except httpx.HTTPStatusError as e:
            return {
                "error": f"cannbot-insight API error: {e.response.status_code} - {e.response.text}",
                "ok": False,
            }
        except Exception as e:
            return {"error": f"Failed to import to cannbot-insight: {e}", "ok": False}

    # ── context_bay 后台上传 ─────────────────────────────────────────────────

    async def start_upload(self, session_id: str) -> dict[str, Any]:
        """启动后台上传：暂停 session → 导出 insight 格式 .db → 收集切片 → commit/push。

        立即返回 taskId，进度经 upload_progress 查询。
        """
        located = self._locate_source(session_id, verb="上传", default_cwd=".")
        if isinstance(located, dict):
            return located
        sdk_session_id, session_name, cwd, source = located

        upload_config = load_upload_config(self._api)
        if not upload_config.repo_url:
            return {
                "error": "上传仓地址未配置：请在 设置 → Context Bay 上传 填写仓地址",
                "ok": False,
            }

        task_id = uuid4().hex
        self._upload_progress[task_id] = {"step": "pause", "pct": 0}
        task = asyncio.create_task(
            self._run_upload(
                task_id=task_id,
                session_id=session_id,
                sdk_session_id=sdk_session_id,
                session_name=session_name,
                cwd=cwd,
                source_type=source.kind,
                source_path=str(source.path),
                repo_url=upload_config.repo_url,
                snapshot_paths=upload_config.snapshot_paths,
            )
        )
        # 持引用防任务被 GC；结束后即弃
        self._upload_tasks[task_id] = task
        task.add_done_callback(functools.partial(self._upload_tasks.pop, task_id))
        return {"ok": True, "taskId": task_id}

    def upload_progress(self, task_id: str) -> dict[str, Any]:
        """查询上传进度；终态（done/error）读后即清。"""
        progress = self._upload_progress.get(task_id, {"step": "unknown", "pct": 0})
        result = {"ok": True, **progress}
        if progress.get("step") in ("done", "error"):
            self._upload_progress.pop(task_id, None)
        return result

    def read_config_section(self) -> dict[str, Any]:
        """设置页读取：仅全局段。合并视图会把项目覆盖烘焙进全局（save 只写全局段）。"""
        return load_global_upload_config(self._api).model_dump()

    def validate_config_section(self, partial: dict[str, Any]) -> None:
        """只校验不落盘：供路由在内核落盘前先行拒绝，坏值请求零持久化。"""
        self._merged_section_model(partial)

    def save_config_section(self, partial: dict[str, Any]) -> dict[str, Any]:
        """设置页保存：模型校验后写全局 context_bay 段，坏值抛 ValueError 由路由转 400。"""
        config = self._merged_section_model(partial)
        self._api.config.update_section(SECTION_NAME, config.model_dump())
        return self.read_config_section()

    def _locate_source(
        self,
        session_id: str,
        *,
        verb: str,
        default_cwd: str | None = None,
    ) -> dict[str, Any] | tuple[str, str, str, TranscriptSource]:
        """import/upload 共享前置：转录上下文 + 转录源定位。

        返回错误响应 dict，或 (sdk_session_id, session_name, cwd, source)。
        default_cwd 为 None 时空 cwd 原样下传、由 claude 分支显式报错
        （import 语义）；否则空 cwd 以 default_cwd 补齐（upload 语义）。
        """
        context = self._api.session.transcript_context(session_id)
        if context is None:
            return {"error": "Session not found", "ok": False}
        sdk_session_id = context.get("native_session_id") or context.get("sdk_session_id")
        if not sdk_session_id:
            return {
                "error": "Session has no session id (not an opencode/claude/codex session)",
                "ok": False,
            }
        runtime = self._api.session.effective_runtime(session_id)
        if runtime == "codex_cli" and verb == "上传":
            return {"error": f"runtime '{runtime}' 暂不支持 {verb}", "ok": False}
        cwd = context["cwd"] if default_cwd is None else (context["cwd"] or default_cwd)
        if _is_cpx_wrapped_session(context, runtime):
            located = _locate_cpx_source(sdk_session_id, context, verb, runtime)
            if isinstance(located, dict):
                return located
            return sdk_session_id, context["name"], cwd, located
        scan_user_homes = self._api.config.claude_scan_user_homes
        try:
            source = resolve_transcript_source(
                sdk_session_id,
                runtime=runtime,
                cwd=cwd,
                env=context.get("env_overrides"),
                scan_user_homes=scan_user_homes,
            )
        except ValueError as e:
            return {"error": str(e), "ok": False}
        if source is None:
            return {"error": f"runtime '{runtime}' 暂不支持 {verb}", "ok": False}
        if not source.path.exists():
            return {"error": _source_not_found_message(source), "ok": False}
        return sdk_session_id, context["name"], cwd, source

    async def _run_upload(
        self,
        *,
        task_id: str,
        session_id: str,
        sdk_session_id: str,
        session_name: str,
        cwd: str,
        source_type: str,
        source_path: str,
        repo_url: str,
        snapshot_paths: list[str],
    ) -> None:
        """后台任务：pause → export .db → clone → copy → commit → push。

        step 流：pause(0-5) → export(5-40) → clone(40-70) → copy(70-85) →
        commit(85-92) → push(92-100)。
        """
        import tempfile

        def _set(step: str, pct: int, **extra: Any) -> None:
            self._upload_progress[task_id] = {"step": step, "pct": pct, **extra}

        tmp_root: Path | None = None
        context_bay_db_path: str | None = None
        try:
            # 1. pause 当前 session
            await self._pause_for_snapshot(task_id, session_id)
            # 2. export session 到 insight 7 表 .db
            context_bay_db_path = _export_upload_db(
                _set,
                source_type=source_type,
                source_path=source_path,
                sdk_session_id=sdk_session_id,
            )
            # 3. 收集 snapshot_paths 产物
            sources = _collect_snapshot_sources(cwd, snapshot_paths, _set)
            # 4. clone Context Bay 仓（失败则本地 init + 关联远端）
            tmp_root = Path(tempfile.mkdtemp(prefix="context-bay-upload-"))
            safe_name = f"{session_id}-{datetime.now(tz=UTC).astimezone():%Y%m%d_%H%M%S}"
            commit_msg = f"snapshot: {session_name} (session_id={session_id})"
            repo_dir = await _prepare_upload_repo(repo_url, tmp_root, _set)
            # 5. 复制 .db + 产物到 repo/<session_name>/
            _copy_upload_artifacts(repo_dir, safe_name, context_bay_db_path, sources, _set)
            # 6+7. commit + push（push 地址可经环境变量注入凭据，其余交本机凭据助手）
            await _commit_and_push(repo_dir, commit_msg, repo_url, _set)
            _mark_upload_done(_set, safe_name, context_bay_db_path)
        except Exception as e:
            logger.exception("upload-to-context-bay failed")
            _set("error", 0, error=str(e))
        finally:
            _cleanup_upload_files(tmp_root, context_bay_db_path)

    def _merged_section_model(self, partial: dict[str, Any]) -> ContextBayConfig:
        """当前段有效值与增量合并后过模型校验，坏值抛 ValueError。

        基线取逐键校验后的段值（与读取视图一致）：存储侧坏值不阻塞保存、
        随保存落盘清除；用户提交的坏值仍在此拒绝。
        """
        base = _valid_section_values(self._api.config.get_section(SECTION_NAME) or {})
        try:
            return ContextBayConfig.model_validate({**base, **partial})
        except ValidationError as exc:
            raise ValueError(f"上传配置校验失败：{exc}") from exc

    async def _pause_for_snapshot(self, task_id: str, session_id: str) -> None:
        """暂停 session 供快照导出；进度以 paused 区分直通成功与跳过。

        workflow 成员归 run 平面唯一写者管理，直通 pause 被守卫拒绝属预期
        跳过；其余失败向上抛出，由上传主流程转 error 终止，不对运行中的
        session 导出可能不一致的快照。
        """
        self._upload_progress[task_id] = {"step": "pause", "pct": 3}
        try:
            await self._api.session.pause(session_id)
        except WorkflowSessionOperationError:
            self._upload_progress[task_id] = {"step": "pause", "pct": 5, "paused": False}
        else:
            self._upload_progress[task_id] = {"step": "pause", "pct": 5, "paused": True}


def _source_not_found_message(source: TranscriptSource) -> str:
    """转录源缺失的报错文案（区分各转录源类型）。"""
    if source.kind == "claude-jsonl":
        return f"Claude Code session file not found: {source.path}"
    if source.kind == "codex-jsonl":
        return f"Codex rollout not found at {source.path}"
    return f"opencode.db not found at {source.path}"
