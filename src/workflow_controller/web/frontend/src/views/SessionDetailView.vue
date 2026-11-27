<!--
  Copyright (c) 2026 Workflow Controller Contributors

  Licensed under the MIT License (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://opensource.org/licenses/MIT

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, onActivated, onDeactivated, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput, NSelect, NCard, NTag, NBadge, NFlex, NEmpty, NAlert, NSpin, NTabs, NTabPane, NText, NModal, NTimeline, NTimelineItem, NPopover, NProgress } from 'naive-ui'
import { useSSE } from '../composables/useSSE'
import { useSessions } from '../composables/useSessions'
import { usePlugins } from '../composables/usePlugins'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import { deriveTopology } from '../composables/useTopology'
import CheckpointPanel from '../plugins/agent_traceback/CheckpointPanel.vue'
import FileProvenanceView from './FileProvenanceView.vue'
import type { SessionInfo, ClaudeEvent } from '../types/api'
import type { RunRecord } from '../types/runs'
import type { CheckpointInfo } from '../plugins/agent_traceback/types'
import { birthTracebackOf } from '../plugins/agent_traceback/types'
import VirtualLog from '../components/common/VirtualLog.vue'
import AgentTopologyGraph from '../components/common/AgentTopologyGraph.vue'
import WatchdogAlerts from '../components/common/WatchdogAlerts.vue'
import {
  fmtExpandedSubagentBlock,
  fmtCollapsedSubagentBlock,
  fmtThinkingBlock,
} from '../utils/subagentLines'
import { waitingInputKind } from '../utils/waitingInput'

// 长文本行数护栏：assistant 回复超过该行数时不全部内联渲染（见 fmtEventLines）。
const MAX_ASSISTANT_LINES = 200
// 单行字符护栏：超长单行（长 JSON/URL 等）在固定行高的虚拟滚动路径会被横向
// 裁剪且无查看入口，截断为预览行并挂 modal 全文。
const MAX_ASSISTANT_LINE_CHARS = 200

defineOptions({ name: 'SessionDetailView' })

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { confirmAction } = useConfirm()
const { sessions, eventsBySession, connected, pipeline, runStateEventCount } = useSSE()
const { pause, resume, handoff, sendMessage, getSubagentHints, registerSubagentHint, clearSubagentHint, listSubagentAgents, getSessionInstructions, registerSessionInstruction, clearSessionInstruction } = useSessions()
const { loadPlugins, pluginLoaded } = usePlugins()

const sessionId = computed(() => route.params.id as string)
const localSession = ref<SessionInfo | null>(null)
const sessionLoading = ref(true)
const sseSession = computed(() => sessions.value.find(s => s.id === sessionId.value))
const session = computed(() => sseSession.value || localSession.value || undefined)
/** 优先读取新版原生会话 ID，并兼容旧字段数据。 */
const nativeSessionId = computed(() => session.value?.native_session_id ?? session.value?.sdk_session_id ?? null)

async function fetchLocalSession() {
  const id = sessionId.value
  if (!id) return
  sessionLoading.value = true
  try {
    const r = await fetch(`/api/v1/sessions/${id}`)
    const data = r.ok ? await r.json() : null
    if (sessionId.value === id) localSession.value = data?.id === id ? data : null
  } catch {
    if (sessionId.value === id) localSession.value = null
  } finally {
    if (sessionId.value === id) sessionLoading.value = false
  }
}

watch(sessionId, () => { localSession.value = null; sessionLoading.value = true; fetchLocalSession() }, { immediate: true })

// 删除当前正在查看的会话（入口在侧栏会话行）：session 从有变 null 后路由仍指向
// 该会话，视图会落入「会话未找到」空态，这里补 watcher 自动回首页。
// 用 prev 的会话 id 与当前 route 比对，避免「切换到另一个会话」的瞬时空窗误触发。
watch(session, (now, prev) => {
  if (!now && prev && route.name === 'sessionDetail' && String(prev.id) === sessionId.value) {
    router.replace('/')
  }
})

// agent_traceback UI is plugin-owned; rendered only when the plugin is loaded.
const tracebackLoaded = computed(() => pluginLoaded('agent_traceback'))
const provenanceLoaded = computed(() => pluginLoaded('file_provenance'))
const maxIterations = ref(10)
watch(() => session.value?.max_iterations, (v) => { if (typeof v === 'number') maxIterations.value = v }, { immediate: true })

const replyMode = ref('auto')
watch(() => session.value?.reviewer_mode, mode => {
  if (mode) replyMode.value = mode
}, { immediate: true })
const waitingForAutoReplyFallback = computed(() => session.value?.waiting_for_auto_reply_fallback === true)
const manualPrompt = ref('')
const sidebarCollapsed = ref(false)
const SIDEBAR_WIDTH_STORAGE_KEY = 'workflow-controller-session-sidebar-width'
const SIDEBAR_DEFAULT_WIDTH = 340
const SIDEBAR_MIN_WIDTH = 260
const SIDEBAR_MAX_WIDTH = 600
const SIDEBAR_RESIZER_WIDTH = 16
const OUTPUT_MIN_WIDTH = 240

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  try {
    const width = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    return Number.isFinite(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH
      ? width
      : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

const panelsContainer = ref<HTMLElement | null>(null)
const preferredSidebarWidth = ref(loadSidebarWidth())
const availableSidebarMax = ref(SIDEBAR_MAX_WIDTH)
const sidebarWidth = computed(() => Math.min(
  Math.max(preferredSidebarWidth.value, SIDEBAR_MIN_WIDTH),
  availableSidebarMax.value,
))
const isResizingSidebar = ref(false)
let panelsResizeObserver: ResizeObserver | null = null
let sidebarResizeStartX = 0
let sidebarResizeStartWidth = SIDEBAR_DEFAULT_WIDTH
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function updateSidebarBounds() {
  const containerWidth = panelsContainer.value?.clientWidth ?? 0
  availableSidebarMax.value = containerWidth > 0
    ? Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, containerWidth - SIDEBAR_RESIZER_WIDTH - OUTPUT_MIN_WIDTH),
      )
    : SIDEBAR_MAX_WIDTH
}

function persistSidebarWidth() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(preferredSidebarWidth.value)))
  } catch {}
}

function setSidebarWidth(width: number, persist = false) {
  preferredSidebarWidth.value = Math.min(
    Math.max(width, SIDEBAR_MIN_WIDTH),
    availableSidebarMax.value,
  )
  if (persist) persistSidebarWidth()
}

function startSidebarResize(event: PointerEvent) {
  if ((event.pointerType === 'mouse' && event.button !== 0) || isResizingSidebar.value) return
  isResizingSidebar.value = true
  sidebarResizeStartX = event.clientX
  sidebarResizeStartWidth = sidebarWidth.value
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  event.preventDefault()
}

function moveSidebarResize(event: PointerEvent) {
  if (!isResizingSidebar.value) return
  // 手柄在右侧 Overview 面板左缘：向右拖减小该面板宽度，向左拖扩大。
  setSidebarWidth(sidebarResizeStartWidth - (event.clientX - sidebarResizeStartX))
  event.preventDefault()
}

function finishSidebarResize() {
  if (!isResizingSidebar.value) return
  isResizingSidebar.value = false
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  persistSidebarWidth()
}

function resizeSidebarWithKeyboard(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  // 键盘方向按 separator 键盘约定作用于 aria-valuenow（面板宽度）：→ 增大、← 减小，
  // 与鼠标拖拽的物理方向（手柄右移 = 面板变窄）相反。
  const direction = event.key === 'ArrowRight' ? 1 : -1
  setSidebarWidth(sidebarWidth.value + direction * (event.shiftKey ? 50 : 10), true)
  event.preventDefault()
}

watch(panelsContainer, (element, previousElement) => {
  if (previousElement) panelsResizeObserver?.unobserve(previousElement)
  if (!element || typeof ResizeObserver === 'undefined') return
  if (!panelsResizeObserver) panelsResizeObserver = new ResizeObserver(updateSidebarBounds)
  panelsResizeObserver.observe(element)
  updateSidebarBounds()
}, { flush: 'post' })

const hintType = ref('')
const hintText = ref('')
const registeredHints = ref<Record<string, string[]>>({})
const availableAgents = ref<string[]>([])
const registeredInstructions = ref<string[]>([])
// 思考块渲染：硬编码全量（每行展开），历史的 workflow_controller_showThinking 开关已移除，不再可配置。
const expandedSubagents = ref<Set<string>>(new Set())
const modalContent = ref('')  // 长文本弹窗内容（user_message 等）
const modalContentShow = computed({
  get: () => modalContent.value !== '',
  set: (v: boolean) => { if (!v) modalContent.value = '' },
})
const breatherThreshold = ref(70)
const breatherSubagentThreshold = ref<number | null>(null)
const breatherContextWindow = ref<number | null>(null)
const mainThreshold = computed(() => session.value?.context_threshold_pct ?? breatherThreshold.value)
const subagentThreshold = computed(() => session.value?.subagent_context_threshold_pct ?? breatherSubagentThreshold.value ?? mainThreshold.value)
const breatherEnabled = ref(false)
const pipelineEnabled = ref(false)
// 侧栏 segment tabs 的 tab 集随插件启停变化；用 key 在变化时重建 NTabs 以重算指示条宽度。
const activeSidebarTab = ref('overview')
const sidebarTabsKey = computed(() => [
  'overview',
  breatherEnabled.value ? 'chain' : '',
  'config',
  tracebackLoaded.value ? 'checkpoints' : '',
  provenanceLoaded.value ? 'provenance' : '',
  pipelineEnabled.value ? 'pipeline' : '',
].join('|'))
const provenanceExpanded = computed(() =>
  provenanceLoaded.value
  && activeSidebarTab.value === 'provenance'
  && !sidebarCollapsed.value,
)
const breatherForcePending = ref(false)
const breatherStopArmed = ref(false)
const breatherPendingSessionId = ref<string | null>(null)
const reviewerEnabled = ref(true)
// 会话自带 reviewer 开关（SessionInfo.reviewer_enabled）优先：表单/重放可
// 按会话关闭 reviewer，输入门控与「回复: 自动/手动」按钮随之按会话区分，
// 无会话读数（旧后端/未加载）时回落全局配置。
const sessionReviewerEnabled = computed(
  () => session.value?.reviewer_enabled ?? reviewerEnabled.value,
)
const reviewerTaskGoal = computed(() => session.value?.reviewer_task_goal?.trim() || '')
const showReviewerTaskGoal = ref(false)
let breatherPollTimer: ReturnType<typeof setInterval> | null = null

const handoffError = ref<string | null>(null)

// Checkpoint topology data fed up by the agent_traceback CheckpointPanel (fork
// edges + replayable markers). The panel owns all checkpoint UI/state; the core
// view only consumes this for the (generic) topology 拓扑图增强.
const topoCheckpoints = ref<CheckpointInfo[]>([])
const topoForkSessions = ref<SessionInfo[]>([])

// ── run 归属（workflow 成员的操作路由与恢复预判）─────────────────
// 所属 run 行：kind 决定成员操作走 run 面（单一写者）还是直通 session 面；
// status 供恢复按钮的拒绝原因预判。kind 不可变，按 run_id 缓存避免 250ms 快照重拉
const runRowByRunId = ref<Record<string, RunRecord>>({})
// 404 的 run 视为已删：无 run 面可指路，直通 session 面（与后端守卫同判）
const absentRunIds = ref<Record<string, boolean>>({})
const memberRunId = computed(() => session.value?.run_id ?? null)
const memberRun = computed(() =>
  memberRunId.value ? runRowByRunId.value[memberRunId.value] ?? null : null)
// kind 未知窗口（有 run_id、行未拉到且非 404）：workflow 成员误投 session 面
// 必被守卫 409，盲投 run 面又违背无驱动成员直通——门禁成员操作直到 kind 确定
const memberRunPending = computed(() =>
  !!memberRunId.value && !memberRun.value && !absentRunIds.value[memberRunId.value])
const isWorkflowMember = computed(() => memberRun.value?.kind === 'workflow')
// 成员操作路由：workflow 成员经 run 面（有 run_id 才路由），其余直通 session 面
const memberRunRouteId = computed(() => isWorkflowMember.value ? memberRunId.value : null)

let memberRunRetryTimer: ReturnType<typeof setTimeout> | null = null
let memberRunRetryDelayMs = 300

function clearMemberRunRetry() {
  if (memberRunRetryTimer) { clearTimeout(memberRunRetryTimer); memberRunRetryTimer = null }
}

