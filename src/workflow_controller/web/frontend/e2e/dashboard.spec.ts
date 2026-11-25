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

// Dashboard 域 mock 层用例（设计文档 §6.1 DA 系列）。每条用例按 §3.4 标注
// 必要性类别（①故障注入 / ②形态渲染 / ③状态不可达·表单造数）：
//   首页在已有会话时仍只显示背景（②形态渲染）
//   DA-06 新建表单 runtime 联动（③表单造数）
//   DA-07 高级设置：评估器说明与迭代上限（③表单造数）
//   DA-08 workflow 表单分支与下发字段（③表单造数）
//   DA-09 新建弹窗提交门控（③状态不可达：矩阵 boot 恒种假 provider）
//   DA-10 无项目时的侧栏入口（③状态不可达：矩阵 project_dir 非空且已种 provider）
//   DA-11 Provider 下拉禁用原因（③状态组合：需多 provider 状态）
// 约定沿 §4：placeholder / form-item label 定位（不用位置序号）、page.route
// 逆序派发（通配路由先注册，专用路由由用例后注册）、拦截侧记录 + expect.poll。

const PROJECT_DIR = '/tmp/e2e-project'

/** SSE 事件序列 → text/event-stream body（journeys.spec 同样的 helper）。 */
function sseBody(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** SSE session_update payload（SessionInfo.__dict__ 形状；与 support/mock-session.ts 的 sessionPayload 同源，本 spec 自持）。 */
function sessionInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e2e-dashboard-session',
    name: 'E2E dashboard session',
    role: 'worker',
    state: 'idle',
    loop_status: 'no',
    stop_reason: null,
    loop_hold: null,
    current_iteration: 1,
    max_iterations: 3,
    progress: 0,
    elapsed_seconds: 2,
    created_at_iso: '2026-11-04T00:00:00Z',
    error: null,
    last_activity: [],
    birth_handoff_doc: null,
    result: null,
    predecessor: null,
    successors: [],
    sdk_session_id: 'sdk-e2e-dashboard',
    project_dir: PROJECT_DIR,
    run_id: null,
    plugin_metadata: {},
    reviewer_mode: 'auto',
    provider_index: null,
    reviewer_provider_index: null,
    ...overrides,
  }
}

interface DashboardMockOptions {
  /** SSE config_update payload（projectDir / recent_dirs 的唯一数据源）。 */
  config?: Record<string, unknown>
  /** SSE session_update payload（Dashboard 会话列表的唯一数据源，不走 GET /sessions）。 */
  sessions?: Array<Record<string, unknown>>
  /** SSE auth_update payload（新建弹窗模型下拉的数据源 authState）。 */
  authUpdate?: Record<string, unknown>
  /** GET /auth/status payload（authReady 门控的 has_api_key + authState 的 REST 回退）。 */
  authStatus?: Record<string, unknown>
  /** GET /plugins payload（graph 分支按 pluginEnabled('graph') 消费）。 */
  plugins?: Array<Record<string, unknown>>
  /** GET /project-config?* payload（新建弹窗的 runtime / evaluator 等默认值）。 */
  projectConfig?: Record<string, unknown>
}

/**
 * mock Dashboard 页（'/'）的全部后端依赖。通用路由在此统一注册；
 * 专用路由（POST /sessions/start、POST /runs、/runs/{id}/** 等）由用例在
 * 调用本函数之后注册——Playwright 按注册逆序派发（newest wins），后注册的
 * 专用路由天然 shadow 通用路由。
 */
async function mockDashboard(page: Page, options: DashboardMockOptions = {}) {
  await page.route('**/api/v1/config', (route) => {
    if (route.request().method() === 'GET') {
      // 仅 NewSessionModal.loadProjectConfig 的全局 reviewer 解析消费此端点。
      return route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
    }
    if (route.request().method() === 'PUT') {
      return route.fulfill({ json: { ok: true } })
    }
    return route.continue()
  })
  await page.route('**/api/v1/plugins', (route) =>
    route.fulfill({ json: { plugins: options.plugins ?? [] } }))
  await page.route('**/api/v1/project-config*', (route) =>
    route.fulfill({ json: options.projectConfig ?? {} }))
  await page.route('**/api/v1/auth/status', (route) =>
    route.fulfill({ json: options.authStatus ?? { has_api_key: true } }))
  const events: Array<[string, unknown]> = [
    ['config_update', options.config ?? { project_dir: PROJECT_DIR, recent_dirs: [PROJECT_DIR] }],
    ['session_update', options.sessions ?? []],
  ]
  if (options.authUpdate) events.push(['auth_update', options.authUpdate])
  await page.route('**/api/v1/events/stream', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: sseBody(events) }))
}

