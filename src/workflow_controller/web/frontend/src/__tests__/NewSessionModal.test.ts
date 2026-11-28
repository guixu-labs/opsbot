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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { NButton, NInput } from 'naive-ui'

const mockGraphEnabled = ref(true)
const mockStart = vi.fn().mockResolvedValue({ session_id: 'session-1' })
const mockStartRun = vi.fn().mockResolvedValue('run-1')
const mockAuthState = ref<{ providers: any[] }>({ providers: [] })

vi.mock('../composables/useSessions', () => ({
  useSessions: () => ({ start: mockStart, loading: ref(false) }),
}))
vi.mock('../composables/useRuns', () => ({
  useRuns: () => ({ startRun: mockStartRun }),
}))
vi.mock('../composables/usePlugins', () => ({
  usePlugins: () => ({ pluginEnabled: (name: string) => name === 'graph' && mockGraphEnabled.value }),
}))
vi.mock('../composables/useProjectPaths', () => ({
  useProjectPaths: () => ({ projectDir: ref('/proj') }),
}))
vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ authReady: ref(true) }),
}))
vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({ authState: mockAuthState }),
}))
vi.mock('../composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

async function mountModal(config: any, globalConfig: any = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url === '/api/v1/config' ? globalConfig : config,
  })))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } },
      { path: '/run/:id', component: { template: '<div />' } }],
  })
  await router.push('/')
  const NewSessionModal = (await import('../components/NewSessionModal.vue')).default
  const SessionForm = (await import('../components/SessionForm.vue')).default
  const wrapper = mount(NewSessionModal, { global: { plugins: [router] } })
  ;(wrapper.vm as any).open()
  await flushPromises()
  return { wrapper, SessionForm }
}