async function fetchMemberRun(runId: string) {
  clearMemberRunRetry()
  try {
    const r = await fetch(`/api/v1/runs/${runId}`)
    if (r.status === 404) {
      absentRunIds.value = { ...absentRunIds.value, [runId]: true }
      memberRunRetryDelayMs = 300
      return
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    if (!d?.run || d.run.run_id !== runId) throw new Error('unexpected payload')
    runRowByRunId.value = { ...runRowByRunId.value, [runId]: d.run }
    memberRunRetryDelayMs = 300
  } catch {
    // 瞬时失败不是终态：不门禁到永远——退避重试（300ms 起倍增、封顶 5s），
    // 成功或 404 即停；成员已切换则放弃（watch 会另起新拉取）
    if (memberRunId.value !== runId) { memberRunRetryDelayMs = 300; return }
    memberRunRetryTimer = setTimeout(() => {
      memberRunRetryTimer = null
      void fetchMemberRun(runId)
    }, memberRunRetryDelayMs)
    memberRunRetryDelayMs = Math.min(memberRunRetryDelayMs * 2, 5000)
  }
}

watch(memberRunId, (runId) => {
  memberRunRetryDelayMs = 300
  clearMemberRunRetry()
  if (runId) void fetchMemberRun(runId)
}, { immediate: true })
// run 状态类事件驱动重拉（恢复/停止后拒绝原因即时刷新）
watch(() => memberRunId.value ? runStateEventCount.value[memberRunId.value] : 0, () => {
  if (memberRunId.value) void fetchMemberRun(memberRunId.value)
})

// Run 徽章状态色（与 RunView/Dashboard 同款词表）
const runStatusColor: Record<string, string> = {
  pending: '#999999', running: '#f0a020', paused: '#0891b2',
  completed: '#52c41a', failed: '#f5222d', stopped: '#bfbfbf',
}

async function loadConfig() {
  try {
    const r = await fetch('/api/v1/config')
    const c = await r.json()
    replyMode.value = session.value?.reviewer_mode || c.reviewer?.mode || 'auto'
    reviewerEnabled.value = c.reviewer?.enabled !== false
  } catch {}
  try {
    const r = await fetch('/api/v1/plugins/staged_pipeline/config')
    if (r.ok) {
      const d = await r.json()
      pipelineEnabled.value = d.enabled === true
    }
  } catch {}
}

async function loadHistoryEvents() {
  if (!sessionId.value) return
  try {
    const r = await fetch(`/api/v1/events?session_id=${sessionId.value}&since=0`)
    if (!r.ok) { historyEvents.value = []; return }
    const d = await r.json()
    historyEvents.value = d.events || []
  } catch {
    historyEvents.value = []
  }
}

async function pollBreatherState() {
  try {
    const r = await fetch('/api/v1/plugins/breather/config')
    if (r.ok) {
      const d = await r.json()
      breatherEnabled.value = d.enabled === true
      if (d.fields?.context_threshold_pct) breatherThreshold.value = Number(d.fields.context_threshold_pct)
      const child = d.fields?.subagent_context_threshold_pct
      breatherSubagentThreshold.value = child == null ? null : Number(child)
      if (d.fields?.context_window) breatherContextWindow.value = Number(d.fields.context_window)
    }
  } catch {}
  if (!breatherEnabled.value) {
    breatherForcePending.value = false
    breatherStopArmed.value = false
    breatherPendingSessionId.value = null
    return
  }
  try {
    const r = await fetch(`/api/breather/state?session_id=${encodeURIComponent(sessionId.value)}`)
    if (r.ok) {
      const d = await r.json()
      breatherForcePending.value = d.force_pending === true
      breatherStopArmed.value = d.stop_armed === true
      breatherPendingSessionId.value = d.pending_session_id || null
    }
  } catch {}
}

function startPolling() {
  if (!breatherPollTimer) {
    pollBreatherState()
    breatherPollTimer = setInterval(pollBreatherState, 2000)
  }
}

function stopPolling() {
  if (breatherPollTimer) {
    clearInterval(breatherPollTimer)
    breatherPollTimer = null
  }
}

onMounted(async () => {
  await loadConfig()
  await loadPlugins()
  startPolling()
})

// historyEvents/hints 由下方 watch(immediate) 首挂载触发，onActivated 覆盖再激活
watch(sessionId, async () => {
  await loadHistoryEvents()
  await loadHints()
}, { immediate: true })

onActivated(async () => {
  await loadHistoryEvents()
  await loadHints()
  startPolling()
})

onDeactivated(() => {
  stopPolling()
  finishSidebarResize()
  clearMemberRunRetry()
})
onUnmounted(() => {
  stopPolling()
  finishSidebarResize()
  clearMemberRunRetry()
  panelsResizeObserver?.disconnect()
  panelsResizeObserver = null
})

const historyEvents = ref<ClaudeEvent[]>([])

const sessionEvents = computed(() => {
  const sse = eventsBySession.value[sessionId.value] || []
  const hist = historyEvents.value.filter(e => e.session_id === sessionId.value)
  // 去重键须含 data.agent_id：并行派发的多个 subagent_start/stop 可共享同一
  // 时间戳（InteractionBridge 的 dispatchTimestamp 相同），仅 ts+type 会把
  // 兄弟子代理事件错误去重，拓扑图整节点丢失
  const keyOf = (e: ClaudeEvent) => {
    const aid = (e.data as Record<string, unknown> | null)?.agent_id
    return `${e.timestamp}:${e.event_type}:${typeof aid === 'string' ? aid : ''}`
  }
  const seen = new Set<string>()
  const dedupedSse = sse.filter(e => {
    const k = keyOf(e)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return [...dedupedSse, ...hist.filter(e => !seen.has(keyOf(e)))]
})

// watchdog 告警徽标计数（弹层用 popover，fault.* 告警事件从 sessionEvents 实时过滤）
const watchdogAlertCount = computed(() =>
  sessionEvents.value.filter(e => e.event_type.startsWith('fault.')).length
)
const watchdogHasAlerts = computed(() => watchdogAlertCount.value > 0)

// Subagent start count — fed to CheckpointPanel so it can reload checkpoints when
// a new checkpoint is created mid-run (checkpoints are saved at subagent start).
const subagentStartCount = computed(() =>
  sessionEvents.value.filter(
    (e) => e.event_type === 'subagent_start',
  ).length,
)

// ── 问题等待提示 ──────────────────────────────────────────────────
const bannerKind = computed(() => waitingInputKind(sessionEvents.value))

const showWaitingBanner = computed(() => waitingForAutoReplyFallback.value || bannerKind.value !== null)

// ── Pipeline (per-session) ──
const sessionPipeline = computed(() => {
  if (!sessionId.value || !pipeline.value) return null
  return pipeline.value[sessionId.value] || null
})
const pipePct = computed(() => Math.round((sessionPipeline.value?.total_progress || 0) * 100))
const pipeDetail = computed(() => sessionPipeline.value?.detail || '')
const stageNames = computed(() => (sessionPipeline.value?.stages || []).map((s: any) => s.name))
// 阶段 timeline item：done→success、active→info、pending→default
const stageTimeline = computed(() => {
  const stages = sessionPipeline.value?.stages || []
  return stages.map((s: any) => ({
    title: s.name,
    content: s.completed ? '已完成' : (s.active ? '进行中' : '待开始'),
    type: s.completed ? 'success' : (s.active ? 'info' : 'default'),
  } as { title: string; content: string; type: 'success' | 'info' | 'default' | 'error' | 'warning' }))
})

interface TypedLine { text: string; cls: string; expandId?: string; html?: string; modal?: string; block?: { title: string; command: string; result: string; expanded: boolean; failed?: boolean } }

// 时间展示为浏览器本地时区的完整日期与分钟：YYYY-MM-DD HH:mm。
function formatLogTimestamp(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const workerOutput = computed((): TypedLine[] => {
  const sorted = [...sessionEvents.value].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
  const src = sorted.slice(-500)

  const saMsgs = new Map<string, any[]>()
  const saMeta = new Map<string, { type: string; tokens: number; content: string }>()
  const saLastIdx = new Map<string, number>()
  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    if (e.event_type !== 'subagent_start' && e.event_type !== 'subagent_progress' && e.event_type !== 'subagent_stop') continue
    const sd = e.data as any
    const id = sd.agent_id || ''
    if (!id) continue
    if (e.event_type === 'subagent_start') {
      if (!saMsgs.has(id)) saMsgs.set(id, [])
      if (!saMeta.has(id)) saMeta.set(id, { type: sd.agent_type || 'subagent', tokens: 0, content: '' })
    } else if (e.event_type === 'subagent_progress') {
      if (!saMsgs.has(id)) saMsgs.set(id, [])
      if (!saMeta.has(id)) saMeta.set(id, { type: sd.agent_type || 'subagent', tokens: 0, content: '' })
      saMsgs.get(id)!.push(...(sd.messages || []))
      saLastIdx.set(id, i)
    } else if (e.event_type === 'subagent_stop') {
      // stop 带非空 messages 时以其为准（权威全量）；为空或缺失时保留
      // progress 累积——envelope 缺失 / db 读空等降级路径不清空折叠块。
      const stopMessages = sd.messages || []
      if (stopMessages.length > 0 || !saMsgs.has(id)) saMsgs.set(id, stopMessages)
      saMeta.set(id, { type: sd.agent_type || 'subagent', tokens: Number(sd.total_tokens) || 0, content: sd.content || '' })
      saLastIdx.set(id, i)
    }
  }

  const out: TypedLine[] = []
  let lastIter = -1

  // ── 工具结果配对（两趟预计算，主循环只消费结论）──
  // 优先按 tool_use_id 精确配对（driver 在 tool_call 里带 tool_use_id）；
  // 历史会话中缺 id 的是旧 tool_call（tool_result 一直带 tool_use_id），此时回退按
  // tool_name 认领尚未被认领的结果（登记顺序先到先得），再退回同名工具 FIFO 队列。
  // 结果可能先于调用（SDK/CLI/hook 在 assistant 消息里先发 TOOL_RESULT 再发
  // TOOL_CALL），也可能后于调用（user_message 内嵌块），因此渲染前用两趟扫描确定
  // 配对，避免并行/批量调用时结果错配。
  const resultByUseId = new Map<string, { content: string; isError: boolean; srcIdx: number | null; srcMsgIdx: number; claimed: boolean; name: string }>()
  const pendingResultsByName = new Map<string, Array<{ content: string; isError: boolean; srcIdx: number }>>()
  const consumedStandaloneIdx = new Set<number>()
  const callResultByIdx = new Map<number, { content: string; isError: boolean }>()

  // 第一趟：登记独立 tool_result 事件与 user_message 内嵌 tool_result 块。
  // 同一 uid 同时有独立事件和嵌入块时，保留独立事件（与先后顺序无关）：
  // 只有它带可被认领消费的事件下标，由它负责该 uid 的展示，避免渲染两次。
  // 同型重复也只保留首个：后续同 uid 独立事件直接记入抑制集合（首个无论
  // 是否被认领都由它展示）；嵌入块记 srcMsgIdx，渲染时据此区分登记来源
  // 消息，多条消息内嵌同 uid 同样只渲染一次。
  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    if (e.event_type === 'tool_result') {
      const d = e.data || {}
      const uid = String((d as any).tool_use_id || '')
      const content = toolResultText(d)
      const isError = Boolean((d as any).is_error)
      if (uid) {
        const prev = resultByUseId.get(uid)
        if (!prev || prev.srcIdx === null) {
          resultByUseId.set(uid, { content, isError, srcIdx: i, srcMsgIdx: -1, claimed: false, name: String((d as any).tool_name || '') })
        } else {
          consumedStandaloneIdx.add(i)
        }
      } else {
        const key = String((d as any).tool_name || '_')
        const q = pendingResultsByName.get(key)
        if (q) q.push({ content, isError, srcIdx: i })
        else pendingResultsByName.set(key, [{ content, isError, srcIdx: i }])
      }
    } else if (e.event_type === 'user_message' && Array.isArray((e.data as any).content)) {
      for (const b of (e.data as any).content) {
        if (b && b.type === 'tool_result') {
          const uid = String(b.tool_use_id || '')
          if (uid && !resultByUseId.has(uid)) {
            resultByUseId.set(uid, {
              content: typeof b.content === 'string' ? b.content.trim() : '',
              isError: Boolean(b.is_error),
              srcIdx: null,
              srcMsgIdx: i,
              claimed: false,
              name: String(b.tool_name || ''),
            })
          }
        }
      }
    }
  }

  // 第二趟：为每个 tool_call 认领结果。分两阶段，避免混合新旧事件的会话中同一
  // 结果被两个工具块重复认领：
  //   阶段 A —— 带 tool_use_id 的调用先全部精确匹配，并跳过已认领条目。这样后到的
  //     无 id 旧 call 的按名回退不会抢先认领属于新调用的结果。
  //   阶段 B —— 无 id 的历史旧 call 按 tool_name 认领未 claim 的结果（登记顺序=
  //     时间线，先到先得），最后回退同名 FIFO。带 uid 的调用只等待自己的结果，
  //     不落入按名回退。
  for (let i = 0; i < src.length; i++) {
    if (src[i].event_type !== 'tool_call') continue
    const d = src[i].data || {}
    const uid = String((d as any).tool_use_id || '')
    if (!uid) continue
    const r = resultByUseId.get(uid)
    if (!r || r.claimed) continue
    r.claimed = true
    if (r.srcIdx !== null) consumedStandaloneIdx.add(r.srcIdx)
    callResultByIdx.set(i, { content: r.content, isError: r.isError })
  }
  for (let i = 0; i < src.length; i++) {
    if (src[i].event_type !== 'tool_call') continue
    const d = src[i].data || {}
    const uid = String((d as any).tool_use_id || '')
    if (uid) continue
    const name = String((d as any).name || '?')
    let claimed: { content: string; isError: boolean; srcIdx: number | null } | undefined
    for (const r of resultByUseId.values()) {
      if (!r.claimed && r.name === name) {
        claimed = r
        r.claimed = true
        break
      }
    }
    if (claimed) {
      if (claimed.srcIdx !== null) consumedStandaloneIdx.add(claimed.srcIdx)
      callResultByIdx.set(i, { content: claimed.content, isError: claimed.isError })
      continue
    }
    const q = pendingResultsByName.get(name)
    const r = q && q.length > 0 ? q.shift() : undefined
    if (r) {
      consumedStandaloneIdx.add(r.srcIdx)
      callResultByIdx.set(i, { content: r.content, isError: r.isError })
    }
  }

  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    const t = e.event_type
    const d = e.data || {}
    const ts = formatLogTimestamp(e.timestamp || '')
    const iter = e.iteration || 0

    // 已被对应工具块消费、或同 uid 首个独立事件已登记的同型重复：不再单独渲染。
    if (t === 'tool_result' && consumedStandaloneIdx.has(i)) continue

    if (t.startsWith('log_') && t !== 'log_manual' && t !== 'log_eval' && !(d as any).hook) continue

    if (iter > 0 && iter !== lastIter) {
      if (out.length) out.push({ text: '', cls: 'cls-separator' })
      out.push({ text: `━━ Iteration ${iter}/${maxIterations.value || '?'} ━━`, cls: 'cls-iter' })
      lastIter = iter
    }

    if ((d as any).hook) {
      for (const ln of fmtHookLines(d, ts)) out.push(ln)
      continue
    }

    if (t === 'subagent_start' || t === 'subagent_progress' || t === 'subagent_stop') {
      for (const ln of fmtSubagentLines(e, ts, i, saMsgs, saMeta, saLastIdx)) out.push(ln)
      continue
    }

    if (t === 'tool_result') {
      // 孤立 tool_result：没有匹配的 tool_call（调用滑出窗口等），照常渲染，
      // 避免结果从日志中整条消失。
      const content = toolResultText(d)
      const failed = Boolean((d as any).is_error)
      if (content) pushResultPreviewLines(out, ts, content, failed)
      continue
    }

    if (t === 'tool_call') {
      const name = String((d as any).name || '?')
      const command = String((d as any).arg || '')
      const matched = callResultByIdx.get(i)
      const failed = Boolean((d as any).is_error) || Boolean(matched?.isError)
      // 失败原因补取：hook server 等场景错误文本只在 error/tool_error 字段，
      // toolResultText 的 content/tool_response/tool_output 链取不到时会落空。
      const resultText = matched?.content || String((d as any).error || '')
      // 展开 ID 基于事件时间戳（+名称/参数），不随 500 事件滑动窗口下标平移，
      // 事件流增长时已展开的工具块不会自发折叠。
      const expandId = toolExpandId(e, name, command)
      const expanded = expandedSubagents.value.has(expandId)
      out.push({
        text: '',
        cls: 'tool-block-line',
        expandId,
        block: { title: `[${ts}] ${name}`, command, ...toolResultBlock(resultText), expanded, failed },
      })
      continue
    }

    if (t === 'user_message') {
      const content = d.content
      // 内嵌 tool_result 块：该 uid 已有独立事件登记（由独立事件负责展示，
      // 无论其是否被认领）、已被工具块认领、或登记来源是其他消息的同型
      // 重复块时跳过；仅当本块是该 uid 的唯一表示且未被认领时渲染，避免
      // 同一结果出现两份。
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            const uid = String(b.tool_use_id || '')
            const r = uid ? resultByUseId.get(uid) : undefined
            if (!r || (r.srcIdx === null && r.srcMsgIdx === i && !r.claimed)) {
              const c = typeof b.content === 'string' ? b.content.trim() : ''
              if (c) pushResultPreviewLines(out, ts, c, Boolean(b.is_error))
            }
          }
        }
      }
      for (const ln of fmtEventLines(e, ts)) out.push(ln)
      continue
    }

    for (const ln of fmtEventLines(e, ts)) out.push(ln)
  }
  return out
})

