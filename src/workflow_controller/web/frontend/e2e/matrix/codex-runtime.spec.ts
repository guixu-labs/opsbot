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

import { expect, test, type Page } from '../fixtures'
import { createProject, IS_LIVE, switchProject } from './support/env'
import { startSession } from './support/flows'

// 特性矩阵 e2e · codex runtime 基线（C1，设计文档
// docs/designs/workflow-controller-e2e-feature-matrix.md §2.4 C1 / §4.6）：
// `CodexCLIDriver` 的 `codex exec --json` 子进程链路。provider 是内置
// GPT 模型 gpt-5.5，catalog preflight 走 codex shim 的 debug models
// 子命令，worker probe 与真实回合都走 exec JSONL 事件流。
test.skip(IS_LIVE, 'E2E_LIVE=1 时为 live 环境（无 shim），shim 矩阵用例不运行')

async function validateCodexProvider(page: Page) {
  const status = await (await page.request.get('/api/v1/auth/status')).json()
  const provider = (status.providers as Array<Record<string, unknown>>)
    .find(item => item.runtime === 'codex_cli' && item.model === 'gpt-5.5')
  expect(provider).toBeTruthy()

  const response = await page.request.post(
    `/api/v1/auth/keys/${provider?.index}/test`,
  )
  expect(response.ok()).toBeTruthy()
  const payload = await response.json()
  expect(payload.worker.status).toBe('valid')

  // 校验写回 auth_state 后刷新页面，REST 兜底把 provider 状态带回模型下拉。
  await page.reload({ waitUntil: 'domcontentloaded' })
}

test('C1 codex + GPT 基线：内置模型 provider 校验通过并一轮完成', async ({ page }) => {
  const project = await createProject('c1-codex-gpt-baseline', { runtime: 'codex_cli' })
  await switchProject(page, project.dir)
  await validateCodexProvider(page)

  const detail = await startSession(page, 'pass-first', {
    project,
    runtime: 'codex_cli',
    reviewer: false,
  })

  await detail.expectStatus('已完成')
  await detail.expectIterations(1, 3)
  await expect(detail.logText('input 128 / output 32'))
    .toBeVisible({ timeout: 15_000 })
  await expect.poll(() => detail.sessionField('model'), { timeout: 15_000 })
    .toBe('gpt-5.5')
  await expect.poll(() => detail.sessionField('native_session_id'), { timeout: 15_000 })
    .toMatch(/^codex-e2e-/)
})
