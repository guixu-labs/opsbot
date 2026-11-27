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

import { expect, test, type Page } from './fixtures'
import { sseBody } from './support/mock-session'

const config = {
  project_dir: '/tmp/e2e-project',
  skills_path: '/tmp/skills',
  agents_path: '/tmp/agents',
  recent_dirs: ['/tmp/e2e-project'],
  hook_server: { enabled: false, host: 'localhost' },
  reviewer: { enabled: true, timeout_seconds: 60, mode: 'auto' },
  watchdog: {
    subagent_timeout_seconds: 0,
    track_file: '',
    file_stall_threshold: 0,
    track_keyword_file: '',
    track_keyword: '',
  },
  context_bay: {
    repo_url: '',
    snapshot_paths: [],
  },
}

test('global Settings saves edited configuration', async ({ page }) => {
  let savedConfig: Record<string, unknown> | null = null
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'PUT') {
      savedConfig = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: config })
  })
  await page.route('**/api/v1/config/save', async (route) => {
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto('/settings?section=全局设置', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // Bind to the "Skills 路径" form item instead of the dialog's nth(0) input, so a
  // new field rendered earlier in the dialog cannot silently retarget this fill.
  const skillsInput = dialog.locator('.n-form-item').filter({ hasText: 'Skills 路径' }).locator('input')
  await skillsInput.fill('/tmp/edited-skills')
  await dialog.getByRole('button', { name: '保存全局设置' }).click()

  await expect.poll(() => savedConfig).not.toBeNull()
  expect(savedConfig).toMatchObject({ skills_path: '/tmp/edited-skills' })
})

test('Plugins section can toggle an installed plugin', async ({ page }) => {
  let toggled = false
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: config })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [{ name: 'demo', version: '1.0.0', enabled: false, path: '/tmp/demo', extra: null, manifest: [] }] } })
  })
  await page.route('**/api/v1/plugins/demo/toggle', async (route) => {
    toggled = true
    await route.fulfill({ json: { ok: true, enabled: true } })
  })

  await page.goto('/settings?section=插件', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await dialog.getByText('插件', { exact: true }).click()
  await expect(dialog.getByText('demo', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '启用' }).click()
  await expect.poll(() => toggled).toBe(true)
})

