#!/usr/bin/env bash
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

# 矩阵层 e2e 后端引导（playwright.matrix.config.ts 的 webServer.command）。
#
# 与现有 mock 层套件（playwright.config.ts，端口 18600，读仓库根用户配置）
# 隔离：独立 cwd / HOME / 配置 / 密钥 / 端口，PATH 前置 CLI shim，并临时
# 启用 breather 插件（快照 + teardown 恢复，见 global-teardown.ts）。
#
# E2E_LIVE=1 切 live 冒烟模式：不注入 shim、不种假 provider——worker/
# 评估器直连环境真实 Provider（settings 目录隔离，见 3b 段）与真实
# claude CLI（真实 HOME）。MATRIX_ROOT / 独立端口 / breather 临时启用
# 两种模式共用。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SCRIPT_DIR = <repo>/src/workflow_controller/web/frontend/e2e/matrix；仓库根用 git 定位，
# 避免手数 ../ 层级出错。
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
FRONTEND_DIR="$REPO_ROOT/src/workflow_controller/web/frontend"
SHIMS_DIR="$REPO_ROOT/tests/e2e-shims"
MATRIX_ROOT="${WORKFLOW_CONTROLLER_E2E_MATRIX_ROOT:-$HOME/.workflow-controller-e2e-matrix}"
# 临时矩阵根由 support/env.ts 把项目夹具放到持久目录，以通过 recent_dirs 校验。
WEB_PORT="${WORKFLOW_CONTROLLER_E2E_WEB_PORT:-18601}"
HOOK_PORT="${WORKFLOW_CONTROLLER_E2E_HOOK_PORT:-18790}"
ANTHROPIC_MOCK_PORT="${WORKFLOW_CONTROLLER_E2E_ANTHROPIC_PORT:-18791}"
# pidfile 放 MATRIX_ROOT 外（该目录每次启动被重建），供 teardown 定位。
ANTHROPIC_MOCK_PID="${WORKFLOW_CONTROLLER_E2E_ANTHROPIC_PID:-/tmp/workflow-controller-e2e-anthropic-mock.pid}"
E2E_LIVE="${E2E_LIVE:-0}"

# ── 1. 前端产物（workflow-controller web 服务 dist）────────────────────────────
# vue-tsc 的类型错误打在 stdout（stderr 只有个别行），全量吞掉会让 boot
# 无声退出成 webServer 超时——失败时显式回显最近输出辅助定位。
if ! npm --prefix "$FRONTEND_DIR" run build > /tmp/workflow-controller-e2e-matrix-build.log 2>&1; then
  echo "matrix e2e boot: frontend build failed:" >&2
  tail -20 /tmp/workflow-controller-e2e-matrix-build.log >&2
  exit 1
fi

# ── 2. 矩阵运行根：daemon cwd、隔离 HOME、项目目录 ─────────────────
rm -rf "$MATRIX_ROOT"
mkdir -p "$MATRIX_ROOT/daemon" "$MATRIX_ROOT/projects" "$MATRIX_ROOT/home/.config"

cat > "$MATRIX_ROOT/workflow-controller-config.yaml" <<EOF
runtime: claude_cli
project_dir: $MATRIX_ROOT/daemon
brand_name: Workflow Controller
log_level: INFO
hook_server:
  enabled: true
  host: 127.0.0.1
EOF

# ── 3. 隔离 HOME 里种假 provider：满足「密钥就绪」门控（表单提交
#       按钮受 authReady 门控），shim 不校验密钥本身。密钥唯一来源是
#       settings.conf（auth_state.json 由它重建），linux（XDG）与
#       macOS（App Support）两个 platformdirs 落点都写。base_url 指向
#       本地 reviewer mock：reviewer 走原生 HTTP 不是子进程，不种
#       base_url 的话 provider 校验 / auth 探活会打到 api.anthropic.com
#       并因假密钥失败。live 模式跳过：provider 走 3b 段的隔离 settings 目录。
#       opencode/codex 条目（设计 §4.5/§4.6）：表单模型下拉按 runtime 过滤
#       provider，对应用例需要 runtime 匹配的条目才过提交门禁与 worker
#       能力校验；worker 探活打到相应 CLI shim（PATH 前置）。
if [ "$E2E_LIVE" != "1" ]; then
  seed_provider() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/settings.conf" <<EOF
api_keys:
  - key: sk-e2e-shim
    model: e2e-shim-model
    runtime: claude_cli
    base_url: http://127.0.0.1:$ANTHROPIC_MOCK_PORT
  - key: sk-e2e-shim
    model: e2e-shim-model
    runtime: opencode
    base_url: http://127.0.0.1:$ANTHROPIC_MOCK_PORT
  - key: sk-e2e-shim
    model: gpt-5.5
    runtime: codex_cli
    base_url: http://127.0.0.1:$ANTHROPIC_MOCK_PORT
EOF
  }
  seed_provider "$MATRIX_ROOT/home/.config/workflow-controller"
  seed_provider "$MATRIX_ROOT/home/Library/Application Support/workflow-controller"
fi

