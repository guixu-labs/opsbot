<script setup lang="ts">
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

// 「新建会话」弹窗。表单主体在 SessionForm.vue（与 ReplayConfigModal 共享），
// 本组件只保留外壳（标题 / 初始化 / 启动逻辑）。
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { NModal, NButton, NFlex, NSpin, NInput } from 'naive-ui'
import { useSessions } from '../composables/useSessions'
import { useRuns } from '../composables/useRuns'
import { useToast } from '../composables/useToast'
import { useAuth } from '../composables/useAuth'
import { useProjectPaths } from '../composables/useProjectPaths'
import { usePlugins } from '../composables/usePlugins'
import SessionForm, { type SessionFormState } from './SessionForm.vue'
import { resolveReviewerThinking } from '../utils/reviewerConfig'

const emit = defineEmits<{ started: [sessionId: string] }>()

const router = useRouter()
const show = ref(false)
const starting = ref(false)

const { start, loading } = useSessions()
const { startRun } = useRuns()
const toast = useToast()
const { authReady } = useAuth()
const { projectDir } = useProjectPaths()
const { pluginEnabled } = usePlugins()

// 过渡代码：填 yaml 经 Runs API 启动 workflow Run；旧 graph 入口退役后删除。
const graphYamlPath = ref('')

function defaultReviewerEnabled() { return !pluginEnabled('graph') }
function defaultEvaluator() { return pluginEnabled('graph') ? 'always_complete' : null }
function defaultMaxIterations() { return pluginEnabled('graph') ? 3 : 10 }

// runtime 未选择时不覆盖项目默认；显式 runtime 下发空值表示关闭。
function effectiveCliWrapper(runtime: string | null | undefined, cliWrapper: string | null | undefined) {
  if (runtime == null) return undefined
  return ['claude_cli', 'opencode', 'codex_cli'].includes(runtime) ? cliWrapper || '' : ''
}

// form 状态：父组件持有 reactive 对象，传给 SessionForm 作 v-model。
// 初始化为空，open() 时按 projectConfig 填充。
const form = ref<SessionFormState>({
  runtime: undefined,
  cliWrapper: '',
  prompt: '',
  sessionModel: '',
  reviewerModel: '',
  reviewerEnabled: defaultReviewerEnabled(),
  reviewerThinkingMode: 'disabled',
  reviewerThinkingBudget: 2048,
  reviewerMaxTokens: 2048,
  systemPrompt: '',
  evaluator: defaultEvaluator(),
  maxIterations: defaultMaxIterations(),
  reviewerTaskGoal: '',
})

// projectConfig 加载状态（控制 SessionForm 高级设置的「加载中…」占位）。
const projectConfigLoaded = ref(false)
// 配置是否成功解析（仅成功时为 true）。thinking 覆盖只在解析成功后才下发，
// 否则加载完成前/失败时会把内置默认值（false/2048）当作显式覆盖发送，绕过项目>全局解析。
const configResolved = ref(false)

// 递增序号防旧项目延迟响应覆盖当前项目：仅接受最新一次 load 的结果。
let configRequestSeq = 0

// SessionForm 实例引用，用于调其暴露的提交前方法。
const sessionFormRef = ref<InstanceType<typeof SessionForm> | null>(null)

async function loadProjectConfig() {
  const seq = ++configRequestSeq
  try {
    const dir = projectDir.value
    const url = dir ? `/api/v1/project-config?dir=${encodeURIComponent(dir)}` : '/api/v1/project-config'
    const [projectResponse, globalResponse] = await Promise.all([fetch(url), fetch('/api/v1/config')])
    const [cfg, globalConfig] = await Promise.all([projectResponse.json(), globalResponse.json()])
    if (seq !== configRequestSeq) return
    configResolved.value = true
    const thinking = resolveReviewerThinking(cfg?.reviewer, globalConfig?.reviewer)
    form.value.reviewerThinkingMode = thinking.mode
    form.value.reviewerThinkingBudget = thinking.budgetTokens
    form.value.reviewerMaxTokens = thinking.maxTokens
    form.value.runtime = cfg?.runtime || undefined
    form.value.cliWrapper = cfg?.cli_wrapper || ''
    form.value.systemPrompt = cfg?.system_prompt ?? ''
    form.value.evaluator = cfg?.loop?.evaluator ?? defaultEvaluator()
    form.value.maxIterations = cfg?.loop?.max_iterations ?? defaultMaxIterations()
    form.value.reviewerTaskGoal = cfg?.reviewer?.task_goal ?? ''
    form.value.reviewerEnabled = cfg?.reviewer?.enabled ?? defaultReviewerEnabled()
    graphYamlPath.value = cfg?.graph_yaml ?? ''
    // 仅在用户尚未编辑提示词时填充 starting_prompt，避免 fetch 期间覆盖用户输入。
    if (!form.value.prompt) form.value.prompt = cfg?.starting_prompt || ''
  } catch {
    // projectConfig 加载失败：留空（form 仍是有效初值，用户可手填）。
  } finally {
    if (seq === configRequestSeq) projectConfigLoaded.value = true
  }
}

