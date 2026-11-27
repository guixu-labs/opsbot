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

/// <reference types="node" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 各用例挂载的组件共享 mockSessions，若不卸载会残留轮询定时器并
// 互相串扰后续用例（改变 sessions 会唤醒所有泄漏组件）
enableAutoUnmount(afterEach)

// ── Mock composables ──────────────────────────────────────────────

const mockConnected = ref(true)
const mockSessions = ref<any[]>([])
const mockRunStateEventCount = ref<Record<string, number>>({})
const mockEvents = ref<Record<string, any[]>>({})
const mockPause = vi.fn().mockResolvedValue(undefined)
const mockResume = vi.fn().mockResolvedValue(undefined)
const mockHandoff = vi.fn()
const mockInjectPrompt = vi.fn().mockResolvedValue(undefined)
const mockSendMessage = vi.fn().mockResolvedValue(true)

vi.mock('../composables/useSSE', () => ({
  useSSE: () => ({
    connected: mockConnected,
    sessions: mockSessions,
    config: ref(null),
    eventsBySession: mockEvents,
    pipeline: ref({}),
    usage: ref(null),
    runStateEventCount: mockRunStateEventCount,
    subscribePlugin: vi.fn(),
  }),
}))

vi.mock('../composables/useSessions', () => ({
  useSessions: () => ({
    pause: mockPause,
    resume: mockResume,
    handoff: mockHandoff,
    injectPrompt: mockInjectPrompt,
    sendMessage: mockSendMessage,
    getSubagentHints: vi.fn().mockResolvedValue({}),
    registerSubagentHint: vi.fn(),
    clearSubagentHint: vi.fn(),
    listSubagentAgents: vi.fn().mockResolvedValue([]),
    getSessionInstructions: vi.fn().mockResolvedValue([]),
    registerSessionInstruction: vi.fn(),
    clearSessionInstruction: vi.fn(),
    removeSession: vi.fn(),
  }),
}))

vi.mock('../composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([]),
    loaded: ref(true),
    loadPlugins: vi.fn(),
    pluginLoaded: vi.fn().mockReturnValue(false),
  }),
}))

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }

vi.mock('../composables/useToast', () => ({
  useToast: () => mockToast,
}))

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({ confirmAction: vi.fn().mockResolvedValue(false) }),
}))

vi.mock('../composables/useTopology', () => ({
  deriveTopology: vi.fn().mockReturnValue(null),
}))

vi.mock('../plugins/agent_traceback/types', () => ({
  birthTracebackOf: vi.fn().mockReturnValue(null),
}))

vi.mock('../utils/subagentLines', () => ({
  fmtExpandedSubagentBlock: vi.fn().mockReturnValue([]),
  fmtCollapsedSubagentBlock: vi.fn().mockReturnValue([]),
  fmtThinkingBlock: vi.fn().mockReturnValue([]),
}))

function makeRun(overrides: Partial<any> = {}) {
  return {
    run_id: 'run-1',
    kind: 'workflow',
    status: 'running',
    label: 'wf',
    format: 'graph-yaml@1',
    created_at: '2026-10-01T00:00:00',
    ...overrides,
  }
}

// fetch 分流：/api/v1/runs/:id 返回 run 行，其余按兜底应答
function mockFetchWithRun(run: any | null) {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/v1/runs/')) {
      if (!run) return Promise.resolve({ ok: false, status: 404, json: vi.fn() } as any)
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ run, sessions: [] }),
      } as any)
    }
    return Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue({ reviewer: { mode: 'auto' } }),
    } as any)
  })
}

beforeEach(() => {
  mockFetchWithRun(null)
  mockEvents.value = {}
})

function makeSession(overrides: Partial<any> = {}) {
  return {
    id: 'sess-1',
    name: 'test session',
    role: 'worker',
    state: 'running',
    loop_status: 'yes',
    stop_reason: null,
    current_iteration: 1,
    max_iterations: 10,
    elapsed_seconds: 5,
    created_at_iso: '2026-09-11T20:00:00',
    native_session_id: 'ses_test_123',
    project_dir: '/tmp',
    run_id: 'run-1',
    plugin_metadata: {},
    predecessor: null,
    successors: [],
    result: null,
    error: null,
    reviewer_mode: 'auto',
    ...overrides,
  }
}

async function mountSessionDetail(
  sessionData: any,
  extraSessions: any[] = [],
) {
  mockSessions.value = [sessionData, ...extraSessions]
  const SessionDetailView = (await import('../views/SessionDetailView.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/session/:id', component: { template: '<div/>' } }] })
  router.push('/session/sess-1')
  await router.isReady()

  const wrapper = mount(SessionDetailView, {
    global: {
      plugins: [router],
      stubs: {
        CheckpointPanel: true,
        DeleteSessionDialog: true,
        FileProvenanceView: true,
        VirtualLog: true,
        AgentTopologyGraph: true,
        WatchdogAlerts: true,
      },
    },
  })
  await flushPromises()
  return wrapper
}

// 恢复按钮定位：title 为「恢复会话」或拒绝原因（部分原因文案不含「恢复」二字）
function findResumeBtn(wrapper: any) {
  return wrapper.findAll('button').find((b: any) => {
    const t = b.attributes('title') || ''
    return t.includes('恢复') || t.includes('所属 Run') || t.includes('由 Run')
  })
}

// ── Tests ─────────────────────────────────────────────────────────

it.each([
  { reviewerEnabled: true, mode: 'manual', fallback: true },
  { reviewerEnabled: true, mode: 'manual', fallback: false },
  { reviewerEnabled: false, mode: 'auto', fallback: false },
])('explains the unanswered question in $mode mode with reviewer enabled=$reviewerEnabled', async ({
  reviewerEnabled, mode, fallback,
}) => {
  mockEvents.value = { 'sess-1': [{
    session_id: 'sess-1', event_type: 'log_loop', iteration: 1,
    timestamp: '2026-11-13T11:48:21',
    data: { decision: 'waiting_for_input', reason: 'unanswered_question' },
  }] }
  const session = makeSession({
    run_id: null, reviewer_enabled: reviewerEnabled, reviewer_mode: mode,
    waiting_for_auto_reply_fallback: fallback,
  })
  const wrapper = await mountSessionDetail(session)

  expect(wrapper.text()).toContain(fallback ? '自动回复出错，请手动回复。' : '模型的问题尚未回答')
  expect(wrapper.get('input[placeholder="回答模型问题..."]').attributes('disabled')).toBeUndefined()
  if (fallback) {
    const button = wrapper.findAll('button').find(b => b.text() === '回复: 手动')!
    expect(button.attributes('disabled')).toBeDefined()
    mockEvents.value = { 'sess-1': [...mockEvents.value['sess-1']!, {
      session_id: 'sess-1', event_type: 'log_manual', iteration: 2,
      timestamp: '2026-11-13T11:48:26', data: { prompt: '继续' },
    }] }
    mockSessions.value = [{ ...session, reviewer_mode: 'auto', waiting_for_auto_reply_fallback: false }]
    await flushPromises()
    expect(wrapper.text()).toContain('回复: 自动')
    expect(wrapper.text()).not.toContain('自动回复出错，请手动回复。')
  }
})