test('Dashboard shows only the background when sessions exist in the sidebar', async ({ page }) => {
  const background = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E'
  await page.addInitScript((url) => {
    localStorage.setItem('workflow-controller-appearance-background-image', url)
  }, background)
  await mockDashboard(page, { sessions: [sessionInfo({ state: 'running' })] })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const sidebar = page.locator('.sidebar')
  await expect(sidebar.getByText('E2E dashboard session')).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '全部停止' })).toBeVisible()

  const main = page.locator('.app-main-layout > .n-layout-scroll-container')
  await expect(main.locator(':scope > *')).toHaveCount(1)
  await expect(main.locator('.dashboard-placeholder')).toHaveCSS('background-image', `url("${background}")`)
})

test('new-session form shows the cpx capture switch only for CLI runtimes', async ({ page }) => {
  // DA-06 ③表单造数：cpx 开关只随表单 runtime 显隐（SessionForm 的
  // v-if="form.runtime === 'claude_cli' || form.runtime === 'opencode'"），
  // 纯前端联动，真实链路断言价值在请求形状（矩阵 E2 已覆盖），此处钉住形态。
  await mockDashboard(page, {
    plugins: [],
    projectConfig: { runtime: 'claude_cli' },
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true }).click()
  const modal = page.getByRole('dialog')
  const cpxField = modal.locator('.n-form-item').filter({ hasText: '通过 cpx 捕获' })
  const runtimeSelect = modal.locator('.n-form-item').filter({ hasText: '代理框架' }).locator('.n-select')

  // 项目默认 runtime=claude_cli（/project-config 回填）：开关可见。
  await expect(cpxField).toBeVisible()

  // 切到 SDK runtime：开关隐藏（v-if 卸载，非 CSS 隐藏）。
  await runtimeSelect.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Claude SDK' }).click()
  await expect(cpxField).toHaveCount(0)

  // 切回 Claude CLI：开关恢复可见。
  await runtimeSelect.click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Claude CLI' }).click()
  await expect(cpxField).toBeVisible()
})

test('advanced settings describe the evaluator and send max_iterations on start', async ({ page }) => {
  // DA-07 ③表单造数：评估器下拉下方的一行说明与「最大迭代」下发。收敛语义
  // 已由矩阵 X1/E4 佐证，本条只管表单联动与 start 请求形状。
  let startBody: Record<string, unknown> = {}
  await mockDashboard(page, { plugins: [], projectConfig: {} })
  await page.route('**/api/v1/sessions/start', async (route) => {
    startBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { session_id: 'e2e-evaluator-session' } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByText('高级设置').click()

  const evaluatorField = modal.locator('.n-form-item').filter({ hasText: '评估器' })
  await evaluatorField.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'passthrough' }).click()
  // passthrough 专属说明（SessionForm evaluatorDescriptions）。
  await expect(modal.getByText('不由评估器判断完成，达到最大迭代后停止。')).toBeVisible()

  await modal.locator('.n-form-item').filter({ hasText: '最大迭代' }).locator('input').fill('5')
  await modal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt').fill('执行 E2E 评估器表单流程')
  await modal.getByRole('button', { name: '启动会话' }).click()

  await expect.poll(() => startBody).toMatchObject({
    evaluator: 'passthrough',
    max_iterations: 5,
    prompt: '执行 E2E 评估器表单流程',
  })
  await expect(modal).toBeHidden()
})