function open() {
  show.value = true
  graphYamlPath.value = ''
  // 重置 form（避免上次输入残留）。
  form.value = {
    runtime: undefined,
    cliWrapper: '',
    prompt: '',
    sessionModel: '',
    reviewerModel: '',
    reviewerEnabled: defaultReviewerEnabled(),
    reviewerThinkingMode: 'disabled',
    reviewerThinkingBudget: 2048,
    reviewerMaxTokens: 2048,
    systemPrompt: '',
    evaluator: defaultEvaluator(),
    maxIterations: defaultMaxIterations(),
    reviewerTaskGoal: '',
  }
  projectConfigLoaded.value = false
  configResolved.value = false
  loadProjectConfig()
}

// graph 变量从 prompt 解析：每行 `key: value` / `key=value` 一组；
// 只有一行且未命中键值格式时整体当作 OP 变量的值
function parseGraphVars(prompt: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const lines = prompt.split('\n').filter(l => l.trim())
  for (const line of lines) {
    const m = line.match(/^(\w+)\s*[:=]\s*(.+)/)
    if (m) { vars[m[1]] = m[2].trim(); continue }
  }
  // 只有一行且没被解析 → 当作 OP 值
  if (!Object.keys(vars).length && lines.length === 1) {
    vars.OP = lines[0].trim()
  }
  return vars
}

// workflow 启动：graph 插件的 yaml 经 runs API 起 workflow run（label 取 yaml
// 文件名 stem；params 携带变量与全部运行配置）
async function startWorkflowRun(yamlPath: string, vars: Record<string, string>) {
  const f = form.value
  const sessionModelName = sessionFormRef.value?.getSelectedModelName('session')
  const reviewerModelName = sessionFormRef.value?.getSelectedModelName('reviewer')
  const providerIndex = sessionFormRef.value?.getSelectedProviderIndex('session')
  const reviewerProviderIndex = sessionFormRef.value?.getSelectedProviderIndex('reviewer')

  const params: Record<string, unknown> = { variables: JSON.stringify(vars) }
  if (f.runtime) params.runtime = f.runtime
  const cliWrapper = effectiveCliWrapper(f.runtime, f.cliWrapper)
  if (cliWrapper !== undefined) params.cli_wrapper = cliWrapper
  if (sessionModelName) params.model = sessionModelName
  if (providerIndex !== undefined && providerIndex !== null) params.provider_index = providerIndex
  if (f.reviewerEnabled && reviewerModelName) params.reviewer_model = reviewerModelName
  if (f.reviewerEnabled && reviewerProviderIndex !== undefined && reviewerProviderIndex !== null) params.reviewer_provider_index = reviewerProviderIndex
  params.reviewer_enabled = f.reviewerEnabled
  if (configResolved.value) {
    // 删除：graph 插件适配 reviewer_thinking_mode 后，改为发送完整 mode 并删除布尔兼容。
    params.reviewer_thinking_enabled = f.reviewerThinkingMode === 'enabled'
    if (f.reviewerThinkingBudget != null) params.reviewer_thinking_budget_tokens = f.reviewerThinkingBudget
    if (f.reviewerMaxTokens != null) params.reviewer_max_tokens = f.reviewerMaxTokens
  }
  if (f.evaluator) params.evaluator = f.evaluator
  if (f.maxIterations) params.max_iterations = f.maxIterations
  if (f.systemPrompt) params.system_prompt = f.systemPrompt
  if (f.reviewerEnabled && f.reviewerTaskGoal) params.reviewer_task_goal = f.reviewerTaskGoal
  if (f.prompt) params.starting_prompt = f.prompt

  const label = yamlPath.split('/').pop()?.replace(/\.ya?ml$/i, '') || ''
  return startRun({
    format: 'graph-yaml@1',
    program_path: yamlPath,
    work_dir: projectDir.value,
    label,
    params,
  })
}

