// Copyright (c) 2026 Workflow Controller Contributors
//
// Licensed under the MIT License (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://opensource.org/licenses/MIT
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect, test } from '../fixtures'
import { createProject, IS_LIVE, switchProject, readShimState } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · opencode runtime 基线（MX-08，设计文档
// docs/designs/workflow-controller-e2e-feature-matrix.md §2.4 O 系列 / §4.5）：
// `OpenCodeDriver` 的 `run --format json` 子进程链路——O1 基线（含原生
// tokens 形状 {input,output,cache:{write,read}} → usage 归一后的读数
// 断言，防止 verbatim 透传把下游字段留 0 的回归）、O2 反馈回路（迭代 2
// 经 --session 复用同一原生会话）、O3 工具渲染（opencode 的 tool_use
// 合并事件：call+result 同 part.state、status=error 即失败对，无孤立
// 结果形态——与 claude stream-json 的本质差异）、O4 stop-hook 链路
// （step_finish 合成 on_stop → reviewer let_exit 先于评估器短路——
// claude 跑道无此链路）。
// 公共骨架与 E1–E2 一致；worker/评估器均由 `opencode` shim 应答，
// reviewer 走本地 HTTP mock（runtime 无关）。
//
// E2E_LIVE=1 时服务端是 live 环境（无 shim），场景哨兵 prompt 无从应答，
// 整文件跳过（live 层未上 opencode 跑道，见设计 §2.5）。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

test('O1 opencode 基线：feedback 评估器一轮完成，原生 usage 归一后读数非零', async ({ page }) => {
  const project = await createProject('o1-opencode-baseline', { runtime: 'opencode' })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'pass-first', {
    project, runtime: 'opencode',
  })
  await detail.expectStatus('已完成')
  await detail.expectIterations(1, 3)
  await detail.expectHeaderMeta()
  // step_finish 原生 tokens（input/output/cache.write/read）必须归一成
  // Anthropic usage 形状——driver 侧 verbatim 透传的话此处渲染恒为 0
  // （breather 配比 / Dashboard token 同源读数一起失明）。
  await expect(detail.logText('input 128 / output 32'))
    .toBeVisible({ timeout: 15_000 })
})

test('O2 opencode 反馈回路：两轮收敛（--session 复用同一原生会话）', async ({ page }) => {
  const project = await createProject('o2-opencode-review', { runtime: 'opencode' })
  await switchProject(page, project.dir)

  // 显式关 reviewer：opencode 的 step_finish 会合成 on_stop（设计 §4.5），
  // reviewer 开启时 stop hook 的 let_exit 会先于评估器短路（该链路由 O4
  // 反向锁定），反馈回路用例须走无 reviewer 干预的纯链路。
  const detail = await startSession(page, 'review-then-pass', {
    project, runtime: 'opencode', reviewer: false,
  })
  // 第 1 轮 shim 回复带 [E2E:INCOMPLETE]，评估器判未完成；第 2 轮经
  // --session <原生会话 id> 续跑后补齐——迭代推进到 2 证明反馈回路跑过。
  await detail.expectIterations(2, 3)
  await detail.expectStatus('已完成')
  // resume 链路可观测断言：迭代 2/3 + 已完成只证明反馈回路跑过——shim 的
  // 回合推进靠 <cwd> state.json 计数，与是否传 --session 无关（resume 断开
  // 时每轮起新原生会话、迭代照样推进）。shim 把「本轮是否收到 --session」
  // 与所用原生会话 id 落盘，回读断言：第 2 轮收到 --session（resumed）且
  // 复用的原生会话 id 与后端捕获的 native_session_id 一致，才证明「复用同一
  // 原生会话」真实跑过。
  const sdk = (await detail.sessionField('native_session_id')) as string | null
  expect(sdk).toBeTruthy()
  await expect.poll(async () => {
    const st = await readShimState(project.dir)
    return st.resumed === true && st.session_id === sdk
  }, { timeout: 15_000 }).toBe(true)
})

test('O4 opencode + reviewer：step_finish 合成 on_stop，let_exit 先于评估器短路', async ({ page }) => {
  const project = await createProject('o4-opencode-reviewer', { runtime: 'opencode' })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'review-then-pass', {
    project, runtime: 'opencode', reviewer: true,
  })
  // opencode driver 在 step_finish(reason=stop) 上合成 on_stop → reviewer
  // decide_stop（本地 HTTP mock 恒答 let_exit）→ loop 以 reviewer_complete
  // 短路、评估器被跳过——claude 跑道无此链路（其 shim 不发 hook 回调），
  // 本条锁的是 opencode 特有的 stop-hook 真实链路。
  await detail.expectStatus('已完成')
  await detail.expectIterations(1, 3)
  await expect.poll(() => detail.sessionField('stop_reason'), { timeout: 15_000 })
    .toBe('reviewer_complete')
})

test('O3 opencode 工具渲染：tool_use 合并事件的成败对折叠块', async ({ page }) => {
  const project = await createProject('o3-opencode-tool-loop', { runtime: 'opencode' })
  await switchProject(page, project.dir)

  const detail = await startSession(page, 'tool-loop', {
    project, runtime: 'opencode',
  })
  await detail.expectStatus('已完成')

  const log = page.locator('.vlog')
  // 成功对 + 失败对的折叠块标题（`[时间] 工具名 ▸`；opencode 工具名是
  // 小写类别名 bash/read，与 claude 的 PascalCase 不同）。
  const okTitle = log.locator('.tool-block-title').filter({ hasText: 'bash' })
  const failTitle = log.locator('.tool-block-title').filter({ hasText: 'read' })
  await expect(okTitle).toBeVisible({ timeout: 15_000 })
  await expect(failTitle).toBeVisible()
  // 失败块：折叠态即带 ✗ 前缀标红（state.status=error → is_error）。
  await expect(failTitle).toHaveText(/^✗ \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] read ▸$/)
  await expect(failTitle).toHaveClass(/failed/)

  // 展开成功块：命令行 + 结果（call+result 合并在一个 part.state，driver
  // 拆成 TOOL_USE/TOOL_RESULT 后照常配对渲染）。
  await okTitle.click()
  await expect(log.locator('.tool-block-command').filter({ hasText: '$ echo workflow-controller-e2e-tool-ok' }))
    .toBeVisible()
  await expect(log.locator('.tool-block-result').filter({ hasText: 'workflow-controller-e2e-tool-ok' }))
    .toBeVisible()

  // 展开失败块：is_error 结果标红展示。
  await failTitle.click()
  await expect(
    log.locator('.tool-block-result.failed').filter({ hasText: 'File not found: /nonexistent/e2e-missing.txt' }),
  ).toBeVisible()

  // Iteration 分隔线（事件流驱动的真实迭代投影）。
  await expect(log.getByText('━━ Iteration 1/3 ━━')).toBeVisible()
})
