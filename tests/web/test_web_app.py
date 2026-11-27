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

"""Web 应用组合根的环境变量边界测试。"""

from __future__ import annotations

import pytest

from workflow_controller.web.app import _hook_port_from_environment


def test_hook_port_environment_is_optional(monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOW_CONTROLLER_HOOK_PORT", raising=False)
    assert _hook_port_from_environment() is None


def test_hook_port_environment_is_parsed(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_CONTROLLER_HOOK_PORT", "18775")
    assert _hook_port_from_environment() == 18775


def test_hook_port_environment_rejects_non_integer(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_CONTROLLER_HOOK_PORT", "invalid")
    with pytest.raises(RuntimeError, match="WORKFLOW_CONTROLLER_HOOK_PORT"):
        _hook_port_from_environment()