describe('NewSessionModal project defaults', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mockAuthState.value = { providers: [] }
  })

  it('uses graph defaults when YAML omits all three fields', async () => {
    mockGraphEnabled.value = true
    const { wrapper, SessionForm } = await mountModal({ loop: {}, reviewer: {} })
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    expect(form.reviewerEnabled).toBe(false)
    expect(form.evaluator).toBe('always_complete')
    expect(form.maxIterations).toBe(3)
    wrapper.unmount()
  })

  it('keeps explicit YAML values ahead of graph defaults', async () => {
    mockGraphEnabled.value = true
    const { wrapper, SessionForm } = await mountModal({
      loop: { evaluator: 'feedback', max_iterations: 8 },
      reviewer: { enabled: true },
    })
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    expect(form.reviewerEnabled).toBe(true)
    expect(form.evaluator).toBe('feedback')
    expect(form.maxIterations).toBe(8)
    wrapper.unmount()
  })

  it('keeps ordinary session defaults when graph is disabled', async () => {
    mockGraphEnabled.value = false
    const { wrapper, SessionForm } = await mountModal({ loop: {}, reviewer: {} })
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    expect(form.reviewerEnabled).toBe(true)
    expect(form.evaluator).toBeNull()
    expect(form.maxIterations).toBe(10)
    wrapper.unmount()
  })

  it('loads thinking defaults and sends them with a normal session', async () => {
    mockGraphEnabled.value = false
    mockStart.mockClear()
    const { wrapper, SessionForm } = await mountModal(
      { loop: {}, reviewer: { thinking_mode: null, thinking_budget_tokens: 4096, max_tokens: 4096 } },
      { reviewer: { thinking_mode: 'enabled', thinking_budget_tokens: 8192, max_tokens: 8192 } },
    )
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    expect(form.reviewerThinkingMode).toBe('enabled')
    expect(form.reviewerThinkingBudget).toBe(4096)
    expect(form.reviewerMaxTokens).toBe(4096)
    const startButton = wrapper.findAllComponents(NButton).find(button =>
      button.text().includes('启动会话'))!
    await startButton.trigger('click')
    await flushPromises()
    expect(mockStart).toHaveBeenCalledWith('/proj', undefined, undefined, expect.objectContaining({
      reviewer_thinking_mode: 'enabled',
      reviewer_thinking_budget_tokens: 4096,
      reviewer_max_tokens: 4096,
    }))
    wrapper.unmount()
  })

  it('constrains asynchronously loaded thinking defaults to provider support', async () => {
    mockGraphEnabled.value = false
    mockAuthState.value = {
      providers: [{
        index: 1,
        model: 'always-thinking',
        runtime: 'claude_sdk',
        status: 'active',
        is_active: true,
        reviewer_validation: {
          status: 'valid',
          thinking_mode: 'adaptive',
          thinking_modes: ['adaptive', 'omitted'],
        },
      }],
    }
    const { wrapper, SessionForm } = await mountModal(
      {
        loop: {},
        reviewer: { enabled: true, thinking_mode: 'disabled', thinking_budget_tokens: 4096 },
      },
      { reviewer: { thinking_mode: 'enabled', thinking_budget_tokens: 8192 } },
    )
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any

    expect(form.reviewerModel).toBe('1')
    expect(form.reviewerThinkingMode).toBe('omitted')
    expect(form.reviewerThinkingBudget).toBe(4096)
    wrapper.unmount()
  })

  it.each(['claude_cli', 'codex_cli'])('sends %s cpx capture through the workflow run params', async (runtime) => {
    mockGraphEnabled.value = true
    mockStartRun.mockClear()
    mockStartRun.mockResolvedValue('run-1')
    const { wrapper, SessionForm } = await mountModal({
      runtime, cli_wrapper: 'cpx', loop: {}, reviewer: { enabled: false },
    })
    const graphPath = wrapper.findAllComponents(NInput).find(input =>
      String(input.props('placeholder')).includes('graph yaml'))!
    graphPath.vm.$emit('update:value', '/proj/workflow.yaml')
    await flushPromises()
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    form.reviewerEnabled = true
    expect(form.cliWrapper).toBe('cpx')
    await flushPromises()
    const startButton = wrapper.findAllComponents(NButton).find(button =>
      button.text().includes('启动工作流'))!
    await startButton.trigger('click')
    await flushPromises()
    const runParams = mockStartRun.mock.calls[0][0].params as Record<string, unknown>
    expect(runParams.reviewer_thinking_mode).toBeUndefined()
    expect(mockStartRun).toHaveBeenCalledWith(expect.objectContaining({
      format: 'graph-yaml@1',
      program_path: '/proj/workflow.yaml',
      params: expect.objectContaining({
        reviewer_enabled: true,
        reviewer_thinking_enabled: false,
        reviewer_thinking_budget_tokens: 2048,
        reviewer_max_tokens: 2048,
        cli_wrapper: 'cpx',
        evaluator: 'always_complete',
        max_iterations: 3,
      }),
    }))
    wrapper.unmount()
  })

  it('omits the CLI wrapper when runtime is not selected', async () => {
    mockGraphEnabled.value = true
    mockStartRun.mockClear()
    mockStartRun.mockResolvedValue('run-1')
    const { wrapper, SessionForm } = await mountModal({
      cli_wrapper: 'cpx', loop: {}, reviewer: { enabled: false },
    })
    const graphPath = wrapper.findAllComponents(NInput).find(input =>
      String(input.props('placeholder')).includes('graph yaml'))!
    graphPath.vm.$emit('update:value', '/proj/workflow.yaml')
    await flushPromises()
    const form = wrapper.findComponent(SessionForm).props('modelValue') as any
    expect(form.runtime).toBeUndefined()
    await flushPromises()
    const startButton = wrapper.findAllComponents(NButton).find(button =>
      button.text().includes('启动工作流'))!
    await startButton.trigger('click')
    await flushPromises()
    expect(mockStartRun).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.not.objectContaining({ cli_wrapper: expect.anything() }),
    }))
    wrapper.unmount()
  })

  it('does not send thinking overrides when project config fails to load', async () => {
    mockGraphEnabled.value = false
    mockStart.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    const NewSessionModal = (await import('../components/NewSessionModal.vue')).default
    const wrapper = mount(NewSessionModal, { global: { plugins: [router] } })
    ;(wrapper.vm as any).open()
    await flushPromises()
    const startButton = wrapper.findAllComponents(NButton).find(button =>
      button.text().includes('启动会话'))!
    await startButton.trigger('click')
    await flushPromises()
    const optionsArg = mockStart.mock.calls[0][3] as Record<string, unknown>
    expect(optionsArg.reviewer_enabled).toBe(true)
    expect(optionsArg.reviewer_thinking_mode).toBeUndefined()
    expect(optionsArg.reviewer_thinking_budget_tokens).toBeUndefined()
    expect(optionsArg.reviewer_max_tokens).toBeUndefined()
    wrapper.unmount()
  })
})
