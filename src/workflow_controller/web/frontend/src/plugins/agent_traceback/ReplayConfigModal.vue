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

// 检查点重放弹窗，复用 SessionForm 表单主体。语义：文件态 / L2 / 检查点链忠实继承到
// 检查点时刻，driver 层配置（模型 / 框架 / Reviewer）改用用户当前选择。提示词默认值为
// 「请继续你之前的工作。」，提交到 POST /api/sessions/{id}/traceback。
import { ref } from 'vue'
import { NModal, NButton, NFlex, NSpin, NAlert } from 'naive-ui'
import { useToast } from '../../composables/useToast'
import { useAuth } from '../../composables/useAuth'
import SessionForm, { type SessionFormState } from '../../components/SessionForm.vue'
import { useCheckpoints, type TracebackOverrides } from './useCheckpoints'
import type { CheckpointInfo, TracebackResult } from './types'
import { resolveReviewerThinking } from '../../utils/reviewerConfig'

const props = defineProps<{
  sessionId: string
  checkpoint: CheckpointInfo | null
  // origin session 的 project_dir（用于读项目配置初始化 form；空则用全局默认）。
  projectDir?: string
}>()

const emit = defineEmits<{
  (e: 'replayed', result: TracebackResult): void
}>()

const show = ref(false)
const submitting = ref(false)
const toast = useToast()
const { authReady } = useAuth()
const { traceback, getReplayRuntime } = useCheckpoints()

// 重放首轮续跑信号（须与 traceback_runner.py 的 _TRACEBACK_CONTINUE_PROMPT 保持一致）。
const TRACEBACK_CONTINUE_PROMPT = '请继续你之前的工作。'

// runtime 未选择时继承源配置；显式 runtime 下发空值表示关闭。
function effectiveCliWrapper(runtime: string | null | undefined, cliWrapper: string | null | undefined) {
  if (runtime == null) return undefined
  return ['claude_cli', 'opencode'].includes(runtime) ? cliWrapper || '' : ''
}

// 可重放的来源 runtime：claude_sdk 来源会话无对话史 seed 路径，重放必然被后端拒绝，
// 预选它为运行时只会引导到必然失败的选择。
const REPLAYABLE_RUNTIMES = ['claude_cli', 'opencode']

const form = ref<SessionFormState>({
  runtime: undefined,
  cliWrapper: '',
  prompt: TRACEBACK_CONTINUE_PROMPT,
  sessionModel: '',
  reviewerModel: '',
  reviewerEnabled: true,
  reviewerThinking: false,
  reviewerThinkingBudget: 2048,
  reviewerMaxTokens: 2048,
  systemPrompt: '',
  evaluator: null,
  maxIterations: 10,
  reviewerTaskGoal: '',
})

const projectConfigLoaded = ref(false)
// 配置成功解析才下发 reviewer_enabled/thinking 覆盖；失败时保持 origin 继承（更保守兜底）。
const configResolved = ref(false)
const sessionFormRef = ref<InstanceType<typeof SessionForm> | null>(null)
let configRequestSeq = 0

async function loadProjectConfig() {
  const seq = ++configRequestSeq
  // 用 origin 的 project_dir 读项目配置给 form 初值；不读 origin 的 config_json，
  // 因为重放用用户当前选择，不继承 origin 的 driver 层配置。
  try {
    const dir = props.projectDir
    const url = dir ? `/api/v1/project-config?dir=${encodeURIComponent(dir)}` : '/api/v1/project-config'
    const [projectResponse, globalResponse, originRuntime] = await Promise.all([
      fetch(url), fetch('/api/v1/config'), getReplayRuntime(props.sessionId),
    ])
    const [cfg, globalConfig] = await Promise.all([projectResponse.json(), globalResponse.json()])
    if (seq !== configRequestSeq) return
    configResolved.value = true
    const thinking = resolveReviewerThinking(cfg?.reviewer, globalConfig?.reviewer)
    form.value.reviewerThinking = thinking.enabled
    form.value.reviewerThinkingBudget = thinking.budgetTokens
    form.value.reviewerMaxTokens = thinking.maxTokens
    const detected = originRuntime || cfg?.runtime
    form.value.runtime = detected && REPLAYABLE_RUNTIMES.includes(detected) ? detected : undefined
    form.value.cliWrapper = cfg?.cli_wrapper || ''
    form.value.systemPrompt = cfg?.system_prompt ?? ''
    form.value.evaluator = cfg?.loop?.evaluator ?? null
    form.value.maxIterations = cfg?.loop?.max_iterations ?? 10
    form.value.reviewerTaskGoal = cfg?.reviewer?.task_goal ?? ''
    form.value.reviewerEnabled = cfg?.reviewer?.enabled ?? globalConfig?.reviewer?.enabled ?? true
    // prompt 不取 starting_prompt，保留 open() 已设的重放默认续跑信号；
    // 此处不重置，避免 fetch 期间用户已编辑的内容被覆盖。
  } catch {
    // 加载失败：保留默认初值，用户可手填。
  } finally {
    if (seq === configRequestSeq) projectConfigLoaded.value = true
  }
}