it('updates the reply button and input when the effective mode changes in a session snapshot', async () => {
  const session = makeSession({ run_id: null, reviewer_enabled: null })
  const wrapper = await mountSessionDetail(session)
  const input = wrapper.get('input')
  expect(wrapper.text()).toContain('回复: 自动')
  expect(input.attributes('disabled')).toBeDefined()

  mockSessions.value = [{ ...session, reviewer_mode: 'manual' }]
  await flushPromises()
  expect(wrapper.text()).toContain('回复: 手动')
  expect(input.attributes('disabled')).toBeUndefined()
})

describe('SessionDetailView — 暂停/恢复按钮', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
  })

  it('running 状态显示「暂停」按钮', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    expect(pauseBtn).toBeTruthy()
  })

  it('点击「暂停」调用 pause API', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    expect(pauseBtn).toBeTruthy()
    await pauseBtn!.trigger('click')
    await flushPromises()
    expect(mockPause).toHaveBeenCalledWith('sess-1', null)
  })

  it('idle 状态（worker 角色）显示「恢复会话」按钮', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'idle', loop_status: 'no', stop_reason: 'user_pause' }))
    expect(findResumeBtn(wrapper)).toBeTruthy()
  })

  it('点击「恢复」调用 resume API', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'idle', loop_status: 'no', stop_reason: 'user_pause' }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn).toBeTruthy()
    await resumeBtn!.trigger('click')
    await flushPromises()
    expect(mockResume).toHaveBeenCalledWith('sess-1', null)
  })

  it('running 状态不显示「恢复」按钮', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    expect(findResumeBtn(wrapper)).toBeFalsy()
  })

  it('idle 状态不显示「暂停」按钮', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'idle', loop_status: 'no' }))
    expect(wrapper.text()).not.toContain('暂停')
  })

  it('没有原生会话 ID 时暂停按钮 disabled', async () => {
    const wrapper = await mountSessionDetail(makeSession({ state: 'running', native_session_id: null }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    expect(pauseBtn).toBeTruthy()
    expect(pauseBtn!.attributes('disabled')).toBeDefined()
  })

  it('旧字段 sdk_session_id 仍可启用暂停按钮', async () => {
    const wrapper = await mountSessionDetail(makeSession({
      state: 'running',
      native_session_id: null,
      sdk_session_id: 'legacy_session',
    }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    expect(pauseBtn).toBeTruthy()
    expect(pauseBtn!.attributes('disabled')).toBeUndefined()
  })
})

describe('SessionDetailView — Reviewer 状态', () => {
  async function enableRealTopology() {
    const actual = await vi.importActual<
      typeof import('../composables/useTopology')
    >('../composables/useTopology')
    const { deriveTopology } = await import('../composables/useTopology')
    vi.mocked(deriveTopology).mockImplementation(
      actual.deriveTopology as typeof deriveTopology,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockEvents.value = {}
    mockSessions.value = []
  })

  it('Reviewer 节点详情显示会话冻结的审查目标，展开后保留全文', async () => {
    await enableRealTopology()
    const reviewerEvent = {
      session_id: 'sess-1',
      timestamp: '2026-11-18T00:00:00',
      event_type: 'log_auto',
      data: { hook: 'stop_hook_llm', decision: 'block' },
    }
    mockFetchWithRun(null)
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(
        url.includes('/api/v1/events')
          ? { events: [reviewerEvent] }
          : {},
      ),
    }))
    const wrapper = await mountSessionDetail(makeSession({
      reviewer_enabled: true,
      reviewer_task_goal: '第一行目标\n第二行目标',
    }))

    expect(wrapper.find('.reviewer-task-text').exists()).toBe(false)
    ;(wrapper.vm as any).onSelectAgent('reviewer')
    await flushPromises()
    expect((wrapper.vm as any).selectedAgent?.role).toBe('reviewer')
    expect((wrapper.vm as any).showAgentDetail).toBe(true)
    expect(document.body.textContent).toContain('Reviewer 目标')
    const expand = [...document.body.querySelectorAll('button')].find(b => b.textContent === '展开')
    expect(expand).toBeTruthy()
    expand!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.body.querySelector('.reviewer-task-text')?.textContent).toBe('第一行目标\n第二行目标')
    ;(wrapper.vm as any).showAgentDetail = false
    await flushPromises()
    ;(wrapper.vm as any).onSelectAgent('reviewer')
    await flushPromises()
    expect(document.body.querySelector('.reviewer-task-text')).toBeNull()
    wrapper.unmount()
  })

  it('reviewer_task_goal 为空时详情不渲染审查目标区域', async () => {
    await enableRealTopology()
    mockFetchWithRun(null)
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(
        url.includes('/api/v1/events')
          ? { events: [{
              session_id: 'sess-1',
              timestamp: '2026-11-18T00:00:00',
              event_type: 'log_auto',
              data: { hook: 'stop_hook_llm', decision: 'block' },
            }] }
          : {},
      ),
    }))
    const wrapper = await mountSessionDetail(makeSession({
      reviewer_enabled: true,
      reviewer_task_goal: null,
    }))

    ;(wrapper.vm as any).onSelectAgent('reviewer')
    await flushPromises()
    expect(document.body.querySelector('.agent-detail-reviewer')).toBeNull()
    expect([...document.body.querySelectorAll('button')].some(b => b.textContent === '展开')).toBe(false)
    wrapper.unmount()
  })
})

