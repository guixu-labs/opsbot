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

"""CANN 领域暂存服务的行为断言（runtime 分流、进度终态清理、pause 三态、上传配置）。

claude 别名集（claude_sdk/claude_code/claude_cli → claude-jsonl 分支）由
transcript 侧测试覆盖，此处每个入口只保留一条 claude 分流用例。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import yaml

from workflow_controller.api.config_api import ConfigAPI
from workflow_controller.api.session_api import SessionAPI, WorkflowSessionOperationError
from workflow_controller.config.settings import AppConfig
from workflow_controller.web.context_bay.config import (
    load_global_upload_config,
    load_upload_config,
)
from workflow_controller.web.context_bay.service import (
    ContextBayConsoleService,
    _resolve_push_url,
    resolve_cpx_session_path,
)


def _core_api(session: Any, runtime: str = "claude_sdk", project_dir: str = ".") -> SimpleNamespace:
    """CoreAPI 桩：session 走真实 SessionAPI，config 走真实 ConfigAPI。"""
    orch = SimpleNamespace(
        pool=SimpleNamespace(get=lambda _sid: session),
        config=AppConfig(runtime=runtime, project_dir=project_dir),
    )
    return SimpleNamespace(
        session=SessionAPI(orch), config=ConfigAPI(orch, Path(project_dir) / "unused.yaml")
    )


def _service(
    config_runtime: str,
    session_runtime: str | None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    cwd: str = "/tmp/proj",
    cli_wrapper: str = "",
) -> ContextBayConsoleService:
    """构造领域服务桩：session 只有 native_session_id 与 config{runtime,cwd}。

    claude 分支因 jsonl 文件不存在会在文件检查处返回——据此断言落在哪个分支。
    """
    monkeypatch.delenv("WORKFLOW_CONTROLLER_DRIVER", raising=False)
    # 隔离 ~/.claude 探测：home 指向不存在的目录，保证落 claude-jsonl
    # 分支时一定报「file not found」而不是命中真实文件继续走下去。
    monkeypatch.setattr(Path, "home", lambda: Path("/workflow-controller-review-nonexistent-home"))
    session = SimpleNamespace(
        native_session_id="sdk-1",
        config=SimpleNamespace(
            runtime=session_runtime,
            cwd=cwd,
            name="s",
            cli_wrapper=cli_wrapper,
        ),
    )
    # 真实 SessionAPI：transcript_context 与 effective runtime 端到端覆盖
    return ContextBayConsoleService(_core_api(session, config_runtime, project_dir=str(tmp_path)))


@pytest.mark.parametrize("suffix", [".jsonl", ".jsonl.gz", ".jsonl.7z"])
def test_resolve_cpx_session_path_supports_capture_formats(tmp_path, monkeypatch, suffix):
    """验证 cpx 捕获文件格式查找。"""
    proxy = tmp_path / "proxy"
    proxy.mkdir()
    expected = proxy / f"cpx-sdk-1{suffix}"
    expected.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(proxy))

    assert resolve_cpx_session_path("sdk-1") == expected


def test_resolve_cpx_session_path_checks_context_insight_default(tmp_path, monkeypatch):
    """验证 context-insight 目录优先于 cannbot-insight fallback。"""
    home = tmp_path / "home"
    context_proxy = home / ".context-insight" / "proxy"
    legacy_proxy = home / ".cannbot-insight" / "proxy"
    context_proxy.mkdir(parents=True)
    legacy_proxy.mkdir(parents=True)
    expected = context_proxy / "cpx-sdk-1.jsonl"
    stale = legacy_proxy / "cpx-sdk-1.jsonl"
    expected.write_text("{}\n", encoding="utf-8")
    stale.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "missing-home")

    assert resolve_cpx_session_path("sdk-1") == expected


def test_resolve_cpx_session_path_falls_back_to_cannbot_insight(tmp_path, monkeypatch):
    """验证仅旧目录存在捕获时使用 cannbot-insight fallback。"""
    home = tmp_path / "home"
    legacy_proxy = home / ".cannbot-insight" / "proxy"
    legacy_proxy.mkdir(parents=True)
    expected = legacy_proxy / "cpx-sdk-1.jsonl"
    expected.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "missing-home")

    assert resolve_cpx_session_path("sdk-1") == expected


def test_resolve_cpx_session_path_prefers_explicit_configured_root(tmp_path, monkeypatch):
    """验证 CANNBOT_PROXY_DIR 显式配置优先于两个默认目录。"""
    home = tmp_path / "home"
    default_proxy = home / ".context-insight" / "proxy"
    default_proxy.mkdir(parents=True)
    (default_proxy / "cpx-sdk-1.jsonl").write_text("{}\n", encoding="utf-8")
    configured = tmp_path / "configured-proxy"
    configured.mkdir()
    expected = configured / "cpx-sdk-1.jsonl"
    expected.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "missing-home")
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(configured))

    assert resolve_cpx_session_path("sdk-1") == expected


def test_resolve_cpx_session_path_ignores_context_insight_without_capture(tmp_path, monkeypatch):
    """验证 context-insight 目录存在但无捕获时回落旧目录。"""
    home = tmp_path / "home"
    context_proxy = home / ".context-insight" / "proxy"
    legacy_proxy = home / ".cannbot-insight" / "proxy"
    context_proxy.mkdir(parents=True)
    legacy_proxy.mkdir(parents=True)
    expected = legacy_proxy / "cpx-sdk-1.jsonl"
    expected.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "missing-home")

    assert resolve_cpx_session_path("sdk-1") == expected


def test_resolve_cpx_session_path_checks_context_insight_only(tmp_path, monkeypatch):
    """验证仅有 context-insight 目录时可直接命中。"""
    home = tmp_path / "home"
    proxy = home / ".context-insight" / "proxy"
    proxy.mkdir(parents=True)
    expected = proxy / "cpx-sdk-1.jsonl"
    expected.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "missing-home")

    assert resolve_cpx_session_path("sdk-1") == expected


def test_locate_source_uses_cpx_capture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """验证 cpx 会话优先读取捕获文件。"""
    monkeypatch.delenv("WORKFLOW_CONTROLLER_DRIVER", raising=False)
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(tmp_path / "proxy"))
    expected = tmp_path / "proxy" / "cpx-sdk-1.jsonl"
    expected.parent.mkdir()
    expected.write_text("{}\n", encoding="utf-8")
    service = _service("claude_cli", "claude_cli", monkeypatch, tmp_path, cli_wrapper="cpx")

    located = getattr(service, "_locate_source")("s1", verb="导入")

    assert located[3].path == expected


def test_locate_source_uses_cpx_capture_for_codex(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """验证 Codex + cpx 的 Insight 导入优先读取捕获文件。"""
    monkeypatch.delenv("WORKFLOW_CONTROLLER_DRIVER", raising=False)
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(tmp_path / "proxy"))
    expected = tmp_path / "proxy" / "cpx-sdk-1.jsonl"
    expected.parent.mkdir()
    expected.write_text("{}\n", encoding="utf-8")
    service = _service("codex_cli", "codex_cli", monkeypatch, tmp_path, cli_wrapper="cpx")

    located = getattr(service, "_locate_source")("s1", verb="insight 导入")

    assert (located[3].framework, located[3].kind, located[3].path) == (
        "claude-code",
        "claude-jsonl",
        expected,
    )


def test_locate_source_reports_missing_codex_cpx_capture(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """验证 Codex + cpx 缺捕获时显式报错，不回退原生 rollout。"""
    monkeypatch.delenv("WORKFLOW_CONTROLLER_DRIVER", raising=False)
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(tmp_path / "missing-proxy"))
    service = _service("codex_cli", "codex_cli", monkeypatch, tmp_path, cli_wrapper="cpx")

    located = getattr(service, "_locate_source")("s1", verb="insight 导入")

    assert located == {
        "error": "Codex cpx 捕获文件不存在（未回退原生 rollout）: sdk-1",
        "ok": False,
    }


async def test_upload_compressed_cpx_capture_rejected(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """验证压缩捕获上传入口快速失败。"""
    monkeypatch.setenv("CANNBOT_PROXY_DIR", str(tmp_path / "proxy"))
    capture_path = tmp_path / "proxy" / "cpx-sdk-1.jsonl.gz"
    capture_path.parent.mkdir()
    capture_path.write_bytes(b"")
    service = _service("claude_cli", "claude_cli", monkeypatch, tmp_path, cli_wrapper="cpx")

    resp = await service.start_upload("s1")

    assert "仅支持 Insight 导入" in resp["error"]
    assert resp["ok"] is False
    assert not getattr(service, "_upload_tasks")


async def test_insight_import_claude_runtime_takes_claude_jsonl_branch(
    monkeypatch, tmp_path: Path
) -> None:
    service = _service("claude_sdk", "claude_sdk", monkeypatch, tmp_path)
    resp = await service.import_to_insight("s1", 1)
    # 落 claude-jsonl 分支：报文件不存在而非「暂不支持」
    assert "Claude Code session file not found" in resp["error"]


async def test_insight_import_runtime_none_inherits_global_runtime(
    monkeypatch, tmp_path: Path
) -> None:
    service = _service("claude_sdk", None, monkeypatch, tmp_path)
    resp = await service.import_to_insight("s1", 1)
    assert "Claude Code session file not found" in resp["error"]


async def test_insight_import_codex_missing_rollout_rejected(
    monkeypatch,
    tmp_path: Path,
) -> None:
    service = _service("claude_sdk", "codex_cli", monkeypatch, tmp_path)
    resp = await service.import_to_insight("s1", 1)
    assert "Codex rollout not found" in resp["error"]


async def test_insight_import_codex_without_cpx_prefers_native_rollout(
    monkeypatch,
    tmp_path: Path,
) -> None:
    sessions = tmp_path / ".codex" / "sessions"
    sessions.mkdir(parents=True)
    rollout = sessions / "rollout-sdk-1.jsonl"
    rollout.write_text(
        '{"type":"session_meta","payload":{"id":"sdk-1","thread_source":"user"}}\n',
        encoding="utf-8",
    )
    service = _service(
        "codex_cli",
        "codex_cli",
        monkeypatch,
        tmp_path,
        cwd=str(tmp_path),
    )

    located = getattr(service, "_locate_source")("s1", verb="insight 导入")

    assert (located[3].framework, located[3].kind, located[3].path) == (
        "codex",
        "codex-jsonl",
        rollout,
    )


def test_locate_source_reports_missing_codex_rollout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = _service("codex_cli", "codex_cli", monkeypatch, tmp_path)
    rollout = tmp_path / "rollout-sdk-1.jsonl"
    monkeypatch.setattr(
        "workflow_controller.web.context_bay.service.resolve_transcript_source",
        lambda *_args, **_kwargs: SimpleNamespace(
            kind="codex-jsonl",
            path=rollout,
        ),
    )

    assert getattr(service, "_locate_source")("s1", verb="insight 导入") == {
        "error": f"Codex rollout not found at {rollout}",
        "ok": False,
    }


async def test_insight_import_opens_source_task_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def raise_for_status() -> None:
            return None

        @staticmethod
        def json() -> dict[str, str]:
            return {"sessionId": "insight-1", "imported": "true"}

    class FakeClient:
        def __init__(self, **kwargs: object) -> None:
            return None

        async def __aenter__(self) -> FakeClient:
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def post(self, url: str, **kwargs: object) -> FakeResponse:
            captured["url"] = url
            captured["json"] = kwargs.get("json")
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    service = _service("codex_cli", "codex_cli", monkeypatch, tmp_path)
    rollout = tmp_path / "rollout.jsonl"
    monkeypatch.setattr(
        service,
        "_locate_source",
        lambda *_args, **_kwargs: (
            "sdk-1",
            "s",
            str(tmp_path),
            SimpleNamespace(kind="codex-jsonl", path=rollout),
        ),
    )

    response = await service.import_to_insight("s1", 21025)

    assert response["sessionId"] == "sdk-1"
    assert response["insightUrl"] == "/insight/run/solo:sdk-1"
    assert captured["json"] == {
        "source": "codex-jsonl",
        "sessionId": "sdk-1",
        "filePath": str(rollout),
    }


async def test_insight_import_claude_empty_cwd_rejected(monkeypatch, tmp_path: Path) -> None:
    """claude 系空 cwd 显式报错：不落 "." 默认值拼出误导性 file-not-found。"""
    service = _service("claude_sdk", "claude_code", monkeypatch, tmp_path, cwd="")
    resp = await service.import_to_insight("s1", 1)
    assert resp["error"] == "Session has no cwd"
    assert resp["ok"] is False


async def test_import_and_upload_reject_missing_session() -> None:
    api = _core_api(None)
    service = ContextBayConsoleService(api)
    assert await service.import_to_insight("s1", 1) == {"error": "Session not found", "ok": False}
    assert await service.start_upload("s1") == {"error": "Session not found", "ok": False}


async def test_upload_context_bay_claude_runtime_takes_claude_jsonl_branch(
    monkeypatch, tmp_path: Path
) -> None:
    service = _service("claude_sdk", "claude_sdk", monkeypatch, tmp_path)
    resp = await service.start_upload("s1")
    assert "Claude Code session file not found" in resp["error"]


async def test_upload_context_bay_runtime_none_inherits_global_runtime(
    monkeypatch, tmp_path: Path
) -> None:
    service = _service("claude_cli", None, monkeypatch, tmp_path)
    resp = await service.start_upload("s1")
    assert "Claude Code session file not found" in resp["error"]


async def test_upload_context_bay_unsupported_runtime_rejected(monkeypatch, tmp_path: Path) -> None:
    service = _service("claude_sdk", "codex_cli", monkeypatch, tmp_path)
    resp = await service.start_upload("s1")
    assert "暂不支持 上传" in resp["error"]


async def test_upload_progress_unknown_task_and_terminal_cleanup() -> None:
    service = ContextBayConsoleService(SimpleNamespace(session=SimpleNamespace(pause=None)))

    assert service.upload_progress("no-such") == {"ok": True, "step": "unknown", "pct": 0}

    getattr(service, "_upload_progress")["t1"] = {"step": "done", "pct": 100}
    assert service.upload_progress("t1")["step"] == "done"
    assert "t1" not in getattr(service, "_upload_progress")  # 终态读后即清


def _pause_service(pause) -> ContextBayConsoleService:
    """构造只覆盖 pause 行为的服务桩（session API 仅暴露 pause）。"""
    return ContextBayConsoleService(SimpleNamespace(session=SimpleNamespace(pause=pause)))


async def test_upload_pause_success_marks_paused_true() -> None:
    async def pause(_sid: str) -> None:
        return None

    service = _pause_service(pause)
    await getattr(service, "_pause_for_snapshot")("t1", "s1")
    assert getattr(service, "_upload_progress")["t1"] == {"step": "pause", "pct": 5, "paused": True}


async def test_upload_pause_workflow_member_skips_and_marks_paused_false() -> None:
    async def pause(_sid: str) -> None:
        raise WorkflowSessionOperationError("s1", "r1")

    service = _pause_service(pause)
    await getattr(service, "_pause_for_snapshot")("t1", "s1")
    assert getattr(service, "_upload_progress")["t1"] == {
        "step": "pause",
        "pct": 5,
        "paused": False,
    }


async def test_upload_pause_unexpected_failure_propagates() -> None:
    """守卫外的 pause 失败不被吞掉：由上传主流程转 error 终止。"""

    async def pause(_sid: str) -> None:
        raise RuntimeError("pause boom")

    service = _pause_service(pause)
    with pytest.raises(RuntimeError, match="pause boom"):
        await getattr(service, "_pause_for_snapshot")("t1", "s1")


# ── 上传配置：领域自有 context_bay 段 + 项目覆盖 ────────────────────────────────


def _config_api(tmp_path: Path, global_yaml: str = "", project_yaml: str = "") -> ConfigAPI:
    """真实 ConfigAPI：全局 yaml 落 tmp 根，项目 yaml 落 proj 子目录。"""
    config_path = tmp_path / "workflow-controller-config.yaml"
    if global_yaml:
        config_path.write_text(global_yaml, encoding="utf-8")
    project = tmp_path / "proj"
    project.mkdir(exist_ok=True)
    if project_yaml:
        (project / "workflow-controller.yaml").write_text(project_yaml, encoding="utf-8")
    orch = SimpleNamespace(
        config=AppConfig.from_yaml(config_path) if global_yaml else AppConfig(),
    )
    orch.config.project_dir = str(project)
    return ConfigAPI(orch, config_path)


def _service_with_config(config_api: ConfigAPI) -> ContextBayConsoleService:
    """挂真实配置 API 的领域服务（session 面用不到）。"""
    return ContextBayConsoleService(SimpleNamespace(session=SimpleNamespace(), config=config_api))


def test_load_upload_config_project_section_overrides_global(tmp_path: Path) -> None:
    """项目 context_bay 段逐键覆盖全局；单值字符串按单元素列表、仓地址去空白。"""
    api = _config_api(
        tmp_path,
        global_yaml="context_bay:\n  repo_url: https://example.com/global.git\n  snapshot_paths: [docs/]\n",
        project_yaml="context_bay:\n  snapshot_paths: operators/x/\n",
    )
    config = load_upload_config(SimpleNamespace(config=api))  # type: ignore[arg-type]
    assert config.repo_url == "https://example.com/global.git"
    assert config.snapshot_paths == ["operators/x/"]


def test_load_upload_config_project_empty_keys_keep_global(tmp_path: Path) -> None:
    """项目段留空键视为未配置，保留全局值。"""
    api = _config_api(
        tmp_path,
        global_yaml="context_bay:\n  repo_url: https://example.com/global.git\n  snapshot_paths: [docs/]\n",
        project_yaml="context_bay:\n  repo_url: ''\n  snapshot_paths: []\n",
    )
    config = load_upload_config(SimpleNamespace(config=api))  # type: ignore[arg-type]
    assert config.repo_url == "https://example.com/global.git"
    assert config.snapshot_paths == ["docs/"]


def test_load_global_upload_config_skips_bad_section_values(tmp_path: Path) -> None:
    """手改 yaml 全局 context_bay 段坏值/未知键：按未配置跳过，读取不抛 ValidationError。"""
    api = _config_api(
        tmp_path,
        global_yaml=("context_bay:\n  snapshot_paths: 123\n  repo_url: [x]\n  typo: 1\n"),
    )
    config = load_global_upload_config(SimpleNamespace(config=api))  # type: ignore[arg-type]
    assert config.repo_url == ""
    assert config.snapshot_paths == []


def test_load_upload_config_skips_bad_project_section_values(tmp_path: Path) -> None:
    """项目 yaml context_bay 段坏值：同样按未配置跳过，全局有效值不受影响。"""
    api = _config_api(
        tmp_path,
        global_yaml="context_bay:\n  repo_url: https://example.com/global.git\n",
        project_yaml="context_bay:\n  snapshot_paths: 123\n  repo_url: [x]\n",
    )
    config = load_upload_config(SimpleNamespace(config=api))  # type: ignore[arg-type]
    assert config.repo_url == "https://example.com/global.git"
    assert config.snapshot_paths == []


def test_save_config_section_normalizes_and_persists(tmp_path: Path) -> None:
    """设置页保存：值归一后写全局段并落盘，读取视图所见即生效。"""
    service = _service_with_config(_config_api(tmp_path))
    result = service.save_config_section({"repo_url": " https://example.com/r.git "})
    assert result == {"repo_url": "https://example.com/r.git", "snapshot_paths": []}
    raw = yaml.safe_load((tmp_path / "workflow-controller-config.yaml").read_text(encoding="utf-8"))
    assert raw["context_bay"]["repo_url"] == "https://example.com/r.git"


def test_save_config_section_rejects_unknown_and_bad_keys(tmp_path: Path) -> None:
    """闭合模型：未知键与坏值在写入边界拒绝（路由转 400），不再静默跳过。"""
    service = _service_with_config(_config_api(tmp_path))
    with pytest.raises(ValueError, match="上传配置校验失败"):
        service.save_config_section({"repo_url": "https://example.com/r.git", "typo": 1})
    with pytest.raises(ValueError, match="上传配置校验失败"):
        service.save_config_section({"snapshot_paths": {"not": "a list"}})
    assert getattr(service, "_api").config.get_section("context_bay") is None  # 拒绝时不落盘


def test_save_config_section_ignores_bad_stored_values(tmp_path: Path) -> None:
    """存储段坏值不阻塞保存：合并基线与读取视图一致，坏值随保存落盘清除。"""
    api = _config_api(tmp_path, global_yaml="context_bay:\n  snapshot_paths: 123\n")
    service = _service_with_config(api)
    result = service.save_config_section({"repo_url": "https://example.com/r.git"})
    assert result == {"repo_url": "https://example.com/r.git", "snapshot_paths": []}
    raw = yaml.safe_load((tmp_path / "workflow-controller-config.yaml").read_text(encoding="utf-8"))
    assert raw["context_bay"] == {"repo_url": "https://example.com/r.git", "snapshot_paths": []}


def test_read_config_section_global_view_without_project_overrides(tmp_path: Path) -> None:
    """设置页读取仅全局段：项目覆盖不并入，原样保存不会把项目值烘焙进全局。"""
    api = _config_api(
        tmp_path,
        global_yaml="context_bay:\n  repo_url: https://example.com/global.git\n  snapshot_paths: [docs/]\n",
        project_yaml="context_bay:\n  snapshot_paths: operators/x/\n",
    )
    service = _service_with_config(api)
    assert service.read_config_section() == {
        "repo_url": "https://example.com/global.git",
        "snapshot_paths": ["docs/"],
    }
    # 设置页未改动直接保存（回写读取值）：全局段保持全局值
    service.save_config_section(service.read_config_section())
    raw = yaml.safe_load((tmp_path / "workflow-controller-config.yaml").read_text(encoding="utf-8"))
    assert raw["context_bay"]["snapshot_paths"] == ["docs/"]
    # 项目覆盖只在消费侧合并生效
    assert load_upload_config(SimpleNamespace(config=api)).snapshot_paths == ["operators/x/"]


async def test_upload_without_repo_url_fails_fast(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未配置上传仓地址时快速失败，不起后台上传任务。"""
    service = _service_with_config(_config_api(tmp_path))
    monkeypatch.setattr(
        service,
        "_locate_source",
        lambda *a, **k: (
            "sdk-1",
            "s",
            "/tmp/p",
            SimpleNamespace(kind="claude-jsonl", path=Path("/tmp/x.jsonl")),
        ),
    )
    resp = await service.start_upload("s1")
    assert "未配置" in resp["error"]
    assert resp["ok"] is False
    assert not getattr(service, "_upload_tasks")