test('Provider settings can test, save, copy, reject duplicates, and delete', async ({ page }) => {
  type Provider = {
    key?: string
    model?: string
    base_url?: string
    runtime?: string
    index?: number
    provider_index: number
    status?: string
    worker_validation?: { status: string }
    reviewer_validation?: { status: string }
  }

  const existingProvider: Provider = {
    key: 'sk-existing',
    model: 'existing-model',
    base_url: '',
    runtime: 'claude_sdk',
    index: 0,
    provider_index: 0,
    worker_validation: { status: 'valid' },
    reviewer_validation: { status: 'valid' },
  }
  let providers: Provider[] = [existingProvider]
  let postedCount = 0
  let postedKeys: Array<Record<string, string>> = []
  let deletedProviderIndex: number | null = null

  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: config })
  })
  await page.route('**/api/v1/project-config', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/auth/keys', async (route) => {
    if (route.request().method() === 'POST') {
      postedCount += 1
      postedKeys = JSON.parse(route.request().postData() || '{}').keys
      providers = postedKeys.map((entry, index): Provider => ({
        ...entry,
        index,
        provider_index: index,
        status: index === 0 ? 'active' : 'unused',
        worker_validation: { status: 'valid' },
        reviewer_validation: { status: 'valid' },
      }))
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: { keys: providers.map(({ status, worker_validation, reviewer_validation, ...entry }) => entry) } })
  })
  await page.route('**/api/v1/auth/keys/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      deletedProviderIndex = Number(new URL(route.request().url()).pathname.split('/').pop())
      providers = providers.filter((item) => item.provider_index !== deletedProviderIndex)
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fallback()
  })
  await page.route('**/api/v1/auth/settings', async (route) => {
    await route.fulfill({ json: { default_model: 'default-model', default_url: 'https://default.test' } })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { provider_count: providers.length, providers } })
  })
  await page.route('**/api/v1/auth/test-key', async (route) => {
    await route.fulfill({ json: { success: true, reviewer: { status: 'valid' } } })
  })
  await page.route('**/api/v1/session/providers', async (route) => {
    await route.fulfill({ json: { providers: [], current_model: '' } })
  })

  await page.goto('/settings', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByText('模型供应商', { exact: true }).click()
  await expect(dialog.getByText('已配置（1）')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '添加并保存' })).toBeDisabled()

  await dialog.locator('.n-select').filter({ hasText: 'Worker 运行时（必选）' }).click()
  await page.getByText('Claude CLI', { exact: true }).click()
  await dialog.getByPlaceholder('API 密钥（必填）').fill('sk-new')
  await dialog.getByPlaceholder('模型（可选，默认 default-model）').fill('new-model')
  await dialog.getByPlaceholder('Base URL（可选，默认 https://default.test）').fill('https://new.test')
  await dialog.getByRole('button', { name: '测试', exact: true }).click()
  await page.getByRole('button', { name: '好的' }).click()

  await dialog.getByRole('button', { name: '添加并保存' }).click()
  await expect.poll(() => postedCount).toBe(1)
  expect(postedKeys).toEqual([
    { key: 'sk-existing', model: 'existing-model', runtime: 'claude_sdk' },
    { key: 'sk-new', model: 'new-model', base_url: 'https://new.test', runtime: 'claude_cli' },
  ])
  await expect(dialog.getByText('已配置（2）')).toBeVisible()
  await expect(dialog.getByPlaceholder('API 密钥（必填）')).toHaveValue('')

  const newRow = dialog.getByRole('row').filter({ hasText: 'new-model' })
  await newRow.getByRole('button', { name: '复制' }).click()
  await expect(dialog.getByPlaceholder('API 密钥（必填）')).toHaveValue('sk-new')
  await expect(dialog.getByRole('button', { name: '添加并保存' })).toBeDisabled()

  await dialog.getByRole('button', { name: '测试', exact: true }).click()
  await page.getByRole('button', { name: '好的' }).click()
  await dialog.getByRole('button', { name: '添加并保存' }).click()
  await expect(page.getByText('该 Provider 配置已存在，未重复添加')).toBeVisible()
  await expect.poll(() => postedCount).toBe(1)

  await newRow.getByRole('button', { name: '删除' }).click()
  await page.locator('.n-dialog').filter({ hasText: '确认删除' }).getByRole('button', { name: '删除' }).click()
  await expect.poll(() => deletedProviderIndex).toBe(1)
  expect(postedCount).toBe(1)
  await expect(dialog.getByText('已配置（1）')).toBeVisible()
  await expect(dialog.getByText('new-model')).toBeHidden()
})