describe('SessionDetailView — workflow 成员操作路由与 Run 徽章', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
  })

  it('workflow 成员的暂停/恢复走 run 级端点，头部显示 Run 徽章', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    }))
    expect(wrapper.text()).toContain('Run · wf')
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
    await resumeBtn!.trigger('click')
    await flushPromises()
    expect(mockResume).toHaveBeenCalledWith('sess-1', 'run-1')
  })

  it('implicit run 成员直通 session 端点（无 Run 徽章）', async () => {
    mockFetchWithRun(makeRun({ kind: 'implicit' }))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause',
    }))
    expect(wrapper.text()).not.toContain('Run ·')
    const resumeBtn = findResumeBtn(wrapper)
    await resumeBtn!.trigger('click')
    await flushPromises()
    expect(mockResume).toHaveBeenCalledWith('sess-1', null)
  })

  it('run 行不可达（已删/404）时直通 session 端点', async () => {
    mockFetchWithRun(null)
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
    await resumeBtn!.trigger('click')
    await flushPromises()
    expect(mockResume).toHaveBeenCalledWith('sess-1', null)
  })

  it('workflow 成员暂停失败时 toast 错误且不提示「已暂停」', async () => {
    mockFetchWithRun(makeRun())
    mockPause.mockRejectedValueOnce(new Error('HTTP 409: run 未运行'))
    const wrapper = await mountSessionDetail(makeSession({ state: 'running', project_dir: '/proj' }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    await pauseBtn!.trigger('click')
    await flushPromises()
    expect(mockPause).toHaveBeenCalledWith('sess-1', 'run-1')
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('暂停失败'))
    expect(mockToast.info).not.toHaveBeenCalledWith('已暂停')
  })

  it('workflow 成员暂停成功时提示「已暂停」', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeSession({ state: 'running', project_dir: '/proj' }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    await pauseBtn!.trigger('click')
    await flushPromises()
    expect(mockToast.info).toHaveBeenCalledWith('已暂停')
  })
})

describe('SessionDetailView — 归属确认窗口与注入输入保全', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
  })

  // run 行拉取悬挂：归属确认窗口内不得把成员操作误投 session 面
  function mockFetchDeferredRun() {
    let resolveRun!: (run: any | null) => void
    const pending = new Promise<any>((resolve) => { resolveRun = resolve })
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/v1/runs/')) {
        return pending.then(run => run
          ? { ok: true, status: 200, json: vi.fn().mockResolvedValue({ run }) } as any
          : { ok: false, status: 404, json: vi.fn() } as any)
      }
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ reviewer: { mode: 'auto' } }),
      } as any)
    })
    return { resolve: resolveRun }
  }

  it('run 行未拉到时暂停/恢复被门禁，拉到后按 kind 正确路由', async () => {
    const deferred = mockFetchDeferredRun()
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn?.attributes('title')).toContain('正在确认所属 Run')
    expect(resumeBtn?.attributes('disabled')).toBeDefined()

    deferred.resolve(makeRun())
    await flushPromises()
    const readyBtn = findResumeBtn(wrapper)
    expect(readyBtn!.attributes('disabled')).toBeUndefined()
    await readyBtn!.trigger('click')
    await flushPromises()
    expect(mockResume).toHaveBeenCalledWith('sess-1', 'run-1')
  })

  it('running 成员在归属确认窗口内暂停按钮禁用', async () => {
    mockFetchDeferredRun()
    const wrapper = await mountSessionDetail(makeSession({ state: 'running', project_dir: '/proj' }))
    const pauseBtn = wrapper.findAll('button').find(b => b.attributes('title')?.includes('暂停'))
    expect(pauseBtn).toBeTruthy()
    expect(pauseBtn!.attributes('disabled')).toBeDefined()
    expect(mockPause).not.toHaveBeenCalled()
  })

  it('run 行拉取瞬时失败（5xx）后退避重试，恢复后路由不再错面', async () => {
    vi.useFakeTimers()
    try {
      let runCalls = 0
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.startsWith('/api/v1/runs/')) {
          runCalls += 1
          if (runCalls === 1) {
            return Promise.resolve({ ok: false, status: 500, json: vi.fn() } as any)
          }
          return Promise.resolve({
            ok: true,
            json: vi.fn().mockResolvedValue({ run: makeRun() }),
          } as any)
        }
        return Promise.resolve({
          ok: true,
          json: vi.fn().mockResolvedValue({ reviewer: { mode: 'auto' } }),
        } as any)
      })
      const wrapper = await mountSessionDetail(makeSession({
        state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
      }))
      await flushPromises()
      // 首拉失败：门禁仍在，不能落到 session 面端点
      expect(findResumeBtn(wrapper)!.attributes('disabled')).toBeDefined()
      vi.advanceTimersByTime(300)
      await flushPromises()
      const resumeBtn = findResumeBtn(wrapper)
      expect(resumeBtn!.attributes('disabled')).toBeUndefined()
      await resumeBtn!.trigger('click')
      await flushPromises()
      expect(mockResume).toHaveBeenCalledWith('sess-1', 'run-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('注入失败时输入回填，不丢用户输入', async () => {
    mockFetchWithRun(makeRun())
    mockSendMessage.mockRejectedValueOnce(new Error('HTTP 409: run 未运行'))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause',
      reviewer_mode: 'manual', project_dir: '/proj',
    }))
    const input = wrapper.find('input[placeholder="输入消息并按 Enter 发送..."]')
    expect(input.exists()).toBe(true)
    await input.setValue('hello')
    const sendBtn = wrapper.findAll('button').find(b => b.text() === '发送')
    expect(sendBtn).toBeTruthy()
    await sendBtn!.trigger('click')
    await flushPromises()
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', true)
    expect((input.element as HTMLInputElement).value).toBe('hello')
    expect(mockToast.error).toHaveBeenCalled()
  })
})

describe('SessionDetailView — resume 按钮拒绝原因（run 状态预判）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
  })

  it('所属 Run 已暂停时禁用并提示先恢复整个 Run', async () => {
    mockFetchWithRun(makeRun({ status: 'paused' }))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn?.attributes('title')).toContain('所属 Run 已暂停')
    expect(resumeBtn?.attributes('disabled')).toBeDefined()
  })

  it.each(['completed', 'failed', 'stopped'])(
    '所属 Run 已结束（%s）时禁用并指路 Run 页',
    async (status) => {
      mockFetchWithRun(makeRun({ status }))
      const wrapper = await mountSessionDetail(makeSession({
        state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
      }))
      const resumeBtn = findResumeBtn(wrapper)
      expect(resumeBtn?.attributes('title')).toContain('所属 Run 已结束')
      expect(resumeBtn?.attributes('disabled')).toBeDefined()
    },
  )

  it('workflow 成员自然结束（max_iterations）→ 禁用提示无需恢复', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'max_iterations', project_dir: '/proj',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('title')).toContain('无需恢复')
    expect(resumeBtn!.attributes('disabled')).toBeDefined()
  })

  it('workflow 成员非用户暂停断点（error）→ 禁用并指路 Run 页', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'error', error: 'boom', project_dir: '/proj',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('title')).toContain('由 Run 调度')
    expect(resumeBtn!.attributes('disabled')).toBeDefined()
  })

  it('普通会话自然结束（stop_reason=%s）后仍可恢复', async () => {
    mockFetchWithRun(makeRun({ kind: 'implicit' }))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'evaluator_complete',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('title')).toContain('恢复会话')
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
  })

  it('普通会话错误（stop_reason=error）仍可恢复', async () => {
    mockFetchWithRun(makeRun({ kind: 'implicit' }))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'error', error: 'boom',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('title')).toContain('恢复会话')
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
  })

  it('已暂停（stop_reason=user_pause）workflow 成员 resume 可用', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    }))
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
  })
})

