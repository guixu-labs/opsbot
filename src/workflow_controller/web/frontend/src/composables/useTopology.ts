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

import type { ClaudeEvent, SessionInfo } from '../types/api'
import type { ForkSessionInfo, TopologySnapshot, TopologyNode, TopologyEdge } from '../types/topology'
import type { CheckpointInfo } from '../plugins/agent_traceback/types'
import { augmentTopology } from '../plugins/agent_traceback/topologyFork'

interface TopologyAugment {
  checkpoints?: CheckpointInfo[]
  forkSessions?: SessionInfo[]
}

const REVIEWER_HOOKS = new Set([
  'stop_hook_llm',
  'pretool_hook_llm',
  'stop_hook_plugin',
  'pretool_hook_deny_manual',
])

const FAIL_MARKERS = /\b(error|failed|failure|traceback|exception)\b/i

function isReviewerHook(data: Record<string, unknown>): boolean {
  const hook = data.hook
  return typeof hook === 'string' && REVIEWER_HOOKS.has(hook)
}

function countToolUses(messages: unknown[]): number {
  return messages.filter((m: any) => m && m.type === 'tool_use').length
}

function mainStatusFromSession(session: SessionInfo | undefined): TopologyNode['status'] {
  if (!session) return 'idle'
  if (session.state === 'running') return 'running'
  if (session.result === 'success') return 'completed'
  if (session.result === 'fail') return 'failed'
  return 'idle'
}

// 取主 agent 指向某子代理的派发边
function dispatchEdgeOf(edges: TopologyEdge[], nodeId: string): TopologyEdge | undefined {
  return edges.find((ed) => ed.type === 'dispatch' && ed.toId === nodeId)
}

// 取 reviewer 指向主 agent 的反馈边
function feedbackEdgeOf(edges: TopologyEdge[]): TopologyEdge | undefined {
  return edges.find((ed) => ed.type === 'feedback' && ed.fromId === 'reviewer')
}

// 把无 stop 事件的在途子代理归档为 stopped：worker query 结束或会话离开 running 时
// 子代理被静默终止、不补发 stop 事件，节点会永远脉冲。fallbackEnd 为冻结的会话末
// 活动时刻，重复推导时归档点不漂移。
function archiveOrphanedSubagents(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  endedAt: number | null,
  fallbackEnd: number | null,
): void {
  for (const node of nodes) {
    if (node.role !== 'subagent' || node.status !== 'running') continue
    node.status = 'stopped'
    if (node.endedAt === null && endedAt !== null) {
      // 末尾即 start 事件时缺少更晚的时间戳，回退冻结时刻避免零时长
      const started = node.startedAt
      node.endedAt = started !== null && endedAt <= started
        ? Math.max(fallbackEnd ?? started, started)
        : endedAt
    }
    const edge = dispatchEdgeOf(edges, node.id)
    if (edge?.status === 'running') edge.status = 'stopped'
  }
}

