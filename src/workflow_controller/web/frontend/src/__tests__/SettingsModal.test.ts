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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const mockVisible = ref(true)
const mockInitialSection = ref('模型供应商')
const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
const mockConfirmDelete = vi.fn().mockResolvedValue(true)
const mockPlugins = ref<any[]>([])
let postedKeys: unknown | undefined
let testedCandidate: any
let deletedProvider: string | undefined
let putConfigBody: any
let saveShouldFail = false

vi.mock('../composables/useToast', () => ({ useToast: () => mockToast }))
vi.mock('../composables/useConfirm', () => ({ useConfirm: () => ({ confirmDelete: mockConfirmDelete }) }))
vi.mock('../composables/useAuth', () => ({ useAuth: () => ({ checkAuth: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('../composables/useSettingsModal', () => ({
  useSettingsModal: () => ({ visible: mockVisible, initialSection: mockInitialSection }),
}))
vi.mock('../composables/usePlugins', () => ({
  usePlugins: () => ({ plugins: mockPlugins, loadPlugins: vi.fn().mockResolvedValue(undefined) }),
}))

const existingProvider = {
  key: 'sk-existing',
  model: 'existing-model',
  custom_name: 'existing-model',
  base_url: '',
  runtime: 'claude_sdk',
  provider_index: 1,
}
type ProviderWithStatus = typeof existingProvider & {
  status?: string
  reviewer_validation?: any
}

// 构造统一 JSON 响应。
function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve(data) } as Response
}

// 挂载设置弹窗并加载测试数据。
async function mountSettings() {
  const SettingsModal = (await import('../components/SettingsModal.vue')).default
  const wrapper = mount(SettingsModal, {
    global: { stubs: { NModal: { template: '<div><slot /></div>' }, DirPicker: true } },
  })
  await flushPromises()
  return { wrapper, setupState: (wrapper.vm as any).$.setupState }
}

// 按按钮文本查找按钮。
function findButton(text: string) {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.trim() === text)
}

beforeEach(() => {
  vi.clearAllMocks()
  postedKeys = undefined
  testedCandidate = undefined
  deletedProvider = undefined
  putConfigBody = undefined
  saveShouldFail = false
  mockVisible.value = true
  mockInitialSection.value = '模型供应商'
  mockPlugins.value = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/auth/keys' && init?.method === 'POST') {
      postedKeys = JSON.parse(String(init.body)).keys
      if (saveShouldFail) return { ok: false, json: () => Promise.resolve({ detail: '保存失败' }) } as Response
      return jsonResponse({ ok: true })
    }
    if (url.startsWith('/api/v1/auth/keys/') && init?.method === 'DELETE') {
      deletedProvider = url
      return jsonResponse({ ok: true })
    }
    if (url === '/api/v1/auth/keys') return jsonResponse({ keys: [existingProvider] })
    if (url === '/api/v1/auth/test-key' && init?.method === 'POST') {
      testedCandidate = JSON.parse(String(init.body))
      return jsonResponse({
        success: true,
        worker: { status: 'valid' },
        reviewer: { status: 'valid', thinking_mode: 'adaptive' },
      })
    }
    if (url === '/api/v1/auth/settings') return jsonResponse({ default_model: 'default-model', default_url: 'https://default.test' })
    if (url === '/api/v1/auth/status') {
      return jsonResponse({
        has_api_key: true,
        provider_count: currentProviders.length,
        providers: currentProviders.map((provider, index) => ({ index: index + 1, ...provider })),
      })
    }
    if (url === '/api/v1/config' && init?.method === 'PUT') {
      putConfigBody = JSON.parse(String(init.body))
      return jsonResponse({ ok: true })
    }
    if (url === '/api/v1/config') {
      return jsonResponse({
        hook_server: { enabled: true, port: 18765, host: 'localhost' },
        reviewer: { timeout_seconds: 300, mode: 'auto' },
        watchdog: { snapshot_paths: [] },
      })
    }
    if (url === '/api/v1/project-config') return jsonResponse({})
    if (url === '/api/v1/plugins') return jsonResponse([])
    if (url === '/api/v1/session/providers') return jsonResponse({ providers: [], current_model: '' })
    return jsonResponse({})
  }))
})

