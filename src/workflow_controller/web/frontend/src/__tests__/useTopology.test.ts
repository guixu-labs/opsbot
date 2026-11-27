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

import { describe, it, expect } from 'vitest'
import { deriveTopology } from '../composables/useTopology'
import type { ClaudeEvent, SessionInfo } from '../types/api'

let rowid = 0
function ev(
  event_type: string,
  timestamp: string,
  data: Record<string, unknown>,
  iteration = 0,
): ClaudeEvent {
  return { rowid: ++rowid, session_id: 's1', event_type, iteration, timestamp, data }
}

function session(state: string, result: string | null = null): SessionInfo {
  return {
    id: 's1',
    name: 'worker',
    role: 'worker',
    state,
    loop_status: 'yes',
    stop_reason: null,
    loop_hold: null,
    current_iteration: 1,
    max_iterations: 10,
    progress: 0,
    elapsed_seconds: 0,
    created_at_iso: '',
    error: null,
    last_activity: [],
    birth_handoff_doc: null,
    result,
    predecessor: null,
    successors: [],
    native_session_id: null,
  }
}

// created_at 早于 T0 30s + elapsed 45s → 冻结会话末活动时刻为 T0+15s
function endedSession(): SessionInfo {
  return {
    ...session('failed'),
    created_at_iso: '2026-10-26T09:59:30',
    elapsed_seconds: 45,
  }
}

const T0 = '2026-10-26T10:00:00'
const t = (sec: number) =>
  new Date(new Date(T0).getTime() + sec * 1000).toISOString()

describe('deriveTopology — 静默终止子代理归档', () => {
  it('session 运行中且子代理在途：保持 running（等待窗口内脉冲是真实的）', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
    ]
    const topo = deriveTopology(events, session('running'), false)
    expect(topo!.nodes.find((n) => n.id === 'a1')?.status).toBe('running')
    expect(topo!.activeSubagents).toBe(1)
    expect(topo!.stoppedSubagents).toBe(0)
  })

  it('session 离开 running（无 subagent_stop）：归档为 stopped', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
      ev('subagent_start', t(1), { agent_id: 'a2', agent_type: 'reader' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const subs = topo!.nodes.filter((n) => n.role === 'subagent')
    expect(subs.map((n) => n.status)).toEqual(['stopped', 'stopped'])
    expect(topo!.activeSubagents).toBe(0)
    expect(topo!.stoppedSubagents).toBe(2)
    for (const n of subs) expect(n.endedAt).not.toBeNull()
    expect(topo!.edges.filter((e) => e.type === 'dispatch').map((e) => e.status))
      .toEqual(['stopped', 'stopped'])
  })

  it('paused / stopped / failed / waiting_retry / idle 同样触发归档', () => {
    for (const state of ['paused', 'stopped', 'failed', 'waiting_retry', 'idle']) {
      const events = [
        ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
      ]
      const topo = deriveTopology(events, session(state), false)
      expect(topo!.nodes.find((n) => n.id === 'a1')?.status, state).toBe('stopped')
    }
  })

  it('query 边界（iteration_end / log_query / iteration_start）归档上一轮遗留的 running 子代理', () => {
    const events = [
      ev('log_query', t(0), { prompt: 'go', iteration: 1 }, 1),
      ev('subagent_start', t(5), { agent_id: 'a1', agent_type: 'writer' }),
      ev('iteration_end', t(30), { reason: 'proc_exit' }, 1),
      // 第 2 轮开始，session 仍 running
      ev('log_query', t(31), { prompt: 'again', iteration: 2 }, 2),
      ev('iteration_start', t(32), { session_id: 'oc1' }, 2),
    ]
    const topo = deriveTopology(events, session('running'), false)
    const node = topo!.nodes.find((n) => n.id === 'a1')
    expect(node?.status).toBe('stopped')
    expect(node?.endedAt).toBe(new Date(t(30)).getTime())
    expect(topo!.stoppedSubagents).toBe(1)
  })

  it('start 事件即流末尾时归档 endedAt 回退冻结的会话末活动时刻，重算不漂移', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
    ]
    const s = endedSession()
    const node = deriveTopology(events, s, false)!.nodes.find((n) => n.id === 'a1')
    expect(node?.status).toBe('stopped')
    const sessionEnd = new Date('2026-10-26T09:59:30').getTime() + 45 * 1000
    expect(node!.endedAt).toBe(sessionEnd)
    expect(node!.endedAt!).toBeGreaterThan(node!.startedAt!)
    // 同输入重算归档点必须一致
    const rerun = deriveTopology(events, s, false)!.nodes.find((n) => n.id === 'a1')
    expect(rerun!.endedAt).toBe(node!.endedAt)
  })

  it('会话末活动时刻不可得（created_at 无效）时回退 startedAt', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
    ]
    const node = deriveTopology(events, session('failed'), false)!
      .nodes.find((n) => n.id === 'a1')
    expect(node?.status).toBe('stopped')
    expect(node!.endedAt).toBe(node!.startedAt)
  })

  it('正常 subagent_stop 不受归档影响（completed / failed 语义保留）', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
      ev('subagent_start', t(1), { agent_id: 'a2', agent_type: 'tester' }),
      ev('subagent_stop', t(10), { agent_id: 'a1', agent_type: 'writer', content: 'done', total_tokens: 42 }),
      ev('subagent_stop', t(11), { agent_id: 'a2', agent_type: 'tester', content: 'error: boom' }),
      ev('iteration_end', t(20), { reason: 'proc_exit' }, 1),
    ]
    const topo = deriveTopology(events, session('running'), false)
    expect(topo!.nodes.find((n) => n.id === 'a1')?.status).toBe('completed')
    expect(topo!.nodes.find((n) => n.id === 'a2')?.status).toBe('failed')
    expect(topo!.stoppedSubagents).toBe(0)
  })

  it('session 结束时 reviewer 从 running 回归 idle，feedback 边置 stopped', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'a1', agent_type: 'writer' }),
      ev('log_auto', t(5), { hook: 'stop_hook_llm', decision: 'block' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), true)
    expect(topo!.nodes.find((n) => n.role === 'reviewer')?.status).toBe('idle')
    expect(topo!.edges.find((e) => e.type === 'feedback')?.status).toBe('stopped')
  })

  it('let_exit 后 reviewer 保持 completed，不被归档误改', () => {
    const events = [
      ev('log_auto', t(0), { hook: 'stop_hook_llm', decision: 'block' }),
      ev('log_auto', t(5), { hook: 'stop_hook_llm', decision: 'let_exit' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), true)
    expect(topo!.nodes.find((n) => n.role === 'reviewer')?.status).toBe('completed')
  })
})