export function deriveTopology(
  events: ClaudeEvent[],
  session: SessionInfo | undefined,
  reviewerEnabled: boolean,
  augment?: TopologyAugment,
): TopologySnapshot | null {
  const sorted = [...events].sort((a, b) =>
    (a.timestamp || '').localeCompare(b.timestamp || ''),
  )

  const nodes: TopologyNode[] = []
  const edges: TopologyEdge[] = []
  const subMap = new Map<string, TopologyNode>()
  const dispatchParents = new Map<string, string>()

  const mainNode: TopologyNode = {
    id: 'main',
    role: 'main',
    agentType: 'worker',
    label: 'Main Agent',
    status: mainStatusFromSession(session),
    startedAt: null,
    endedAt: null,
    tokens: 0,
    toolCallCount: 0,
    iteration: session?.current_iteration || 0,
    messageCount: 0,
    dispatchContent: null,
    model: null,
  }

  // reviewer 常驻：开启即有节点（idle），首个评审事件再起跑
  const reviewerNode: TopologyNode | null = reviewerEnabled
    ? {
        id: 'reviewer',
        role: 'reviewer',
        agentType: 'reviewer',
        label: 'Reviewer',
        status: 'idle',
        startedAt: null,
        endedAt: null,
        tokens: 0,
        toolCallCount: 0,
        iteration: 0,
        messageCount: 0,
        dispatchContent: null,
        model: null,
      }
    : null
  let reviewerDecisionCount = 0
  if (reviewerNode) {
    nodes.push(reviewerNode)
    edges.push({
      fromId: 'reviewer',
      toId: 'main',
      type: 'feedback',
      status: 'stopped',
      label: 'feedback',
    })
  }

  let globalStart = Infinity
  let globalEnd = 0

  // 会话离开 running 后 elapsed_seconds 冻结在末次活动，created_at + elapsed 即会话
  // 末活动的墙钟时间，作归档回退时刻可保证重复推导结果稳定
  let archiveFallbackEnd: number | null = null
  if (session && session.state !== 'running') {
    const created = new Date(session.created_at_iso).getTime()
    if (!Number.isNaN(created)) {
      archiveFallbackEnd = created + session.elapsed_seconds * 1000
    }
  }

  for (const e of sorted) {
    const ts = new Date(e.timestamp).getTime()
    if (!Number.isNaN(ts)) {
      if (ts < globalStart) globalStart = ts
      if (ts > globalEnd) globalEnd = ts
    }

    const d = (e.data || {}) as Record<string, unknown>

    // query 边界：上一轮 worker 进程及其子代理已全部终止，仍 running 的子代理是孤儿
    if (
      e.event_type === 'iteration_end'
      || e.event_type === 'log_query'
      || e.event_type === 'iteration_start'
    ) {
      archiveOrphanedSubagents(nodes, edges, Number.isNaN(ts) ? null : ts, archiveFallbackEnd)
    }

    // Phase B: prefer step_finish (new usage carrier); accept result for
    // backward compat with historical sessions. Slimmed RESULT (Phase B+)
    // has empty usage → skipped. See docs/result-event-analysis.md §10 / §11.
    if (e.event_type === 'step_finish' || e.event_type === 'result') {
      const u = (d.usage || {}) as Record<string, unknown>
      if (Object.keys(u).length > 0) {
        mainNode.tokens +=
          Number(u.input_tokens || 0) +
          Number(u.output_tokens || 0) +
          Number(u.cache_read_input_tokens || 0) +
          Number(u.cache_creation_input_tokens || 0)
      }
    }

    if (e.event_type === 'subagent_start' || e.event_type === 'subagent_progress' || e.event_type === 'subagent_context' || e.event_type === 'subagent_stop') {
      const id = d.agent_id
      if (typeof id !== 'string' || !id) continue
      const rawType = typeof d.agent_type === 'string' ? d.agent_type : ''
      const agentType = rawType || ''
      // 重建合成事件带 agent_name（bridge.subagentName，如「Designer: …」），
      // 比 agent_type 更具辨识度；start 时记到节点，后续 progress/stop 刷新
      // agent_type 不覆盖 name 派生的 label（stop 事件通常不再带 agent_name）
      const rawName = typeof d.agent_name === 'string' ? d.agent_name : ''

      if (e.event_type === 'subagent_start') {
        const node: TopologyNode = {
          id,
          role: 'subagent',
          agentType,
          agentName: rawName || undefined,
          label: rawName || agentType || `sub:${id.slice(-8)}`,
          status: 'running',
          startedAt: Number.isNaN(ts) ? null : ts,
          endedAt: null,
          tokens: 0,
          toolCallCount: 0,
          iteration: e.iteration || 0,
          messageCount: 0,
          dispatchContent: null,
          model: null,
        }
        if (!subMap.has(id)) {
          subMap.set(id, node)
          nodes.push(node)
          // 同时间戳的 start 可能让子节点先于父节点注册；先保留原始父级，
          // 待事件流注册完成后统一解析，避免过早回退 main 后无法恢复真实层级
          dispatchParents.set(
            id,
            typeof d.parent_agent_id === 'string' ? d.parent_agent_id : '',
          )
          edges.push({
            fromId: 'main',
            toId: id,
            type: 'dispatch',
            status: 'running',
            label: null,
          })
        } else if (typeof d.parent_agent_id === 'string' && d.parent_agent_id) {
          // 同 id 的重复 start 携带后到解析出的父级（首条 hook 路径父级为空），
          // 只做空→非空补充；已确认父级不被后续事件覆盖
          if (!dispatchParents.get(id)) {
            dispatchParents.set(id, d.parent_agent_id)
          }
        }
      } else if (e.event_type === 'subagent_context') {
        const node = subMap.get(id)
        if (node) {
          node.contextTokens = Number(d.current_tokens) || 0
          node.contextWindow = Number(d.max_tokens) || 0
          node.contextPercentage = Number(d.percentage) || 0
        }
      } else if (e.event_type === 'subagent_progress') {
        const node = subMap.get(id)
        if (node) {
          const msgs = Array.isArray(d.messages) ? d.messages : []
          node.messageCount += msgs.length
          node.toolCallCount += countToolUses(msgs)
          if (agentType && !node.agentType) {
            node.agentType = agentType
            if (!node.agentName) node.label = agentType
          }
        }
      } else if (e.event_type === 'subagent_stop') {
        const node = subMap.get(id)
        if (node) {
          const msgs = Array.isArray(d.messages) ? d.messages : []
          const content = typeof d.content === 'string' ? d.content : ''
          const looksFailed =
            FAIL_MARKERS.test(content) ||
            msgs.some((m: any) => m && m.type === 'tool_result' && m.is_error)
          node.status = d.status === 'interrupted' ? 'interrupted' : looksFailed ? 'failed' : 'completed'
          node.endedAt = Number.isNaN(ts) ? null : ts
          node.tokens = Number(d.total_tokens) || node.tokens
          if (agentType) {
            node.agentType = agentType
            if (!node.agentName) node.label = agentType
          }
          if (msgs.length) {
            node.messageCount = msgs.length
            node.toolCallCount = countToolUses(msgs)
          }
          const edge = dispatchEdgeOf(edges, id)
          if (edge) edge.status = node.status === 'interrupted' ? 'interrupted'
            : node.status === 'failed' ? 'failed' : 'completed'
        }
      }
    }

    if (reviewerEnabled && e.event_type === 'log_auto' && isReviewerHook(d)) {
      if (reviewerDecisionCount === 0) {
        reviewerNode!.status = 'running'
        reviewerNode!.startedAt = Number.isNaN(ts) ? null : ts
        reviewerNode!.iteration = e.iteration || 0
        const fbEdge = feedbackEdgeOf(edges)
        if (fbEdge) fbEdge.status = 'running'
      }
      reviewerDecisionCount++
      const decision = d.decision
      if (decision === 'let_exit') {
        reviewerNode!.status = 'completed'
        reviewerNode!.endedAt = Number.isNaN(ts) ? null : ts
        const fbEdge = feedbackEdgeOf(edges)
        if (fbEdge) fbEdge.status = 'completed'
      } else if (decision === 'block') {
        reviewerNode!.status = 'running'
        const fbEdge = feedbackEdgeOf(edges)
        if (fbEdge) fbEdge.status = 'running'
      }
    }
  }

  for (const [childId, rawParent] of dispatchParents) {
    const edge = dispatchEdgeOf(edges, childId)
    if (edge) edge.fromId = rawParent && subMap.has(rawParent) ? rawParent : 'main'
  }

  nodes.unshift(mainNode)

  const subValues = [...subMap.values()]
  let no = 0
  for (const sub of subValues) {
    no++
    sub.subagentNo = no
  }

  if (!Number.isFinite(globalStart)) globalStart = Date.now()
  if (globalEnd === 0) globalEnd = Date.now()

  const hasSubagents = subValues.length > 0
  const hasReviewer = reviewerNode !== null
  const sessionRunning = session?.state === 'running'

  const forks: ForkSessionInfo[] = []

  // 会话级归档：会话离开 running 后 worker 进程已不在，其派生的子代理与 reviewer
  // 都不可能存活
  if (session && session.state !== 'running') {
    archiveOrphanedSubagents(nodes, edges, globalEnd, archiveFallbackEnd)
    if (reviewerNode && reviewerNode.status === 'running') {
      reviewerNode.status = 'idle'
      // 非真实 let_exit，completed 只保留给该决策
      const fbEdge = feedbackEdgeOf(edges)
      if (fbEdge?.status === 'running') fbEdge.status = 'stopped'
    }
  }

  if (augment?.checkpoints?.length || augment?.forkSessions?.length) {
    augmentTopology(
      nodes, edges, subMap, forks,
      augment.checkpoints || [],
      augment.forkSessions || [],
      session?.id || '',
    )
  }

  if (!hasSubagents && !hasReviewer && !sessionRunning && forks.length === 0) return null

  return {
    nodes,
    edges,
    globalStartMs: globalStart,
    globalEndMs: globalEnd,
    totalSubagents: subValues.length,
    activeSubagents: subValues.filter((n) => n.status === 'running').length,
    completedSubagents: subValues.filter((n) => n.status === 'completed').length,
    failedSubagents: subValues.filter((n) => n.status === 'failed').length,
    stoppedSubagents: subValues.filter((n) => n.status === 'stopped').length,
    reviewerDecisions: reviewerDecisionCount,
    forks,
  }
}