async function doStart() {
  if (!projectDir.value) { toast.error('请先选择项目目录'); return }
  starting.value = true
  try {
    const f = form.value
    const sessionModelName = sessionFormRef.value?.getSelectedModelName('session')
    const reviewerModelName = sessionFormRef.value?.getSelectedModelName('reviewer')
    const providerIndex = sessionFormRef.value?.getSelectedProviderIndex('session')
    const reviewerProviderIndex = sessionFormRef.value?.getSelectedProviderIndex('reviewer')

    if (graphYamlPath.value.trim() && pluginEnabled('graph')) {
      // Graph 工作流：起 workflow run 并跳 RunView
      const vars = parseGraphVars(f.prompt || '')
      const runId = await startWorkflowRun(graphYamlPath.value.trim(), vars)
      if (runId) {
        toast.success('工作流已启动')
        show.value = false
        router.push(`/run/${runId}`)
      }
    } else {
      // 普通 session
      const result = await start(
        projectDir.value,
        f.prompt || undefined,
        f.runtime || undefined,
        {
          model: sessionModelName,
          reviewer_model: f.reviewerEnabled ? reviewerModelName : undefined,
          reviewer_enabled: f.reviewerEnabled,
          reviewer_thinking_mode: configResolved.value ? f.reviewerThinkingMode : undefined,
          reviewer_thinking_budget_tokens: configResolved.value ? (f.reviewerThinkingBudget ?? undefined) : undefined,
          reviewer_max_tokens: configResolved.value ? (f.reviewerMaxTokens ?? undefined) : undefined,
          system_prompt: f.systemPrompt || undefined,
          evaluator: f.evaluator || undefined,
          max_iterations: f.maxIterations || undefined,
          reviewer_task_goal: f.reviewerEnabled ? (f.reviewerTaskGoal || undefined) : undefined,
          provider_index: providerIndex,
          reviewer_provider_index: f.reviewerEnabled ? reviewerProviderIndex : undefined,
          cli_wrapper: effectiveCliWrapper(f.runtime, f.cliWrapper),
        },
      )
      if (result?.error) { toast.error(result.error); return }
      toast.success('会话已启动')
      show.value = false
      emit('started', result.session_id || result.id || '')
    }
  } catch (e: any) {
    toast.error(`启动失败: ${e}`)
  } finally {
    starting.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="新建会话" style="width:700px" :segmented="true">
    <n-flex vertical :size="16">
      <!-- Graph YAML 路径（仅 graph 插件 enable 时显示） -->
      <n-flex v-if="pluginEnabled('graph')" vertical :size="4">
        <span style="font-size:13px;font-weight:600;color:var(--workflow-controller-text, #cbd5e1)">YAML 路径（留空则创建普通会话）</span>
        <n-input v-model:value="graphYamlPath" placeholder="graph yaml 文件路径，留空 = 普通会话" :input-props="{ spellcheck: false }" />
      </n-flex>
      <session-form
        ref="sessionFormRef"
        v-model="form"
        :project-config-loaded="projectConfigLoaded"
      />
      <n-flex>
        <n-button :disabled="!projectDir || loading || !authReady || starting" @click="doStart">
          <template #icon><n-spin v-if="starting" :size="12" /></template>
          {{ graphYamlPath.trim() && pluginEnabled('graph') ? '启动工作流' : '启动会话' }}
        </n-button>
        <n-button @click="show = false">取消</n-button>
      </n-flex>
    </n-flex>
  </n-modal>
</template>

<style>
/* Naive UI 把 select 菜单 teleport 到 body，选项态需跟随当前主题（scoped 样式无法命中）。 */
.n-base-select-menu .n-base-select-option,
.n-base-select-menu .n-base-select-option--selected,
.n-base-select-menu .n-base-select-option--pending {
  background: var(--workflow-controller-modal) !important;
  color: var(--workflow-controller-text) !important;
}
.n-base-select-menu .n-base-select-option--selected,
.n-base-select-menu .n-base-select-option--pending {
  background: color-mix(in srgb, var(--workflow-controller-primary) 22%, var(--workflow-controller-modal)) !important;
  color: var(--workflow-controller-text) !important;
}
.n-base-select-menu .n-base-select-option__check { color: var(--workflow-controller-primary) !important; }
</style>