def test_resolve_push_url_env_same_repo_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """环境变量是同仓注入凭据的 URL（仅 userinfo 不同）时作为 push 地址生效。"""
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@example.com/r.git"
    )
    assert _resolve_push_url("https://example.com/r.git") == "https://user:token@example.com/r.git"


def test_resolve_push_url_env_other_repo_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """环境变量指向别的仓库时不生效：自建仓快照不被凭据地址劫持，沿用 repo_url。"""
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://push.example.com/mirror.git"
    )
    assert _resolve_push_url("https://example.com/r.git") == "https://example.com/r.git"


def test_resolve_push_url_falls_back_to_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", raising=False)
    assert _resolve_push_url("https://example.com/r.git") == "https://example.com/r.git"


def test_resolve_push_url_env_git_suffix_and_default_port_same_repo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同仓判定归一 .git 后缀与显式默认端口：仅差这两种写法的环境变量
    凭据地址仍生效，不因误判退回无凭据的 repo_url 原值。
    """
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@example.com/r"
    )
    assert _resolve_push_url("https://example.com/r.git") == "https://user:token@example.com/r"

    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@example.com:443/r.git"
    )
    assert (
        _resolve_push_url("https://example.com/r.git") == "https://user:token@example.com:443/r.git"
    )


def test_resolve_push_url_malformed_url_env_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """环境变量带畸形端口/未闭合 IPv6 括号时不抛裸 ValueError：按非同仓安全
    忽略，回落原仓地址交本机凭据助手——错误的环境变量不中断上传流程。
    """
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@example.com:99999/r.git"
    )
    assert _resolve_push_url("https://example.com/r.git") == "https://example.com/r.git"

    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@exa[mple.com/r.git"
    )
    assert _resolve_push_url("https://example.com/r.git") == "https://example.com/r.git"

    # 原仓地址畸形同理：回落原值，由 git 自身的报错暴露问题
    monkeypatch.setenv(
        "WORKFLOW_CONTROLLER_CONTEXT_BAY_PUSH_URL", "https://user:token@example.com/r.git"
    )
    assert _resolve_push_url("https://example.com:abc/r.git") == "https://example.com:abc/r.git"