# ── 3.5 reviewer mock（本地 /v1/messages 端点）。残留 pidfile 自愈清理
#      两种模式都执行（live 不起新 mock，但上次 shim 运行硬杀的遗留也要
#      清掉，防 teardown kill 到复用 pid 的无关进程）；shim 模式随后启动
#      mock 并等就绪（provider 校验在首个 session 激活时就会打到它），
#      live 模式不起——reviewer 直连真实 Provider。
if [ -f "$ANTHROPIC_MOCK_PID" ]; then
  kill "$(cat "$ANTHROPIC_MOCK_PID")" 2>/dev/null || true
  rm -f "$ANTHROPIC_MOCK_PID"
fi
if [ "$E2E_LIVE" != "1" ]; then
  python3 "$SHIMS_DIR/anthropic_mock.py" --port "$ANTHROPIC_MOCK_PORT" &
  echo $! > "$ANTHROPIC_MOCK_PID"
  for _ in $(seq 1 40); do
    curl -sf -m 1 "http://127.0.0.1:$ANTHROPIC_MOCK_PORT/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf -m 1 "http://127.0.0.1:$ANTHROPIC_MOCK_PORT/health" >/dev/null
fi

# ── 3b. live 模式：settings 目录隔离（真实 HOME 不动——claude CLI 依赖其
#        onboarding 状态，实测隔离即挂起）。从真实 platformdirs 位置拷贝
#        settings.conf（密钥唯一来源不动）：全新目录无 auth_state 历史，
#        未显式绑定 runtime 的 key sync 后按全局 runtime: claude_cli 生效；
#        探测/validation 都写隔离目录，不污染真实 auth_state.json。
LIVE_SETTINGS_DIR=""
if [ "$E2E_LIVE" = "1" ]; then
  LIVE_SETTINGS_DIR="$MATRIX_ROOT/live-settings"
  mkdir -p "$LIVE_SETTINGS_DIR"
  for conf in \
    "${XDG_CONFIG_HOME:-$HOME/.config}/workflow-controller/settings.conf" \
    "$HOME/Library/Application Support/workflow-controller/settings.conf"; do
    if [ -f "$conf" ]; then
      cp "$conf" "$LIVE_SETTINGS_DIR/settings.conf"
      break
    fi
  done
fi
# ── 4. 插件临时启用（快照 + teardown 恢复，见 global-teardown.ts）──────
# 矩阵用例需要真实启用部分默认关闭的内置插件（breather 交接、
# agent_traceback 检查点）。启停/行内配置写源码树 src/workflow_controller/plugins/
# <name>/config.yaml（PluginRegistry 默认目录），必须快照还原防止污染
# 工作区（设计文档 §8.6）：快照目录在 MATRIX_ROOT 之外（该目录每次启动
# 被重建），清单集中在此声明。自愈：若上次运行被硬杀、快照残留（teardown
# 未执行），先按快照还原，避免把上次运行留下的 enabled: true 当成本次
# 运行的"原始状态"。
PLUGIN_SNAPSHOT_DIR="${WORKFLOW_CONTROLLER_E2E_PLUGIN_SNAPSHOT_DIR:-/tmp/workflow-controller-e2e-plugin-snapshots}"
mkdir -p "$PLUGIN_SNAPSHOT_DIR"
# 矩阵层临时启用的插件清单（boot 时快照原状 → 强制 enabled: true）。
E2E_ENABLED_PLUGINS="breather agent_traceback"
for name in $E2E_ENABLED_PLUGINS; do
  cfg="$REPO_ROOT/src/workflow_controller/plugins/$name/config.yaml"
  snap="$PLUGIN_SNAPSHOT_DIR/$name.yaml"
  if [ -f "$snap" ]; then
    cp "$snap" "$cfg"
  fi
  cp "$cfg" "$snap"
  if grep -q '^enabled: false' "$cfg"; then
    sed -i.tmp 's/^enabled: false/enabled: true/' "$cfg"
    rm -f "$cfg.tmp"
  fi
done

# ── 5. 起被测服务：shim 模式 PATH 前置 shim、HOME/XDG 隔离，cwd = 矩阵根；
#       live 模式 PATH/HOME 都不动（真实 CLI + 真实 HOME），仅 cwd 与
#       settings 目录隔离。
cd "$MATRIX_ROOT"
if [ "$E2E_LIVE" != "1" ]; then
  export PATH="$SHIMS_DIR:$PATH"
  export HOME="$MATRIX_ROOT/home"
  export XDG_CONFIG_HOME="$MATRIX_ROOT/home/.config"
fi
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/workflow-controller-uv-cache}"
if [ "$E2E_LIVE" = "1" ]; then
  exec uv run --project "$REPO_ROOT" workflow-controller web --no-open --host 127.0.0.1 --port "$WEB_PORT" --hook-port "$HOOK_PORT" --settings-dir "$LIVE_SETTINGS_DIR"
fi
exec uv run --project "$REPO_ROOT" workflow-controller web --no-open --host 127.0.0.1 --port "$WEB_PORT" --hook-port "$HOOK_PORT"
