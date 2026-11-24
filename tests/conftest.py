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

"""共享 pytest 配置：环境隔离（HOME 重定向、外网封禁、环境变量防泄漏）与公共夹具。"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import shutil
import socket
import sys
import tempfile
from functools import partial
from pathlib import Path
from typing import Any

import pytest

_SRC = Path(__file__).parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

# ---- 环境隔离：封禁外网与 DNS ----

_DNS_API_NAMES = (
    "getaddrinfo",
    "gethostbyname",
    "gethostbyname_ex",
    "gethostbyaddr",
    "getfqdn",
)
_ORIGINAL_APIS = {
    (socket.socket, "connect"): socket.socket.connect,
    (socket.socket, "connect_ex"): socket.socket.connect_ex,
    (socket, "create_connection"): socket.create_connection,
    **{(socket, name): getattr(socket, name) for name in _DNS_API_NAMES},
}


class ExternalNetworkBlockedError(RuntimeError):
    """测试内外网访问被环境隔离拦截。"""


def _host_is_local(host: object) -> bool:
    """判断主机名或地址是否为本机（回环地址或 localhost 变体）。"""
    if host in {None, "", "localhost", "localhost.localdomain"}:
        return True
    if isinstance(host, bytes):
        host = host.decode(errors="ignore")
    if not isinstance(host, str):
        return False
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _address_is_local(address: object) -> bool:
    """socket 地址（字符串、路径或 host/port 元组）是否只涉及本机。"""
    if isinstance(address, (str, bytes, Path)):
        return True
    return isinstance(address, tuple) and bool(address) and _host_is_local(address[0])


def _blocked(address: object) -> ExternalNetworkBlockedError:
    return ExternalNetworkBlockedError(
        f"External network and DNS are disabled in tests: {address!r}. "
        "Use loopback/Unix sockets, or mark a real integration test and pass --live."
    )


def _guarded_connect(sock: socket.socket, address: Any) -> Any:
    """connect 守卫：非本机地址直接抛错。"""
    if not _address_is_local(address):
        raise _blocked(address)
    return _ORIGINAL_APIS[(socket.socket, "connect")](sock, address)


def _guarded_connect_ex(sock: socket.socket, address: Any) -> int:
    """connect_ex 守卫：非本机地址直接抛错。"""
    if not _address_is_local(address):
        raise _blocked(address)
    return _ORIGINAL_APIS[(socket.socket, "connect_ex")](sock, address)


def _guarded_create_connection(
    address: tuple[str, int], *args: Any, **kwargs: Any
) -> socket.socket:
    """create_connection 守卫：非本机地址直接抛错。"""
    original = _ORIGINAL_APIS[(socket, "create_connection")]
    return original(address, *args, **kwargs)


def _guarded_dns_call(original: Any, host: Any, *args: Any, **kwargs: Any) -> Any:
    """DNS 解析守卫：非本机主机名直接抛错。"""
    if not _host_is_local(host):
        raise _blocked(host)
    return original(host, *args, **kwargs)


def _install_network_guard() -> None:
    """替换 socket 连接与 DNS 接口为本机守卫版本。"""
    setattr(socket.socket, "connect", _guarded_connect)
    setattr(socket.socket, "connect_ex", _guarded_connect_ex)
    setattr(socket, "create_connection", _guarded_create_connection)
    for name in _DNS_API_NAMES:
        original = _ORIGINAL_APIS[(socket, name)]
        setattr(socket, name, partial(_guarded_dns_call, original))


def _restore_network() -> None:
    """还原被守卫替换的 socket 接口。"""
    for (owner, name), original in _ORIGINAL_APIS.items():
        setattr(owner, name, original)


# ---- pytest 钩子 ----


def pytest_addoption(parser: pytest.Parser) -> None:
    """注册 --live 选项：放行依赖真实外部服务的用例。"""
    parser.addoption(
        "--live",
        action="store_true",
        default=False,
        help="Allow tests marked live_llm/reviewer_recall to use real external services.",
    )


def pytest_configure(config: pytest.Config) -> None:
    """会话级环境隔离：HOME 与配置根重定向到临时目录，默认封禁外网。"""
    setattr(config, "_original_environment", dict(os.environ))  # type: ignore[attr-defined]
    config_dir = Path(tempfile.mkdtemp(prefix="workflow-controller-pytest-config-"))
    setattr(config, "_isolated_config_dir", config_dir)  # type: ignore[attr-defined]
    os.environ["HOME"] = str(config_dir)
    os.environ["XDG_CONFIG_HOME"] = str(config_dir)
    if not config.getoption("--live"):
        _install_network_guard()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """未开 --live 时跳过依赖真实外部服务的用例。"""
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="needs --live (uses a real external service)")
    for item in items:
        if "live_llm" in item.keywords or "reviewer_recall" in item.keywords:
            item.add_marker(skip)


def pytest_sessionfinish(session: pytest.Session) -> None:
    """会话收尾：检查环境变量未泄漏、还原环境与网络、清理临时目录。"""
    config = session.config
    original = getattr(config, "_original_environment")  # type: ignore[attr-defined]
    config_dir = getattr(config, "_isolated_config_dir")  # type: ignore[attr-defined]
    current = dict(os.environ)
    expected = dict(original)
    expected["HOME"] = str(config_dir)
    expected["XDG_CONFIG_HOME"] = str(config_dir)
    if current != expected and session.exitstatus == pytest.ExitCode.OK:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
    os.environ.clear()
    os.environ.update(original)
    _restore_network()
    shutil.rmtree(config_dir, ignore_errors=True)


# ---- 公共 autouse 夹具 ----


@pytest.fixture(autouse=True)
def _restore_environment_after_test():
    """用例结束检查并还原环境变量，防止测试间泄漏。

    需要改环境变量的用例应使用 monkeypatch.setenv/delenv。
    """
    before = dict(os.environ)
    yield
    after = dict(os.environ)
    ignored = {"PYTEST_CURRENT_TEST"}
    comparable_before = {key: value for key, value in before.items() if key not in ignored}
    comparable_after = {key: value for key, value in after.items() if key not in ignored}
    if comparable_after == comparable_before:
        return
    added = sorted(comparable_after.keys() - comparable_before.keys())
    removed = sorted(comparable_before.keys() - comparable_after.keys())
    changed = sorted(
        key
        for key in comparable_before.keys() & comparable_after.keys()
        if comparable_before[key] != comparable_after[key]
    )
    os.environ.clear()
    os.environ.update(before)
    pytest.fail(
        "Test leaked environment changes; use monkeypatch.setenv/delenv. "
        f"added={added}, removed={removed}, changed={changed}",
        pytrace=False,
    )


@pytest.fixture(autouse=True)
def _restore_workflow_controller_logger_state():
    """还原 ``workflow_controller`` logger 的全局状态。

    configure_logging 会关 propagate、装文件 handler——测试不还原时，
    同进程后续用例的日志（caplog 经 root 捕获）会静默收不到。
    """
    logger = logging.getLogger("workflow_controller")
    saved = (logger.propagate, logger.disabled, logger.level, list(logger.handlers))
    yield
    logger.propagate, logger.disabled, logger.level = saved[:3]
    for handler in list(logger.handlers):
        if handler not in saved[3]:
            handler.close()
            logger.removeHandler(handler)


@pytest.fixture(autouse=True)
async def _cancel_background_tasks():
    """测试结束前 cancel 掉 spawn() 留下的 fire-and-forget 后台 task。

    sync_session_status / runner.resume 等路径会 spawn(runner.run())——
    run() 是 while True 主循环、_run_one 会阻塞在 _pause_event.wait()，
    这些 task 永不自然结束。不 cancel 的话 pytest 关 event loop 时，
    pending task 会导致进程挂起（EXIT=124）。
    """
    yield
    from workflow_controller.support import tasks

    for task in list(getattr(tasks, "_background_tasks")):
        if not task.done():
            task.cancel()
    if getattr(tasks, "_background_tasks"):
        await asyncio.gather(*getattr(tasks, "_background_tasks"), return_exceptions=True)