describe('deriveTopology — 重建合成事件的 agent_name label', () => {
  it('subagent_start 带 agent_name 时 label 优先用它', () => {
    const events = [
      ev('subagent_start', t(0), {
        agent_id: 'sub-1',
        agent_type: 'designer',
        agent_name: 'Designer: Qwen4Exp golden 设计',
      }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const node = topo!.nodes.find((n) => n.id === 'sub-1')
    expect(node?.label).toBe('Designer: Qwen4Exp golden 设计')
    expect(node?.agentType).toBe('designer')
  })

  it('无 agent_name 时 label 回退 agent_type；stop 事件的 agent_type 不覆盖 name label', () => {
    const events = [
      ev('subagent_start', t(0), {
        agent_id: 'sub-1',
        agent_type: 'designer',
        agent_name: 'Designer: X',
      }),
      ev('subagent_start', t(1), { agent_id: 'sub-2', agent_type: 'Explore' }),
      ev('subagent_stop', t(10), { agent_id: 'sub-1', agent_type: 'designer', content: 'ok' }),
      ev('subagent_stop', t(11), { agent_id: 'sub-2', agent_type: 'Explore', content: 'done' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    expect(topo!.nodes.find((n) => n.id === 'sub-1')?.label).toBe('Designer: X')
    expect(topo!.nodes.find((n) => n.id === 'sub-2')?.label).toBe('Explore')
  })
})

describe('deriveTopology — dispatch 边父级（孙 agent 层级）', () => {
  it('start 事件带 parent_agent_id 且父节点已注册：dispatch 边 fromId 指向派发者', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'sub-1', agent_type: 'designer' }),
      // Designer 派的孙 agent：parent_agent_id = sub-1
      ev('subagent_start', t(1), {
        agent_id: 'sub-2',
        agent_type: 'Explore',
        parent_agent_id: 'sub-1',
      }),
      ev('subagent_start', t(2), { agent_id: 'sub-3', agent_type: 'auditor' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const edgeOf = (id: string) =>
      topo!.edges.find((e) => e.type === 'dispatch' && e.toId === id)
    expect(edgeOf('sub-1')?.fromId).toBe('main')
    expect(edgeOf('sub-2')?.fromId).toBe('sub-1')
    expect(edgeOf('sub-3')?.fromId).toBe('main')
    // 三层节点都在，孙 agent 不丢失
    expect(topo!.totalSubagents).toBe(3)
  })

  it('同时间戳且子节点先注册：全部注册后仍解析到真实父节点', () => {
    const events = [
      ev('subagent_start', t(0), {
        agent_id: 'sub-g', agent_type: 'Explore', parent_agent_id: 'sub-1',
      }),
      ev('subagent_start', t(0), { agent_id: 'sub-1', agent_type: 'designer' }),
      ev('subagent_start', t(0), {
        agent_id: 'sub-gg', agent_type: 'tester', parent_agent_id: 'sub-g',
      }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const edgeOf = (id: string) =>
      topo!.edges.find((e) => e.type === 'dispatch' && e.toId === id)
    expect(edgeOf('sub-1')?.fromId).toBe('main')
    expect(edgeOf('sub-g')?.fromId).toBe('sub-1')
    expect(edgeOf('sub-gg')?.fromId).toBe('sub-g')
  })

  it('后到的父级补充（同 id 重复 start）：非空父级更新 dispatch 边，空父级不覆盖', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'sub-1', agent_type: 'designer' }),
      // hook 路径首条 start 父级为空
      ev('subagent_start', t(1), { agent_id: 'sub-2', agent_type: 'Explore' }),
      // 父级解析完成后重发的 start：携带真实 parent_agent_id
      ev('subagent_start', t(2), {
        agent_id: 'sub-2',
        agent_type: 'Explore',
        parent_agent_id: 'sub-1',
      }),
      // 再次的重复 start 不带父级，不覆盖已确认的父级
      ev('subagent_start', t(3), { agent_id: 'sub-2', agent_type: 'Explore' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const edgeOf = (id: string) =>
      topo!.edges.find((e) => e.type === 'dispatch' && e.toId === id)
    expect(edgeOf('sub-1')?.fromId).toBe('main')
    expect(edgeOf('sub-2')?.fromId).toBe('sub-1')
    // 重复 start 不产生重复节点
    expect(topo!.totalSubagents).toBe(2)
  })

  it('parent_agent_id 缺失（实时旧事件）或父节点未注册：回退挂 main', () => {
    const events = [
      // 乱序：孙 agent start 先于父（parent 未注册）
      ev('subagent_start', t(0), {
        agent_id: 'sub-g',
        agent_type: 'Explore',
        parent_agent_id: 'sub-missing',
      }),
      ev('subagent_start', t(1), { agent_id: 'sub-1', agent_type: 'designer' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    const edgeOf = (id: string) =>
      topo!.edges.find((e) => e.type === 'dispatch' && e.toId === id)
    expect(edgeOf('sub-g')?.fromId).toBe('main')
    expect(edgeOf('sub-1')?.fromId).toBe('main')
  })

  it('孙 agent stop 正常归档：dispatchEdgeOf 仍按 toId 命中孙边', () => {
    const events = [
      ev('subagent_start', t(0), { agent_id: 'sub-1', agent_type: 'designer' }),
      ev('subagent_start', t(1), {
        agent_id: 'sub-2',
        agent_type: 'Explore',
        parent_agent_id: 'sub-1',
      }),
      ev('subagent_stop', t(5), { agent_id: 'sub-2', agent_type: 'Explore', content: 'done' }),
    ]
    const topo = deriveTopology(events, session('completed', 'success'), false)
    expect(topo!.nodes.find((n) => n.id === 'sub-2')?.status).toBe('completed')
    expect(
      topo!.edges.find((e) => e.type === 'dispatch' && e.toId === 'sub-2')?.status,
    ).toBe('completed')
  })
})