describe('SessionDetailView — 同目录并发检查（workflow 成员）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
    mockFetchWithRun(makeRun())
  })

  it('同 run 兄弟成员运行时不阻止恢复（驱动自管并发）', async () => {
    const current = makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    })
    const siblingRunning = makeSession({
      id: 'sess-sibling', state: 'running', project_dir: '/proj', run_id: 'run-1',
    })
    const wrapper = await mountSessionDetail(current, [siblingRunning])
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
    await resumeBtn!.trigger('click')
    expect(mockResume).toHaveBeenCalledWith('sess-1', 'run-1')
  })

  it('普通会话运行时，workflow 成员恢复被阻止', async () => {
    const current = makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    })
    const otherRunning = makeSession({
      id: 'sess-other', state: 'running', project_dir: '/proj', run_id: 'run-other',
    })
    const wrapper = await mountSessionDetail(current, [otherRunning])
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn?.attributes('title')).toContain('同目录已有运行中的会话')
    expect(resumeBtn?.attributes('disabled')).toBeDefined()
  })

  it('普通会话恢复不受同目录运行限制（宿主无目录互斥）', async () => {
    mockFetchWithRun(makeRun({ kind: 'implicit' }))
    const current = makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: '/proj',
    })
    const otherRunning = makeSession({
      id: 'sess-other', state: 'running', project_dir: '/proj',
    })
    const wrapper = await mountSessionDetail(current, [otherRunning])
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn!.attributes('title')).toContain('恢复会话')
    expect(resumeBtn!.attributes('disabled')).toBeUndefined()
  })

  it('缺少 project_dir 时不把另一个无目录的运行会话当作同目录', async () => {
    const current = makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', project_dir: undefined,
    })
    const otherRunning = makeSession({
      id: 'sess-other', state: 'running', project_dir: undefined,
    })
    const wrapper = await mountSessionDetail(current, [otherRunning])
    const resumeBtn = findResumeBtn(wrapper)
    expect(resumeBtn?.attributes('disabled')).toBeUndefined()
  })
})

describe('SessionDetailView — 单请求发送消息', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendMessage.mockResolvedValue(true)
    mockConnected.value = true
    mockSessions.value = []
  })

  function makeIdleMember() {
    return makeSession({
      state: 'idle',
      loop_status: 'no',
      stop_reason: 'user_pause',
      project_dir: '/proj',
      reviewer_mode: 'manual',
    })
  }

  async function sendPrompt(wrapper: any) {
    const input = wrapper.find('input[placeholder="输入消息并按 Enter 发送..."]')
    expect(input.exists()).toBe(true)
    await input.setValue('hello')
    const sendBtn = wrapper.findAll('button').find((b: any) => b.text() === '发送')
    expect(sendBtn).toBeTruthy()
    await sendBtn!.trigger('click')
    await flushPromises()
  }

  it('workflow 成员 idle 时发送消息走单个 run 级端点', async () => {
    mockFetchWithRun(makeRun())
    const wrapper = await mountSessionDetail(makeIdleMember())
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', true)
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('消息已发送')
  })

  it('注入被拒（409 等）时报错提示，不假成功也不自动恢复', async () => {
    mockFetchWithRun(makeRun())
    mockSendMessage.mockRejectedValueOnce(new Error('workflow 成员需经 run 面操作'))
    const wrapper = await mountSessionDetail(makeIdleMember())
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', true)
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('workflow 成员需经 run 面操作'))
    expect(mockToast.success).not.toHaveBeenCalledWith('消息已发送')
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('Run 级暂不可恢复时确认消息已入队', async () => {
    mockFetchWithRun(makeRun())
    mockSendMessage.mockResolvedValueOnce(false)
    const wrapper = await mountSessionDetail(makeIdleMember())
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', true)
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('消息已发送')
    expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('未自动恢复'))
  })

  it('普通会话发送消息走单个 session 端点', async () => {
    mockFetchWithRun(makeRun({ kind: 'implicit' }))
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', reviewer_mode: 'manual',
    }))
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', null, true)
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('workflow 成员已自然结束时发送消息，只入队不自动恢复', async () => {
    mockFetchWithRun(makeRun())
    mockSendMessage.mockResolvedValueOnce(false)
    const wrapper = await mountSessionDetail(makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'evaluator_complete', reviewer_mode: 'manual',
      project_dir: '/proj',
    }))
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', true)
    expect(mockToast.success).toHaveBeenCalledWith('消息已发送')
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockToast.warning).toHaveBeenCalledWith(expect.stringContaining('无需恢复'))
  })

  it('同目录存在其他 run 运行中会话时，发送消息传 allow_resume=false', async () => {
    mockFetchWithRun(makeRun())
    const current = makeSession({
      state: 'idle', loop_status: 'no', stop_reason: 'user_pause', reviewer_mode: 'manual',
      project_dir: '/proj',
    })
    const otherRunning = makeSession({
      id: 'sess-other', state: 'running', project_dir: '/proj', run_id: 'run-other',
    })
    const wrapper = await mountSessionDetail(current, [otherRunning])
    await sendPrompt(wrapper)
    expect(mockSendMessage).toHaveBeenCalledWith('sess-1', 'hello', 'run-1', false)
    expect(mockResume).not.toHaveBeenCalled()
  })
})

