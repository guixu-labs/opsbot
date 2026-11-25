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

// 共享会话配置表单主体。被 NewSessionModal（新建会话）与 ReplayConfigModal（重放检查点）
// 共用，表单状态经 defineModel 双向绑定回父组件，提交语义（端点 / 提示词默认值 /
// 初始化来源）由父组件决定。
import { computed, h, watch } from 'vue'
import { NInput, NInputNumber, NSelect, NFormItem, NFlex, NCollapse, NCollapseItem, NSwitch, NTooltip } from 'naive-ui'
import { useSSE } from '../composables/useSSE'
import { useAuth } from '../composables/useAuth'

export interface SessionFormState {
  runtime?: string | null
  cliWrapper?: string | null
  prompt: string
  sessionModel: string
  reviewerModel: string
  reviewerEnabled: boolean
  reviewerThinkingMode?: string
  // 删除：traceback 重放插件尚未迁移；其改用 thinking_mode 后删除旧布尔状态。
  reviewerThinking?: boolean
  reviewerThinkingBudget: number | null
  systemPrompt?: string | null
  evaluator?: string | null
  maxIterations?: number | null
  reviewerTaskGoal?: string | null
}

// form 经 defineModel 双向绑定（父组件持有 reactive 状态，本组件只渲染 + 同步 provider 选择）。
const form = defineModel<SessionFormState>({ required: true })

// projectConfigLoaded：控制「高级设置」内层渲染（未加载时显示「加载中…」占位）。
const props = defineProps<{
  projectConfigLoaded?: boolean
  // 禁用的 runtime 值（如重放表单禁用 claude_sdk——它不是可重放的来源 runtime）。
  disabledRuntimes?: string[]
}>()

const { authState } = useSSE()
const { authReady } = useAuth()

// 评估器类型 → 完成规则一句话说明；键序即下拉选项顺序
const evaluatorDescriptions: Record<string, string> = {
  passthrough: '不由评估器判断完成，达到最大迭代后停止。',
  always_complete: '第一轮结束后即视为完成，适合一次性任务。',
  feedback: '由 Reviewer 模型按 Reviewer 目标逐轮判断是否完成。',
  max_iteration: '以最大迭代次数作为完成标准。',
}
const evaluatorTypes = Object.keys(evaluatorDescriptions)

// 代理框架展示名：顶部下拉与 Reviewer 模型选项共用，同一 runtime 一词一译。
const runtimeLabels: Record<string, string> = {
  claude_sdk: 'Claude SDK',
  claude_cli: 'Claude CLI',
  opencode: 'OpenCode',
  codex_cli: 'Codex CLI',
}

// 代理框架下拉选项：禁用父组件标记的 runtime（重放表单禁用 claude_sdk）。
const runtimeOptions = computed(() => {
  const disabled = new Set(props.disabledRuntimes || [])
  return Object.entries(runtimeLabels).map(([value, label]) => ({ label, value, disabled: disabled.has(value) }))
})

// ── Model selection ──────────────────────────────────────────
const allProviders = computed(() => authState.value?.providers || [])

function quotaUnavailable(p: any) {
  return p.status !== 'unused' && p.status !== 'active'
}

// Provider 显示名优先取自定义名，旧后端/异常数据回落模型名。
function providerDisplayName(p: any) {
  return (p.custom_name || '').trim() || p.model || '(无模型)'
}

const workerModelOptions = computed(() =>
  allProviders.value.filter((p: any) => {
    const validation = p.worker_validation || {}
    return !quotaUnavailable(p) && validation.status === 'valid'
  }).map((p: any) => {
    const mismatch = !!form.value.runtime && p.runtime !== form.value.runtime
    const runtime = runtimeLabels[p.runtime] ?? p.runtime
    return {
      label: mismatch ? `${providerDisplayName(p)}（绑定 ${runtime}）` : providerDisplayName(p),
      value: String(p.index),
      disabled: mismatch,
    }
  }),
)

const reviewerModelOptions = computed(() =>
  allProviders.value.filter((p: any) => {
    const validation = p.reviewer_validation || {}
    return !quotaUnavailable(p) && validation.status === 'valid'
  }).map((p: any) => ({
    // Reviewer 池跨 runtime 并列，自定义名前带框架名区分归属。
    label: `${runtimeLabels[p.runtime] ?? p.runtime}：${providerDisplayName(p)}`,
    value: String(p.index),
    disabled: false,
  })),
)

