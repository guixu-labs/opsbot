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

import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { NInputNumber, NSelect, NSwitch, NTooltip } from 'naive-ui'
import type { SessionFormState } from '../components/SessionForm.vue'

type TestSessionForm = Omit<SessionFormState, 'runtime' | 'cliWrapper'> &
  Partial<Pick<SessionFormState, 'runtime' | 'cliWrapper'>>

vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({ authState: reactive(mockAuthState) }),
}))
vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ authReady: ref(true) }),
}))

const mockAuthState = vi.hoisted(() => ({ value: { providers: [] as any[] } }))

// 挂载表单并展开「高级设置」折叠面板
async function mountExpandedForm(evaluator: string | null, runtime?: string) {
  const SessionForm = (await import('../components/SessionForm.vue')).default
  const form = reactive<TestSessionForm>({
    runtime,
    cliWrapper: '',
    prompt: '',
    sessionModel: '',
    reviewerModel: '',
    reviewerEnabled: false,
    reviewerThinkingMode: 'omitted',
    reviewerThinkingBudget: 2048,
    evaluator,
  })
  const wrapper = mount(SessionForm, { props: { modelValue: form, projectConfigLoaded: true } })
  await wrapper.get('.n-collapse-item__header-main').trigger('click')
  await flushPromises()
  return { wrapper, form }
}

async function mountExpandedFormWithProviders(runtime: string) {
  mockAuthState.value.providers = [
    {
      index: 0,
      model: 'worker-only',
      runtime,
      status: 'active',
      worker_validation: { status: 'valid' },
      reviewer_validation: { status: 'invalid', error: 'protocol mismatch' },
    },
    {
      index: 1,
      model: 'reviewer-only',
      runtime,
      status: 'active',
      worker_validation: { status: 'invalid', error: 'protocol mismatch' },
      reviewer_validation: { status: 'valid' },
    },
    {
      index: 2,
      model: 'opencode-only',
      runtime: 'opencode',
      status: 'active',
      worker_validation: { status: 'valid' },
      reviewer_validation: { status: 'invalid', error: 'protocol mismatch' },
    },
  ]
  return mountExpandedForm(null, runtime)
}