describe('SessionDetailView — 渲染健壮性与加载去重', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnected.value = true
    mockSessions.value = []
    mockFetchWithRun(null)
  })

  it('error 事件的 message 为对象时不抛 TypeError（JSON 兜底渲染）', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v1/events')) {
        return Promise.resolve({
          ok: true,
          json: vi.fn().mockResolvedValue({
            events: [{
              session_id: 'sess-1',
              timestamp: '2026-01-01T00:00:00',
              event_type: 'error',
              data: { error: { data: { message: { code: 500, detail: 'boom' } } } },
            }],
          }),
        })
      }
      return Promise.resolve({ ok: true, json: vi.fn().mockResolvedValue({}) })
    })
    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const vl = wrapper.findComponent({ name: 'VirtualLog' })
    expect(vl.exists()).toBe(true)
    const texts: string[] = (vl.props('lines') as any[]).map(l => l.text)
    expect(texts.some(t => t.includes('错误:'))).toBe(true)
  })

  it('subagent DONE 的多行摘要逐行展示，超限内容可打开全文', async () => {
    const content = ['复审完成。', '', '**状态**: ✅通过', '| 项目 | 结果 |',
      '| A | 通过 |', '| B | 通过 |', '| C | 通过 |', '| D | 通过 |'].join('\n')
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [{
        session_id: 'sess-1', timestamp: '2026-10-19T00:00:00',
        event_type: 'subagent_stop',
        data: { agent_id: 'agent-1', agent_type: 'reviewer', content },
      }] } : {}),
    }))

    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const lines = wrapper.findComponent({ name: 'VirtualLog' }).props('lines') as any[]
    const summary = lines.filter(line => line.cls === 'cls-subagent')
    expect(summary.map(line => line.text)).toEqual(expect.arrayContaining([
      expect.stringContaining('DONE: reviewer'),
      '  │ 复审完成。', '  │ **状态**: ✅通过', '  │ | 项目 | 结果 |',
    ]))
    expect(summary.find(line => line.modal)?.modal).toBe(content)
    expect(summary.some(line => line.text.includes('| D |'))).toBe(false)
  })

  it('subagent DONE 的超长单行保留 120 字预览和全文弹窗', async () => {
    const content = '状态: ' + '通过'.repeat(70)
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [{
        session_id: 'sess-1', timestamp: '2026-10-19T00:00:00',
        event_type: 'subagent_stop', data: { agent_id: 'agent-2', content },
      }] } : {}),
    }))

    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const lines = wrapper.findComponent({ name: 'VirtualLog' }).props('lines') as any[]
    expect(lines.some(line => line.text === `  │ ${content.slice(0, 120)}…`)).toBe(true)
    expect(lines.find(line => line.modal)?.modal).toBe(content)
  })

  it('assistant 超长单行（行数少）截断为预览并挂全文弹窗，不再整体内联', async () => {
    const longLine = 'x'.repeat(500)
    const shortLine = 'short line'
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [{
        session_id: 'sess-1', timestamp: '2026-10-19T00:00:00',
        event_type: 'assistant_message',
        data: { content: [{ type: 'text', text: `${longLine}\n${shortLine}` }] },
      }] } : {}),
    }))

    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    const lines = wrapper.findComponent({ name: 'VirtualLog' }).props('lines') as any[]
    const body = lines.filter(line => line.cls === 'cls-user')
    expect(body.some(line => line.text === `${'x'.repeat(200)} …`)).toBe(true)
    expect(body.some(line => line.text === shortLine)).toBe(true)
    expect(body.find(line => line.modal)?.modal).toBe(longLine)
    // 原始超长行不再整体内联（固定行高路径会被横向裁剪且无查看入口）
    expect(body.some(line => line.text === longLine)).toBe(false)
  })

  it('同时间戳的并行 subagent_start（不同 agent_id）不被去重吞掉', async () => {
    // InteractionBridge 的 dispatchTimestamp 对并行派发相同：两条 start 事件
    // 共享 timestamp+event_type。旧去重键 ts:type 会吞掉第二条，拓扑图整
    // 节点丢失（grandson agent 消失）。本文件默认把 deriveTopology mock 成
    // null，这里换回真实实现让拓扑卡片真实推导
    const actual = await vi.importActual<
      typeof import('../composables/useTopology')
    >('../composables/useTopology')
    const { deriveTopology } = await import('../composables/useTopology')
    vi.mocked(deriveTopology).mockImplementation(
      actual.deriveTopology as typeof deriveTopology,
    )
    const start = (agent_id: string) => ({
      session_id: 'sess-1', timestamp: '2026-10-28T13:38:23.538000',
      event_type: 'subagent_start',
      data: { agent_id, agent_type: 'Explore', agent_name: agent_id },
    })
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [
        start('sub-aaa'), start('sub-bbb'),
      ] } : {}),
    }))

    const wrapper = await mountSessionDetail(makeSession({ state: 'running' }))
    expect(wrapper.text()).toContain('2 子代理')
    expect(wrapper.text()).toContain('Agent 调用树')
    expect(wrapper.text()).not.toContain('子代理阈值')
  })

  it('首挂载只拉取一次 /api/v1/events（watch immediate 覆盖 onMounted）', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      urls.push(url)
      return Promise.resolve({ ok: true, json: vi.fn().mockResolvedValue({ events: [] }) })
    })
    await mountSessionDetail(makeSession({ state: 'running' }))
    expect(urls.filter(u => u.includes('/api/v1/events'))).toHaveLength(1)
  })

  it('当前上下文使用单请求快照，超窗封顶且分段合计同窗口口径', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [{
        session_id: 'sess-1', iteration: 1, timestamp: '2026-10-29T00:00:00',
        event_type: 'step_finish', data: {
          usage: { input_tokens: 3000, output_tokens: 100 },
          context_usage: { input_tokens: 1000, cache_read_input_tokens: 100, cache_creation_input_tokens: 100 },
          modelUsage: { model: { contextWindow: 1000 } },
        },
      }] } : {}),
    }))
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    expect(state.currentContext).toMatchObject({ pct: 100, over: true, tokens: 1200, window: 1000 })
    expect(state.usageData.turns).toBe(0)
    expect(state.contextHistory[0].pct).toBe(100)
  })

  it('窗口取 modelUsage 中各模型的 contextWindow 最大值', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(url.includes('/api/v1/events') ? { events: [{
        session_id: 'sess-1', iteration: 1, timestamp: '2026-10-29T00:00:00',
        event_type: 'step_finish', data: {
          usage: { input_tokens: 3000 },
          context_usage: { input_tokens: 1200 },
          modelUsage: { opus: { contextWindow: 1000 }, sonnet: { contextWindow: 1800 } },
        },
      }] } : {}),
    }))
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    expect(state.currentContext).toMatchObject({ tokens: 1200, window: 1800 })
  })
})