// 模型选项悬浮显示 Provider base_url（为空则不提供悬浮）。
function renderModelOptionLabel(option: any) {
  const provider = allProviders.value.find((p: any) => String(p.index) === String(option.value))
  const url = (provider?.base_url || '').trim()
  if (!url) return option.label
  return h(NTooltip, { trigger: 'hover' }, {
    trigger: () => h('span', {}, option.label),
    default: () => url,
  })
}

const reviewerThinkingModes = computed(() => {
  const provider = allProviders.value.find(
    (item: any) => String(item.index) === form.value.reviewerModel,
  )
  const validation = provider?.reviewer_validation || {}
  const modes = Array.isArray(validation.thinking_modes)
    ? validation.thinking_modes.filter((mode: unknown) => typeof mode === 'string')
    : []
  return modes.length ? modes : (validation.thinking_mode ? [validation.thinking_mode] : [])
})
const reviewerThinkingModeOptions = computed(() => {
  const labels: Record<string, string> = {
    disabled: 'Disabled',
    enabled: 'Enabled',
    adaptive: 'Adaptive',
    omitted: 'Omitted',
  }
  return ['disabled', 'enabled', 'adaptive', 'omitted']
    .filter(mode => reviewerThinkingModes.value.includes(mode))
    .map(mode => ({ label: labels[mode], value: mode }))
})
const usesThinkingModes = computed(() => form.value.reviewerThinkingMode !== undefined)
const reviewerThinkingBudgetAvailable = computed(() =>
  form.value.reviewerEnabled
  && (usesThinkingModes.value
    ? form.value.reviewerThinkingMode === 'enabled'
    : form.value.reviewerThinking === true)
)

const activeProviderIndex = computed(() => {
  const p = allProviders.value.find((x: any) => x.is_active)
  return p ? String(p.index) : ''
})

function getProviderByIndex(idx: number) {
  return allProviders.value.find((p: any) => p.index === idx) || null
}

// 取选中 provider 的 model 名（提交时由父组件调用，下发后端）。
function getSelectedModelName(which: 'session' | 'reviewer'): string | undefined {
  const idxStr = which === 'session' ? form.value.sessionModel : form.value.reviewerModel
  if (!idxStr) return undefined
  const p = getProviderByIndex(Number(idxStr))
  return p?.model || undefined
}

function getSelectedProviderIndex(which: 'session' | 'reviewer'): number | undefined {
  const value = which === 'session' ? form.value.sessionModel : form.value.reviewerModel
  return value ? Number(value) : undefined
}

function selectUsableModels() {
  const worker = workerModelOptions.value.find((o: any) => o.value === form.value.sessionModel && !o.disabled)
  if (!worker) {
    form.value.sessionModel = workerModelOptions.value.find((o: any) => !o.disabled)?.value || ''
  }
  const reviewer = reviewerModelOptions.value.find((o: any) => o.value === form.value.reviewerModel && !o.disabled)
  if (!reviewer) {
    form.value.reviewerModel = reviewerModelOptions.value.find((o: any) => !o.disabled)?.value || ''
  }
}

watch([authState, () => form.value.runtime], selectUsableModels, { immediate: false })

watch(
  [authState, () => form.value.reviewerModel, () => form.value.reviewerThinkingMode],
  () => {
    if (!usesThinkingModes.value) return
    if (!reviewerThinkingModes.value.length) return
    if (!reviewerThinkingModes.value.includes(form.value.reviewerThinkingMode)) {
      const requested = form.value.reviewerThinkingMode || 'disabled'
      const preferences: Record<string, string[]> = {
        disabled: ['disabled', 'omitted', 'adaptive', 'enabled'],
        enabled: ['enabled', 'adaptive', 'omitted', 'disabled'],
        adaptive: ['adaptive', 'omitted', 'enabled', 'disabled'],
        omitted: ['omitted', 'adaptive', 'disabled', 'enabled'],
      }
      form.value.reviewerThinkingMode = (preferences[requested]
        ?.find((mode: string) => reviewerThinkingModes.value.includes(mode)))
        || reviewerThinkingModes.value[0]
        || 'disabled'
    }
  },
  { immediate: true },
)

watch(authReady, (ready) => {
  if (ready && activeProviderIndex.value) {
    selectUsableModels()
  }
}, { immediate: true })

defineExpose({
  getSelectedModelName,
  getSelectedProviderIndex,
  authReady,
})
</script>