let currentProviders: ProviderWithStatus[] = [existingProvider]
let activeWrapper: VueWrapper | null = null


afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  currentProviders = [existingProvider]
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('SettingsModal provider interactions', () => {
  it('keeps defaults as placeholders and disables add before testing', { timeout: 15000 }, async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    expect(setupState.pendingKey).toEqual({ key: '', model: '', base_url: '', custom_name: '' })
    const keyInput = document.body.querySelector<HTMLInputElement>('input[placeholder="API 密钥（必填）"]')
    const eye = keyInput?.closest('.n-input')?.querySelector<HTMLElement>('.n-input__eye')
    expect(keyInput?.type).toBe('password')
    expect(eye).toBeTruthy()

    eye?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(keyInput?.type).toBe('text')

    eye?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(keyInput?.type).toBe('password')

    expect(document.body.querySelector('input[placeholder="模型（可选，默认 default-model）"]')).toBeTruthy()
    expect(document.body.querySelector('input[placeholder="自定义名（可选；模型名已被其他自定义名占用时必填）"]')).toBeTruthy()
    expect(document.body.querySelector('input[placeholder="Base URL（可选，默认 https://default.test）"]')).toBeTruthy()
    const addButton = findButton('添加并保存')
    expect(addButton?.disabled).toBe(true)

    setupState.pendingKeyTested = true
    setupState.pendingKeyTestOk = true
    await nextTick()
    expect(addButton?.disabled).toBe(false)
    expect(findButton('保存')).toBeUndefined()
  })

  it('adds and saves a tested provider, then clears the form', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.pendingKey = { key: 'sk-new', model: 'new-model', base_url: 'https://new.test' }
    setupState.pendingRuntime = 'claude_cli'
    await nextTick()
    setupState.pendingKeyTestOk = true
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(postedKeys).toEqual([
      { key: 'sk-existing', model: 'existing-model', custom_name: 'existing-model', runtime: 'claude_sdk' },
      { key: 'sk-new', model: 'new-model', base_url: 'https://new.test', runtime: 'claude_cli' },
    ])
    expect(setupState.pendingKey).toEqual({ key: '', model: '', base_url: '', custom_name: '' })
    expect(setupState.pendingRuntime).toBeNull()
    expect(setupState.pendingKeyTestOk).toBe(false)
  })

  it('rejects a duplicate provider without posting it', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.pendingKey = { key: existingProvider.key, model: existingProvider.model, base_url: '' }
    setupState.pendingRuntime = existingProvider.runtime
    await nextTick()
    setupState.pendingKeyTestOk = true
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(postedKeys).toBeUndefined()
    expect(mockToast.warning).toHaveBeenCalledWith('该 Provider 配置已存在，未重复添加')
    expect(setupState.pendingKey.key).toBe('')
    expect(setupState.pendingKeyTestOk).toBe(false)
  })

  it('rejects a duplicate custom name before posting', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.pendingKey = {
      key: 'sk-new', model: 'new-model', base_url: 'https://new.test',
      custom_name: 'existing-model',
    }
    setupState.pendingRuntime = 'claude_cli'
    await nextTick()
    setupState.pendingKeyTestOk = true
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(postedKeys).toBeUndefined()
    expect(mockToast.error).toHaveBeenCalledWith('自定义名重复：existing-model')
    expect(setupState.pendingKey.key).toBe('sk-new')
  })

  it('requires a custom name when the model name is already claimed, then sends it', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.pendingKey = { key: 'sk-new', model: 'existing-model', base_url: 'https://new.test' }
    setupState.pendingRuntime = 'claude_cli'
    await nextTick()
    setupState.pendingKeyTestOk = true
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(postedKeys).toBeUndefined()
    expect(mockToast.error).toHaveBeenCalledWith('模型名已被其他自定义名占用，请输入自定义名')

    setupState.pendingKey.custom_name = 'existing-model-cli'
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(postedKeys).toEqual([
      { key: 'sk-existing', model: 'existing-model', custom_name: 'existing-model', runtime: 'claude_sdk' },
      {
        key: 'sk-new', model: 'existing-model', base_url: 'https://new.test',
        custom_name: 'existing-model-cli', runtime: 'claude_cli',
      },
    ])
  })

  it('shows the reviewer thinking mode used by the probe', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    window.$dialog = {
      info: vi.fn(() => ({ destroy: () => undefined }) as any),
      error: vi.fn(),
    } as any

    setupState.pendingKey = { key: 'sk-test', model: 'model', base_url: 'https://compatible.test' }
    setupState.pendingRuntime = 'claude_sdk'
    await setupState.testPendingKey()

    expect(testedCandidate.reviewer_thinking_enabled).toBeUndefined()
    const info = window.$dialog!.info as ReturnType<typeof vi.fn>
    expect(info.mock.calls[1][0].content).toContain('Reviewer thinking: adaptive')
  })

  it('rejects a duplicate preset provider by resolved catalog path', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    const catalogPath = '/tmp/codex-models/zhipu-glm-test.json'
    let posted = false
    setupState.authKeys = [{
      key: 'sk-existing',
      model: 'glm-5.3',
      base_url: 'https://open.bigmodel.cn/api/v1',
      runtime: 'codex_cli',
      model_catalog_path: catalogPath,
      provider_index: 1,
    }]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/auth/test-key' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          catalog_status: 'preset',
          model_catalog_name: 'Zhipu GLM',
          model_catalog_path: catalogPath,
          worker: { status: 'valid' },
          reviewer: { status: 'valid' },
        })
      }
      if (url === '/api/v1/auth/keys' && init?.method === 'POST') {
        posted = true
        return jsonResponse({ ok: true })
      }
      return jsonResponse({})
    }))
    window.$dialog = {
      info: vi.fn(() => ({ destroy: () => undefined }) as any),
      error: vi.fn(),
    } as any

    setupState.pendingKey = {
      key: 'sk-existing',
      model: 'glm-5.3',
      base_url: 'https://open.bigmodel.cn/api/v1',
    }
    setupState.pendingRuntime = 'codex_cli'
    await nextTick()
    await setupState.testPendingKey()
    expect(setupState.resolvedModelCatalogPath).toBe(catalogPath)
    expect(setupState.showCustomModelCatalog).toBe(false)

    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(posted).toBe(false)
    expect(mockToast.warning).toHaveBeenCalledWith('该 Provider 配置已存在，未重复添加')
    expect(setupState.pendingKey.key).toBe('')
  })

  it('handles Codex CLI model catalog preflight', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    const responses = [
      {
        success: true,
        catalog_status: 'preset',
        model_catalog_name: 'Zhipu GLM',
        worker: { status: 'valid' },
        reviewer: { status: 'valid' },
      },
      {
        success: false,
        catalog_status: 'custom_required',
        error: '请配置第三方 provider 官方推荐的 model catalog JSON 文件，并将所在绝对路径输入设置中',
        worker: { status: 'invalid' },
        reviewer: { status: 'invalid' },
      },
      {
        success: false,
        catalog_status: 'custom_invalid',
        error: '请输入合法且包含正确模型名的 model catalog JSON 文件路径',
        worker: { status: 'invalid' },
        reviewer: { status: 'invalid' },
      },
      {
        success: true,
        catalog_status: 'custom',
        worker: { status: 'valid' },
        reviewer: { status: 'valid' },
      },
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/auth/test-key' && init?.method === 'POST') {
        testedCandidate = JSON.parse(String(init.body))
        return jsonResponse(responses.shift())
      }
      return jsonResponse({})
    }))
    window.$dialog = {
      info: vi.fn(() => ({ destroy: () => undefined }) as any),
      error: vi.fn(),
    } as any

    setupState.pendingRuntime = 'codex_cli'
    setupState.pendingKey.key = 'sk-test'
    await nextTick()
    expect(document.body.querySelector('input[placeholder^="第三方 provider 官方 model catalog JSON"]')).toBeNull()
    await setupState.testPendingKey()
    expect(setupState.modelCatalogStatus).toBe('preset')
    expect(setupState.showCustomModelCatalog).toBe(false)

    setupState.pendingKey.base_url = 'https://unknown.test/v1'
    await nextTick()
    setupState.pendingKey.model_catalog_path = ''
    await setupState.testPendingKey()
    expect(setupState.modelCatalogStatus).toBe('custom_required')
    expect(setupState.showCustomModelCatalog).toBe(true)
    expect(mockToast.error).toHaveBeenCalledWith(
      '请配置第三方 provider 官方推荐的 model catalog JSON 文件，并将所在绝对路径输入设置中',
    )

    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder^="第三方 provider 官方 model catalog JSON"]',
    )
    expect(input?.disabled).toBe(false)

    setupState.pendingKey.model_catalog_path = '~/invalid-models.json'
    await nextTick()
    await setupState.testPendingKey()
    expect(setupState.modelCatalogStatus).toBe('custom_invalid')
    expect(setupState.pendingKeyTestError).toBe(
      '请输入合法且包含正确模型名的 model catalog JSON 文件路径',
    )

    setupState.pendingKey.model_catalog_path = '~/models.json'
    await setupState.testPendingKey()
    expect(testedCandidate.model_catalog_path).toBe('~/models.json')
  })

  it('copies a configured provider and invalidates its test result', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.pendingKeyTestOk = true
    await flushPromises()
    findButton('复制')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(setupState.pendingKey).toEqual({
      key: existingProvider.key,
      model: existingProvider.model,
      base_url: existingProvider.base_url,
      custom_name: '',
    })
    expect(setupState.pendingRuntime).toBe(existingProvider.runtime)
    expect(setupState.pendingKeyTestOk).toBe(false)
  })

  it('deletes the provider matched by provider index', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper

    findButton('删除')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(deletedProvider).toBe('/api/v1/auth/keys/1')
    expect(mockConfirmDelete).toHaveBeenCalledWith('existing-model 的密钥')
    expect(postedKeys).toBeUndefined()
  })

  it('keeps the pending provider when saving fails', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    saveShouldFail = true

    setupState.pendingKey = { key: 'sk-new', model: 'new-model', base_url: 'https://new.test' }
    setupState.pendingRuntime = 'claude_cli'
    await nextTick()
    setupState.pendingKeyTestOk = true
    await nextTick()
    findButton('添加并保存')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.error).toHaveBeenCalledWith('保存失败: Error: 保存失败')
    expect(setupState.authKeys).toHaveLength(1)
    expect(setupState.pendingKey.key).toBe('sk-new')
    expect(setupState.pendingKeyTestOk).toBe(true)
  })

  it('orders actions after provider fields and translates rotation status', async () => {
    currentProviders = [
      {
        ...existingProvider,
        reviewer_validation: {
          status: 'valid',
          thinking_mode: 'adaptive',
          thinking_modes: ['disabled', 'enabled', 'adaptive', 'omitted'],
        },
      },
      { ...existingProvider, key: 'sk-active', status: 'active' },
      { ...existingProvider, key: 'sk-exhausted', status: 'exhausted' },
      { ...existingProvider, key: 'sk-invalid', status: 'invalid' },
    ]
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    expect(setupState.providerColumns.map((column: any) => column.key)).toEqual([
      'status', 'base_url', 'model_catalog_path', 'model', 'key', 'runtime', 'validation', 'retest', 'copy', 'delete',
    ])
    expect(setupState.providerColumns.find((column: any) => column.key === 'model').width).toBe(180)
    for (const key of ['base_url', 'model_catalog_path', 'model', 'key']) {
      expect(setupState.providerColumns.find((column: any) => column.key === key).ellipsis).toEqual({ tooltip: true })
    }
    expect(setupState.providerColumns.find((column: any) => column.key === 'copy').title).toBe('')
    expect(setupState.providerColumns.find((column: any) => column.key === 'retest').title).toBe('')
    expect(setupState.providerColumns.find((column: any) => column.key === 'delete').title).toBe('')
    expect(document.body.textContent).toContain('默认')
    expect(document.body.textContent).toContain('备用')
    expect(document.body.textContent).toContain('额度耗尽')
    expect(document.body.textContent).toContain('凭据失效')
    expect(document.body.textContent).toContain('Claude SDK')
    expect(document.body.textContent).toContain('Reviewer:valid')
    expect(document.body.textContent).not.toContain('Reviewer:valid·')
  })

  it('renders the model column as custom name with the real model', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    const render = setupState.providerColumns.find((column: any) => column.key === 'model').render
    expect(render({ model: 'glm-4.7', custom_name: 'glm-prod' }).children).toBe('glm-prod（glm-4.7）')
    expect(render({ model: '', custom_name: 'glm-prod' }).children).toBe('glm-prod')
    expect(render({ model: '', custom_name: '' }).children).toBe('(默认)')
  })
})

