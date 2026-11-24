# opsbot — Workflow Controller 控制台与领域外组件仓

本仓发行完整的 `workflow-controller` 包：Web 控制台（Vue 3 SPA + SSE 实时流）、Insight 反代、Context Bay 上传与导出，依赖 [axcor](https://github.com/guixu-labs/axcor) 仓的内核与全部内置插件（`workflow_controller` PEP 420 共享命名空间，安装后合并为单包体验）。

| 内容 | 说明 |
|---|---|
| `src/workflow_controller/web/` | Web 组合根、控制台装配、路由、SPA、Insight 反代、前端源码 |
| `src/workflow_controller/context_bay_exporter/` | Context Bay（insight 库）导出转换 |
| `tests/` | web 路由与装配、公开 API 约定（`tests/contract/manifest.yaml` 为唯一清单来源）、导出、e2e shim 测试 |
| `install.sh` | 面向用户的唯一正式安装入口 |
| `axcor.lock` | 构建所用 axcor 提交的锁定 |

## 安装

```bash
git clone https://github.com/guixu-labs/opsbot.git
cd opsbot
./install.sh
```

- 自动安装 uv 与 Python（≥3.12）；node + npm 需自备（构建 Web 前端）。
- 脚本按 `axcor.lock` 锁定的 axcor 提交构建内核与插件 wheel，连同本仓完整包一起经 `uv tool install` 装入隔离环境。
- 安装后自动验证 `workflow-controller --help`、Web 健康检查与 Headless fake run。
- 开发安装：`./install.sh --dev`（本仓 `uv sync` + 前端依赖，`uv run workflow-controller web --dev` 启动 Vite HMR）。

## 快速开始

```bash
workflow-controller web                 # Web UI（默认端口 18600，自动打开浏览器）
workflow-controller run --headless      # Headless JSON lines 输出（CI/脚本）
```

不依赖外部 agent 运行时的最小 headless 冒烟（fake 驱动）：

```python
import asyncio
from pathlib import Path

from workflow_controller.api.core_api import boot
from workflow_controller.config.settings import AppConfig, HookServerConfig, ReviewerConfig


async def main() -> None:
    workdir = Path("fake-demo").resolve()
    workdir.mkdir(exist_ok=True)
    program = workdir / "fake-program.yaml"
    program.write_text("format: fake@1\n", encoding="utf-8")
    config = AppConfig(
        project_dir=str(workdir),
        hook_server=HookServerConfig(enabled=True, port=0),
        reviewer=ReviewerConfig(enabled=False),
    )
    orchestrator, api = await boot(config, workdir / "workflow-controller-config.yaml")
    run = await api.run.start("fake-demo", program, fmt="fake@1")
    while run.status.value not in ("completed", "failed"):
        await asyncio.sleep(0.1)
        run = await api.run.get_run(run.run_id)
    print("run:", run.run_id, run.status)
    await orchestrator.shutdown()


asyncio.run(main())
```

公开 HTTP API 与 SSE 事件清单见 [docs/api-contract.md](docs/api-contract.md)。

## 开发

```bash
uv sync                # 内核与插件经 git 源钉到 axcor.lock 的 axcor 提交
uv run pytest -q
uv run ruff format --check . && uv run ruff check .
uv run lint-imports --no-cache

# 前端
cd src/workflow_controller/web/frontend
npm install && npm run build
```

升级 axcor 依赖：推进 `axcor.lock` 的 `axcor_sha`，并保持 `pyproject.toml` 的 git 源 rev 与之一致，重新 `uv lock`。