test('Settings surfaces and provider links follow live theme changes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const themedConfig = {
    ...config,
    context_bay: { repo_url: '', snapshot_paths: ['operators/add/'] },
  }
  const provider = {
    key: 'sk-theme',
    model: 'theme-model',
    base_url: 'https://theme.test',
    runtime: 'claude_sdk',
    index: 0,
    provider_index: 0,
  }
  await page.route('**/api/v1/config', async (route) => {
    await route.fulfill({ json: themedConfig })
  })
  await page.route('**/api/v1/project-config', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/auth/keys', async (route) => {
    await route.fulfill({ json: { keys: [provider] } })
  })
  await page.route('**/api/v1/auth/settings', async (route) => {
    await route.fulfill({ json: { default_model: 'default-model', default_url: 'https://default.test' } })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { provider_count: 1, providers: [provider] } })
  })
  await page.route('**/api/v1/session/providers', async (route) => {
    await route.fulfill({ json: { providers: [], current_model: '' } })
  })

  await page.goto('/settings?section=Context Bay 上传', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByText('Context Bay 上传', { exact: true }).click()
  const pathItem = dialog.locator('.snapshot-path-item').first()
  await expect(pathItem).toBeVisible()
  await expect(pathItem).toHaveCSS('background-color', 'rgb(22, 27, 34)')
  await expect(pathItem.locator('span').first()).toHaveCSS('color', 'rgb(240, 246, 252)')
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('settings-context-bay-dark.png') })

  await dialog.getByText('模型供应商', { exact: true }).click()
  const providerLink = dialog.locator('span[style*="--workflow-controller-primary"]').filter({ hasText: 'https://theme.test' })
  await expect(providerLink).toHaveCSS('color', 'rgb(88, 166, 255)')

  await dialog.getByText('外观', { exact: true }).click()
  await dialog.locator('.n-select').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: 'GitHub Light' }).click()
  await dialog.getByText('Context Bay 上传', { exact: true }).click()
  await expect(pathItem).toBeVisible()
  await expect(pathItem).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(pathItem.locator('span').first()).toHaveCSS('color', 'rgb(31, 35, 40)')
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('settings-context-bay-light.png') })

  await dialog.getByText('模型供应商', { exact: true }).click()
  await expect(providerLink).toHaveCSS('color', 'rgb(9, 105, 218)')
})

// 设置弹窗挂载即拉 config/project-config/plugins/auth(keys/settings/status)/
// session providers；新用例统一 mock 这些端点，保持离线确定性。
async function mockSettingsDeps(page: Page) {
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ...config, brand_name: 'Workflow Controller' } })
      return
    }
    await route.fulfill({ json: { ok: true } })
  })
  await page.route('**/api/v1/project-config', async (route) => {
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/v1/plugins', async (route) => {
    await route.fulfill({ json: { plugins: [] } })
  })
  await page.route('**/api/v1/auth/keys', async (route) => {
    await route.fulfill({ json: { keys: [] } })
  })
  await page.route('**/api/v1/auth/settings', async (route) => {
    await route.fulfill({ json: { default_model: 'default-model', default_url: 'https://default.test' } })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { provider_count: 0, providers: [] } })
  })
  await page.route('**/api/v1/session/providers', async (route) => {
    await route.fulfill({ json: { providers: [], current_model: '' } })
  })
}

test('appearance save failure keeps the previous brand title', async ({ page }) => {
  // ST-03（①故障注入：PUT /config 500 → 不假成功 + 品牌名乐观预写回滚）
  // document.title 跟随 SSE config_update 的 brand_name（App.vue watch），
  // 这里 mock 流以固定初始品牌，失败后标题不得变成新品牌。
  await page.route('**/api/v1/events/stream', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: sseBody([
      ['config_update', { brand_name: 'Workflow Controller' }],
      ['session_update', []],
    ]),
  }))
  await mockSettingsDeps(page)
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 500, json: { detail: 'config write failed' } })
      return
    }
    await route.fulfill({ json: { ...config, brand_name: 'Workflow Controller' } })
  })
  await page.route('**/api/v1/config/save', async (route) => {
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto('/settings?section=外观', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.title()).toBe('Workflow Controller')

  await dialog.getByPlaceholder('Workflow Controller').fill('E2E 失败品牌')
  await dialog.getByRole('button', { name: '保存外观设置' }).click()

  await expect(page.getByText('保存失败: Error: HTTP 500')).toBeVisible()
  await expect(page.getByText('外观设置已保存')).toHaveCount(0)
  await expect.poll(() => page.title()).toBe('Workflow Controller')
})

