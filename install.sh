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

set -euo pipefail

# ============================================================
# install.sh — 安装 Workflow Controller 完整发行包（workflow-controller CLI）
#
# 生产模式：按 axcor.lock 锁定的 axcor 提交构建内核与插件 wheel →
#   构建前端与完整包 wheel → uv tool 安装 → 最小启动验证
#   （--help、Web 健康检查、Headless fake run）。
# 开发模式（--dev）：本仓 uv sync + 前端依赖，源码改动即时生效。
#
# 自动安装 uv 与 Python（≥3.12）；node + npm 需自备（构建 Web 前端）。
# 本地 plugins/<name>/config.yaml 的启停与自定义字段在首次启动时
# 自动继承到用户配置目录，无需手工迁移。
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
FRONTEND_DIR="$PROJECT_DIR/src/workflow_controller/web/frontend"
DIST_DIR="$PROJECT_DIR/dist"
AXCOR_REPO="https://github.com/guixu-labs/axcor.git"
AXCOR_PACKAGES=(
  workflow-controller-kernel
  workflow-controller-plugin-agent-traceback
  workflow-controller-plugin-breather
  workflow-controller-plugin-fake-driver
  workflow-controller-plugin-file-provenance
  workflow-controller-plugin-graph
  workflow-controller-plugin-staged-pipeline
)
WEB_SMOKE_PORT=18997

DEV_MODE=0

banner() { echo ""; echo -e "\033[1;34m=== $* ===\033[0m"; }
info()   { echo -e "\033[1;32m==>\033[0m $*"; }
warn()   { echo -e "\033[1;33mWARN:\033[0m $*"; }
die()    { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Modes:
  (default)        Production: build axcor wheels + frontend -> wheel -> uv tool install
  --dev            Developer : uv sync + frontend deps (source changes live, Vite HMR)

Options:
  -h, --help       Show this help

After install:
  workflow-controller web            # Web UI (port 18600)
  workflow-controller run --headless # JSON lines to stdout
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dev)          DEV_MODE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "Unknown option: $arg (try --help)" ;;
  esac
done

VERSION=$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$PROJECT_DIR/pyproject.toml" | head -1)
VERSION="${VERSION:-unknown}"
info "Workflow Controller v$VERSION ($([ "$DEV_MODE" = "1" ] && echo "dev" || echo "production"))"

# ============================================================
# Dependency setup — auto-install uv + python; node is user's job
# ============================================================
banner "Checking / installing dependencies"

if ! command -v uv >/dev/null 2>&1; then
  info "uv not found — installing via official installer"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v uv >/dev/null 2>&1 \
    || die "uv install failed. Install manually: https://docs.astral.sh/uv/"
fi
info "uv $(uv --version 2>/dev/null || echo '?')"

PY_OK=0
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)" 2>/dev/null; then
    PY_OK=1
  fi
fi
if [ "$PY_OK" = "0" ]; then
  info "python3 ≥3.12 not found — installing via uv (uv python install 3.12)"
  uv python install 3.12
  UV_PYTHON_BIN="$(uv python find 3.12 2>/dev/null || true)"
  if [ -n "$UV_PYTHON_BIN" ] && [ -x "$UV_PYTHON_BIN" ]; then
    export PATH="$(dirname "$UV_PYTHON_BIN"):$PATH"
  fi
  command -v python3 >/dev/null 2>&1 \
    || die "uv python install did not put python3 on PATH. Run manually: uv python install 3.12"
fi
info "python3 $(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: node + npm not found. They are required to build the Web UI frontend.

  Install Node.js (includes npm) from: https://nodejs.org/
  Use the official LTS installer or your system package manager, then re-run:
    ./install.sh
EOF
  exit 1
fi
info "node $(node --version 2>/dev/null || echo '?')  npm $(npm --version 2>/dev/null || echo '?')"

if [ "$DEV_MODE" = "1" ]; then
  banner "Installing (dev mode)"
  uv sync
  ( cd "$FRONTEND_DIR" && npm install )
  banner "Done! (dev mode)"
  echo "  Start dev:  uv run workflow-controller web --dev   # Vite HMR (18601) + uvicorn reload"
  exit 0
fi

# ============================================================
# Build — axcor wheels at locked commit + frontend + full wheel
# ============================================================
AXCOR_SHA="$(sed -n 's/^axcor_sha: *//p' "$PROJECT_DIR/axcor.lock" | head -1 | tr -d '[:space:]')"
[ -n "$AXCOR_SHA" ] || die "axcor.lock 中未找到 axcor_sha"
info "axcor locked commit: $AXCOR_SHA"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workflow-controller-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

banner "Fetching axcor at locked commit"
git clone -q "$AXCOR_REPO" "$BUILD_DIR/axcor"
git -C "$BUILD_DIR/axcor" checkout -q "$AXCOR_SHA" \
  || die "axcor 提交 $AXCOR_SHA 检出失败，请确认 axcor.lock 是否过期"