<template>
  <n-flex vertical :size="16">
    <n-flex :size="12" style="width:100%">
      <n-form-item label="代理框架" :show-feedback="false" style="flex:1;min-width:0">
        <n-select
          v-model:value="form.runtime"
          :options="runtimeOptions"
        />
      </n-form-item>
      <n-form-item
        v-if="form.runtime != null && ['claude_cli', 'opencode', 'codex_cli'].includes(form.runtime)"
        label="通过 cpx 捕获"
        :show-feedback="false"
        style="flex:0 0 auto"
      >
        <n-switch
          :value="form.cliWrapper === 'cpx'"
          @update:value="value => form.cliWrapper = value ? 'cpx' : ''"
        />
      </n-form-item>
      <n-form-item label="会话模型" :show-feedback="false" style="flex:1;min-width:0">
        <n-select
          v-model:value="form.sessionModel"
          :options="workerModelOptions"
          :render-label="renderModelOptionLabel"
        />
      </n-form-item>
    </n-flex>
    <p v-if="form.runtime === 'opencode'" style="font-size:11px;color:var(--workflow-controller-text-muted, #94a3b8);margin:0 0 4px">
      OpenCode 需要带 provider 前缀，如 cannbot/glm-5.2、cannbot/deepseek-v4-pro。裸模型名会走 opencode 默认 provider。
    </p>

    <n-form-item label="提示词" :show-feedback="false">
      <n-input
        v-model:value="form.prompt"
        type="textarea"
        :rows="6"
        placeholder="默认为 workflow-controller.yaml 中的 starting_prompt"
      />
    </n-form-item>

    <!-- 高级设置（默认折叠） -->
    <n-collapse>
      <n-collapse-item title="高级设置" name="advanced">
        <n-flex v-if="projectConfigLoaded !== false" vertical :size="12">
          <n-flex :size="12" align="center">
            <n-form-item label="启用 Reviewer" :show-feedback="false">
              <n-switch v-model:value="form.reviewerEnabled" />
            </n-form-item>
            <n-form-item label="Reviewer 模型" :show-feedback="false" style="flex:1;min-width:0">
              <n-select v-model:value="form.reviewerModel" :options="reviewerModelOptions" :render-label="renderModelOptionLabel" :disabled="!form.reviewerEnabled" />
            </n-form-item>
          </n-flex>
          <n-flex :size="12" align="center">
            <n-form-item
              v-if="usesThinkingModes"
              label="Reviewer thinking mode"
              :show-feedback="false"
              style="flex:1;min-width:180px"
            >
              <n-select
                v-model:value="form.reviewerThinkingMode"
                :options="reviewerThinkingModeOptions"
                :disabled="!form.reviewerEnabled"
              />
            </n-form-item>
            <!-- 删除：traceback 重放插件迁移 thinking_mode 后删除旧布尔控件。 -->
            <n-form-item v-else label="Reviewer thinking" :show-feedback="false" style="flex:1;min-width:180px">
              <n-switch v-model:value="form.reviewerThinking" :disabled="!form.reviewerEnabled" />
            </n-form-item>
            <n-form-item label="思考 token 预算" :show-feedback="false" style="width:180px">
              <n-input-number v-model:value="form.reviewerThinkingBudget" :min="1024" :step="1024" :disabled="!form.reviewerEnabled || !reviewerThinkingBudgetAvailable" style="width:100%" />
            </n-form-item>
          </n-flex>
          <n-form-item label="系统提示词" :show-feedback="false">
            <n-input v-model:value="form.systemPrompt" type="textarea" :rows="2" placeholder="kernel 级行为约束" />
          </n-form-item>
          <n-flex :size="12">
            <n-form-item label="评估器" :show-feedback="false" style="flex:1">
              <n-select
                v-model:value="form.evaluator"
                :options="evaluatorTypes.map(t => ({ label: t, value: t }))"
              />
            </n-form-item>
            <n-form-item label="最大迭代" :show-feedback="false" style="width:150px">
              <n-input-number v-model:value="form.maxIterations" :min="1" style="width:120px" />
            </n-form-item>
          </n-flex>
          <p v-if="form.evaluator && evaluatorDescriptions[form.evaluator]"
            style="font-size:11px;color:#999;margin:-4px 0 4px">
            {{ evaluatorDescriptions[form.evaluator] }}
          </p>
          <n-form-item label="Reviewer 目标" :show-feedback="false">
            <n-input v-model:value="form.reviewerTaskGoal" type="textarea" :rows="3" :disabled="!form.reviewerEnabled" placeholder="feedback 评估器判完成的依据" />
          </n-form-item>
        </n-flex>
        <n-flex v-else>
          <span style="color:var(--workflow-controller-text-muted, #94a3b8);font-size:12px">加载中…</span>
        </n-flex>
      </n-collapse-item>
    </n-collapse>
  </n-flex>
</template>