describe('SessionDetailView — 实时上下文', () => {
  function ctxEvent(id: string, data: any, type = 'context_usage') {
    return { id, session_id: 'sess-1', iteration: 1, timestamp: `2026-10-19T20:00:0${id}`, event_type: type, data }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockEvents.value = {}
  })

  it('未知用量的交接响应显示未知提示', async () => {
    mockHandoff.mockResolvedValue({ handoff_triggered: false, reason: 'context_usage_unknown', context: { percentage: null } })
    const wrapper = await mountSessionDetail(makeSession())
    await (wrapper.vm as any).doHandoff(false)
    expect(mockToast.warning).toHaveBeenCalledWith('上下文用量未知，暂无法判断是否达到交接阈值')
  })

  it('实时事件即时更新占比，累计用量只取 step_finish', async () => {
    const wrapper = await mountSessionDetail(makeSession())
    expect(wrapper.text()).toContain('上下文用量未知')
    expect(wrapper.text()).toContain('暂无累计用量')
    mockEvents.value = { 'sess-1': [ctxEvent('1', {
      context_usage: { input_tokens: 10000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 30000 },
    })] }
    await flushPromises()
    expect(wrapper.find('.context-pct').text()).toBe('30%')
    mockEvents.value['sess-1']!.push(ctxEvent('2', {
      context_usage: { input_tokens: 80000 },
      usage: { input_tokens: 900000 }, total_cost_usd: 1.5, num_turns: 8,
    }, 'step_finish'))
    await flushPromises()
    expect(wrapper.find('.context-pct').text()).toBe('40%')
    const state = wrapper.vm as any
    expect(state.usageData).toMatchObject({ turns: 8, totalTokens: 900000 })
    expect(wrapper.text()).toContain('900.0K tokens')
  })

  it('全零步骤记录不冒充累计用量', async () => {
    mockEvents.value = { 'sess-1': [ctxEvent('1', { usage: { input_tokens: 0, output_tokens: 0 } }, 'step_finish')] }
    const wrapper = await mountSessionDetail(makeSession())
    expect(wrapper.text()).toContain('暂无累计用量')
  })

  it('明确零值有效，非法读数不覆盖', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('1', { context_usage: { input_tokens: 50000 } }),
      ctxEvent('2', { context_usage: { input_tokens: null } }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    expect(wrapper.find('.context-pct').text()).toBe('25%')
    mockEvents.value['sess-1']!.push(ctxEvent('3', { context_usage: { input_tokens: 0 } }))
    await flushPromises()
    expect(wrapper.find('.context-pct').text()).toBe('0%')
  })

  it('旧事件兼容 usage，按时间取最新，窗口分母与读数同源', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('2', { usage: { cache_creation_input_tokens: 100000 },
        modelUsage: { model: { contextWindow: 1000000 } } }, 'result'),
      ctxEvent('1', { context_usage: { input_tokens: 50000 } }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    expect(wrapper.find('.context-pct').text()).toBe('10%')
    expect(state.currentContext.window).toBe(1000000)
  })

  it('context_usage 为空对象时整体回退 usage：总量与四段同源，别名键计入总量', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('1', {
        context_usage: {},
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40, cache_write_input_tokens: 10 },
      }, 'step_finish'),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const c = (wrapper.vm as any).currentContext
    // 回退后总量来自 usage，且 input+output+cache 读写四段合计与总量一致
    expect(c.tokens).toBe(200)
    expect(c.input).toBe(100)
    expect(c.output).toBe(50)
    expect(c.cacheRead).toBe(40)
    expect(c.cacheWrite).toBe(10)
    expect(c.input + c.output + c.cacheRead + c.cacheWrite).toBe(c.tokens)
  })

  it('轮内 context_usage 沿用会话已知窗口，不落 200k 扁平分母', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('1', {
        usage: { input_tokens: 100000 },
        modelUsage: { model: { contextWindow: 1000000 } },
      }, 'step_finish'),
      ctxEvent('2', { context_usage: { input_tokens: 500000 } }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    expect(wrapper.find('.context-pct').text()).toBe('50%')
    expect(state.currentContext.window).toBe(1000000)
    expect(state.currentContext.tokens).toBe(500000)
  })

  it('同一 iteration 的多条读数聚合为一点，趋势图不随 assistant 消息数膨胀', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('1', { context_usage: { input_tokens: 20000 } }),
      ctxEvent('2', { context_usage: { input_tokens: 40000 } }),
      ctxEvent('3', { context_usage: { input_tokens: 60000 } }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    expect(state.contextHistory).toHaveLength(1)
    expect(state.currentContext.tokens).toBe(60000)
    mockEvents.value['sess-1']!.push({ ...ctxEvent('4', { context_usage: { input_tokens: 30000 } }), iteration: 2 })
    await flushPromises()
    expect(state.contextHistory).toHaveLength(2)
    expect(state.contextHistory[0].iter).toBe(1)
    expect(state.contextHistory[1].iter).toBe(2)
    expect(state.contextHistory[1].tokens).toBe(30000)
    expect(state.currentContext.tokens).toBe(30000)
  })

  it('分段条零 token 段不渲染；超窗时宽度按 max(窗口, 已用) 归一充满整条', async () => {
    mockEvents.value = { 'sess-1': [
      ctxEvent('1', { context_usage: { input_tokens: 1000, output_tokens: 0 }, modelUsage: { model: { contextWindow: 2000 } } }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const state = wrapper.vm as any
    // Output/Cache 读写均零 token：不渲染为最小色条；正常时宽度合计 100%
    expect(state.contextBarSegments.map((s: any) => s.label)).toEqual(['Input', 'Free space'])
    expect(state.contextBarSegments.reduce((sum: number, s: any) => sum + s.widthPct, 0)).toBeCloseTo(100, 5)

    mockEvents.value = { 'sess-1': [
      ctxEvent('1', { context_usage: { input_tokens: 3000 }, modelUsage: { model: { contextWindow: 2000 } } }),
    ] }
    await flushPromises()
    // 超窗：行内百分比仍按窗口口径（150%），宽度分母取已用总量，充满整条不溢出
    expect(state.currentContext.over).toBe(true)
    expect(state.contextBreakdown[0].pct).toBe(150)
    expect(state.contextBarSegments.map((s: any) => s.label)).toEqual(['Input'])
    expect(state.contextBarSegments[0].widthPct).toBe(100)
    wrapper.unmount()
  })
})

describe('SessionDetailView — 侧栏宽度键盘方向', () => {
  it('ArrowRight 增大 aria-valuenow、ArrowLeft 减小（separator 键盘约定）', async () => {
    const wrapper = await mountSessionDetail(makeSession())
    const handle = wrapper.find('.session-sidebar-resizer')
    expect(handle.exists()).toBe(true)
    const before = Number(handle.attributes('aria-valuenow'))
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(Number(handle.attributes('aria-valuenow'))).toBe(before + 10)
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(Number(handle.attributes('aria-valuenow'))).toBe(before)
    wrapper.unmount()
  })
})

describe('SessionDetailView — 工具调用结果配对与渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEvents.value = {}
    mockSessions.value = []
  })

  function toolEvent(id: string, event_type: string, data: any) {
    return { id, session_id: 'sess-1', iteration: 1, timestamp: `2026-10-19T20:00:0${id}`, event_type, data }
  }
  function linesOf(wrapper: any): any[] {
    return (wrapper.vm as any).$?.setupState.workerOutput ?? []
  }
  function toolBlocks(wrapper: any): any[] {
    return linesOf(wrapper).filter((l: any) => l.block)
  }

  it('独立 tool_result（先于调用）按 tool_use_id 配对进工具块，不再重复渲染', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'file found', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'Read', arg: 'foo.py', tool_use_id: 'tu1', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.result).toBe('file found')
    expect(blocks[0].block.title).toContain('Read')
    // 结果只在工具块内展示一次，不产生孤立 result 行
    expect(linesOf(wrapper).some((l: any) => l.text.includes('← result'))).toBe(false)
    wrapper.unmount()
  })

  it('并行工具调用结果不串位：按 tool_use_id 各归其主', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tuA', tool_name: 'bash', content: 'A-out', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'bash', arg: 'a', tool_use_id: 'tuA', is_error: false }),
      toolEvent('3', 'tool_result', { tool_use_id: 'tuB', tool_name: 'bash', content: 'B-out', is_error: false }),
      toolEvent('4', 'tool_call', { name: 'bash', arg: 'b', tool_use_id: 'tuB', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].block.result).toBe('A-out')
    expect(blocks[1].block.result).toBe('B-out')
    wrapper.unmount()
  })

  it('user_message 内嵌 tool_result 被认领后不重复显示，同消息文本块保留', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'ok', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'Read', arg: 'foo', tool_use_id: 'tu1', is_error: false }),
      toolEvent('3', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false },
        { type: 'text', text: 'please check this' },
      ] }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.some((l: any) => l.text.includes('please check this'))).toBe(true)
    expect(lines.filter((l: any) => l.text.includes('← result'))).toHaveLength(0)
    wrapper.unmount()
  })

  it('孤立 tool_result（无匹配调用）仍渲染，避免整条丢失', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tuX', tool_name: 'Read', content: 'orphan result', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(toolBlocks(wrapper)).toHaveLength(0)
    expect(lines.some((l: any) => l.text.includes('orphan result'))).toBe(true)
    wrapper.unmount()
  })

  it('孤立 tool_result 超长单行截断为预览行，全文挂 modal', async () => {
    const longLine = 'x'.repeat(500)
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tuX', tool_name: 'Read', content: longLine, is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const preview = linesOf(wrapper).find((l: any) => l.text.startsWith('  │ '))
    expect(preview.text.length).toBeLessThanOrEqual('  │ '.length + 200 + 2)
    expect(preview.text.endsWith('…')).toBe(true)
    expect(preview.modal).toBe(longLine)
    wrapper.unmount()
  })

  it('内嵌 tool_result 超长单行同样截断为预览行，全文挂 modal', async () => {
    const longLine = 'y'.repeat(600)
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tuE', content: longLine, is_error: false },
      ] }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const preview = linesOf(wrapper).find((l: any) => l.text.startsWith('  │ '))
    expect(preview.text.length).toBeLessThanOrEqual('  │ '.length + 200 + 2)
    expect(preview.text.endsWith('…')).toBe(true)
    expect(preview.modal).toBe(longLine)
    wrapper.unmount()
  })

  it('独立事件与内嵌块同 uid 且无调用（调用滑出窗口）时只渲染一次', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'shared result', is_error: false }),
      toolEvent('2', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'shared result', is_error: false },
      ] }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.filter((l: any) => l.text.includes('← result'))).toHaveLength(1)
    expect(lines.some((l: any) => l.text.includes('shared result'))).toBe(true)
    wrapper.unmount()
  })

  it('内嵌块先于独立事件出现时同样只渲染一次', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'shared result', is_error: false },
      ] }),
      toolEvent('2', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'shared result', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.filter((l: any) => l.text.includes('← result'))).toHaveLength(1)
    expect(lines.some((l: any) => l.text.includes('shared result'))).toBe(true)
    wrapper.unmount()
  })

  it('同 uid 的同型重复独立事件（无调用认领）只渲染一次', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'dup result', is_error: false }),
      toolEvent('2', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'dup result', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.filter((l: any) => l.text.includes('← result'))).toHaveLength(1)
    expect(lines.filter((l: any) => l.text.includes('dup result'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('同 uid 重复独立事件且首个已被工具块认领时，重复事件不产生孤立行', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'claimed result', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'Read', arg: 'foo.py', tool_use_id: 'tu1', is_error: false }),
      toolEvent('3', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'claimed result', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.result).toBe('claimed result')
    expect(linesOf(wrapper).some((l: any) => l.text.includes('← result'))).toBe(false)
    wrapper.unmount()
  })

  it('多条 user_message 内嵌同 uid 块时只渲染登记来源那条', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'embedded result', is_error: false },
      ] }),
      toolEvent('2', 'user_message', { content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'embedded result', is_error: false },
      ] }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.filter((l: any) => l.text.includes('← result'))).toHaveLength(1)
    expect(lines.filter((l: any) => l.text.includes('embedded result'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('工具块展开 ID 基于时间戳而非窗口下标（事件流增长不折叠）', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'ok', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'Read', arg: 'foo', tool_use_id: 'tu1', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const block = toolBlocks(wrapper)[0]
    expect(block.expandId).toBe('tool:2026-10-19T20:00:02:Read:foo')
    wrapper.unmount()
  })

  it('历史会话降级回退：旧 tool_call 缺 id 时按 tool_name 认领带 uid 的结果', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'Read', content: 'legacy result', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'Read', arg: 'foo.py', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.result).toBe('legacy result')
    expect(linesOf(wrapper).some((l: any) => l.text.includes('← result'))).toBe(false)
    wrapper.unmount()
  })

  it('混合新旧事件：无 uid 旧 call 不抢先认领属于新 call 的结果（同一结果不被认领两次）', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_call', { name: 'bash', arg: 'old-cmd', is_error: false }),
      toolEvent('2', 'tool_result', { tool_use_id: 'tuNew', tool_name: 'bash', content: 'NEW-out', is_error: false }),
      toolEvent('3', 'tool_call', { name: 'bash', arg: 'new-cmd', tool_use_id: 'tuNew', is_error: false }),
      toolEvent('4', 'tool_result', { tool_use_id: 'tuOld', tool_name: 'bash', content: 'OLD-out', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].block.command).toBe('old-cmd')
    expect(blocks[0].block.result).toBe('OLD-out')
    expect(blocks[1].block.command).toBe('new-cmd')
    expect(blocks[1].block.result).toBe('NEW-out')
    expect(linesOf(wrapper).some((l: any) => l.text.includes('← result'))).toBe(false)
    wrapper.unmount()
  })

  it('带 uid 的调用只等待自己的结果，不误领同名无 uid 的结果', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_name: 'bash', content: 'orphan-old', is_error: false }),
      toolEvent('2', 'tool_call', { name: 'bash', arg: 'ls', tool_use_id: 'tuRunning', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.result).toBe('')
    expect(linesOf(wrapper).some((l: any) => l.text.includes('orphan-old'))).toBe(true)
    wrapper.unmount()
  })

  it('工具结果超长时块内截断预览，全文进 fullText 供弹窗查看', async () => {
    const huge = 'x'.repeat(50000)
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'bash', content: huge, is_error: false }),
      toolEvent('2', 'tool_call', { name: 'bash', arg: 'ls', tool_use_id: 'tu1', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const block = toolBlocks(wrapper)[0]
    expect(block.block.result.length).toBeLessThanOrEqual(20000)
    expect(block.block.fullText).toBe(huge)
    wrapper.unmount()
  })

  it('孤立失败 tool_result 的 content 为空串时回退 tool_error，错误文本不丢', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tuX', tool_name: 'bash', content: '', is_error: true, tool_error: 'boom: exit 1' }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.some((l: any) => l.text.includes('✗ error'))).toBe(true)
    expect(lines.some((l: any) => l.text.includes('boom: exit 1'))).toBe(true)
    wrapper.unmount()
  })

  it('孤立结果预览行标签区分成败：失败 ✗ error、成功 ← result', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tuF', tool_name: 'bash', content: 'boom', is_error: true }),
      toolEvent('2', 'tool_result', { tool_use_id: 'tuS', tool_name: 'bash', content: 'ok', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const lines = linesOf(wrapper)
    expect(lines.some((l: any) => l.cls === 'cls-error' && l.text.includes('✗ error'))).toBe(true)
    expect(lines.some((l: any) => l.cls === 'cls-result' && l.text.includes('← result'))).toBe(true)
    wrapper.unmount()
  })

  it('配对失败结果 content 为空串时取结果侧 tool_error，工具块不落空', async () => {
    mockEvents.value = { 'sess-1': [
      toolEvent('1', 'tool_result', { tool_use_id: 'tu1', tool_name: 'bash', content: '', is_error: true, tool_error: 'cmd failed: no such file' }),
      toolEvent('2', 'tool_call', { name: 'bash', arg: 'ls missing', tool_use_id: 'tu1', is_error: false }),
    ] }
    const wrapper = await mountSessionDetail(makeSession())
    const blocks = toolBlocks(wrapper)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.failed).toBe(true)
    expect(blocks[0].block.result).toBe('cmd failed: no such file')
    wrapper.unmount()
  })

  it('localSession 已缓存时，SSE 列表移除该会话不触发视图内回跳（回跳由侧栏删除路径负责）', async () => {
    const s = makeSession()
    mockSessions.value = [s]
    // 如实模拟正常挂载：GET /api/v1/sessions/:id 命中并缓存 localSession
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue(
        url.includes('/api/v1/events') ? { events: [] } : url.includes('/api/v1/sessions/sess-1') ? s : {},
      ),
    } as any))
    const SessionDetailView = (await import('../views/SessionDetailView.vue')).default
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', name: 'dashboard', component: { template: '<div/>' } },
      { path: '/session/:id', name: 'sessionDetail', component: { template: '<div/>' } },
    ] })
    await router.push('/session/sess-1')
    await router.isReady()
    const wrapper = mount(SessionDetailView, {
      global: {
        plugins: [router],
        stubs: {
          CheckpointPanel: true, DeleteSessionDialog: true, FileProvenanceView: true,
          VirtualLog: true, AgentTopologyGraph: true, WatchdogAlerts: true,
        },
      },
    })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/session/sess-1')
    // SSE 列表移除后 localSession 仍兜底有值，「session 变 null」的 watcher 不触发；
    // 正常删除流程的回首页由侧栏删除成功路径显式执行（见 AppSidebar 测试）
    mockSessions.value = []
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/session/sess-1')
    wrapper.unmount()
  })

  it('localSession 未缓存（深链拉取失败）时，SSE 列表移除仍由 watcher 兜底回首页', async () => {
    const s = makeSession()
    mockSessions.value = [s]
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false } as any)
    const SessionDetailView = (await import('../views/SessionDetailView.vue')).default
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', name: 'dashboard', component: { template: '<div/>' } },
      { path: '/session/:id', name: 'sessionDetail', component: { template: '<div/>' } },
    ] })
    await router.push('/session/sess-1')
    await router.isReady()
    const wrapper = mount(SessionDetailView, {
      global: {
        plugins: [router],
        stubs: {
          CheckpointPanel: true, DeleteSessionDialog: true, FileProvenanceView: true,
          VirtualLog: true, AgentTopologyGraph: true, WatchdogAlerts: true,
        },
      },
    })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/session/sess-1')
    // 模拟删除：SSE 会话列表移除该会话（本地也未加载到）
    mockSessions.value = []
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    wrapper.unmount()
  })
})

describe('SessionDetailView — 可点击日志行深色 hover', () => {
  // scoped CSS 无法在 jsdom 中求值，直接断言源文件规则（同 api-paths.spec 的源码断言方式）
  it('user/result/error 预览行在 flow 与虚拟滚动两路径下均为半透明靛蓝，不落回浅蓝 #ecf3ff', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../views/SessionDetailView.vue'),
      'utf8',
    )
    const selectors = [
      ':deep(.vlog-line.cls-user.vlog-clickable:hover)',
      ':deep(.vlog-flow-line.cls-user.vlog-clickable:hover)',
      ':deep(.vlog-line.cls-result.vlog-clickable:hover)',
      ':deep(.vlog-flow-line.cls-result.vlog-clickable:hover)',
      ':deep(.vlog-line.cls-error.vlog-clickable:hover)',
      ':deep(.vlog-flow-line.cls-error.vlog-clickable:hover)',
    ]
    for (const sel of selectors) {
      const at = source.indexOf(sel)
      expect(at, `missing override rule for ${sel}`).toBeGreaterThanOrEqual(0)
      const rule = source.slice(at, source.indexOf('}', at) + 1)
      expect(rule).toContain('rgba(124,140,255,.12)')
    }
  })
})