describe('Breather template selection', () => {
  it('uses Workflow names for both built-in instruction downloads', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const downloads: Array<[string | null, string]> = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push([this.getAttribute('href'), this.download])
    })
    try {
      mounted.setupState.downloadBuiltinInstructions('handoff_prompt_path')
      mounted.setupState.downloadBuiltinInstructions('continuation_prompt_path')
    } finally {
      click.mockRestore()
    }
    expect(downloads).toEqual([
      ['/api/v1/plugins/breather/builtin-instructions/handoff', 'workflow-handoff-instructions.md'],
      ['/api/v1/plugins/breather/builtin-instructions/continuation', 'workflow-continuation-instructions.md'],
    ])
  })

  it('uploads the selected document only when saving and persists its returned path', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    setupState.pluginConfigs = { breather: { fields: {
      context_threshold_pct: 70, subagent_context_threshold_pct: null,
      handoff_prompt_path: null, continuation_prompt_path: null,
    }, error: '' } }
    const requests: string[] = []
    let savedFields: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method || 'GET'} ${url}`)
      if (url.startsWith('/api/v1/plugins/breather/template?')) {
        expect((init?.body as File).name).toBe('handoff-v2.md')
        return jsonResponse({ path: '/tmp/handoff-v2.md' })
      }
      if (url === '/api/v1/plugins/breather/config' && init?.method === 'PUT') {
        savedFields = JSON.parse(String(init.body)).fields
        return jsonResponse({ ok: true })
      }
      return jsonResponse({})
    }))

    const file = new File(['<!-- workflow:main -->\nV2'], 'handoff-v2.md', { type: 'text/markdown' })
    setupState.templateUploadField = 'handoff_prompt_path'
    await setupState.uploadTemplate({ target: { files: [file], value: 'handoff-v2.md' } } as unknown as Event)
    expect(requests).toEqual([])
    expect(setupState.pendingTemplateFiles.handoff_prompt_path).toBe(file)

    await setupState.savePluginConfig('breather')
    expect(requests).toEqual([
      'POST /api/v1/plugins/breather/template?filename=handoff-v2.md',
      'PUT /api/v1/plugins/breather/config',
    ])
    expect(savedFields.handoff_prompt_path).toBe('/tmp/handoff-v2.md')
    expect(setupState.pendingTemplateFiles.handoff_prompt_path).toBeNull()
  })

  it('clears the pending document and still saves other fields when upload fails', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    setupState.pluginConfigs = { breather: { fields: {
      context_threshold_pct: 70, subagent_context_threshold_pct: null,
      handoff_prompt_path: '/tmp/old.md', continuation_prompt_path: null,
    }, error: '' } }
    const requests: string[] = []
    let savedFields: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method || 'GET'} ${url}`)
      if (url.startsWith('/api/v1/plugins/breather/template?')) {
        return { ok: false, json: () => Promise.resolve({ detail: '上传失败' }) } as Response
      }
      if (url === '/api/v1/plugins/breather/config' && init?.method === 'PUT') {
        savedFields = JSON.parse(String(init.body)).fields
        return jsonResponse({ ok: true })
      }
      return jsonResponse({})
    }))

    setupState.templateUploadField = 'handoff_prompt_path'
    await setupState.uploadTemplate({ target: {
      files: [new File(['V2'], 'handoff-v2.md')], value: 'handoff-v2.md',
    } } as unknown as Event)
    await setupState.savePluginConfig('breather')

    expect(requests).toEqual([
      'POST /api/v1/plugins/breather/template?filename=handoff-v2.md',
      'PUT /api/v1/plugins/breather/config',
    ])
    expect(savedFields.handoff_prompt_path).toBe('/tmp/old.md')
    expect(setupState.pendingTemplateFiles.handoff_prompt_path).toBeNull()
    expect(mockToast.error).toHaveBeenCalled()
  })

  it('restores the built-in template without uploading a pending document', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    setupState.pluginConfigs = { breather: { fields: {
      context_threshold_pct: 70, subagent_context_threshold_pct: null,
      handoff_prompt_path: '/tmp/old.md', continuation_prompt_path: null,
    }, error: '' } }
    const requests: string[] = []
    let savedFields: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method || 'GET'} ${url}`)
      if (url === '/api/v1/plugins/breather/config' && init?.method === 'PUT') {
        savedFields = JSON.parse(String(init.body)).fields
      }
      return jsonResponse({ ok: true })
    }))
    setupState.templateUploadField = 'handoff_prompt_path'
    await setupState.uploadTemplate({ target: {
      files: [new File(['V2'], 'unused.md')], value: 'unused.md',
    } } as unknown as Event)
    setupState.pluginConfigs.breather.fields.handoff_prompt_path = ''
    setupState.clearPendingTemplate('handoff_prompt_path')
    await setupState.savePluginConfig('breather')
    expect(requests).toEqual(['PUT /api/v1/plugins/breather/config'])
    expect(savedFields.handoff_prompt_path).toBe('')
  })
})

describe('SettingsModal provider errors', () => {
  it('retests the selected row and shows the full Worker error', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const originalFetch = globalThis.fetch
    const longError = `HTTP 400: ${'x'.repeat(600)}`
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/auth/keys/1/test') {
        expect(init?.method).toBe('POST')
        return jsonResponse({ success: false, worker: { error: longError } })
      }
      return originalFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const dialogs = {
      info: vi.fn((...args: any[]) => ({ args, destroy: () => undefined }) as any),
      error: vi.fn(),
    }
    vi.stubGlobal('$dialog', dialogs)

    findButton('重新测试')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/auth/keys/1/test', { method: 'POST' })
    expect(dialogs.error.mock.calls[0][0].content().children).toBe(longError)
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/auth/status')
  })

  it('shows an info dialog when Worker passes but Reviewer fails', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/auth/keys/1/test') {
        expect(init?.method).toBe('POST')
        return jsonResponse({
          success: true,
          worker: { status: 'valid' },
          reviewer: { status: 'invalid', error: 'invalid token' },
        })
      }
      return originalFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const dialogs = {
      info: vi.fn(() => ({ destroy: () => undefined }) as any),
      error: vi.fn(),
    }
    vi.stubGlobal('$dialog', dialogs)

    findButton('重新测试')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(dialogs.error).not.toHaveBeenCalled()
    expect(dialogs.info).toHaveBeenCalledTimes(1)
    const arg = (dialogs.info.mock.calls as any[][])[0]?.[0]
    expect(arg.title).toBe('Worker 检测通过')
    expect(arg.content().children).toBe('Reviewer 不可用：invalid token')
  })

  it('allows a Reviewer-only provider when Worker fails', async () => {
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/auth/test-key' && init?.method === 'POST') {
        return jsonResponse({
          success: true,
          worker: {
            status: 'invalid',
            error: 'gateway does not support this model with OpenAI Responses format',
          },
          reviewer: { status: 'valid' },
        })
      }
      return originalFetch(input, init)
    })
    vi.stubGlobal('fetch', fetchSpy)
    const dialogs = {
      info: vi.fn((...args: any[]) => ({ args, destroy: () => undefined }) as any),
      error: vi.fn(),
    }
    vi.stubGlobal('$dialog', dialogs)

    setupState.pendingKey = { key: 'sk', model: 'model', base_url: 'https://compatible.test' }
    setupState.pendingRuntime = 'codex_cli'
    await setupState.testPendingKey()
    await flushPromises()

    expect(dialogs.error).not.toHaveBeenCalled()
    expect(
      dialogs.info.mock.calls.some(args => (args as any[])[0]?.title === 'Reviewer 检测通过'),
    ).toBe(true)
    const reviewerDialog = dialogs.info.mock.calls
      .map(args => (args as any[])[0])
      .find(option => option?.title === 'Reviewer 检测通过')
    expect(reviewerDialog?.content().children).toBe(
      'Worker 不可用：gateway does not support this model with OpenAI Responses format',
    )
    expect(setupState.pendingKeyTestOk).toBe(true)
    expect(findButton('添加并保存')?.disabled).toBe(false)
  })

  it('shows the complete validation error in a scrollable dialog', async () => {
    const longError = `HTTP 400: ${'x'.repeat(600)}`
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: false, error: longError }),
    })))
    const dialogs = { info: vi.fn(() => ({ destroy: vi.fn() })), error: vi.fn() }
    vi.stubGlobal('$dialog', dialogs)

    setupState.pendingKey = { key: 'sk-test', model: 'model', base_url: '' }
    setupState.pendingRuntime = 'claude_sdk'
    await setupState.testPendingKey()

    const content = dialogs.error.mock.calls[0][0].content()
    expect(content.type).toBe('pre')
    expect(content.children).toBe(longError)
    expect(content.props.style).toMatchObject({
      maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap',
    })
    expect(setupState.pendingKeyTestError).toBe(longError)
  })
})

describe('SettingsModal brand name', () => {
  it('品牌名走外观分区草稿，未点保存前不落盘，保存时只 PUT 外观字段', async () => {
    mockInitialSection.value = '外观'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    // mock 的 /api/v1/config 无 brand_name → 回落默认
    expect(setupState.config.brand_name).toBe('Workflow Controller')
    // 草稿随 loadConfig 同步；未点「保存外观设置」前不写回 config
    expect(setupState.draftBrandName).toBe('Workflow Controller')

    setupState.draftBrandName = 'Ascendbot'
    await nextTick()
    expect(setupState.config.brand_name).toBe('Workflow Controller')

    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    // 外观保存只 PUT brand_name，不带其他全局设置字段
    expect(putConfigBody).toEqual({ brand_name: 'Ascendbot' })
    expect(setupState.config.brand_name).toBe('Ascendbot')
    expect(mockToast.success).toHaveBeenCalledWith('外观设置已保存')
  })
})

describe('SettingsModal 外观保存', () => {
  it('背景图为无法解码的 base64 data URL 时保存成功，同时提示背景未生效', async () => {
    mockInitialSection.value = '外观'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.draftAppearanceBackgroundImage = 'data:image/png;base64,###not-base64###'
    await nextTick()
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.success).toHaveBeenCalledWith('外观设置已保存')
    expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('base64 内容无法解析'))

    // 换回空值保存：错误清除，不再重复告警
    setupState.draftAppearanceBackgroundImage = ''
    await nextTick()
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(mockToast.warning).toHaveBeenCalledTimes(1)
  })

  it('背景图持久化失败（配额超限）时保存成功，但提示当次生效、刷新后丢失', async () => {
    mockInitialSection.value = '外观'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    const originalSetItem = localStorage.setItem.bind(localStorage)
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'workflow-controller-appearance-background-image') throw new DOMException('quota exceeded', 'QuotaExceededError')
      originalSetItem(key, value)
    })

    setupState.draftAppearanceBackgroundImage = 'https://example.com/big-bg.jpg'
    await nextTick()
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.success).toHaveBeenCalledWith('外观设置已保存')
    expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('刷新后背景图将丢失'))

    // 配额恢复可写后保存：持久化错误清除，不再重复告警
    setItemSpy.mockRestore()
    setupState.draftAppearanceBackgroundImage = ''
    await nextTick()
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(mockToast.warning).toHaveBeenCalledTimes(1)
  })

  it('PUT /config 失败时不提示成功，品牌名本地预写回滚', async () => {
    mockInitialSection.value = '外观'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.draftBrandName = 'Ascendbot'
    await nextTick()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/config' && init?.method === 'PUT') {
        putConfigBody = JSON.parse(String(init.body))
        return { ok: false, status: 400, json: () => Promise.resolve({ detail: '校验失败' }) } as Response
      }
      return jsonResponse({ ok: true })
    }))
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(putConfigBody).toEqual({ brand_name: 'Ascendbot' })
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
    // 请求前乐观写入本地 config 的品牌名回滚，未落盘值不驻留界面
    expect(setupState.config.brand_name).toBe('Workflow Controller')
  })

  it('POST /config/save 失败（PUT 成功）同样报错并回滚', async () => {
    mockInitialSection.value = '外观'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper
    const { setupState } = mounted

    setupState.draftBrandName = 'Ascendbot'
    await nextTick()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/config' && init?.method === 'PUT') return jsonResponse({ ok: true })
      if (url === '/api/v1/config/save' && init?.method === 'POST') {
        return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response
      }
      return jsonResponse({ ok: true })
    }))
    findButton('保存外观设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
    expect(setupState.config.brand_name).toBe('Workflow Controller')
  })
})

describe('SettingsModal 全局设置保存', () => {
  it('PUT /config 失败时不提示成功', async () => {
    mockInitialSection.value = '全局设置'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/config' && init?.method === 'PUT') {
        return { ok: false, status: 400, json: () => Promise.resolve({ detail: '校验失败' }) } as Response
      }
      return jsonResponse({ ok: true })
    }))
    findButton('保存全局设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
  })

  it('POST /config/save 失败（PUT 成功）同样报错', async () => {
    mockInitialSection.value = '全局设置'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/config' && init?.method === 'PUT') return jsonResponse({ ok: true })
      if (url === '/api/v1/config/save' && init?.method === 'POST') {
        return { ok: false, status: 500, json: () => Promise.resolve({}) } as Response
      }
      return jsonResponse({ ok: true })
    }))
    findButton('保存全局设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('保存失败'))
  })
})

describe('SettingsModal 内置插件展示', () => {
  it('内置插件显示中文名和用途说明，未知插件回退显示原始 ID', async () => {
    mockPlugins.value = [
      {
        name: 'breather', version: '1.0.0', enabled: true, path: '', extra: null, manifest: [],
      },
      {
        name: 'user-installed-plugin', version: '0.1.0', enabled: false, path: '', extra: null, manifest: [],
      },
    ]
    mockInitialSection.value = '插件'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper

    // 内置插件：显示中文 label 和用途说明，且行内不再裸露原始 ID
    const breatherRow = Array.from(document.body.querySelectorAll('strong'))
      .find(element => element.textContent === '上下文交接')
    expect(breatherRow).toBeTruthy()
    expect(breatherRow?.parentElement?.textContent).toContain('上下文交接')
    expect(breatherRow?.parentElement?.textContent).not.toContain('breather')
    expect(document.body.textContent).toContain('上下文用量达到阈值时交接当前任务，由新会话继续。')
    // 未匹配插件：回退显示原始 ID，仍可启停/配置
    expect(document.body.textContent).toContain('user-installed-plugin')
    expect(findButton('启用')).toBeTruthy()
    expect(findButton('配置')).toBeTruthy()
  })

  it('内置插件 ID 通过悬停 tooltip 提供，不占用主显示文本', async () => {
    mockPlugins.value = [
      { name: 'breather', version: '1.0.0', enabled: true, path: '', extra: null, manifest: [] },
    ]
    mockInitialSection.value = '插件'
    const mounted = await mountSettings()
    activeWrapper = mounted.wrapper

    // 主显示文本只含中文 label；原始 ID 不在行内直接可见，仅在 tooltip 中
    const body = document.body
    const rowText = Array.from(body.querySelectorAll('strong'))
      .find(element => element.textContent === '上下文交接')?.parentElement?.textContent ?? ''
    expect(rowText).toContain('上下文交接')
    expect(rowText).not.toContain('breather')
    expect(body.textContent).not.toContain('插件 ID：breather')
  })
})