describe('SessionForm evaluator hint', () => {
  it('提供 Codex CLI 代理框架选项', async () => {
    const { wrapper } = await mountExpandedForm(null)
    const select = wrapper.findComponent(NSelect)
    expect(select.props('options')).toContainEqual({
      label: 'Codex CLI', value: 'codex_cli', disabled: false,
    })
    wrapper.unmount()
  })

  it('shows the completion rule of the selected evaluator type', async () => {
    const { wrapper, form } = await mountExpandedForm('feedback')
    const fragments: Record<string, string> = {
      passthrough: '不由评估器判断完成',
      always_complete: '一次性任务',
      feedback: 'Reviewer 模型',
      max_iteration: '完成标准',
    }
    for (const [evaluator, fragment] of Object.entries(fragments)) {
      form.evaluator = evaluator
      await nextTick()
      expect(wrapper.get('p').text()).toContain(fragment)
    }
    wrapper.unmount()
  })

  it('hides the hint when no evaluator is selected', async () => {
    const { wrapper } = await mountExpandedForm(null)
    expect(wrapper.find('p').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the cpx switch only for CLI runtimes', async () => {
    const { wrapper, form } = await mountExpandedForm(null)
    form.runtime = 'claude_cli'
    await nextTick()
    expect(wrapper.text()).toContain('通过 cpx 捕获')
    form.runtime = 'codex_cli'
    await nextTick()
    expect(wrapper.text()).toContain('通过 cpx 捕获')
    form.runtime = 'claude_sdk'
    await nextTick()
    expect(wrapper.text()).not.toContain('通过 cpx 捕获')
    wrapper.unmount()
  })

  it('keeps valid runtime mismatches visible but disabled', async () => {
    const { wrapper } = await mountExpandedFormWithProviders('codex_cli')
    const selects = wrapper.findAllComponents(NSelect)
    const options = selects.map(select => select.props('options') as any[])

    expect(options[1]).toEqual([
      { label: 'worker-only', value: '0', disabled: false },
      { label: 'opencode-only（绑定 OpenCode）', value: '2', disabled: true },
    ])
    expect(options[2]).toEqual([
      { label: 'Codex CLI：reviewer-only', value: '1', disabled: false },
    ])
    wrapper.unmount()
    mockAuthState.value.providers = []
  })

  it('prefixes reviewer model options with the provider runtime label', async () => {
    mockAuthState.value.providers = [
      {
        index: 0,
        model: 'glm-4.7',
        custom_name: 'glm-4.7-prod',
        base_url: 'https://glm.test/v1',
        runtime: 'codex_cli',
        status: 'active',
        worker_validation: { status: 'valid' },
        reviewer_validation: { status: 'valid' },
      },
      {
        index: 1,
        model: 'claude-sonnet-4-5',
        custom_name: 'claude-sonnet-prod',
        base_url: 'https://sonnet.test/v1',
        runtime: 'claude_sdk',
        status: 'active',
        worker_validation: { status: 'valid' },
        reviewer_validation: { status: 'valid' },
      },
      {
        index: 2,
        model: 'quota-exhausted',
        custom_name: 'quota-exhausted',
        runtime: 'claude_sdk',
        status: 'exhausted',
        reviewer_validation: { status: 'valid' },
      },
    ]
    const { wrapper } = await mountExpandedForm(null)
    const selects = wrapper.findAllComponents(NSelect)

    expect((selects[1].props('options') as any[])).toEqual([
      { label: 'glm-4.7-prod', value: '0', disabled: false },
      { label: 'claude-sonnet-prod', value: '1', disabled: false },
    ])
    expect((selects[2].props('options') as any[])).toEqual([
      { label: 'Codex CLI：glm-4.7-prod', value: '0', disabled: false },
      { label: 'Claude SDK：claude-sonnet-prod', value: '1', disabled: false },
    ])
    const renderLabel = selects[1].props('renderLabel') as (option: any) => any
    expect(renderLabel({ label: 'missing-url', value: '9' })).toBe('missing-url')
    expect(renderLabel({ label: 'glm-4.7-prod', value: '0' }).type).toBe(NTooltip)
    wrapper.unmount()
    mockAuthState.value.providers = []
  })

  it('shows only provider-tested thinking modes', async () => {
    mockAuthState.value.providers = [{
      index: 1,
      model: 'partial-thinking',
      runtime: 'claude_sdk',
      status: 'active',
      reviewer_validation: {
        status: 'valid',
        thinking_mode: 'adaptive',
        thinking_modes: ['adaptive', 'omitted'],
      },
    }]
    const { wrapper, form } = await mountExpandedForm(null)
    form.reviewerEnabled = true
    form.reviewerModel = '1'
    form.reviewerThinkingMode = 'disabled'
    await nextTick()

    const selects = wrapper.findAllComponents(NSelect)
    expect(form.reviewerThinkingMode).toBe('omitted')
    expect(selects[3].props('options')).toEqual([
      { label: 'Adaptive', value: 'adaptive' },
      { label: 'Omitted', value: 'omitted' },
    ])
    expect(wrapper.getComponent(NInputNumber).props('disabled')).toBe(true)
    wrapper.unmount()
    mockAuthState.value.providers = []
  })

  it('enables the budget only for enabled thinking mode', async () => {
    mockAuthState.value.providers = [{
      index: 1,
      model: 'all-thinking',
      runtime: 'claude_sdk',
      status: 'active',
      reviewer_validation: {
        status: 'valid',
        thinking_mode: 'disabled',
        thinking_modes: ['disabled', 'enabled', 'adaptive', 'omitted'],
      },
    }]
    const { wrapper, form } = await mountExpandedForm(null)
    form.reviewerEnabled = true
    form.reviewerModel = '1'
    form.reviewerThinkingMode = 'omitted'
    await nextTick()

    expect(form.reviewerThinkingMode).toBe('omitted')
    expect(wrapper.getComponent(NInputNumber).props('disabled')).toBe(true)
    form.reviewerThinkingMode = 'enabled'
    await nextTick()
    expect(wrapper.getComponent(NInputNumber).props('disabled')).toBe(false)
    wrapper.unmount()
    mockAuthState.value.providers = []
  })

  it('keeps the legacy thinking switch for replay forms', async () => {
    const SessionForm = (await import('../components/SessionForm.vue')).default
    const form = reactive<TestSessionForm>({
      cliWrapper: '',
      prompt: '',
      sessionModel: '',
      reviewerModel: '',
      reviewerEnabled: true,
      reviewerThinking: false,
      reviewerThinkingBudget: 2048,
      evaluator: null,
    })
    const wrapper = mount(SessionForm, { props: { modelValue: form, projectConfigLoaded: true } })
    await wrapper.get('.n-collapse-item__header-main').trigger('click')
    await flushPromises()

    expect(form.reviewerThinkingMode).toBeUndefined()
    expect(wrapper.text()).not.toContain('Reviewer thinking mode')
    expect(wrapper.findAllComponents(NSwitch)[1].props('disabled')).toBe(false)
    expect(wrapper.getComponent(NInputNumber).props('disabled')).toBe(true)
    form.reviewerThinking = true
    await nextTick()
    expect(wrapper.getComponent(NInputNumber).props('disabled')).toBe(false)
    wrapper.unmount()
  })
})