// 独立 tool_result 事件的文本提取：兼容 SDK/CLI 的 content、
// hook 服务器的 tool_response / tool_output 等形状。
// 失败路径补取 tool_error/error：hook server 的 post-tool-use-failure 场景
// 错误文本常只在 tool_error 字段，content 链取不到时不能落空。
function toolResultText(d: any): string {
  const pick = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      return value.map((item: any) => {
        if (typeof item === 'string') return item
        const t = item?.text ?? item?.content ?? item?.value
        return typeof t === 'string' ? t : ''
      }).join('\n')
    }
    if (value && typeof value === 'object') {
      const t = (value as any).content ?? (value as any).text ?? (value as any).message
      if (typeof t === 'string') return t
      if (Array.isArray(t)) return pick(t)
    }
    return ''
  }
  // 按提取结果非空逐来源回退：?? 链会在 content 为空串/空对象时提前停住，
  // 失败结果的错误文本滞留在 tool_error/error 字段取不到。
  for (const raw of [d?.content, d?.tool_response, d?.tool_output, d?.tool_error, d?.error]) {
    const text = pick(raw).trim()
    if (text) return text
  }
  return ''
}

// 工具块结果长度护栏：Read 大文件 / bash 长输出可能几百 KB，展开即把全文一次性
// 渲染进非虚拟化 flow 容器。超过阈值时块内只放截断预览，全文挂到 fullText 供
// 「查看全文」弹窗读取，避免长会话卡顿。
const MAX_TOOL_RESULT_CHARS = 20000
function toolResultBlock(resultText: string): { result: string; fullText?: string } {
  if (resultText.length <= MAX_TOOL_RESULT_CHARS) return { result: resultText }
  return { result: resultText.slice(0, MAX_TOOL_RESULT_CHARS), fullText: resultText }
}

// 孤立/内嵌 tool_result 预览行：单行超长（minified JSON、超长 base64 等）截断为
// 预览，不整行进入非虚拟化的 flow 渲染路径。整体超过工具块同阈值时先截断再
// 切行——workerOutput 每个 SSE 批次重算，全文 split 超长输出会反复产生整份
// 行数组；modal 仍持有完整内容引用（原文始终存活于事件数据中），弹窗可看全文。
const MAX_RESULT_LINE_CHARS = 200
function pushResultPreviewLines(out: TypedLine[], ts: string, content: string, failed: boolean): void {
  const cls = failed ? 'cls-error' : 'cls-result'
  const head = content.length > MAX_TOOL_RESULT_CHARS ? content.slice(0, MAX_TOOL_RESULT_CHARS) : content
  out.push({ text: `[${ts}] ${failed ? '✗ error' : '← result'}`, cls })
  for (const l of head.split('\n').slice(0, 5)) {
    out.push({
      text: l.length > MAX_RESULT_LINE_CHARS ? `  │ ${l.slice(0, MAX_RESULT_LINE_CHARS)} …` : `  │ ${l}`,
      cls,
      modal: content,
    })
  }
}

// 工具块稳定展开 ID：基于事件时间戳，避免滑动窗口下标引起的折叠态漂移。
function toolExpandId(e: ClaudeEvent, name: string, command: string): string {
  return `tool:${e.timestamp || '?'}:${name}:${command.slice(0, 24)}`
}

// assistant 正文单行输出：超长单行截断为预览并挂 modal，固定行高路径不裁剪丢内容。
function pushAssistantBodyLine(lines: TypedLine[], l: string): void {
  if (l.length > MAX_ASSISTANT_LINE_CHARS) {
    lines.push({ text: `${l.slice(0, MAX_ASSISTANT_LINE_CHARS)} …`, cls: 'cls-user', modal: l })
  } else {
    lines.push({ text: l, cls: 'cls-user' })
  }
}

function fmtEventLines(e: ClaudeEvent, ts: string): TypedLine[] {
  const d = e.data || {}
  const t = e.event_type
  const lines: TypedLine[] = []
  switch (t) {
    case 'log_manual': {
      const prompt = (d as any).prompt || ''
      if (prompt) lines.push({ text: `[${ts}] 👤 ${prompt}`, cls: 'cls-user' })
      break
    }
    case 'assistant_message': {
      const blocks = (d.content || []) as any[]
      for (const b of blocks) {
        if (b.type === 'text') {
          const text = (b.text || '').trim()
          if (!text) continue
          lines.push({ text: `[${ts}] Assistant Message:`, cls: 'cls-user' })
          // 长文本行数护栏：assistant 回复可能几千行，配合非虚拟化 vlog-flow 会挂载
          // 数千 DOM 行。只内联前 MAX_ASSISTANT_LINES 行，剩余以「… 全文」行收起，
          // 点击弹窗看全文，完整内容不丢失。
          const bodyLines = text.split('\n')
          if (bodyLines.length > MAX_ASSISTANT_LINES) {
            for (const l of bodyLines.slice(0, MAX_ASSISTANT_LINES)) pushAssistantBodyLine(lines, l)
            lines.push({ text: `… 共 ${bodyLines.length} 行，点击查看全文`, cls: 'cls-user', modal: text })
          } else {
            for (const l of bodyLines) pushAssistantBodyLine(lines, l)
          }
        } else if (b.type === 'thinking') {
          const text = (b.thinking || '').trim()
          if (!text) continue
          // 展开 ID 追加事件唯一键：rowid 只在历史事件（/api/v1/events 下发）上存在，
          // 实时 SSE 事件不带 rowid，此时回退到完整 e.timestamp（微秒精度）而不是
          // 分钟精度的展示 ts，同一分钟内前缀相同的思考块不再联动。
          const expandId = `thinking:${e.rowid || e.timestamp || ts}:${text.slice(0, 24)}`
          for (const line of fmtThinkingBlock(text, expandId, expandedSubagents.value, `[${ts}] `)) lines.push(line)
        }
        // tool_use / tool_result blocks → 由独立的 tool_call 事件渲染，此处跳过
      }
      break
    }
    case 'step_finish':
    case 'result': {
      // Phase B: slimmed RESULT (no usage) is suppressed — avoid duplicate
      // rows next to STEP_FINISH; only render events with usage data
      // (historical RESULT or new STEP_FINISH). See docs/result-event-analysis.md §10.
      const u = (d.usage) as any
      if (!u || Object.keys(u).length === 0) break
      lines.push({ text: `[${ts}] ${d.is_error ? '✕ 失败' : '✓ 完成'} (${Number(d.num_turns) || 0} turns, input ${u?.input_tokens || 0} / output ${u?.output_tokens || 0})`, cls: 'cls-result' })
      lines.push({ text: '', cls: '' })
      break
    }
    case 'error': {
      const errObj = (d as any).error
      // message 字段可能是对象/数字等非字符串，测量长度前先归一化
      const rawMsg = typeof errObj === 'string'
        ? errObj
        : (errObj?.data?.message || errObj?.message)
      const errMsg = typeof rawMsg === 'string' && rawMsg
        ? rawMsg
        : JSON.stringify(errObj || d).slice(0, 200)
      const isLong = errMsg.length > 80 || errMsg.includes('\n')
      if (isLong) {
        const preview = errMsg.split('\n')[0].slice(0, 80)
        lines.push({ text: `[${ts}] 错误: ${preview} …`, cls: 'cls-error', modal: errMsg })
      } else {
        lines.push({ text: `[${ts}] 错误: ${errMsg}`, cls: 'cls-error' })
      }
      break
    }
    case 'user_message': {
      const content = d.content
      // 长文本（多行或超 80 字符）只显示首行预览 + 省略号，点击弹窗看全文。
      // VirtualLog 行高固定 20px + 不换行，长 prompt 直接塞一行会被截断。
      const pushUserText = (raw: string) => {
        const text = raw.trim()
        if (!text) return
        const firstLine = text.split('\n')[0]
        const isLong = text.length > 80 || text.includes('\n')
        if (isLong) {
          const preview = firstLine.length > 80 ? firstLine.slice(0, 80) : firstLine
          lines.push({ text: `[${ts}] User Message: ${preview} …`, cls: 'cls-user', modal: text })
        } else {
          lines.push({ text: `[${ts}] User Message: ${text}`, cls: 'cls-user' })
        }
      }
      if (typeof content === 'string') {
        pushUserText(content)
      } else if (Array.isArray(content)) {
        // tool_result 内嵌块由主循环按配对状态处理（已认领时在工具块内展示，
        // 孤立时以 result 行渲染），这里只渲染文本块。
        for (const b of content) {
          if (b?.type === 'text') pushUserText(b.text || '')
        }
      }
      break
    }
    case 'system_message':
    case 'notification':
    case 'iteration_start': {
      // 三种 wire format 共享同一渲染：旧 row 仍是 'system_message'（init 子类型），
      // 新 row 'iteration_start'（init 子类型，已从 notification 桶拆出），
      // 新 row 'notification'（纯 notification，仅 api_retry 等罕见子类型）。
      // init 渲染对三种都适用；api_retry 仅 notification 类（实际无 emitter，dead path）。
      const st = (d as any).subtype || ''
      if (st === 'init') {
        // model/cwd 都为空时（如 opencode）跳过，避免显示无意义的 `init: ? @ .`
        const m = (d as any).model || ''
        const c = (d as any).cwd || ''
        if (m || c) lines.push({ text: `[${ts}] init: ${m || '?'} @ ${c || '.'}`, cls: 'cls-system' })
      }
      else if (st === 'api_retry') lines.push({ text: `[${ts}] api_retry #${(d as any).attempt}: ${(d as any).error_status || ''}`, cls: 'cls-system' })
      break
    }
    case 'tool_use':
      break  // 由归一化的 tool_call 工具块展示，避免重复
    case 'log_eval': {
      const complete = (d as any).is_complete ? '✓ complete' : '✗ continue'
      const pct = Math.round(((d as any).progress || 0) * 100)
      const summary = ((d as any).summary || '').slice(0, 100)
      lines.push({ text: `[${ts}] ◆ [EVAL] ${complete} (${pct}%)${summary ? ' ' + summary : ''}`, cls: 'cls-hook-eval' })
      break
    }
    case 'subagent_context': {
      const agentType = (d as any).agent_type || 'subagent'
      const agentId = String((d as any).agent_id || '').slice(0, 12)
      const tokens = Number((d as any).current_tokens) || 0
      const window = Number((d as any).max_tokens) || 0
      const pct = Number((d as any).percentage) || 0
      lines.push({
        text: `[${ts}] 🤖 CONTEXT: ${agentType} (${agentId}) ${fmtN(tokens)} / ${fmtN(window)} (${pct}%)`,
        cls: 'cls-subagent',
      })
      break
    }
  }
  return lines
}