test('provider retest surfaces masked worker and reviewer failures', async ({ page }) => {
  // ST-07（①故障注入：矩阵 provider 指向本地 mock 恒成功，失败分支只能注入）
  const provider = {
    key: 'sk-abc123', model: 'retest-model', base_url: 'https://api.example.com',
    runtime: 'claude_sdk', index: 0, provider_index: 0, status: 'active',
    worker_validation: { status: 'valid' }, reviewer_validation: { status: 'valid' },
  }
  await mockSettingsDeps(page)
  await page.route('**/api/v1/auth/keys', async (route) => {
    await route.fulfill({ json: { keys: [provider] } })
  })
  await page.route('**/api/v1/auth/status', async (route) => {
    await route.fulfill({ json: { provider_count: 1, providers: [provider] } })
  })
  const mockRetest = async (payload: Record<string, unknown>) => {
    await page.route('**/api/v1/auth/keys/0/test', async (route) => {
      await route.fulfill({ json: payload })
    })
  }

  await mockRetest({
    success: false,
    error: 'connect timeout to https://api.example.com/v1 (key sk-***abc)',
  })
  await page.goto('/settings?section=模型供应商', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('已配置（1）')).toBeVisible()

  // 分支一：Worker / Reviewer 检测失败 → 弹窗展示脱敏错误（可滚动等宽区）
  await dialog.getByRole('button', { name: '重新测试' }).click()
  const failedDialog = page.locator('.n-dialog').filter({ hasText: 'Worker 与 Reviewer 检测失败' })
  await expect(failedDialog).toBeVisible()
  await expect(failedDialog).toContainText('connect timeout to https://api.example.com/v1 (key sk-***abc)')
  await failedDialog.getByRole('button', { name: '关闭' }).click()
  await expect(failedDialog).toBeHidden()

  // 分支二：Worker 通过但 Reviewer 不可用 → 「Worker 检测通过」+ Reviewer 区分提示。
  // SettingsView 打开弹窗后 router.replace('/')，reload 会停在 '/'（弹窗不开），
  // 须重新走深链入口。
  await mockRetest({
    success: true,
    worker: { status: 'valid' },
    reviewer: { status: 'invalid', error: 'reviewer probe failed: 401' },
  })
  await page.goto('/settings?section=模型供应商', { waitUntil: 'domcontentloaded' })
  await dialog.getByRole('button', { name: '重新测试' }).click()
  const partialDialog = page.locator('.n-dialog').filter({ hasText: 'Worker 检测通过' })
  await expect(partialDialog).toBeVisible()
  await expect(partialDialog).toContainText('Reviewer 不可用：reviewer probe failed: 401')
  await partialDialog.getByRole('button', { name: '关闭' }).click()
  await expect(partialDialog).toBeHidden()
})

test('global settings save failures never claim success', async ({ page }) => {
  // ST-10（①故障注入：PUT /config 500 与 PUT 成功但 /config/save 500 两分支）
  await mockSettingsDeps(page)
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 500, json: { detail: 'config write failed' } })
      return
    }
    await route.fulfill({ json: { ...config, brand_name: 'Workflow Controller' } })
  })
  await page.route('**/api/v1/config/save', async (route) => {
    await route.fulfill({ json: { ok: true } })
  })

  await page.goto('/settings?section=全局设置', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const skillsInput = () => dialog.locator('.n-form-item').filter({ hasText: 'Skills 路径' }).locator('input')

  // 分支一：PUT /config 500
  await skillsInput().fill('/tmp/failing-skills-1')
  await dialog.getByRole('button', { name: '保存全局设置' }).click()
  await expect(page.getByText('保存失败: Error: HTTP 500')).toBeVisible()
  await expect(page.getByText('全局设置已保存')).toHaveCount(0)

  // 分支二：PUT 成功但落盘（POST /config/save）500。SettingsView 打开弹窗后
  // router.replace('/')，reload 会停在 '/'（弹窗不开），须重新走深链入口。
  await page.route('**/api/v1/config', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: { ...config, brand_name: 'Workflow Controller' } })
  })
  await page.route('**/api/v1/config/save', async (route) => {
    await route.fulfill({ status: 500, json: { detail: 'disk full' } })
  })
  await page.goto('/settings?section=全局设置', { waitUntil: 'domcontentloaded' })
  await skillsInput().fill('/tmp/failing-skills-2')
  await dialog.getByRole('button', { name: '保存全局设置' }).click()
  await expect(page.getByText('保存失败: Error: HTTP 500')).toBeVisible()
  await expect(page.getByText('全局设置已保存')).toHaveCount(0)
})