function open() {
  show.value = true
  // 重置 form，避免上次残留。
  form.value = {
    runtime: undefined,
    cliWrapper: '',
    prompt: TRACEBACK_CONTINUE_PROMPT,
    sessionModel: '',
    reviewerModel: '',
    reviewerEnabled: true,
    reviewerThinking: false,
    reviewerThinkingBudget: 2048,
    reviewerMaxTokens: 2048,
    systemPrompt: '',
    evaluator: null,
    maxIterations: 10,
    reviewerTaskGoal: '',
  }
  projectConfigLoaded.value = false
  configResolved.value = false
  loadProjectConfig()
}

async function doTraceback() {
  if (!props.checkpoint) { toast.error('未指定检查点'); return }
  if (!props.sessionId) { toast.error('未指定源会话'); return }
  submitting.value = true
  try {
    const f = form.value
    const sessionModelName = sessionFormRef.value?.getSelectedModelName('session')
    const reviewerModelName = sessionFormRef.value?.getSelectedModelName('reviewer')
    // opencode driver 仅当 model 含 / 才透传 -m，故下发 provider 的 model 名（含 / 原样下发，
    // 裸名由后端兜底解析）。
    const overrides: TracebackOverrides = {}
    const cliWrapper = effectiveCliWrapper(f.runtime, f.cliWrapper)
    if (cliWrapper !== undefined) overrides.cli_wrapper = cliWrapper
    if (sessionModelName) overrides.model = sessionModelName
    const providerIndex = sessionFormRef.value?.getSelectedProviderIndex('session')
    const reviewerProviderIndex = sessionFormRef.value?.getSelectedProviderIndex('reviewer')
    if (providerIndex != null) overrides.provider_index = providerIndex
    if (reviewerModelName) overrides.reviewer_model = reviewerModelName
    if (reviewerProviderIndex != null) overrides.reviewer_provider_index = reviewerProviderIndex
    if (configResolved.value) {
      overrides.reviewer_enabled = f.reviewerEnabled
      overrides.reviewer_thinking_enabled = f.reviewerThinking
      if (f.reviewerThinkingBudget != null) overrides.reviewer_thinking_budget_tokens = f.reviewerThinkingBudget
      if (f.reviewerMaxTokens != null) overrides.reviewer_max_tokens = f.reviewerMaxTokens
    }
    if (f.systemPrompt) overrides.system_prompt = f.systemPrompt
    if (f.evaluator) overrides.evaluator = f.evaluator
    if (f.maxIterations != null && f.maxIterations > 0) overrides.max_iterations = f.maxIterations
    if (f.reviewerTaskGoal) overrides.reviewer_task_goal = f.reviewerTaskGoal
    if (f.prompt) overrides.initial_prompt = f.prompt
    const result: TracebackResult = await traceback(
      props.sessionId, props.checkpoint.checkpoint_id,
      f.runtime || undefined, overrides,
    )
    if (result.ok && result.session_id) {
      toast.success('重放会话已启动')
      show.value = false
      emit('replayed', result)
    } else {
      toast.error(`重放失败: ${result.error || '未知错误'}`)
    }
  } catch (e: any) {
    toast.error(`重放出错: ${e}`)
  } finally {
    submitting.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="`重放检查点 ${checkpoint?.checkpoint_id || ''}`"
    style="width:700px"
    :segmented="true"
  >
    <n-flex vertical :size="16">
      <!-- 重放语义说明 -->
      <n-alert type="info" :bordered="false">
        文件态与对话态将回到检查点时刻；模型与框架使用你当前的选择。
      </n-alert>

      <session-form
        ref="sessionFormRef"
        v-model="form"
        :project-config-loaded="projectConfigLoaded"
        :disabled-runtimes="['claude_sdk']"
      />

      <n-flex>
        <n-button
          :disabled="!checkpoint || submitting || !authReady"
          @click="doTraceback"
        >
          <template #icon><n-spin v-if="submitting" :size="12" /></template>
          确认重放
        </n-button>
        <n-button @click="show = false">取消</n-button>
      </n-flex>
    </n-flex>
  </n-modal>
</template>
