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
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { NButton } from 'naive-ui'

vi.mock('../composables/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('../composables/useAuth', () => ({
  useAuth: () => ({ authReady: ref(true) }),
}))

afterEach(() => vi.unstubAllGlobals())

describe('replay reviewer settings', () => {
  it('uses project and global thinking defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      json: async () => url === '/api/v1/config'
        ? { reviewer: { thinking_mode: 'enabled', thinking_budget_tokens: 8192 } }
        : { reviewer: { enabled: false, thinking_mode: null, thinking_budget_tokens: 4096, max_tokens: 4096 } },
    })))
    const ReplayConfigModal = (await import('../plugins/agent_traceback/ReplayConfigModal.vue')).default
    const wrapper = mount(ReplayConfigModal, {
      props: { sessionId: 'origin', checkpoint: { checkpoint_id: 'cp-1' } as any, projectDir: '/proj' },
      global: { stubs: {
        NModal: { props: ['show'], template: '<div><slot /></div>' },
        NFlex: { template: '<div><slot /></div>' },
        NAlert: { template: '<div><slot /></div>' },
        NButton: { template: '<button><slot /></button>' },
        NSpin: { template: '<span><slot /></span>' },
        SessionForm: {
          name: 'SessionForm', props: ['modelValue', 'projectConfigLoaded', 'disabledRuntimes'],
          template: '<div data-testid="session-form" />',
        },
      } },
    })
    ;(wrapper.vm as any).open()
    await flushPromises()
    const form = (wrapper.findComponent('[data-testid="session-form"]') as any).props('modelValue') as any
    expect(form.reviewerEnabled).toBe(false)
    expect(form.reviewerThinking).toBe(true)
    expect(form.reviewerThinkingBudget).toBe(4096)
    expect(form.reviewerMaxTokens).toBe(4096)
    wrapper.unmount()
  })

  it('sends reviewer_enabled / thinking overrides on traceback submission', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/traceback')) {
        return { text: async () => JSON.stringify({ ok: true, session_id: 'fork-1' }) }
      }
      return {
        json: async () => url === '/api/v1/config'
          ? { reviewer: { thinking_mode: 'enabled', thinking_budget_tokens: 8192, max_tokens: 8192 } }
          : { reviewer: { enabled: false, thinking_mode: null, thinking_budget_tokens: 4096, max_tokens: 4096 } },
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const ReplayConfigModal = (await import('../plugins/agent_traceback/ReplayConfigModal.vue')).default
    const wrapper = mount(ReplayConfigModal, {
      props: { sessionId: 'origin', checkpoint: { checkpoint_id: 'cp-1' } as any, projectDir: '/proj' },
      global: { stubs: {
        NModal: { props: ['show'], template: '<div><slot /></div>' },
        NFlex: { template: '<div><slot /></div>' },
        NAlert: { template: '<div><slot /></div>' },
        NSpin: { template: '<span><slot /></span>' },
        SessionForm: {
          name: 'SessionForm', props: ['modelValue', 'projectConfigLoaded', 'disabledRuntimes'],
          template: '<div data-testid="session-form" />',
          methods: {
            getSelectedModelName: () => undefined,
            getSelectedProviderIndex: () => undefined,
          },
        },
      } },
    })
    ;(wrapper.vm as any).open()
    await flushPromises()
    const replayButton = wrapper.findAllComponents(NButton).find(b => b.text().includes('确认重放'))!
    await replayButton.trigger('click')
    await flushPromises()
    const tracebackCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/traceback')) as any
    expect(tracebackCall).toBeTruthy()
    expect(JSON.parse(String(tracebackCall[1].body))).toEqual(expect.objectContaining({
      checkpoint_id: 'cp-1',
      overrides: expect.objectContaining({
        reviewer_enabled: false,
        reviewer_thinking_enabled: true,
        reviewer_thinking_budget_tokens: 4096,
        reviewer_max_tokens: 4096,
      }),
    }))
    wrapper.unmount()
  })
})