test('plugin installation refreshes the installed plugin list', async ({ page }) => {
  // ST-06（③环境自扰：真实安装会写源码树，矩阵层禁止执行）
  const plugins: Array<Record<string, unknown>> = []
  let installBody: Record<string, unknown> = {}
  await mockSettingsDeps(page)
  await page.route('**/api/v1/plugins', route => route.fulfill({ json: { plugins } }))
  await page.route('**/api/v1/plugins/install', async route => {
    installBody = JSON.parse(route.request().postData() || '{}')
    plugins.push({ name: 'demo-installed', version: '1.0.0', enabled: false, manifest: [] })
    await route.fulfill({ json: { ok: true, name: 'demo-installed' } })
  })

  await page.goto('/settings?section=插件', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('/path/to/plugin-dir').fill('/tmp/demo-installed')
  await dialog.getByRole('button', { name: '安装', exact: true }).click()

  await expect.poll(() => installBody).toMatchObject({ path: '/tmp/demo-installed' })
  await expect(dialog.getByText('demo-installed', { exact: true })).toBeVisible()
  await expect(dialog.getByPlaceholder('/path/to/plugin-dir')).toHaveValue('')
})

test('provider-wide defaults save and update the new-provider placeholders', async ({ page }) => {
  // ST-08（③环境自扰：修改矩阵唯一 provider 的默认值会干扰同批用例）
  const defaults = { default_model: 'default-model', default_url: 'https://default.test' }
  let savedDefaults: Record<string, unknown> = {}
  await mockSettingsDeps(page)
  await page.route('**/api/v1/auth/settings', async route => {
    if (route.request().method() === 'PUT') {
      savedDefaults = JSON.parse(route.request().postData() || '{}')
      Object.assign(defaults, savedDefaults)
      await route.fulfill({ json: { ok: true, ...defaults } })
      return
    }
    await route.fulfill({ json: defaults })
  })

  await page.goto('/settings?section=模型供应商', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  const card = dialog.locator('.n-card').filter({ hasText: '全局默认设置' })
  await expect(card).toBeVisible()
  await expect(dialog.getByPlaceholder('模型（可选，默认 default-model）')).toBeVisible()
  await card.locator('.n-form-item').filter({ hasText: '默认模型' }).locator('input')
    .fill('e2e-shared-model')
  await card.locator('.n-form-item').filter({ hasText: '默认 Base URL' }).locator('input')
    .fill('https://shared-default.test')
  await card.getByRole('button', { name: '保存默认设置' }).click()

  await expect.poll(() => savedDefaults).toMatchObject({
    default_model: 'e2e-shared-model', default_url: 'https://shared-default.test',
  })
  await expect(dialog.getByPlaceholder('模型（可选，默认 e2e-shared-model）')).toBeVisible()
  await expect(dialog.getByPlaceholder('Base URL（可选，默认 https://shared-default.test）')).toBeVisible()
})

test('Hook server settings are included in the global config save', async ({ page }) => {
  let savedConfig: Record<string, unknown> = {}
  await mockSettingsDeps(page)
  await page.route('**/api/v1/config', async route => {
    if (route.request().method() === 'PUT') {
      savedConfig = JSON.parse(route.request().postData() || '{}')
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ json: config })
  })
  await page.route('**/api/v1/config/save', route => route.fulfill({ json: { ok: true } }))

  await page.goto('/settings?section=全局设置', { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  const hookCard = dialog.locator('.n-card').filter({ hasText: 'Hook 服务器' })
  await hookCard.locator('.n-checkbox').filter({ hasText: '启用' }).click()
  await hookCard.locator('.n-form-item').filter({ hasText: '主机' }).locator('input').fill('127.0.0.1')
  await dialog.getByRole('button', { name: '保存全局设置' }).click()

  await expect.poll(() => savedConfig).toMatchObject({
    hook_server: { enabled: true, host: '127.0.0.1' },
  })
})