test('graph workflow branch posts the yaml program path and navigates to the Run', async ({ page }) => {
  // DA-08 ③表单造数：graph 插件启用时弹窗多出 YAML 路径输入、填路径后按钮变
  // 「启动工作流」、POST /api/v1/runs 下发 graph-yaml@1 程序字段；启动→跳转的
  // 真实链路已由矩阵 E3 覆盖，本条只管表单联动与请求形状。
  let runBody: Record<string, unknown> = {}
  await mockDashboard(page, {
    plugins: [{ name: 'graph', enabled: true, manifest: [] }],
    projectConfig: {},
  })
  const workflow = {
    run_id: 'e2e-run-new', kind: 'workflow', format: 'graph-yaml@1', label: 'e2e-flow',
    status: 'pending', pause_reason: null, work_dir: PROJECT_DIR,
    created_at: '2026-11-04T00:00:00Z', finished_at: null, error: null,
  }
  const container = { ...workflow, run_id: 'e2e-container', kind: 'container', format: '', label: '容器运行' }
  for (const run of [workflow, container]) {
    await page.route(`**/api/v1/runs/${run.run_id}`, route =>
      route.fulfill({ json: { run, sessions: [] } }))
    await page.route(`**/api/v1/runs/${run.run_id}/state`, route =>
      route.fulfill({ json: { processes: [], metrics: null, driver: null } }))
    await page.route(`**/api/v1/runs/${run.run_id}/events**`, route =>
      route.fulfill({ json: { events: [], next_cursor: null } }))
  }
  await page.route('**/api/v1/runs', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { runs: [workflow, container] } })
      return
    }
    runBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { run_id: 'e2e-run-new', status: 'pending', format: 'graph-yaml@1', kind: 'workflow' } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true }).click()
  const modal = page.getByRole('dialog')
  await expect(modal.getByText('YAML 路径（留空则创建普通会话）')).toBeVisible()

  // 路径留空时仍是普通会话按钮；填入 graph yaml 后切「启动工作流」。
  await expect(modal.getByRole('button', { name: '启动会话' })).toBeVisible()
  await modal.getByPlaceholder('graph yaml 文件路径，留空 = 普通会话').fill(`${PROJECT_DIR}/graphs/e2e-flow.yaml`)
  await expect(modal.getByRole('button', { name: '启动工作流' })).toBeVisible()

  await modal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt').fill('执行 E2E 工作流')
  await modal.getByRole('button', { name: '启动工作流' }).click()

  // 下发字段（NewSessionModal.startWorkflowRun）：format / program_path /
  // work_dir / label（yaml 文件名 stem）。
  await expect.poll(() => runBody).toMatchObject({
    format: 'graph-yaml@1',
    program_path: `${PROJECT_DIR}/graphs/e2e-flow.yaml`,
    work_dir: PROJECT_DIR,
    label: 'e2e-flow',
  })
  await expect(page).toHaveURL(/\/run\/e2e-run-new$/)
  await expect(page.locator('.app-main-layout').getByText('e2e-flow', { exact: true })).toBeVisible()

  // 两种 Run 都没有可从侧栏打开的成员，仍可从「运行记录」回到详情。
  for (const run of [workflow, container]) {
    await page.goto('/')
    await page.getByRole('button', { name: '运行记录', exact: true }).click()
    await modal.getByRole('link', { name: run.label, exact: true }).click()
    await expect(page).toHaveURL(`/run/${run.run_id}`)
    await expect(page.locator('.app-main-layout').getByText(run.label, { exact: true })).toBeVisible()
  }
})

test('new-session submit stays gated until auth and the project become ready', async ({ page }) => {
  // DA-09 ③状态不可达：矩阵层 boot 恒种假 provider（has_api_key 恒真），门控的
  // 禁用分支在真实链路不可达，只能 mock。
  // 代码事实（与设计文档 §6.1 的表述差异）：authReady 仅由 App.vue 挂载时的
  // GET /auth/status has_api_key 驱动（useAuth.checkAuth），SSE auth_update 只喂
  // 模型下拉数据源 authState；projectDir 由 SSE config_update 驱动
  // （useProjectPaths）。因此本条用 has_api_key 翻转 + reload 驱动 auth 门控，
  // 用 SSE 重连帧的 config_update 翻转驱动弹窗内 projectDir 门控
  // （提交条件 !projectDir || loading || !authReady || starting，NewSessionModal）。
  let authOk = false
  let frameConfig: Record<string, unknown> = { project_dir: PROJECT_DIR, recent_dirs: [PROJECT_DIR] }
  await page.route('**/api/v1/events/stream', (route) => route.fulfill({
    contentType: 'text/event-stream',
    body: sseBody([['config_update', frameConfig], ['session_update', []]]),
  }))
  await page.route('**/api/v1/auth/status', (route) =>
    route.fulfill({ json: { has_api_key: authOk } }))
  await page.route('**/api/v1/config', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { reviewer: { enabled: false, mode: 'auto' } } })
    }
    if (route.request().method() === 'PUT') {
      return route.fulfill({ json: { ok: true } })
    }
    return route.continue()
  })
  await page.route('**/api/v1/plugins', (route) => route.fulfill({ json: { plugins: [] } }))
  await page.route('**/api/v1/project-config*', (route) => route.fulfill({ json: {} }))

  // 无可用 provider：authReady=false，新建入口按钮即被门控（弹窗无从打开）。
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const entry = page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true })
  await expect(entry).toBeDisabled()

  // provider 就绪（has_api_key=true）后 reload 重新鉴权：入口可用、弹窗提交可用。
  authOk = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(entry).toBeEnabled()
  await entry.click()
  const modal = page.getByRole('dialog')
  const submit = modal.getByRole('button', { name: '启动会话' })
  await expect(submit).toBeEnabled()

  // SSE 重连帧把 project_dir 清空 → 弹窗提交按钮实时转禁用；恢复推送后转可用。
  frameConfig = { project_dir: '', recent_dirs: [] }
  await expect(submit).toBeDisabled()
  frameConfig = { project_dir: PROJECT_DIR, recent_dirs: [PROJECT_DIR] }
  await expect(submit).toBeEnabled()
})