banner "Building axcor wheels (kernel + plugins)"
mkdir -p "$BUILD_DIR/wheels"
for pkg in "${AXCOR_PACKAGES[@]}"; do
  info "building $pkg"
  ( cd "$BUILD_DIR/axcor" && uv build --package "$pkg" --wheel --out-dir "$BUILD_DIR/wheels" ) \
    || die "$pkg wheel 构建失败"
done

banner "Building frontend"
( cd "$FRONTEND_DIR" && npm install && npm run build )

banner "Building workflow-controller wheel"
mkdir -p "$DIST_DIR"
( cd "$PROJECT_DIR" && uv build --wheel --out-dir "$DIST_DIR" )
WHEEL="$(ls "$DIST_DIR"/workflow_controller-*-py3-none-any.whl 2>/dev/null | head -1)"
[ -n "$WHEEL" ] || die "Wheel build failed — no matching .whl found in $DIST_DIR"
info "wheel: $(basename "$WHEEL")"

# ============================================================
# Install — full package plus axcor wheels in one tool env
# ============================================================
banner "Installing via uv tool"
WITH_ARGS=()
for wheel in "$BUILD_DIR"/wheels/*.whl; do
  WITH_ARGS+=(--with "$wheel")
done
export PATH="$HOME/.local/bin:$PATH"
uv tool install "$WHEEL" --force "${WITH_ARGS[@]}"

# ============================================================
# Verify — CLI help, Web health, headless fake run
# ============================================================
banner "Verifying install"
command -v workflow-controller >/dev/null 2>&1 \
  || die "workflow-controller not on PATH. Run: uv tool update-shell (then open a new shell)"
workflow-controller --help >/dev/null 2>&1 || die "workflow-controller --help failed"
info "workflow-controller works (v$VERSION)"

TOOL_PY="$(uv tool dir)/workflow-controller/bin/python"
[ -x "$TOOL_PY" ] || { warn "tool env python 未找到，跳过 Web/Headless 启动验证"; exit 0; }

info "web smoke: starting on port $WEB_SMOKE_PORT"
( cd "$BUILD_DIR" && exec workflow-controller web \
    --port "$WEB_SMOKE_PORT" --host 127.0.0.1 --no-open \
    --settings-dir "$BUILD_DIR/settings" >"$BUILD_DIR/web.log" 2>&1 ) &
WEB_PID=$!
WEB_OK=0
for _ in $(seq 1 40); do
  sleep 1
  if curl -sf --noproxy '*' "http://127.0.0.1:$WEB_SMOKE_PORT/api/v1/health" >/dev/null 2>&1; then
    WEB_OK=1
    break
  fi
  kill -0 "$WEB_PID" 2>/dev/null || break
done
kill "$WEB_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true
[ "$WEB_OK" = "1" ] || { cat "$BUILD_DIR/web.log" >&2 || true; die "web 健康检查未通过"; }
info "web health check passed"

info "headless smoke: fake@1 run"
cat >"$BUILD_DIR/fake_run.py" <<'PYEOF'
import asyncio
from pathlib import Path

from workflow_controller.api.core_api import boot
from workflow_controller.config.settings import AppConfig, HookServerConfig, ReviewerConfig


async def main() -> None:
    workdir = Path(__file__).parent / "fake-demo"
    workdir.mkdir(exist_ok=True)
    program = workdir / "fake-program.yaml"
    program.write_text("format: fake@1\n", encoding="utf-8")
    config = AppConfig(
        project_dir=str(workdir),
        hook_server=HookServerConfig(enabled=True, port=0),
        reviewer=ReviewerConfig(enabled=False),
    )
    orchestrator, api = await boot(config, workdir / "workflow-controller-config.yaml")
    try:
        run = await api.run.start("fake-demo", program, fmt="fake@1")
        while run.status.value not in ("completed", "failed"):
            await asyncio.sleep(0.1)
            run = await api.run.get_run(run.run_id)
        if run.status.value != "completed":
            raise SystemExit(f"fake run ended as {run.status.value}")
    finally:
        await orchestrator.shutdown()


asyncio.run(main())
PYEOF
( cd "$BUILD_DIR" && "$TOOL_PY" fake_run.py ) \
  || die "headless fake run 失败，详见上方输出"
info "headless fake run passed"

# ---- external runtime deps (soft checks) ----
banner "External runtime deps"
if command -v claude >/dev/null 2>&1; then
  info "claude CLI found  -> claude_cli runtime available"
else
  warn "claude CLI not found (needed only for claude_cli runtime; default claude_sdk is in-process)"
fi
if command -v opencode >/dev/null 2>&1; then
  info "opencode found     -> opencode runtime available"
else
  warn "opencode not found (optional; for opencode runtime)"
fi

banner "Done! (workflow-controller v$VERSION)"
echo "  Installed:  $(basename "$WHEEL") + axcor wheels @${AXCOR_SHA:0:12}"
echo "  Start:       workflow-controller web          # Web UI (port 18600)"
echo "  Headless:   workflow-controller run --headless"
