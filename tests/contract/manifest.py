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

"""约定清单加载与文档渲染 —— manifest.yaml 是控制台自有 HTTP 路由的唯一事实来源。"""

from __future__ import annotations

from functools import cache
from pathlib import Path

import yaml

MANIFEST_PATH = Path(__file__).with_suffix(".yaml")
API_CONTRACT_DOC_PATH = Path(__file__).parents[2] / "docs" / "api-contract.md"
ROUTE_CLASSES = ("stable", "experimental", "internal")

_CLASS_TITLES = {
    "stable": "Stable API — 已承担兼容责任；只允许向后兼容地增加端点、字段与事件类型",
    "experimental": "Experimental API — 较新或后续迁移/删除的面，不承诺兼容",
    "internal": "Internal API — 内核/控制台内部装配面，不对消费者承诺",
}


@cache
def load_manifest() -> dict:
    """读入清单并做结构校验（未知键、路由行形状、重复端点即报错）。"""
    with MANIFEST_PATH.open(encoding="utf-8") as stream:
        manifest = yaml.safe_load(stream)

    unknown = set(manifest) - {"routes"}
    if unknown:
        raise ValueError(f"清单出现未知顶层键：{sorted(unknown)}")

    classes = manifest["routes"]
    if set(classes) != set(ROUTE_CLASSES):
        raise ValueError(f"路由分类必须恰为 {list(ROUTE_CLASSES)}")
    seen_global: set[tuple[str, str]] = set()
    for class_name in ROUTE_CLASSES:
        seen_in_class: set[tuple[str, str]] = set()
        for row in classes[class_name]:
            if not (isinstance(row, list) and len(row) == 3):
                raise ValueError(f"{class_name} 路由行须为 [方法, 路径, [状态码]]：{row!r}")
            method, path, codes = row
            key = (method, path)
            if key in seen_in_class:
                raise ValueError(f"{class_name} 内重复端点：{key}")
            if key in seen_global:
                raise ValueError(f"跨分类重复端点：{key}")
            seen_in_class.add(key)
            if not all(isinstance(code, int) for code in codes):
                raise ValueError(f"{key} 状态码须为整数列表：{codes!r}")
            seen_global.add(key)
    return manifest


def console_routes() -> set[tuple[str, str]]:
    """三分类并集：控制台自有路由的全集 {(方法, 路径)}。"""
    return {
        (method, path)
        for rows in load_manifest()["routes"].values()
        for method, path, _codes in rows
    }


def render_manifest_markdown() -> str:
    """由清单渲染人读 API 文档内容。"""
    lines = [
        "# 控制台自有 HTTP 路由约定",
        "",
        "> 本文档由 `tests/contract/manifest.yaml` 生成；改动清单后运行",
        "> `python scripts/generate_api_contract_doc.py` 再提交，生成校验测试会拦截未同步的漂移。",
        "",
        "> 内核面端点（`/api/v1` 下的 Session、Run、Auth、Config、Plugins、Overview、SSE、Watchdog）、",
        "> SSE 事件名与告警词表的约定住 axcor 仓的 `docs/api-contract.md`；控制台应用复用同一份路由实现，",
        "> 约定测试要求控制台应用的正式路由面去掉下列自有端点后与内核应用完全一致。",
        "",
    ]
    manifest = load_manifest()
    for class_name in ROUTE_CLASSES:
        routes = manifest["routes"][class_name]
        lines.append(f"## {_CLASS_TITLES[class_name]}（{len(routes)} 条）")
        lines.append("")
        lines.append("| 方法 | 路径 | 登记状态码 |")
        lines.append("|---|---|---|")
        for method, path, codes in routes:
            rendered = ", ".join(str(code) for code in codes) if codes else "—"
            lines.append(f"| {method} | `{path}` | {rendered} |")
        lines.append("")
    return "\n".join(lines)