test('Dashboard without a project shows the sidebar add-project entry', async ({ page }) => {
  // DA-10 ③状态不可达：矩阵层 project_dir 非空且恒种 provider。
  await mockDashboard(page, {
    config: { project_dir: '', recent_dirs: [] },
    sessions: [],
    authStatus: { has_api_key: false },
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: '添加项目' })).toBeVisible()
  await expect(page.locator('.sidebar').getByRole('button', { name: '新建会话' })).toHaveCount(0)
})

test('session model dropdown explains disabled providers and starts with the usable one', async ({ page }) => {
  // DA-11 ③状态组合：需要「runtime 不匹配 + 可用」的多 provider 组合，矩阵层
  // 单 provider 环境造不出。数据源代码事实：会话模型下拉的 providers 来自
  // useSSE.authState（SSE auth_update，GET /auth/status 作 REST 回退），不是
  // /api/v1/session/providers（那是 Settings 的端点）；禁用原因文案在
  // SessionForm.workerModelOptions——runtime 不匹配渲染「绑定 {runtime}」。
  const mismatchedProvider = {
    index: 0, model: 'e2e-opencode-model', runtime: 'opencode', status: 'active', is_active: false,
    worker_validation: { status: 'valid' },
  }
  const usableProvider = {
    index: 1, model: 'e2e-cli-model', runtime: 'claude_cli', status: 'active', is_active: true,
    worker_validation: { status: 'valid' },
  }
  let startBody: Record<string, unknown> = {}
  await mockDashboard(page, {
    plugins: [],
    projectConfig: { runtime: 'claude_cli' },
    authUpdate: { providers: [mismatchedProvider, usableProvider] },
    authStatus: { has_api_key: true, providers: [mismatchedProvider, usableProvider] },
  })
  await page.route('**/api/v1/sessions/start', async (route) => {
    startBody = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ json: { session_id: 'e2e-provider-session' } })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.project-row.active').getByRole('button', { name: '新建会话', exact: true }).click()
  const modal = page.getByRole('dialog')
  const modelField = modal.locator('.n-form-item').filter({ hasText: '会话模型' })
  // 表单 runtime=claude_cli：不匹配项被禁用，可用项自动选中（selectUsableModels）。
  await expect(modelField).toContainText('e2e-cli-model')

  await modelField.locator('.n-select').click()
  const mismatchedOption = page.locator('.n-base-select-option').filter({ hasText: 'e2e-opencode-model' })
  await expect(mismatchedOption).toContainText('绑定 OpenCode')
  await expect(mismatchedOption).toHaveClass(/n-base-select-option--disabled/)

  await page.locator('.n-base-select-option').filter({ hasText: 'e2e-cli-model' }).click()
  await modal.getByPlaceholder('默认为 workflow-controller.yaml 中的 starting_prompt').fill('执行 E2E provider 表单流程')
  await modal.getByRole('button', { name: '启动会话' }).click()

  // 选中的可用 provider 随 start body 下发 provider_index 与模型名。
  await expect.poll(() => startBody).toMatchObject({
    provider_index: 1,
    model: 'e2e-cli-model',
  })
})