function fmtHookLines(d: any, ts: string): TypedLine[] {
  const tagMap: Record<string, string> = { stop_hook_llm: '审查', stop_hook_plugin: '门禁', pretool_hook_llm: 'AUQ', pretool_hook_deny_manual: 'AUQ' }
  const hook = tagMap[d.hook as string] || d.hook
  const decision = d.decision || d.answer || '?'
  const feedback = d.feedback ? ` → ${d.feedback}` : ''
  const rationale = d.rationale ? ` (${d.rationale})` : ''
  const isAuq = (d.hook as string)?.startsWith('pretool')
  const cls = isAuq ? 'cls-hook-auq' : 'cls-hook-stop'
  const lines: TypedLine[] = [{ text: `[${ts}] ◆ [${hook}] ${decision}${feedback}${rationale}`, cls }]
  const qs = d.questions as any[]
  if (qs?.length) {
    for (const q of qs) {
      const opts = (q.options || []).map((o: any) => o.label).join(', ')
      lines.push({ text: `  > ${q.header}: ${q.question}  [${opts}]`, cls })
    }
  }
  return lines
}

function fmtSubagentLines(
  e: ClaudeEvent, ts: string, idx: number,
  saMsgs: Map<string, any[]>,
  saMeta: Map<string, { type: string; tokens: number; content: string }>,
  saLastIdx: Map<string, number>,
): TypedLine[] {
  const d = e.data || {}
  const phase = e.event_type === 'subagent_start' ? 'start' : e.event_type === 'subagent_stop' ? 'stop' : 'progress'
  const fullAgentId = (d as any).agent_id || ''
  const agentId = fullAgentId.slice(0, 12)
  const meta = saMeta.get(fullAgentId) || { type: 'subagent', tokens: 0, content: '' }
  const agentType = meta.type || 'subagent'
  const tokens = meta.tokens
  const messages = saMsgs.get(fullAgentId) || []
  const lines: TypedLine[] = []

  if (phase === 'start') {
    lines.push({ text: `[${ts}] 🤖 START: ${agentType} (${agentId})`, cls: 'cls-subagent' })
    return lines
  }
  if (phase !== 'progress' && phase !== 'stop') {
    lines.push({ text: `[${ts}] 🤖 ${phase}: ${agentType}`, cls: 'cls-subagent' })
    return lines
  }
  if (saLastIdx.get(fullAgentId) !== idx) return lines

  const isStop = phase === 'stop'
  const content = meta.content.trim()
  lines.push({
    text: `[${ts}] 🤖 ${isStop ? 'DONE' : '…'}: ${agentType} (${agentId})${isStop && tokens ? `, ${tokens} tokens` : ''}`,
    cls: 'cls-subagent',
  })
  if (content && isStop) {
    // VirtualLog 固定行高且不换行；每段摘要分行预览，超限时用现有 modal 看全文。
    const rows = content.split('\n').filter((line) => line.trim() !== '')
    const clipped = rows.length > 5 || rows.some((line) => line.length > 120)
    for (const line of rows.slice(0, 5)) {
      const shown = line.length > 120 ? `${line.slice(0, 120)}…` : line
      lines.push({ text: `  │ ${shown}`, cls: 'cls-subagent' })
    }
    if (clipped) lines.push({ text: '  │ …（点击查看完整内容）', cls: 'cls-subagent', modal: content })
  }

  const expandId = messages.length > 0 ? `sa:${fullAgentId}` : ''
  const isExpanded = expandId && expandedSubagents.value.has(expandId)
  if (expandId) {
    if (isExpanded) {
      for (const ln of fmtExpandedSubagentBlock(messages, expandId, expandedSubagents.value)) lines.push(ln)
    } else {
      for (const ln of fmtCollapsedSubagentBlock(messages, expandId)) lines.push(ln)
    }
  }
  return lines
}

function toggleSubagentExpand(expandId: string) {
  const s = new Set(expandedSubagents.value)
  if (s.has(expandId)) s.delete(expandId)
  else s.add(expandId)
  expandedSubagents.value = s
}

// 长文本行点击 → 弹窗展示全文（VirtualLog 行高固定，长内容无法内联展开）
function openLogModal(content: string) {
  modalContent.value = content
}

const usageData = computed(() => {
  let turns = 0
  let totalTokens = 0
  let hasUsage = false
  for (const e of sessionEvents.value) {
    if (e.event_type !== 'step_finish' && e.event_type !== 'result') continue
    const d = e.data as any
    turns += Number(d.num_turns) || 0
    if (e.event_type !== 'step_finish') continue
    const usage = contextUsageOf({ usage: d.usage })
    if (usage && usage.tokens > 0) {
      totalTokens += usage.tokens
      hasUsage = true
    }
  }
  return { turns, totalTokens: hasUsage ? totalTokens : null }
})

type ContextPoint = { pct: number; over: boolean; tokens: number; window: number; input: number; output: number; cacheRead: number; cacheWrite: number }

function modelContextWindow(d: any): number {
  const modelUsage = d.modelUsage && typeof d.modelUsage === 'object' ? d.modelUsage : {}
  let win = 0
  for (const entry of Object.values(modelUsage)) {
    const cw = Number((entry as { contextWindow?: number } | undefined)?.contextWindow) || 0
    if (cw > win) win = cw
  }
  return win
}

// used 基数 = input + output + cache 读写：与分段条的各段口径一致，
// 否则各段宽度合计会超过 100%（Free space 对不上）。
function usageNumber(usage: any, ...keys: string[]): number {
  for (const key of keys) {
    const value = usage?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

// 取值键含 cache_write_input_tokens（部分事件对 cache_creation 的别名），
// 计入总量才能与 cacheWrite 分段同口径。
const CONTEXT_USAGE_KEYS = [
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'cache_write_input_tokens',
]

// 单一取源：总量与四段必须来自同一份 usage 快照——若总量在 context_usage 为
// 空对象时回退 usage 而分段不回退，会出现「已用非零、四段全 0」。
// context_usage 是当前窗口快照，usage 是累计计费数据，前者无可用读数时整体回退后者。
function contextUsageOf(data: any) {
  for (const usage of [data?.context_usage, data?.usage]) {
    if (!usage || typeof usage !== 'object') continue
    if (!CONTEXT_USAGE_KEYS.some(k => k in usage)) continue
    if (CONTEXT_USAGE_KEYS.some(k => k in usage && (typeof usage[k] !== 'number' || !Number.isFinite(usage[k]) || usage[k] < 0))) continue
    const input = usageNumber(usage, 'input_tokens')
    const output = usageNumber(usage, 'output_tokens')
    const cacheRead = usageNumber(usage, 'cache_read_input_tokens')
    const cacheWrite = usageNumber(usage, 'cache_creation_input_tokens', 'cache_write_input_tokens')
    return { input, output, cacheRead, cacheWrite, tokens: input + output + cacheRead + cacheWrite }
  }
  return null
}

function contextPoint(d: any, windowHint = 0): ContextPoint | null {
  const u = contextUsageOf(d)
  if (!u) return null
  const ctxWindow = Number(session.value?.context_window || breatherContextWindow.value || modelContextWindow(d) || windowHint || 200000)
  const rawPct = u.tokens / ctxWindow * 100
  return { pct: Math.min(100, Math.round(rawPct)), over: rawPct > 100, tokens: u.tokens, window: ctxWindow, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }
}

// 按时间升序：context_usage 事件即时入列，step_finish 与历史 result 兼容读数；
// 同一 iteration 只保留最新读数——CLI 每条主会话 assistant 消息都发 context_usage，
// 不聚合的话长轮（多 tool 调用）的点数会随消息数线性增长，把 sparkline 挤爆。
// context_usage 不带 modelUsage，轮内读数沿用会话内最近一条上报窗口，与 loop 边界同分母。
const contextHistory = computed(() => {
  const byIter = new Map<number, ContextPoint & { iter: number; ts: string }>()
  const events = [...sessionEvents.value].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
  let seen = 0
  let lastWindow = 0
  for (const e of events) {
    if (!['context_usage', 'step_finish', 'result', 'main_context'].includes(e.event_type)) continue
    const ownWindow = e.event_type === 'main_context' ? Number((e.data as any).max_tokens) : modelContextWindow(e.data)
    const point = e.event_type === 'main_context'
      ? (() => {
          const tokens = Number((e.data as any).current_tokens)
          const window = Number(session.value?.context_window || breatherContextWindow.value || ownWindow || lastWindow || 200000)
          if (!Number.isFinite(tokens) || tokens < 0) return null
          const rawPct = tokens / window * 100
          return { pct: Math.min(100, Math.round(rawPct)), over: rawPct > 100, tokens, window,
            input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }
        })()
      : contextPoint(e.data, lastWindow)
    if (ownWindow) lastWindow = ownWindow
    if (!point) continue
    const iter = e.iteration || seen
    byIter.set(iter, { ...point, iter, ts: e.timestamp })
    seen += 1
  }
  return [...byIter.values()]
})

const currentContext = computed(() => contextHistory.value.at(-1) ?? null)

// 上下文分段：Input/Output/Cache 读写/剩余窗口，各段按同一窗口口径计算百分比。
// 分段条宽度分母取 max(窗口, 已用)：超窗时四段按占比充满整条、不被 overflow 裁掉，
// 正常时与行内百分比同口径。
const contextBreakdown = computed(() => {
  const total = currentContext.value?.window || 0
  const used = currentContext.value?.tokens || 0
  const pct = (value: number) => total > 0 ? Math.round((value / total) * 1000) / 10 : 0
  const scale = Math.max(total, used)
  const widthPct = (value: number) => scale > 0 ? Math.min((value / scale) * 100, 100) : 0
  return [
    { label: 'Input', tokens: currentContext.value?.input || 0, pct: pct(currentContext.value?.input || 0), widthPct: widthPct(currentContext.value?.input || 0), color: '#4d9fff' },
    { label: 'Output', tokens: currentContext.value?.output || 0, pct: pct(currentContext.value?.output || 0), widthPct: widthPct(currentContext.value?.output || 0), color: '#20a779' },
    { label: 'Cache read', tokens: currentContext.value?.cacheRead || 0, pct: pct(currentContext.value?.cacheRead || 0), widthPct: widthPct(currentContext.value?.cacheRead || 0), color: '#e65f2a' },
    { label: 'Cache write', tokens: currentContext.value?.cacheWrite || 0, pct: pct(currentContext.value?.cacheWrite || 0), widthPct: widthPct(currentContext.value?.cacheWrite || 0), color: '#d99500' },
    { label: 'Free space', tokens: Math.max(total - used, 0), pct: pct(Math.max(total - used, 0)), widthPct: widthPct(Math.max(total - used, 0)), color: 'var(--workflow-controller-free-space, #282828)' },
  ]
})

// 零宽段不渲染：min-width 会把 0 token 段画成可见色条，误读为非零。
const contextBarSegments = computed(() => contextBreakdown.value.filter((item) => item.widthPct > 0))

// 重建 session 无实时用量数据，显示更清晰的提示而非默认「暂无上下文数据」
const isReconstructed = computed(() =>
  !!birthTracebackOf(session.value?.plugin_metadata)?.reconstructed_from,
)

// 浏览器原生下载重建日志（重建会话头部按钮，cwd 取自 birth_traceback.fork_cwd）
function downloadReconstructLog() {
  const cwd = birthTracebackOf(session.value?.plugin_metadata)?.fork_cwd?.trim()
  if (!cwd) return
  window.open(
    `/api/sessions/import-db/log?target_cwd=${encodeURIComponent(cwd)}`,
    '_blank',
  )
}

const handoffAgentSession = computed(() => {
  if (!session.value) return null
  const all = sessions.value.filter(s =>
    s.role === 'handoff_agent' && s.predecessor?.id === session.value!.id
  )
  return all.length > 0 ? all[all.length - 1] : null
})

const resumedPredecessor = computed(() => {
  const s = session.value
  if (s?.role !== 'handoff_agent' || !s.predecessor || s.successors?.length) return null
  const continuationId = (s.plugin_metadata?.breather as Record<string, unknown> | undefined)?.continuation_session_id
  if (continuationId === s.predecessor.id) return s.predecessor
  // 旧交接记录没有 continuation_session_id；成功的子代理整体交接会恢复原主会话。
  if (!continuationId && s.result === 'success' && /-subagent-handoff-[\da-f]{12}$/.test(s.name)) {
    return s.predecessor
  }
  return null
})

const activeSubagents = computed(() => {
  const started = new Map<string, { agent_type: string; agent_id: string }>()
  for (const e of sessionEvents.value) {
    if (e.event_type !== 'subagent_start' && e.event_type !== 'subagent_progress' && e.event_type !== 'subagent_stop') continue
    const d = e.data as any
    const id = d.agent_id || ''
    if (e.event_type === 'subagent_start') started.set(id, { agent_type: d.agent_type || 'unknown', agent_id: id })
    else if (e.event_type === 'subagent_progress') { if (!started.has(id)) started.set(id, { agent_type: 'unknown', agent_id: id }) }
    else if (e.event_type === 'subagent_stop') started.delete(id)
  }
  return [...started.values()]
})

const subagentContexts = computed(() => {
  const latest = new Map<string, { tokens: number; window: number; pct: number }>()
  for (const e of sessionEvents.value) {
    if (e.event_type !== 'subagent_context') continue
    const d = e.data as any
    latest.set(String(d.agent_id), {
      tokens: Number(d.current_tokens) || 0,
      window: Number(d.max_tokens) || 0,
      pct: Number(d.percentage) || 0,
    })
  }
  return latest
})

const topology = computed(() =>
  deriveTopology(sessionEvents.value, session.value, sessionReviewerEnabled.value, {
    checkpoints: tracebackLoaded.value ? topoCheckpoints.value : [],
    forkSessions: tracebackLoaded.value ? topoForkSessions.value : [],
  }),
)

const subagentNoMap = computed(() => {
  const map = new Map<string, number>()
  if (topology.value) {
    for (const n of topology.value.nodes) {
      if (n.role === 'subagent' && n.subagentNo) {
        map.set(n.id, n.subagentNo)
      }
    }
  }
  return map
})

// Checkpoint UI/state (检查点列表/重放/文件预览/fork 面板) is owned by the
// agent_traceback plugin's CheckpointPanel component. 拓扑图的重放徽章经此 ref 转发进面板.
const checkpointPanelRef = ref<InstanceType<typeof CheckpointPanel> | null>(null)
function onReplay(checkpointId: string) { checkpointPanelRef.value?.onReplay(checkpointId) }
function onOpenFork(forkSessionId: string) { openSession(forkSessionId) }

// 拓扑节点点击：弹出节点详情，并同步展开对应子代理的日志块。
const selectedAgentId = ref<string | null>(null)
const showAgentDetail = ref(false)
const selectedAgent = computed(() => topology.value?.nodes.find(n => n.id === selectedAgentId.value) || null)
watch(selectedAgentId, () => {
  showReviewerTaskGoal.value = false
})
watch(showAgentDetail, (show) => {
  if (!show) showReviewerTaskGoal.value = false
})

function onSelectAgent(agentId: string) {
  selectedAgentId.value = agentId
  showAgentDetail.value = true
  const expandId = `sa:${agentId}`
  toggleSubagentExpand(expandId)
}

const ALL_AGENTS_KEY = '所有 agent'

const agentOptions = computed(() => {
  const set = new Set<string>(availableAgents.value)
  for (const k of Object.keys(registeredHints.value)) set.add(k)
  for (const s of activeSubagents.value) {
    if (s.agent_type && s.agent_type !== 'unknown') set.add(s.agent_type)
  }
  const real = [...set].filter(a => a && a !== 'unknown').sort()
  return [ALL_AGENTS_KEY, ...real]
})

const mergedHints = computed<Record<string, string[]>>(() => {
  const result: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(registeredHints.value)) result[k] = [...v]
  if (registeredInstructions.value.length) {
    result[ALL_AGENTS_KEY] = [...registeredInstructions.value]
  }
  return result
})

const hintPlaceholder = computed(() =>
  hintType.value === ALL_AGENTS_KEY
    ? '全局指令：如「目标架构为 arch32」「禁用 xxx 依赖」— 对所有 agent 生效'
    : '补充指令：如根因 + 修复结论',
)

const connectionState = computed(() => connected.value ? 'monitoring' : 'disconnected')

const handoffState = computed(() => {
  if (!session.value || session.value.role === 'handoff_agent') return 'none'
  const agent = handoffAgentSession.value
  if (agent) {
    if (agent.state === 'running') return 'doing'
    if (!agent.result) return 'pending'
  }
  if (breatherStopArmed.value || (breatherForcePending.value && breatherPendingSessionId.value === session.value!.id)) return 'pending'
  const isRunning = session.value.state === 'running'
  if (isRunning) {
    const ctx = currentContext.value
    if (breatherEnabled.value && mainThreshold.value < 100 && ctx && ctx.pct > mainThreshold.value) return 'pending'
  }
  return 'waiting'
})

const sessionState = computed(() => session.value?.state || 'idle')

const showButtons = computed(() => connectionState.value === 'monitoring' || handoffState.value === 'pending')
// workflow 成员缺 run_id 时无法路由到 run 面，藏暂停按钮（后端守卫也会拒直通）
const showPause = computed(() => showButtons.value && sessionState.value === 'running' && handoffState.value !== 'doing'
  && (!isWorkflowMember.value || !!memberRunId.value))
const showCancel = computed(() => session.value?.role === 'handoff_agent' && sessionState.value === 'running')
function normalizeProjectDir(path: string | undefined) {
  if (!path) return ''
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}
const showResume = computed(() => {
  if (session.value?.role === 'handoff_agent') return false
  return sessionState.value !== 'running'
})
// 同目录运行中的其他会话（双写者冲突预警）。同 run 成员除外——驱动自管
// 节点并发，兄弟成员同目录运行是正常形态
const sameDirRunningSessions = computed(() => {
  if (!session.value) return []
  const currentDir = normalizeProjectDir(session.value.project_dir)
  if (!currentDir) return []
  return sessions.value.filter(s => s.id !== session.value!.id
    && s.state === 'running'
    && s.run_id !== session.value!.run_id
    && normalizeProjectDir(s.project_dir) === currentDir)
})
// workflow 成员的「已完成」：loop_status=no 且 stop_reason 为自然结束原因。
// 已完成成员不可恢复，应去 Run 页续跑；普通会话不受此限制，自然结束后
// 仍可恢复继续同一 opencode 会话
const isMemberCompleted = computed(() => {
  const s = session.value
  if (!s) return false
  return s.loop_status === 'no'
    && ['evaluator_complete', 'reviewer_complete', 'max_iterations', 'iteration_gate_stop'].includes(s.stop_reason || '')
})
// workflow 成员恢复的拒绝原因预判（run 级 resume 准入的前端镜像；节点
// 验收态等运行期变化由后端 409 拒绝兜底，toast 透传 detail）
const resumeDisabledReason = computed(() => {
  if (memberRunPending.value) return '正在确认所属 Run…'
  if (!isWorkflowMember.value) return null
  if (isMemberCompleted.value) return '该会话已完成，无需恢复；请到 Run 页续跑'
  const runStatus = memberRun.value?.status
  if (runStatus === 'paused') return '所属 Run 已暂停，请先恢复整个 Run'
  if (runStatus && ['completed', 'failed', 'stopped'].includes(runStatus)) return '所属 Run 已结束，请到 Run 页重启续跑'
  if (session.value?.stop_reason !== 'user_pause') return '该成员由 Run 调度，请到 Run 页操作'
  if (sameDirRunningSessions.value.length) return '同目录已有运行中的会话，无法恢复'
  return null
})
// 交接按钮随 会话交接 tab（breather 启用）渲染：历史版本按钮在头部、
// breather 启用时只留 Force（自动阈值监控已处理）；11e21c04 重构把按钮
// 挪进 tab 后遗留了 `!breatherEnabled` 条件，按钮变成永不可达死代码——
// 手动阈值检查入口（toast 反馈触发/未触发/用量未知）随 tab 恢复可用。
const showHandoff = computed(() => showButtons.value && handoffState.value !== 'doing')
const showForce = computed(() => showButtons.value && handoffState.value !== 'doing')
const showCancelForce = computed(() => breatherForcePending.value)

function fmtDur(s: number) {
  if (s >= 3600) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}h ${m}m` }
  if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s)}s`
}
function fmtN(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function getLoopStatusDisplay(s: SessionInfo | undefined) {
  if (!s) return '空闲'
  if (s.state === 'running') return '运行中'
  if (s.role === 'handoff_agent') {
    if (s.loop_status === 'yes') return '运行中'
    if (s.result === 'success') return '已完成'
    if (s.result === 'fail') return '失败'
    return '空闲'
  }
  if (s.loop_status === 'yes') return '空闲'
  if (s.loop_status === 'no') {
    const reason = s.stop_reason || ''
    if (reason === 'error' && s.error) return '错误'
    if (reason === 'timeout') return '错误'
    if (reason === 'user_pause') return '已暂停'
    if (reason === 'handoff_triggered') return '已交接'
    if (reason === 'evaluator_complete' || reason === 'reviewer_complete') return '已完成'
    if (reason === 'max_iterations' || reason === 'iteration_gate_stop') return '已完成'
    return '空闲'
  }
  return '空闲'
}

async function toggleReply() {
  const next = replyMode.value === 'auto' ? 'manual' : 'auto'
  try {
    const r = await fetch(`/api/v1/sessions/${sessionId.value}/reviewer-mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next }) })
    if (!r.ok) { toast.error(`回复模式切换失败: ${r.status}`); return }
    replyMode.value = next
    toast.info(next === 'manual' ? '手动回复模式' : '自动回复模式')
  } catch (e: any) { toast.error(`回复模式切换失败: ${e}`) }
}

async function doInject() {
  if (sessionReviewerEnabled.value && replyMode.value === 'auto' && !showWaitingBanner.value) {
    toast.warning('请切换到手动回复模式再发送'); return
  }
  if (memberRunPending.value) {
    toast.warning('正在确认会话所属 Run，请稍候再发送'); return
  }
  if (!manualPrompt.value) return
  const text = manualPrompt.value
  manualPrompt.value = ''
  try {
    // 同目录已有其他 run 的运行中会话时，只入队不自动恢复（避免双写者冲突）。
    // 该 same-dir 仲裁信号仅对 run 成员生效：普通会话端点无 allow_resume 入参。
    const allowResume = sameDirRunningSessions.value.length === 0
    const resumed = await sendMessage(sessionId.value, text, memberRunRouteId.value, allowResume)
    toast.success('消息已发送')
    if (!resumed && session.value?.state === 'idle') {
      toast.warning(`消息已入队，但未自动恢复：${resumeDisabledReason.value || '会话暂不可恢复'}`)
    }
  } catch (e: any) {
    manualPrompt.value = text  // 失败回填：用户输入不随一次可重试的失败丢失
    toast.error(`错误: ${e}`); return
  }
}

function onInputEnter(e: KeyboardEvent) {
  if (e.isComposing) return
  doInject()
}

async function doPause() {
  try {
    await pause(sessionId.value, memberRunRouteId.value)
  } catch (e: any) {
    toast.error(`暂停失败: ${e?.message || e}`)
    return
  }
  toast.info('已暂停')
}
async function doResume() {
  try {
    await resume(sessionId.value, memberRunRouteId.value)
  } catch (e: any) {
    toast.error(`恢复失败: ${e?.message || e}`)
    return
  }
  toast.info('已恢复')
}

async function openInInsight() {
  if (!nativeSessionId.value) { toast.error('会话没有 session id（不是 opencode 会话）'); return }
  try {
    toast.info('正在导入到 cannbot-insight...')
    const currentSessionId = session.value?.id
    if (!currentSessionId) { return }
    const res = await fetch(`/api/v1/insight/import?session_id=${currentSessionId}`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) { toast.success('已导入到 cannbot-insight'); window.open(data.insightUrl, '_blank') }
    else { toast.error(`导入失败: ${data.error}`) }
  } catch (e: any) { toast.error(`错误: ${e}`) }
}

async function loadHints() {
  try {
    const [hints, agents, instructions] = await Promise.all([
      getSubagentHints(sessionId.value),
      listSubagentAgents(sessionId.value),
      getSessionInstructions(sessionId.value),
    ])
    registeredHints.value = hints
    availableAgents.value = agents
    registeredInstructions.value = instructions
    if (!hintType.value && agentOptions.value.length) hintType.value = agentOptions.value[0]
  } catch {}
}

async function doRegisterHint() {
  const stype = hintType.value.trim()
  const h = hintText.value.trim()
  if (!stype) { toast.warning('subagent_type 必填'); return }
  if (!h) { toast.warning('补充指令不能为空'); return }
  try {
    if (stype === ALL_AGENTS_KEY) {
      const ok = await registerSessionInstruction(sessionId.value, h)
      if (ok) { hintText.value = ''; await loadHints(); toast.success('已登记全局指令（下一轮对所有 agent 生效）') }
      else { toast.error('登记失败') }
    } else {
      const ok = await registerSubagentHint(sessionId.value, stype, h)
      if (ok) { hintText.value = ''; await loadHints(); toast.success(`已为 ${stype} 登记补充指令（下一轮生效）`) }
      else { toast.error('登记失败') }
    }
  } catch (e: any) { toast.error(`错误: ${e}`) }
}

async function doClearHint(stype: string, index: number) {
  try {
    if (stype === ALL_AGENTS_KEY) {
      await clearSessionInstruction(sessionId.value, index)
      await loadHints()
      toast.info(`已清除第 ${index + 1} 条全局指令`)
    } else {
      await clearSubagentHint(sessionId.value, stype, index)
      await loadHints()
      toast.info(`已清除 ${stype} 的第 ${index + 1} 条补充指令`)
    }
  } catch (e: any) { toast.error(`错误: ${e}`) }
}

async function doCancelHandoff() {
  if (!await confirmAction('取消交接', '确定要取消当前 handoff 吗？')) return
  try {
    const r = await fetch(`/api/v1/sessions/${sessionId.value}/cancel-handoff`, { method: 'POST' })
    if (r.ok) toast.success('交接已取消')
    else { const d = await r.json(); toast.error(`取消失败: ${d.error || r.status}`) }
  } catch (e: any) { toast.error(`错误: ${e}`) }
}

async function doHandoff(force = false) {
  const data = await handoff(sessionId.value, force)
  if (data.handoff_triggered) {
    toast.success(`交接已触发${force ? '（强制）' : ''}`)
    if (force) { breatherForcePending.value = true; breatherPendingSessionId.value = sessionId.value }
  }
  else if (data.reason === 'context_usage_unknown' || data.context?.percentage === null) {
    toast.warning('上下文用量未知，暂无法判断是否达到交接阈值')
  }
  else if (data.context) toast.info(`未触发交接 — 上下文 ${data.context.percentage}% ≤ 阈值`)
  else toast.warning(`交接未触发: ${data.reason || '未知原因'}`)
}

async function resetHandoff() {
  try {
    const r = await fetch('/api/breather/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId.value }),
    })
    if (r.ok) { breatherForcePending.value = false; breatherStopArmed.value = false; breatherPendingSessionId.value = null; toast.success('交接状态已重置'); await pollBreatherState() }
    else toast.error('重置交接状态失败')
  } catch (e: any) { toast.error(`失败: ${e}`) }
}

function goBack() { router.push('/') }
function openSession(id: string) { router.push(`/session/${id}`) }

function isInputDisabled(): boolean {
  if (!session.value) return true
  if (waitingForAutoReplyFallback.value) return false
  if (sessionReviewerEnabled.value && replyMode.value === 'auto') {
    const recentEvents = sessionEvents.value.slice(-10)
    const hasWaitingForInput = recentEvents.some(e => {
      const d = e.data as any
      return d.decision === 'waiting_for_input' || d.hook === 'pretool_hook_deny_manual'
    })
    if (!hasWaitingForInput) return true
  }
  if (session.value.state === 'idle') return false
  if (session.value.state === 'running') {
    const recentEvents = sessionEvents.value.slice(-10)
    if (recentEvents.some(e => (e.data as any).decision === 'waiting_for_input')) return false
    if (recentEvents.some(e => { const d = e.data as any; return d.hook === 'pretool_hook_deny_manual' || d.hook === 'pretool_hook_llm' })) return false
  }
  return false
}

function getInputPlaceholder(): string {
  if (!session.value) return ''
  if (waitingForAutoReplyFallback.value) return '回答模型问题...'
  if (session.value.state === 'idle') return '输入消息并按 Enter 发送...'
  if (session.value.state === 'running') {
    const recentEvents = sessionEvents.value.slice(-10)
    if (recentEvents.some(e => (e.data as any).decision === 'waiting_for_input')) return '回答模型问题...'
    if (recentEvents.some(e => { const d = e.data as any; return d.hook === 'pretool_hook_deny_manual' || d.hook === 'pretool_hook_llm' })) return '回答 CP 问题...'
    // 「请切换到手动回复」只对 auto 态成立：manual 态输入框可用（注入运行中
    // 会话），提示文案须与可用状态一致，否则自相矛盾。
    if (sessionReviewerEnabled.value && replyMode.value === 'auto') return '请切换到手动回复模式再发送消息'
    return '会话运行中，无 CP 门禁'
  }
  return '输入消息并按 Enter 发送...'
}
</script>

<template>
  <n-flex vertical class="session-detail-shell" style="height:100vh">
    <div style="flex:1;overflow:hidden;padding:16px 20px;display:flex;flex-direction:column;min-height:0" v-if="session">
      <!-- 会话头部 -->
      <n-flex align="center" :size="12" style="flex-shrink:0;margin-bottom:12px">
        <n-button @click="goBack" strong quaternary>←</n-button>
        <n-text strong size="large">{{ session.name }}</n-text>
        <n-tag
          size="small"
          :bordered="true"
          round
          :color="sessionState === 'running'
            ? { color: 'rgba(53,214,177,.14)', textColor: '#35d6b1', borderColor: 'rgba(53,214,177,.34)' }
            : { color: 'rgba(124,140,255,.14)', textColor: '#aab4ff', borderColor: 'rgba(124,140,255,.34)' }"
        >{{ getLoopStatusDisplay(session) }}
        </n-tag>
        <n-text v-if="session.error" type="error" style="font-size:12px;max-width:480px">
          {{ session.error }}
        </n-text>
        <!-- 所属 Run 徽章：workflow 成员进 run 面的唯一入口（状态色 + label，点击跳转） -->
        <n-tag
          v-if="isWorkflowMember && memberRunId"
          size="small"
          :bordered="false"
          round
          style="cursor:pointer"
          :color="{ color: runStatusColor[memberRun?.status || ''] || '#999999' }"
          title="查看所属 Run"
          @click="router.push(`/run/${memberRunId}`)"
        >Run · {{ memberRun?.label || memberRunId }}</n-tag>
        <n-flex :size="6" style="margin-left:auto">
          <n-button v-if="showPause" quaternary size="medium" title="暂停" :disabled="!nativeSessionId || memberRunPending" @click="doPause">
            <template #icon>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" stroke-width="1.8">
                <circle cx="12" cy="12" r="11"/>
                <rect x="8" y="7" width="3" height="10" rx="1" fill="#8f8f8f" stroke="none"/>
                <rect x="13" y="7" width="3" height="10" rx="1" fill="#8f8f8f" stroke="none"/>
              </svg>
            </template>
          </n-button>
          <n-button v-if="showResume" quaternary size="medium" :disabled="!!resumeDisabledReason" :title="resumeDisabledReason || '恢复会话'" @click="doResume">
            <template #icon>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" stroke-width="1.8">
                <circle cx="12" cy="12" r="11"/>
                <path d="M9.5 7l9 5-9 5z" fill="#8f8f8f" stroke="none"/>
              </svg>
            </template>
          </n-button>
          <n-button v-if="isReconstructed" quaternary size="medium" title="下载重建日志" aria-label="下载重建日志" @click="downloadReconstructLog">
            <template #icon>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12"/>
                <path d="M7 10l5 5 5-5"/>
                <path d="M4 21h16"/>
              </svg>
            </template>
          </n-button>
          <n-badge v-if="!connected" value="连接中" type="warning" />
          <n-popover trigger="click" placement="bottom-end" :width="460" :scrollable="true" style="max-height:70vh">
            <template #trigger>
              <n-button quaternary size="medium" :title="watchdogHasAlerts ? `${watchdogAlertCount} 条告警` : '告警'">
                <template #icon>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" :stroke="watchdogHasAlerts ? '#ed4831' : '#8f8f8f'" stroke-width="1.8">
                    <path d="M12 2L2 20h20L12 2z"/>
                    <line x1="12" y1="9" x2="12" y2="14" :stroke="watchdogHasAlerts ? '#ed4831' : '#8f8f8f'" stroke-width="2"/>
                    <circle cx="12" cy="17" r="1" :fill="watchdogHasAlerts ? '#ed4831' : '#8f8f8f'" stroke="none"/>
                  </svg>
                </template>
                <span v-if="watchdogHasAlerts" style="font-size:12px;color:#ed4831;margin-left:4px">{{ watchdogAlertCount }}</span>
              </n-button>
            </template>
            <WatchdogAlerts :session-events="sessionEvents" :session-id="sessionId" />
          </n-popover>
          <n-button quaternary size="medium" :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" @click="sidebarCollapsed = !sidebarCollapsed; ($event.currentTarget as HTMLElement).blur()">
            <template #icon>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8f8f8f" stroke-width="1.8">
                <rect x="3" y="4" width="18" height="16" rx="2"/>
                <line x1="12" y1="4" x2="12" y2="20"/>
                <rect v-if="!sidebarCollapsed" x="3" y="4" width="9" height="16" fill="#8f8f8f" opacity="0.2" rx="2"/>
              </svg>
            </template>
          </n-button>
          <n-button size="medium" ghost @click="openInInsight">Insight</n-button>
        </n-flex>
      </n-flex>

      <div ref="panelsContainer" class="session-panels" :class="{ 'provenance-expanded': provenanceExpanded }">
        <!-- 左侧面板 -->
        <n-card
          v-show="!sidebarCollapsed"
          size="small"
          class="session-sidebar-card"
          :style="provenanceExpanded ? undefined : { width: `${sidebarWidth}px` }"
          :content-style="provenanceExpanded ? 'flex:1;overflow:hidden;padding:0' : 'flex:1;overflow:hidden;padding:8px'"
        >
          <n-tabs
            :key="sidebarTabsKey"
            v-model:value="activeSidebarTab"
            type="segment"
            size="small"
            animated
            style="height:100%;min-height:0"
            :pane-wrapper-style="{ flexGrow: 1, minHeight: 0, overflowY: 'auto' }"
          >
            <!-- Tab 1: 概览 -->
            <n-tab-pane name="overview" tab="概览">
              <n-flex vertical :size="16">
                <!-- 会话统计：迭代/累计轮次/耗时/创建时间纵向四行 + 上下文分段 -->
                <n-card size="small" title="会话统计" :bordered="false" class="session-stat-card">
                  <div class="session-meta-stats">
                    <div><span>迭代</span><strong>{{ session.current_iteration }}/{{ session.max_iterations }}</strong></div>
                    <div><span>累计轮次</span><strong>{{ usageData.turns }}</strong></div>
                    <div><span>累计用量</span><strong>{{ usageData.totalTokens === null ? '暂无累计用量' : `${fmtN(usageData.totalTokens)} tokens` }}</strong></div>
                    <div><span>耗时</span><strong>{{ fmtDur(session.elapsed_seconds) }}</strong></div>
                    <div><span>创建时间</span><strong>{{ formatLogTimestamp(session.created_at_iso) }}</strong></div>
                  </div>
                  <div class="session-stats-divider" />
                  <div v-if="currentContext" class="context-breakdown">
                    <div class="context-breakdown-summary" title="前端「已用」口径含 Input/Output/Cache 读写；后端 breather 阈值按 Input+Cache 读+写计算，output 密集时会话的显示百分比可能高于触发口径">
                      <span class="context-breakdown-used context-pct">{{ currentContext.pct }}%</span>
                      <span class="context-breakdown-total">{{ fmtN(currentContext.tokens) }} / {{ fmtN(currentContext.window) }}</span>
                    </div>
                    <div class="context-breakdown-bar" role="img" :aria-label="`上下文已使用 ${currentContext.pct}%`">
                      <span v-for="item in contextBarSegments" :key="item.label" :style="{ width: `${item.widthPct}%`, background: item.color }" />
                    </div>
                    <div v-for="item in contextBreakdown" :key="item.label" class="context-breakdown-row">
                      <span class="context-breakdown-swatch" :style="{ background: item.color }" />
                      <span class="context-breakdown-label">{{ item.label }}</span>
                      <span class="context-breakdown-value">{{ fmtN(item.tokens) }}</span>
                      <span class="context-breakdown-pct">{{ item.pct.toFixed(1) }}%</span>
                    </div>
                    <div v-if="currentContext.over" class="context-over" title="实测用量超过当前窗口口径">⚠ 超窗</div>
                  </div>
                  <n-empty v-else :description="isReconstructed ? '已重建会话 — 原始用量未录制' : '上下文用量未知 — 等待模型上报'" size="small" />
                  <n-text depth="3" style="font-size:12px">主代理阈值：{{ mainThreshold }}%{{ mainThreshold === 100 ? ' · 不自动交接' : '' }}</n-text>
                </n-card>
                <n-card v-if="breatherEnabled && session.state === 'running' && activeSubagents.length" size="small" title="运行中子代理" :bordered="false" class="subagent-context-card">
                  <template #header-extra><n-tag size="small" :bordered="false" type="info">{{ activeSubagents.length }} 个运行中</n-tag></template>
                  <n-text depth="3" class="subagent-context-note">{{ subagentThreshold === 100 ? '只采集用量，不自动交接' : `超过 ${subagentThreshold}% 后自动交接` }} · 用量来自 Claude JSONL 或 OpenCode 本地库</n-text>
                  <div class="subagent-context-list">
                    <div v-for="agent in activeSubagents" :key="agent.agent_id" class="subagent-context-item">
                      <div class="subagent-context-heading">
                        <div class="subagent-context-identity">
                          <n-tag size="small" type="success" :bordered="false">运行中</n-tag>
                          <strong>{{ agent.agent_type }}</strong>
                          <n-text depth="3" class="subagent-context-id" :title="agent.agent_id">{{ agent.agent_id.slice(0, 10) }}</n-text>
                        </div>
                        <strong v-if="subagentContexts.get(agent.agent_id)" class="subagent-context-percent">{{ subagentContexts.get(agent.agent_id)!.pct }}%</strong>
                        <n-text v-else depth="3">等待用量</n-text>
                      </div>
                      <template v-if="subagentContexts.get(agent.agent_id)">
                        <div class="subagent-context-metrics">
                          <n-progress type="line" :show-indicator="false" :height="5" :percentage="Math.min(subagentContexts.get(agent.agent_id)!.pct, 100)" />
                          <n-text depth="3" class="subagent-context-usage">{{ fmtN(subagentContexts.get(agent.agent_id)!.tokens) }} / {{ fmtN(subagentContexts.get(agent.agent_id)!.window) }} tokens</n-text>
                        </div>
                      </template>
                      <n-text v-else depth="3" class="subagent-context-usage">首次带用量的模型响应完成后更新</n-text>
                    </div>
                  </div>
                </n-card>

                <!-- Agent 调用树 -->
                <n-card v-if="topology" size="small" title="Agent 调用树" :bordered="false" class="agent-topology-card">
                  <template #header-extra>
                    <span style="font-size:11px;color:var(--workflow-controller-text-muted, #6f6f6f)">
                      {{ topology.totalSubagents }} 子代理 · {{ topology.activeSubagents }} 运行中
                      <span v-if="topology.stoppedSubagents"> · {{ topology.stoppedSubagents }} 已停止</span>
                      <span v-if="topology.failedSubagents"> · {{ topology.failedSubagents }} 失败</span>
                      <span v-if="topology.forks.length"> · {{ topology.forks.length }} 重放</span>
                    </span>
                  </template>
                  <AgentTopologyGraph :topology="topology" @select-agent="onSelectAgent" @replay="onReplay" @open-fork="onOpenFork" />
                </n-card>
                <n-modal v-if="selectedAgent" v-model:show="showAgentDetail" preset="card" :title="selectedAgent.label" style="width: min(520px, calc(100vw - 40px))">
                  <div class="agent-detail-header">
                    <div class="agent-detail-title"><span class="agent-status-dot" :class="`status-${selectedAgent.status}`" /><span>{{ selectedAgent.agentType || selectedAgent.role }} · </span><span class="agent-detail-status" :class="`status-${selectedAgent.status}`">{{ selectedAgent.status }}</span></div>
                  </div>
                  <div class="agent-detail-stats">
                    <span v-if="selectedAgent.tokens">{{ fmtN(selectedAgent.tokens) }} tokens</span>
                    <span v-if="selectedAgent.toolCallCount">{{ selectedAgent.toolCallCount }} 次工具调用</span>
                    <span v-if="selectedAgent.messageCount">{{ selectedAgent.messageCount }} 条消息</span>
                    <span v-if="selectedAgent.role === 'reviewer'">{{ topology?.reviewerDecisions || 0 }} 次审核决策</span>
                  </div>
                  <div v-if="selectedAgent.model" class="agent-detail-line">模型：{{ selectedAgent.model }}</div>
                  <div v-if="selectedAgent.startedAt" class="agent-detail-line">开始：{{ new Date(selectedAgent.startedAt).toLocaleTimeString() }}</div>
                  <div v-if="selectedAgent.endedAt" class="agent-detail-line">结束：{{ new Date(selectedAgent.endedAt).toLocaleTimeString() }}</div>
                  <div v-if="selectedAgent.dispatchContent" class="agent-detail-prompt">{{ selectedAgent.dispatchContent }}</div>
                  <div v-if="selectedAgent.role === 'reviewer' && reviewerTaskGoal" class="agent-detail-reviewer">
                    <n-flex align="center" justify="space-between" :size="8">
                      <n-text depth="3">Reviewer 目标</n-text>
                      <n-button size="tiny" quaternary @click="showReviewerTaskGoal = !showReviewerTaskGoal">
                        {{ showReviewerTaskGoal ? '收起' : '展开' }}
                      </n-button>
                    </n-flex>
                    <pre v-if="showReviewerTaskGoal" class="reviewer-task-text">{{ reviewerTaskGoal }}</pre>
                  </div>
                </n-modal>
              </n-flex>
            </n-tab-pane>

            <!-- Tab 2: 会话交接 -->
            <n-tab-pane v-if="breatherEnabled" name="chain" tab="会话交接">
              <n-flex vertical :size="16">
                <!-- 交接操作 -->
                <n-card v-if="session.role === 'worker' && (showHandoff || showForce || showCancelForce)" size="small" title="交接操作">
                  <n-flex :size="6">
                    <n-button v-if="showHandoff" size="small" @click="doHandoff(false)" title="检查上下文用量，超过阈值时触发交接">交接</n-button>
                    <n-button v-if="showForce" size="small" @click="doHandoff(true)" title="跳过阈值检查，强制触发交接">强制</n-button>
                    <n-button v-if="showCancelForce" size="small" type="error" @click="resetHandoff" title="取消强制交接">重置交接</n-button>
                  </n-flex>
                </n-card>
                <n-card v-if="session.role === 'handoff_agent' && showCancel" size="small" title="交接操作">
                  <n-flex :size="6">
                    <n-button size="small" type="error" @click="($event.currentTarget as HTMLElement).blur(); doCancelHandoff()" title="取消交接，标记为失败">取消交接</n-button>
                  </n-flex>
                </n-card>

                <!-- 前序会话 -->
                <n-card v-if="session?.predecessor" size="small" title="前序会话">
                  <n-flex align="center" :size="8" style="padding:6px 8px;border-radius:6px;cursor:pointer" @click="openSession(session!.predecessor!.id)">
                    <n-badge :dot="true" :type="sessions.find(s => s.id === session!.predecessor!.id)?.state === 'running' ? 'success' : 'default'" />
                    <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ session!.predecessor.name }}</n-text>
                    <n-text depth="3">←</n-text>
                  </n-flex>
                </n-card>

                <!-- 后续会话 -->
                <n-card v-if="session.successors?.length || resumedPredecessor" size="small" title="后续会话">
                  <n-flex v-for="succ in session.successors" :key="succ.id" align="center" :size="8" style="padding:6px 8px;border-radius:6px;cursor:pointer" @click="openSession(succ.id)">
                    <n-badge :dot="true" :type="sessions.find(s => s.id === succ.id)?.state === 'running' ? 'success' : 'default'" />
                    <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ succ.name }}</n-text>
                    <n-text depth="3">→</n-text>
                  </n-flex>
                  <template v-if="resumedPredecessor">
                    <n-flex align="center" :size="8" style="padding:6px 8px;border-radius:6px;cursor:pointer" @click="openSession(resumedPredecessor.id)">
                      <n-badge :dot="true" :type="sessions.find(s => s.id === resumedPredecessor!.id)?.state === 'running' ? 'success' : 'default'" />
                      <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ resumedPredecessor.name }}</n-text>
                      <n-text depth="3">{{ resumedPredecessor.id }}</n-text>
                      <n-text depth="3">→</n-text>
                    </n-flex>
                    <n-text depth="3">只有子代理越过阈值，主代理沿用原会话继续运行，因此前序与后续会话的 ID 相同。</n-text>
                  </template>
                </n-card>

                <!-- 交接状态 -->
                <n-card v-if="handoffState !== 'none'" size="small" title="交接状态">
                  <n-tag v-if="handoffState === 'waiting'" class="handoff-waiting-tag" :bordered="false" size="small">等待中</n-tag>
                  <n-tag v-if="handoffState === 'pending'" type="warning" :bordered="false" size="small">待处理</n-tag>
                  <n-tag v-if="handoffState === 'doing'" type="info" :bordered="false" size="small">执行中</n-tag>
                  <n-alert v-if="handoffError" type="error" style="margin-top:8px" :show-icon="false">{{ handoffError }}</n-alert>
                </n-card>

                <!-- 最近一次交接 -->
                <n-card v-if="handoffAgentSession && session.role !== 'handoff_agent'" size="small" title="最近一次交接">
                  <n-flex align="center" :size="8">
                    <template v-if="handoffAgentSession.state === 'running'">
                      <n-spin :size="14" /><span>交接执行中...</span><n-button size="tiny" type="primary" @click="openSession(handoffAgentSession.id)">查看</n-button>
                    </template>
                    <template v-else-if="handoffAgentSession.result === 'success'">
                      <n-tag type="success" size="small">成功</n-tag><n-button size="tiny" type="primary" @click="openSession(handoffAgentSession.id)">查看</n-button>
                    </template>
                    <template v-else-if="handoffAgentSession.result === 'fail'">
                      <n-tag type="error" size="small">失败</n-tag><n-button size="tiny" type="primary" @click="openSession(handoffAgentSession.id)">查看</n-button>
                    </template>
                    <template v-else>
                      <n-tag type="warning" size="small">等待中</n-tag><n-button size="tiny" type="primary" @click="openSession(handoffAgentSession.id)">查看</n-button>
                    </template>
                  </n-flex>
                </n-card>

                <!-- 交接结果（交接会话） -->
                <n-card v-if="session.role === 'handoff_agent'" size="small" title="交接结果">
                  <n-tag v-if="session.state === 'running'" type="info" size="small">运行中</n-tag>
                  <n-tag v-else-if="session.result === 'success'" type="success" size="small">成功</n-tag>
                  <n-tag v-else-if="session.result === 'fail'" type="error" size="small">失败</n-tag>
                  <n-tag v-else type="warning" size="small">等待结果</n-tag>
                  <div v-if="session.result === 'success' && session.successors && session.successors.length > 0" style="margin-top:8px">
                    <span style="font-size:12px;color:#6f6f6f">后续工作会话已启动：</span>
                    <n-flex v-for="succ in session.successors" :key="succ.id" align="center" :size="8" style="padding:6px 8px;border-radius:6px;cursor:pointer" @click="openSession(succ.id)">
                      <n-badge :dot="true" :type="sessions.find(s => s.id === succ.id)?.state === 'running' ? 'success' : 'default'" />
                      <n-text style="font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ succ.name }}</n-text>
                    </n-flex>
                  </div>
                </n-card>

                <n-empty v-if="!session?.predecessor && (!session.successors || session.successors.length === 0) && handoffState === 'none'" description="暂无关联会话" size="small" />
              </n-flex>
            </n-tab-pane>

            <!-- Tab 3: 子代理控制 -->
            <n-tab-pane name="config" tab="子代理控制">
              <n-card v-if="session.role !== 'handoff_agent'" size="small" title="子代理补充指令（可选）" :bordered="false">
                <div style="font-size:12px;color:#6f6f6f;margin-bottom:10px;line-height:1.5">
                  登记诊断结论，下一轮注入到系统 prompt。选择「{{ ALL_AGENTS_KEY }}」对所有 agent 生效（worker + 全部子代理）；选择具体 subagent_type 仅对该子代理生效。非侵入、可逆。
                </div>
                <n-flex vertical :size="8">
                  <n-select v-model:value="hintType" size="small" placeholder="选择 subagent_type" :options="agentOptions.map(a => ({ label: a, value: a }))" :virtual-scroll="false" />
                  <n-input v-model:value="hintText" type="textarea" :rows="3" :placeholder="hintPlaceholder" />
                  <n-button size="small" type="primary" :disabled="!hintType.trim() || !hintText.trim()" @click="doRegisterHint">登记</n-button>
                </n-flex>
                <n-flex v-if="Object.keys(mergedHints).length" vertical :size="8" style="margin-top:12px">
                  <template v-for="(hints, stype) in mergedHints" :key="stype">
                    <div v-for="(text, idx) in hints" :key="`${stype}-${idx}`" :style="stype === ALL_AGENTS_KEY ? 'border:1px solid var(--workflow-controller-border, #e5e5e5);border-radius:6px;padding:8px;background:color-mix(in srgb, #52c41a 8%, var(--workflow-controller-surface, #eef9ee));color:var(--workflow-controller-text, #1f2328)' : 'border:1px solid var(--workflow-controller-border, #e5e5e5);border-radius:6px;padding:8px;background:color-mix(in srgb, var(--workflow-controller-primary, #4078f2) 8%, var(--workflow-controller-surface, #ecf3ff));color:var(--workflow-controller-text, #1f2328)'">
                      <n-flex align="center" justify="space-between" style="margin-bottom:6px">
                        <n-tag size="small" :type="stype === ALL_AGENTS_KEY ? 'success' : 'warning'" round>{{ stype }} #{{ idx + 1 }}</n-tag>
                        <n-button size="tiny" type="error" quaternary @click="doClearHint(String(stype), idx)">清除</n-button>
                      </n-flex>
                      <pre class="hint-text-pre">{{ text }}</pre>
                    </div>
                  </template>
                </n-flex>
                <div v-else style="font-size:12px;color:#8f8f8f;margin-top:8px">尚未登记补充指令</div>
              </n-card>
              <n-empty v-else description="交接会话无配置选项" size="small" />
            </n-tab-pane>

            <!-- Tab 4: 检查点 (traceback replay) — plugin-owned. The entire panel
                 (list / replay dialog / file preview / fork sessions) is contributed
                 by the agent_traceback plugin; hidden when that plugin isn't loaded. -->
            <n-tab-pane v-if="tracebackLoaded" name="checkpoints" tab="检查点">
              <CheckpointPanel
                ref="checkpointPanelRef"
                :session-id="sessionId"
                :sessions="sessions"
                :subagent-start-count="subagentStartCount"
                :session-state="session?.state"
                :subagent-no-map="subagentNoMap"
                @open-session="openSession"
                @checkpoints-update="cps => topoCheckpoints = cps"
                @forks-update="fs => topoForkSessions = fs"
              />
            </n-tab-pane>

            <n-tab-pane
              v-if="provenanceLoaded"
              name="provenance"
              tab="文件归因"
              display-directive="show:lazy"
            >
              <FileProvenanceView
                :project-dir="session?.project_dir"
                :session-id="session?.id"
                :active="activeSidebarTab === 'provenance'"
              />
            </n-tab-pane>

            <!-- Tab 5: 阶段验证 -->
            <n-tab-pane v-if="pipelineEnabled" name="pipeline" tab="阶段验证">
              <n-flex vertical :size="16">
                <n-card v-if="stageNames.length > 0" size="small" title="阶段进度">
                  <n-timeline>
                    <n-timeline-item
                      v-for="item in stageTimeline"
                      :key="item.title"
                      :type="item.type"
                      :title="item.title"
                      :content="item.content"
                    />
                  </n-timeline>
                  <div style="font-size:11px;color:#6f6f6f;margin-top:8px">
                    {{ pipePct }}%
                    <span v-if="pipeDetail"> · {{ pipeDetail }}</span>
                  </div>
                </n-card>
                <n-empty v-else description="未配置阶段" size="small" />
              </n-flex>
            </n-tab-pane>
          </n-tabs>
        </n-card>
        <div
          v-show="!sidebarCollapsed && !provenanceExpanded"
          class="session-sidebar-resizer"
          :class="{ resizing: isResizingSidebar }"
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          :aria-valuemin="SIDEBAR_MIN_WIDTH"
          :aria-valuemax="availableSidebarMax"
          :aria-valuenow="Math.round(sidebarWidth)"
          tabindex="0"
          @pointerdown="startSidebarResize"
          @pointermove="moveSidebarResize"
          @pointerup="finishSidebarResize"
          @pointercancel="finishSidebarResize"
          @lostpointercapture="finishSidebarResize"
          @keydown="resizeSidebarWithKeyboard"
        />
        <!-- 右侧内容 -->
        <n-card v-show="!provenanceExpanded" size="small" class="session-output-card" content-style="flex:1;overflow:hidden;display:flex;flex-direction:column;padding:8px;gap:8px">
          <!-- 输出日志 -->
          <n-flex vertical style="flex:1;min-height:0;overflow:hidden">
            <VirtualLog :lines="workerOutput" @toggle="toggleSubagentExpand" @open-modal="openLogModal" style="flex:1;min-height:0">
              等待事件...
            </VirtualLog>
          </n-flex>

          <!-- 长文本弹窗（user_message 等） -->
          <n-modal v-model:show="modalContentShow" preset="card" title="完整内容" style="max-width: 800px;">
            <pre class="log-modal-pre">{{ modalContent }}</pre>
          </n-modal>

          <!-- 等待输入提示 -->
          <n-alert v-if="showWaitingBanner" type="warning" :bordered="true">
            <template v-if="waitingForAutoReplyFallback">自动回复出错，请手动回复。</template>
            <template v-else-if="bannerKind === 'unanswered_question'">本轮结束时，模型的问题尚未回答，已转为等待人工回复。请在下方回复后继续。</template>
            <template v-else-if="bannerKind === 'question'"> 模型在等你回答问题 — 在下方输入框回复</template>
            <template v-else-if="bannerKind === 'manual'">📝 手动回复模式 — 在下方输入框输入指令继续</template>
          </n-alert>

          <!-- 输入框 -->
          <n-flex align="center" :size="8">
            <n-button v-if="sessionReviewerEnabled" size="small" :disabled="waitingForAutoReplyFallback" @click="toggleReply">
              回复: {{ replyMode === 'auto' ? '自动' : '手动' }}
            </n-button>
            <n-input
              v-model:value="manualPrompt"
              :placeholder="getInputPlaceholder()"
              :disabled="isInputDisabled()"
              @keydown.enter="onInputEnter"
              style="flex:1"
            />
            <n-button size="small" type="primary" :disabled="!manualPrompt || isInputDisabled() || memberRunPending" @click="doInject">发送</n-button>
          </n-flex>
        </n-card>
      </div>
    </div>

    <div v-else style="flex:1;overflow-y:auto;padding:20px">
      <n-spin v-if="sessionLoading" size="large" style="padding:80px 20px" />
      <n-empty v-else size="huge" description="会话未找到" style="padding:60px 20px">
        <template #extra>
          <n-button type="primary" @click="goBack">返回仪表盘</n-button>
        </template>
      </n-empty>
    </div>
  </n-flex>
</template>

<style scoped>
.session-detail-shell { background:var(--workflow-controller-body, #0b1020); color:var(--workflow-controller-text, #f8fafc); }
.session-detail-shell :deep(.n-card) { background:rgba(17,24,39,.82); border-color:rgba(148,163,184,.18); box-shadow:0 14px 36px rgba(2,6,23,.18); border-radius:14px; color:#e2e8f0; }
.session-detail-shell :deep(.n-card-header__main) { color:#f8fafc; }
.session-detail-shell :deep(.n-tabs-tab) { color:#94a3b8; }
.session-detail-shell :deep(.n-tabs-tab--active) { color:#f8fafc; }
.session-detail-shell :deep(.n-tabs-bar) { background:#8b9cff; }
.session-detail-shell :deep(.n-tabs-nav--segment-type .n-tabs-rail) { background:#172033; border:1px solid rgba(148,163,184,.18); }
.session-detail-shell :deep(.n-tabs-nav--segment-type .n-tabs-tab) { color:#94a3b8; }
.session-detail-shell :deep(.n-tabs-nav--segment-type .n-tabs-tab--active) { background:#0f172a; color:#f8fafc; box-shadow:0 2px 8px rgba(2,6,23,.28); }
.session-detail-shell :deep(.n-input), .session-detail-shell :deep(.n-base-selection) { background:#111827; color:#f8fafc; }
.session-detail-shell :deep(.n-input__textarea), .session-detail-shell :deep(.n-input__input-el) { color:#f8fafc; }
.session-detail-shell :deep([style*="#6f6f6f"]), .session-detail-shell :deep([style*="#8f8f8f"]) { color:#94a3b8 !important; }
.session-detail-shell :deep([style*="#f8f8f8"]), .session-detail-shell :deep([style*="#fbfcfd"]) { background:#111827 !important; }
.session-detail-shell :deep([style*="#e8e8e8"]), .session-detail-shell :deep([style*="#e5e5e5"]) { border-color:rgba(148,163,184,.18) !important; }
.session-panels {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.session-sidebar-card {
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  order: 3;
}

/* 详情内容采用「对话在左、Overview 在右」的工作台顺序。 */
.session-output-card { order: 1; }

.session-panels.provenance-expanded .session-sidebar-card {
  flex: 1;
  width: 100%;
}

.session-sidebar-resizer {
  position: relative;
  flex: 0 0 16px;
  width: 16px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
  order: 2;
}

.session-sidebar-resizer::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 40px;
  border-radius: 2px;
  background: rgba(148,163,184,.55);
  transform: translate(-50%, -50%);
  transition: height 0.15s ease, background-color 0.15s ease;
}

.session-sidebar-resizer:hover::before,
.session-sidebar-resizer:focus-visible::before,
.session-sidebar-resizer.resizing::before {
  height: 64px;
  background: #8b9cff;
}

.session-output-card {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.context-pct { font-size: 36px; font-weight: 700; color: #35d6b1; font-family: 'JetBrains Mono', monospace }
.context-over { display: block; font-size: 12px; color: #ef4444; font-weight: 500 }
.context-pct.warn { color: #f59e0b }
.context-pct.danger { color: #ef4444 }
.context-breakdown { padding: 2px 0; color:#cbd5e1; }
.context-breakdown-summary { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; }
.context-breakdown-used { color:#f8fafc; font-size:18px; }
.context-breakdown .context-pct { margin:0; color:#f8fafc; font-size:18px; font-family:inherit; }
.context-breakdown-total { color:#94a3b8; font-size:13px; }
.context-breakdown-bar { display:flex; width:100%; height:8px; overflow:hidden; margin-bottom:14px; border-radius:4px; background:var(--workflow-controller-hover); }
.context-breakdown-bar span { height:100%; }
.context-breakdown-row { display:grid; grid-template-columns:14px minmax(0,1fr) auto auto; align-items:center; gap:8px; min-height:28px; font-size:12px; }
.context-breakdown-swatch { width:12px; height:12px; border-radius:3px; }
.context-breakdown-label { overflow:hidden; color:#cbd5e1; text-overflow:ellipsis; white-space:nowrap; }
.context-breakdown-value { color:#94a3b8; font-variant-numeric:tabular-nums; }
.context-breakdown-pct { min-width:38px; color:#f8fafc; text-align:right; font-variant-numeric:tabular-nums; }
.session-stats-divider { height:1px; margin:14px 0 10px; background:rgba(148,163,184,.14); }
.session-meta-stats { display:flex; flex-direction:column; gap:8px; }
.session-meta-stats div { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
.session-meta-stats span { color:#94a3b8; font-size:11px; }
.session-meta-stats strong { overflow:hidden; color:#f8fafc; font-size:13px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
.session-stat-card, .agent-topology-card { border:1px solid rgba(148,163,184,.18) !important; border-radius:12px; }
.agent-detail-reviewer { margin-top:10px; }
.reviewer-task-text { max-height:180px; overflow-y:auto; margin:10px 0 0; padding:8px; border:1px solid rgba(148,163,184,.16); border-radius:8px; background:rgba(148,163,184,.045); color:var(--workflow-controller-text, #f8fafc); font-size:12px; line-height:1.6; white-space:pre-wrap; }
.subagent-context-card { border:1px solid rgba(148,163,184,.18) !important; border-radius:12px; }
.subagent-context-note { display:block; font-size:11px; line-height:1.5; margin-bottom:12px; }
.subagent-context-list { display:grid; gap:8px; }
.subagent-context-item { padding:10px 12px; border:1px solid rgba(148,163,184,.16); border-radius:10px; background:rgba(148,163,184,.045); }
.subagent-context-heading, .subagent-context-identity { display:flex; align-items:center; gap:6px; min-width:0; }
.subagent-context-heading { justify-content:space-between; margin-bottom:8px; }
.subagent-context-identity strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.subagent-context-id { font-size:11px; flex:none; }
.subagent-context-percent { font-variant-numeric:tabular-nums; }
.subagent-context-metrics { display:flex; align-items:center; justify-content:flex-end; gap:10px; }
.subagent-context-metrics .n-progress { width:88px; flex:none; }
.subagent-context-usage { font-size:11px; text-align:right; }
.agent-detail-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.agent-detail-title { display:flex; align-items:center; gap:7px; color:#f8fafc; font-size:13px; font-weight:600; }
.agent-detail-status.status-completed { color:#8f8f8f; }
.agent-detail-status.status-running { color:#35d6b1; }
.agent-detail-status.status-failed { color:#ef4444; }
.agent-detail-status.status-stopped { color:#f0a020; }
.agent-detail-line { margin-top:4px; color:#94a3b8; font-size:11px; }
.agent-status-dot { width:8px; height:8px; border-radius:50%; background:#8f8f8f; }
.agent-status-dot.status-running { background:#35d6b1; }
.agent-status-dot.status-completed { background:#8f8f8f; }
.agent-status-dot.status-failed { background:#ef4444; }
.agent-status-dot.status-stopped { background:#f0a020; }
.agent-detail-stats { display:flex; flex-wrap:wrap; gap:6px 12px; margin-top:8px; color:#cbd5e1; font-size:11px; }
.handoff-waiting-tag { background:rgba(148,163,184,.12) !important; color:#94a3b8 !important; }
.agent-detail-prompt { max-height:100px; overflow:auto; margin-top:8px; padding:8px; border-radius:7px; background:#0f172a; color:#cbd5e1; font-size:11px; line-height:1.5; white-space:pre-wrap; }

.hint-text-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: var(--workflow-controller-text-muted, #cbd5e1); max-height: 120px; overflow: auto; font-family: 'JetBrains Mono', monospace }

/* 长文本弹窗（user_message 全文等）：保留换行、自动换行、可滚动 */
.log-modal-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--workflow-controller-text, #cbd5e1); max-height: 60vh; overflow: auto; font-family: 'JetBrains Mono', monospace }

/* VirtualLog line type classes */
:deep(.cls-iter) { color: #aab4ff; font-weight: 600; background: rgba(124,140,255,.14); display: block }
:deep(.cls-tool) { color: #aab4ff; }
:deep(.cls-result) { color: #94a3b8; }
:deep(.cls-thinking) { color: #94a3b8; font-style: normal; }
:deep(.cls-thinking-active) { color: #f8fafc; }
:deep(.vlog-line.cls-thinking.vlog-clickable:hover) { background: transparent; color: #f8fafc; }
:deep(.vlog-flow-line.cls-thinking:hover) { background: transparent; }
:deep(.cls-user) { color: #f8fafc; font-weight: 600; }
:deep(.vlog-line.cls-user.vlog-clickable:hover) { background: rgba(124,140,255,.12); }
/* 可点击预览行（user/assistant 超长单行、孤立/内嵌 result/error）深色 hover：
   覆盖 VirtualLog 内置的浅色默认值，flow 与虚拟滚动两路径同口径。 */
:deep(.vlog-flow-line.cls-user.vlog-clickable:hover),
:deep(.vlog-line.cls-result.vlog-clickable:hover),
:deep(.vlog-flow-line.cls-result.vlog-clickable:hover),
:deep(.vlog-line.cls-error.vlog-clickable:hover),
:deep(.vlog-flow-line.cls-error.vlog-clickable:hover) { background: rgba(124,140,255,.12); }
:deep(.cls-subagent) { color: #a753ae; font-weight: 500; }
:deep(.cls-error) { color: #ed4831; font-weight: 600; }
:deep(.cls-system) { color: #94a3b8; }
:deep(.cls-separator) { color: #475569; }
:deep(.cls-hook-stop) { color: #aab4ff; font-weight: 500; }
:deep(.cls-hook-auq) { color: #f4b860; font-weight: 500; }
:deep(.cls-hook-eval) { color: #35d6b1; font-weight: 500; }
:deep(.cls-tool-arg) { color: #94a3b8; }
:deep(.tool-heading) { color: #cbd5e1; font-size: 13px; }
:deep(.vlog-line.cls-tool), :deep(.vlog-line.cls-result) { padding-left:8px; padding-right:8px; background:#111827; }
</style>
