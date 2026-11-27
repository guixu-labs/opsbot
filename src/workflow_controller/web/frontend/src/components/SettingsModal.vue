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
import { computed, ref, shallowRef, watch, onMounted, h, nextTick } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NCard, NTag, NFlex, NCheckbox, NAlert, NDataTable, NFormItem, NEmpty, NModal, NTabs, NTabPane, NSpin, NText, NTooltip } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import { useAuth } from '../composables/useAuth'
import { useSettingsModal } from '../composables/useSettingsModal'
import { usePlugins } from '../composables/usePlugins'
import { DEFAULT_BRAND_NAME } from '../utils/brand'
import { APPEARANCE_FONT_OPTIONS, APPEARANCE_THEMES, DEFAULT_THEME_VALUE, cssUrlString, useAppearance } from '../composables/useAppearance'
import DirPicker from './common/DirPicker.vue'

const toast = useToast()
const { confirmDelete } = useConfirm()
const { checkAuth } = useAuth()
const { visible, initialSection } = useSettingsModal()
// 用共享单例（同 SessionDetailView）：toggle 后刷新这里的 plugins 即同步刷新
// 全局 pluginLoaded，SessionDetailView 的「检查点」等插件 tab 实时显隐。
const { plugins, loadPlugins } = usePlugins()

// 内置插件显示名/用途说明映射。新增内置插件时需同步更新
// docs/Web-UI.md 的插件表，避免两处漂移。
const pluginPresentation = new Map([
  ['agent_traceback', {
    label: '检查点回滚',
    description: '恢复检查点的文件状态和对话，创建分支会话继续运行。',
  }],
  ['breather', {
    label: '上下文交接',
    description: '上下文用量达到阈值时交接当前任务，由新会话继续。',
  }],
  ['fake_driver', {
    label: '测试驱动',
    description: '无需连接真实 Agent，即可验证运行流程。',
  }],
  ['file_provenance', {
    label: '变更溯源',
    description: '记录会话中的文件变更，支持查看和导出审计证据。',
  }],
  ['graph', {
    label: '图工作流',
    description: '按 YAML 定义的任务依赖运行工作流，并展示节点进度。',
  }],
  ['staged_pipeline', {
    label: '阶段门禁',
    description: '按项目配置逐阶段推进，满足当前阶段的完成条件后才放行。',
  }],
])

const config = ref<any>(null)
const projectConfig = ref<any>(null)
const saving = ref(false)
const tokenToggle = ref<string | null>(null)
const installingPlugin = ref(false)
const installPath = ref('')
const sections = ['全局设置', '外观', 'Watchdog', 'Context Bay 上传', '模型供应商', '插件']
const activeSection = ref(initialSection.value)
const {
  theme: appearanceTheme,
  font: appearanceFont,
  backgroundImage: appearanceBackgroundImage,
  backgroundImageError,
  backgroundImagePersistError,
  backgroundImageFit: appearanceBackgroundImageFit,
  setTheme,
  setFont,
  setBackgroundImage,
  setBackgroundImageFit,
} = useAppearance()
const draftAppearanceTheme = ref(appearanceTheme.value)
const draftAppearanceFont = ref(appearanceFont.value)
const draftAppearanceBackgroundImage = ref(appearanceBackgroundImage.value)
const draftAppearanceBackgroundImageFit = ref(appearanceBackgroundImageFit.value)
// 品牌名与同页其他外观字段一致走草稿：未点「保存外观设置」前不落盘，
// 避免改了品牌名后去「全局设置」保存把未确认的值一并写入。
const draftBrandName = ref('')
const draftSelectedTheme = computed(() => APPEARANCE_THEMES.find(item => item.value === draftAppearanceTheme.value) || APPEARANCE_THEMES.find(item => item.value === DEFAULT_THEME_VALUE)!)
const backgroundFileInput = ref<HTMLInputElement | null>(null)
const appearanceThemeOptions = [
  { label: '浅色主题', type: 'group', key: 'light', children: APPEARANCE_THEMES.filter(item => item.mode === 'light').map(item => ({ label: item.label, value: item.value })) },
  { label: '深色主题', type: 'group', key: 'dark', children: APPEARANCE_THEMES.filter(item => item.mode === 'dark').map(item => ({ label: item.label, value: item.value })) },
]
const backgroundImageFitOptions = [
  { label: '铺满（可能裁剪）', value: 'cover' },
  { label: '完整显示（可能留空白）', value: 'contain' },
]

// 每次打开弹窗时把草稿重置为当前生效值；主题/字体选择即时预览。
// 分区随打开入口走：路由深链（SettingsView open(section)）与侧栏入口共用
// initialSection——组件常驻挂载（App 无 v-if），onMounted 只跑一次，若不在
// 此处同步，深链 ?section=X 会永远停在挂载初值「全局设置」。
watch(visible, isVisible => {
  if (!isVisible) return
  activeSection.value = initialSection.value
  draftAppearanceTheme.value = appearanceTheme.value
  draftAppearanceFont.value = appearanceFont.value
  draftAppearanceBackgroundImage.value = appearanceBackgroundImage.value
  draftAppearanceBackgroundImageFit.value = appearanceBackgroundImageFit.value
  draftBrandName.value = config.value?.brand_name ?? DEFAULT_BRAND_NAME
})
watch(draftAppearanceTheme, value => { if (visible.value) setTheme(value) })
watch(draftAppearanceFont, value => { if (visible.value) setFont(value) })

onMounted(async () => {
  activeSection.value = initialSection.value
  await loadConfig(); await loadProjectConfig(); await loadPlugins(); await loadAuth(); await loadSessionProviders()
})

async function loadConfig() {
  const r = await fetch('/api/v1/config'); config.value = await r.json()
  if (typeof config.value?.brand_name !== 'string' || !config.value.brand_name.trim()) {
    config.value.brand_name = DEFAULT_BRAND_NAME
  }
  draftBrandName.value = config.value.brand_name
  if (config.value?.hook_server) config.value.hook_server.enabled = config.value.hook_server.enabled ?? true
  if (!config.value?.watchdog) config.value.watchdog = { enabled: true, subagent_timeout_seconds: 1800, track_file: '', file_stall_threshold: 3, track_keyword_file: '', track_keyword: '' }
  if (!config.value.context_bay) config.value.context_bay = { repo_url: '', snapshot_paths: [] }
}
async function loadProjectConfig() {
  try {
    const r = await fetch('/api/v1/project-config'); projectConfig.value = await r.json()
    if (!projectConfig.value?.loop) projectConfig.value.loop = { evaluator: null, max_iterations: 10 }
    if (!projectConfig.value?.reviewer) projectConfig.value.reviewer = { task_goal: '' }
  } catch { projectConfig.value = null }
}

async function saveWeb(successMessage = '全局设置已保存'): Promise<boolean> {
  saving.value = true
  try {
    const r1 = await fetch('/api/v1/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config.value) })
    if (!r1.ok) throw new Error(`HTTP ${r1.status}`)
    const r2 = await fetch('/api/v1/config/save', { method: 'POST' })
    if (!r2.ok) throw new Error(`HTTP ${r2.status}`)
    toast.success(successMessage)
    await loadSessionProviders()
    return true
  } catch (e: any) { toast.error(`保存失败: ${e}`); return false }
  finally {
    saving.value = false
  }
}

// 外观页只维护品牌名（存于全局配置）+ 主题/字体/背景图（存于浏览器本地）。
// 品牌 PUT 只带外观字段，避免把「全局设置」页尚未点击保存的改动一并落盘。
async function saveAppearance() {
  saving.value = true
  let prevBrandName: string | undefined
  try {
    prevBrandName = config.value.brand_name
    const brandName = (draftBrandName.value || '').trim() || DEFAULT_BRAND_NAME
    config.value.brand_name = brandName
    // fetch 在 4xx/5xx 也正常 resolve，两个请求都要校验 ok，否则校验/写盘失败仍提示成功
    const r1 = await fetch('/api/v1/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_name: brandName }) })
    if (!r1.ok) throw new Error(`HTTP ${r1.status}`)
    const r2 = await fetch('/api/v1/config/save', { method: 'POST' })
    if (!r2.ok) throw new Error(`HTTP ${r2.status}`)
    setTheme(draftAppearanceTheme.value)
    setFont(draftAppearanceFont.value)
    setBackgroundImage(draftAppearanceBackgroundImage.value)
    setBackgroundImageFit(draftAppearanceBackgroundImageFit.value)
    // 背景图经 watch 异步 apply/持久化，nextTick 后才能读到解码与落盘成败。
    await nextTick()
    toast.success('外观设置已保存')
    if (backgroundImageError.value) toast.warning(`背景图未生效：${backgroundImageError.value}`)
    if (backgroundImagePersistError.value) toast.warning(`背景图仅当次会话生效：${backgroundImagePersistError.value}`)
    return true
  } catch (e: any) {
    // 品牌名在请求前乐观写入本地 config（标题/侧栏即时生效），失败必须回滚
    config.value.brand_name = prevBrandName
    toast.error(`保存失败: ${e}`)
    return false
  }
  finally {
    saving.value = false
  }
}

function selectSection(s: string) {
  activeSection.value = s
  if (s === '模型供应商') loadAuth()
  if (s === '插件') loadPlugins()
}

// 本地背景图转 base64 data URL：原始文件上限 3MB（序列化后约 4MB 字符），
// 仍在 localStorage 约 5MB 配额内，避免静默持久化失败。
function onBackgroundImageFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) { toast.warning('请选择图片文件'); return }
  if (file.size > 3 * 1024 * 1024) { toast.warning('本地背景图不能超过 3MB'); return }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = String(reader.result || '')
    // 双重校验：即便原始文件 ≤3MB，也按序列化后的长度再校验一次。
    if (dataUrl.length > 4 * 1024 * 1024) {
      toast.warning('背景图过大，无法持久化保存（请换更小的图片）')
      return
    }
    draftAppearanceBackgroundImage.value = dataUrl
  }
  reader.onerror = () => toast.error('读取背景图失败')
  reader.readAsDataURL(file)
}

function backgroundCss(value: string) {
  return cssUrlString(value)
}

async function togglePlugin(name: string) {
  tokenToggle.value = name
  const r = await fetch(`/api/v1/plugins/${encodeURIComponent(name)}/toggle`, { method: 'POST' })
  const d = await r.json()
  if (d.error) { toast.error(d.error); tokenToggle.value = null; return }
  await loadPlugins()
  toast.info(`${d.name} 已${d.enabled ? '启用' : '禁用'}（保存后生效）`)
  tokenToggle.value = null
}

async function installPlugin() {
  if (!installPath.value) { toast.warning('未选择目录'); return }
  installingPlugin.value = true
  const r = await fetch('/api/v1/plugins/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: installPath.value }) })
  const d = await r.json()
  if (d.error) { toast.error(d.error); installingPlugin.value = false; return }
  await loadPlugins()
  installPath.value = ''
  installingPlugin.value = false
  toast.success('插件已安装 · 保存并刷新页面以生效')
}

// ── 插件配置：行内展开编辑（不离开设置弹窗）──────────────────────
const expandedPlugin = ref<string | null>(null)
const pluginConfigs = ref<Record<string, { fields: Record<string, any>, error: string }>>({})
const pluginConfigLoading = ref<string | null>(null)
const pluginSaving = ref<string | null>(null)
const templateUploadField = ref<string | null>(null)
const templateFileInput = ref<HTMLInputElement | null>(null)
const pendingTemplateFiles = shallowRef<Record<string, File | null>>({})
const templateFields: Record<string, { label: string; help: string; projectHelp: string }> = {
  handoff_prompt_path: {
    label: '交接指令',
    help: '可上传自定义交接指令，建议参考内置指令修改。留空并保存后，将使用内置交接指令。',
    projectHelp: '项目 workflow-controller.yaml 中的交接指令路径优先于这里的全局设置。',
  },
  continuation_prompt_path: {
    label: '接续指令',
    help: '用于告诉后续会话：读取交接文档后该如何继续任务。留空并保存后，将使用内置接续指令。',
    projectHelp: '项目 workflow-controller.yaml 中的接续指令路径优先于这里的全局设置。',
  },
}
const breatherFieldLabels: Record<string, string> = {
  context_window: '上下文窗口（Token）',
  handoff_wait_stop_timeout: '等待主代理停止超时（秒）',
  handoff_agent_timeout: '交接代理超时（秒）',
  handoff_skill: '交接技能名称',
}

function chooseTemplate(key: string) {
  templateUploadField.value = key
  templateFileInput.value?.click()
}

function downloadBuiltinInstructions(key: string) {
  const kind = key === 'handoff_prompt_path' ? 'handoff' : 'continuation'
  const link = document.createElement('a')
  link.href = `/api/v1/plugins/breather/builtin-instructions/${kind}`
  link.download = `workflow-${kind}-instructions.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
}

async function uploadTemplate(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const key = templateUploadField.value
  input.value = ''
  if (!file || !key) return
  if (!/\.(md|txt)$/i.test(file.name)) { toast.error('请选择 .md 或 .txt 文档'); return }
  if (file.size > 10 * 1024 * 1024) { toast.error('文档不能超过 10 MiB'); return }
  pendingTemplateFiles.value = { ...pendingTemplateFiles.value, [key]: file }
  toast.info(`已选择 ${file.name}；点击保存才会上传并启用`)
}

function clearPendingTemplate(key: string) {
  pendingTemplateFiles.value = { ...pendingTemplateFiles.value, [key]: null }
}

async function savePendingTemplates(fields: Record<string, any>) {
  for (const key of Object.keys(templateFields)) {
    const file = pendingTemplateFiles.value[key]
    if (!file) continue
    try {
      const r = await fetch(`/api/v1/plugins/breather/template?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: file,
      })
      const d = await r.json()
      if (!r.ok || !d.path) throw new Error(d.detail || d.error || `${file.name} 上传失败`)
      fields[key] = d.path
    } catch (e: any) {
      toast.error(`指令上传失败：${e}`)
    } finally {
      clearPendingTemplate(key)
    }
  }
}

function pluginFieldKeys(name: string): string[] {
  const keys = Object.keys(pluginConfigs.value[name]?.fields || {})
  return name === 'breather'
    ? keys.filter(key => key !== 'context_threshold_pct' && key !== 'subagent_context_threshold_pct' && key !== 'group_handoff_prompt_path' && key !== 'handoff_filename')
    : keys
}

function parseThreshold(value: unknown): number | null | undefined {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : undefined
}

async function togglePluginConfig(name: string) {
  if (expandedPlugin.value === name) { expandedPlugin.value = null; return }
  expandedPlugin.value = name
  if (!pluginConfigs.value[name]) await loadPluginConfig(name)
}

async function loadPluginConfig(name: string) {
  pluginConfigLoading.value = name
  try {
    const r = await fetch(`/api/v1/plugins/${encodeURIComponent(name)}/config`)
    const d = await r.json()
    if (d.error) { pluginConfigs.value[name] = { fields: {}, error: d.error } }
    else { pluginConfigs.value[name] = { fields: { ...d.fields }, error: '' } }
  } catch (e: any) {
    pluginConfigs.value[name] = { fields: {}, error: String(e) }
  }
  pluginConfigLoading.value = null
}

async function savePluginConfig(name: string) {
  const cfg = pluginConfigs.value[name]
  if (!cfg) return
  if (name === 'breather') {
    const main = parseThreshold(cfg.fields.context_threshold_pct)
    const child = parseThreshold(cfg.fields.subagent_context_threshold_pct)
    if (main == null || child === undefined) {
      toast.error('主代理和子代理阈值必须在 0～100% 之间；子代理可留空以沿用主代理阈值')
      return
    }
    cfg.fields.context_threshold_pct = main
    cfg.fields.subagent_context_threshold_pct = child
  }
  pluginSaving.value = name
  try {
    if (name === 'breather') await savePendingTemplates(cfg.fields)
    const r = await fetch(`/api/v1/plugins/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: cfg.fields }),
    })
    const d = await r.json()
    if (!r.ok || d.error) { toast.error(d.error || d.detail || '保存失败') }
    else { toast.success(`${name} 配置已保存`) }
  } catch (e: any) {
    toast.error(`保存失败: ${e}`)
  }
  pluginSaving.value = null
}

const dirPicker = ref<InstanceType<typeof DirPicker> | null>(null)
const browseTarget = ref('')

type ProviderDraft = { key: string, model: string, base_url: string, runtime: string, custom_name?: string, model_catalog_path?: string, provider_index?: number | null }
type PendingProviderDraft = Omit<ProviderDraft, 'runtime'> & { runtime?: string }

// Auth state
const authKeys = ref<Array<ProviderDraft & { provider_kind?: string, worker_validation?: any, reviewer_validation?: any }>>([])
const authDefaultModel = ref('')
const authDefaultUrl = ref('')
const authStatus = ref<any>({})
const authSaving = ref(false)
const authDefaultsSaving = ref(false)
const providerTestingIndex = ref<number | null>(null)

const pendingKey = ref<PendingProviderDraft>({ key: '', model: '', base_url: '', custom_name: '' })
// Provider 绑定单一 Worker runtime；真实 driver smoke test 按该值执行。
const pendingRuntime = ref<string | null>(null)
const pendingKeyTested = ref(false)
const pendingKeyTestOk = ref(false)
const pendingKeyTesting = ref(false)
const pendingKeyTestError = ref('')
const showCustomModelCatalog = ref(false)
const modelCatalogStatus = ref<'hidden' | 'builtin' | 'preset' | 'custom_required' | 'custom_invalid' | 'custom'>('hidden')
const modelCatalogName = ref('')
const resolvedModelCatalogPath = ref('')
const MODEL_CATALOG_ERROR = '请配置第三方 provider 官方推荐的 model catalog JSON 文件，并将所在绝对路径输入设置中'
const INVALID_MODEL_CATALOG_ERROR = '请输入合法且包含正确模型名的 model catalog JSON 文件路径'

// 测试通过只对当时那组参数有效：任一待测参数（runtime/密钥/模型/base_url）变动即失效，
// 确保存进去的就是实际测过的组合。
watch(
  [pendingRuntime, () => pendingKey.value.key, () => pendingKey.value.model, () => pendingKey.value.base_url, () => pendingKey.value.model_catalog_path],
  () => {
    pendingKeyTested.value = false
    pendingKeyTestOk.value = false
    pendingKeyTestError.value = ''
    resolvedModelCatalogPath.value = ''
  },
)

watch(
  [pendingRuntime, () => pendingKey.value.model, () => pendingKey.value.base_url],
  () => {
    modelCatalogStatus.value = 'hidden'
    modelCatalogName.value = ''
    if (!pendingKey.value.model_catalog_path) showCustomModelCatalog.value = false
  },
)

// 待测参数快照（与 /auth/test-key 请求体一致）。测试期间输入仍可改动：watch 会先清空
// 状态，旧响应返回时凭快照识别参数已变，丢弃结果而不是把未测过的组合重新放行。
function pendingKeyTestParams() {
  return JSON.stringify([
    pendingKey.value.key.trim(),
    pendingKey.value.model.trim(),
    pendingKey.value.base_url.trim(),
    pendingRuntime.value,
    pendingModelCatalogPath(),
  ])
}

function pendingModelCatalogPath() {
  return pendingRuntime.value === 'codex_cli'
    ? pendingKey.value.model_catalog_path?.trim() || ''
    : ''
}

const pendingSnapshotPath = ref('')

function addSnapshotPath() {
  const p = pendingSnapshotPath.value.trim()
  if (!p) return
  if (!config.value.context_bay.snapshot_paths.includes(p)) config.value.context_bay.snapshot_paths.push(p)
  pendingSnapshotPath.value = ''
}
function removeSnapshotPath(idx: number | string) {
  config.value.context_bay.snapshot_paths.splice(idx, 1)
}

function providerErrorTooltip(error?: string) {
  if (!error) return ''
  return error.length <= 500 ? error : `${error.slice(0, 500)}…`
}

function providerErrorContent(error: string) {
  return () => h('pre', {
    style: {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: '60vh',
      overflow: 'auto',
      margin: '0',
      fontSize: '12px',
      lineHeight: '1.5',
      fontFamily: 'JetBrains Mono, monospace',
    },
  }, error)
}

function capabilityValid(result: any, capability: 'worker' | 'reviewer') {
  return result?.[capability]?.status === 'valid'
}

function reviewerThinkingText(result: any) {
  const modes = Array.isArray(result?.reviewer?.thinking_modes)
    ? result.reviewer.thinking_modes
    : []
  const normalized = modes.filter((mode: unknown) => typeof mode === 'string')
  const fallback = result?.reviewer?.thinking_mode
  const display = normalized.length
    ? normalized
    : (fallback ? [fallback] : [])
  return display.length ? `\nReviewer thinking: ${display.join(' / ')}` : ''
}

function validationErrorMessage(result: any) {
  const workerError = result.worker?.error || result.error || '未知错误'
  const reviewerError = result.reviewer?.error
  return reviewerError
    ? `Worker：${workerError}\nReviewer：${reviewerError}`
    : workerError
}

async function retestProvider(index: number) {
  if (providerTestingIndex.value !== null) return
  providerTestingIndex.value = index
  try {
    const response = await fetch(`/api/v1/auth/keys/${index}/test`, { method: 'POST' })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.detail || result.error || `HTTP ${response.status}`)
    const workerValid = capabilityValid(result, 'worker')
    const reviewerValid = capabilityValid(result, 'reviewer')
    if (workerValid && reviewerValid) {
      toast.success('Worker 与 Reviewer 检测均通过')
    } else if (workerValid) {
      window.$dialog!.info({
        title: 'Worker 检测通过',
        content: providerErrorContent(`Reviewer 不可用：${result.reviewer?.error || '未知错误'}`),
        positiveText: '关闭',
      })
    } else if (reviewerValid) {
      window.$dialog!.info({
        title: 'Reviewer 检测通过',
        content: providerErrorContent(`Worker 不可用：${result.worker?.error || '未知错误'}${reviewerThinkingText(result)}`),
        positiveText: '关闭',
      })
    } else {
      window.$dialog!.error({
        title: 'Worker 与 Reviewer 检测失败',
        content: providerErrorContent(validationErrorMessage(result)),
        positiveText: '关闭',
      })
    }
  } catch (error) {
    window.$dialog!.error({
      title: '重测失败',
      content: providerErrorContent(error instanceof Error ? error.message : String(error)),
      positiveText: '关闭',
    })
  } finally {
    await loadAuth()
    providerTestingIndex.value = null
  }
}

async function testPendingKey() {
  if (!pendingKey.value.key.trim()) { toast.error('请输入密钥'); return }
  if (!pendingRuntime.value) { toast.error('请选择运行时'); return }
  pendingKeyTesting.value = true
  pendingKeyTestError.value = ''
  const testedParams = pendingKeyTestParams()

  const loadingDialog = window.$dialog!.info({
    title: '正在测试',
    content: `正在测试 ${pendingKey.value.model.trim() || '模型'} 连接...`,
    positiveText: undefined as unknown as string,
    negativeText: undefined as unknown as string,
    closable: false,
    maskClosable: false,
  })

  try {
    const r = await fetch('/api/v1/auth/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: pendingKey.value.key.trim(),
        model: pendingKey.value.model.trim(),
        base_url: pendingKey.value.base_url.trim(),
        runtime: pendingRuntime.value || undefined,
        model_catalog_path: pendingModelCatalogPath(),
      })
    })
    const d = await r.json()
    loadingDialog.destroy()
    if (pendingKeyTestParams() !== testedParams) {
      toast.warning('待测参数已改动，本次测试结果已忽略，请重新测试')
      return
    }
    pendingKeyTested.value = true
    pendingKeyTestOk.value = d.success
    resolvedModelCatalogPath.value = d.model_catalog_path || ''
    if (d.catalog_status) modelCatalogStatus.value = d.catalog_status
    if (d.model_catalog_name) modelCatalogName.value = d.model_catalog_name
    if (d.catalog_status === 'custom_required' || d.catalog_status === 'custom_invalid') {
      showCustomModelCatalog.value = true
      pendingKeyTestError.value = d.error || (
        d.catalog_status === 'custom_invalid'
          ? INVALID_MODEL_CATALOG_ERROR
          : MODEL_CATALOG_ERROR
      )
      if (d.reviewer?.status === 'valid') {
        window.$dialog!.info({
          title: 'Reviewer 检测通过',
          content: providerErrorContent(`Worker 不可用：${pendingKeyTestError.value}${reviewerThinkingText(d)}`),
          positiveText: '关闭',
        })
      } else {
        toast.error(pendingKeyTestError.value)
      }
      return
    }
    const workerValid = capabilityValid(d, 'worker')
    const reviewerValid = capabilityValid(d, 'reviewer')
    if (workerValid && reviewerValid) {
      window.$dialog!.info({
        title: '测试通过',
        content: `Worker 与 Reviewer 检测均通过${reviewerThinkingText(d).replace('\n', ' ')}`,
        positiveText: '好的',
      })
    } else if (workerValid) {
      window.$dialog!.info({
        title: 'Worker 检测通过',
        content: providerErrorContent(`Reviewer 不可用：${d.reviewer?.error || '未知错误'}`),
        positiveText: '好的',
      })
    } else if (reviewerValid) {
      window.$dialog!.info({
        title: 'Reviewer 检测通过',
        content: providerErrorContent(`Worker 不可用：${d.worker?.error || '未知错误'}${reviewerThinkingText(d)}`),
        positiveText: '好的',
      })
    } else {
      pendingKeyTestError.value = d.error || '测试失败'
      window.$dialog!.error({
        title: 'Worker 与 Reviewer 检测失败',
        content: providerErrorContent(validationErrorMessage(d)),
        positiveText: '关闭',
      })
    }
  } catch (e: any) {
    loadingDialog.destroy()
    if (pendingKeyTestParams() !== testedParams) return
    const message = e instanceof Error ? e.message : String(e)
    pendingKeyTested.value = true; pendingKeyTestOk.value = false; pendingKeyTestError.value = message
    window.$dialog!.error({
      title: '测试失败',
      content: providerErrorContent(message),
      positiveText: '关闭',
    })
  } finally {
    pendingKeyTesting.value = false
  }
}

// 判断待添加配置是否已存在。
function pendingProviderExists(entry: ProviderDraft) {
  return authKeys.value.some(provider =>
    provider.key.trim() === entry.key
    && provider.model.trim() === entry.model
    && provider.base_url.trim() === entry.base_url
    && provider.runtime.trim() === entry.runtime
    && (provider.model_catalog_path || '').trim() === (entry.model_catalog_path || '')
  )
}

// 复制已配置供应商到待添加表单。
function copyProviderToPending(providerIndex: number) {
  const provider = authKeys.value.find(provider => provider.provider_index === providerIndex)
  if (!provider) return
  pendingKey.value = {
    key: provider.key,
    model: provider.model,
    base_url: provider.base_url,
    // 自定义名不复制：新 Provider 须重新命名以满足全局唯一。
    custom_name: '',
    ...(provider.model_catalog_path ? { model_catalog_path: provider.model_catalog_path } : {}),
  }
  pendingRuntime.value = provider.runtime || null
  showCustomModelCatalog.value = Boolean(provider.model_catalog_path)
}

// 写入并保存待添加供应商，失败时回滚本地列表。
async function addPendingProviderAndSave() {
  if (!pendingKeyTestOk.value) return
  const pendingModelName = pendingKey.value.model.trim()
  // 探测出的协议包只留在后端状态中，避免与显式配置混淆。
  const entry: ProviderDraft = {
    key: pendingKey.value.key.trim(),
    model: pendingModelName,
    base_url: pendingKey.value.base_url.trim(),
    runtime: pendingRuntime.value!,
      ...(
        pendingRuntime.value === 'codex_cli'
        && resolvedModelCatalogPath.value.trim()
      ) ? { model_catalog_path: resolvedModelCatalogPath.value.trim() } : {},
  }
  if (pendingProviderExists(entry)) {
    pendingKey.value = { key: '', model: '', base_url: '', custom_name: '' }
    pendingRuntime.value = null
    pendingKeyTested.value = false
    pendingKeyTestOk.value = false
    pendingKeyTestError.value = ''
    resolvedModelCatalogPath.value = ''
    toast.warning('该 Provider 配置已存在，未重复添加')
    return
  }
  // 配置重复检查在前：完全相同的配置直接提示已存在，不落入命名冲突分支。
  const customName = pendingKey.value.custom_name?.trim() || ''
  const occupiedNames = new Set(
    authKeys.value.map(provider => (provider.custom_name || '').trim()).filter(Boolean),
  )
  if (customName && occupiedNames.has(customName)) {
    toast.error(`自定义名重复：${customName}`)
    return
  }
  if (!customName && pendingModelName && occupiedNames.has(pendingModelName)) {
    toast.error('模型名已被其他自定义名占用，请输入自定义名')
    return
  }
  entry.custom_name = customName
  const previousKeys = authKeys.value.map(entry => ({ ...entry }))
  authSaving.value = true
  try {
    authKeys.value.push(entry)
    await syncKeys(false)
    pendingKey.value = { key: '', model: '', base_url: '', custom_name: '' }
    pendingRuntime.value = null
    pendingKeyTested.value = false
    pendingKeyTestOk.value = false
    pendingKeyTestError.value = ''
    resolvedModelCatalogPath.value = ''
  } catch (e: any) {
    authKeys.value = previousKeys
    toast.error(`保存失败: ${e}`)
  } finally { authSaving.value = false }
}

async function deleteProvider(providerIndex: number) {
  const index = authKeys.value.findIndex(provider => provider.provider_index === providerIndex)
  if (index < 0) return
  const p = authKeys.value[index]
  if (!await confirmDelete(`${p.custom_name || p.model || '默认模型'} 的密钥`)) return
  try {
    const response = await fetch(`/api/v1/auth/keys/${providerIndex}`, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.detail || body.error || `HTTP ${response.status}`)
    }
    await loadAuth()
    await checkAuth()
  } catch (e: any) {
    toast.error(`删除失败: ${e}`)
  }
}

async function loadAuth() {
  try {
    const r = await fetch('/api/v1/auth/keys'); const d = await r.json()
    authKeys.value = (d.keys || []).map((k: any) => ({
      key: k.key || '', model: k.model || '', base_url: k.base_url || '', runtime: k.runtime || '',
      custom_name: k.custom_name || '',
      ...(k.model_catalog_path ? { model_catalog_path: k.model_catalog_path } : {}),
      provider_index: k.provider_index ?? null,
      provider_kind: k.provider_kind || '',
      worker_validation: k.worker_validation, reviewer_validation: k.reviewer_validation,
    }))
  } catch {}
  try {
    const r = await fetch('/api/v1/auth/settings'); const d = await r.json()
    authDefaultModel.value = d.default_model || ''; authDefaultUrl.value = d.default_url || ''
  } catch {}
  try { const r = await fetch('/api/v1/auth/status'); authStatus.value = await r.json() } catch {}
}

async function saveAuthDefaults() {
  authDefaultsSaving.value = true
  try {
    const response = await fetch('/api/v1/auth/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_model: authDefaultModel.value.trim(),
        default_url: authDefaultUrl.value.trim(),
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || body.error || `HTTP ${response.status}`)
    await loadAuth()
    toast.success('全局默认设置已保存')
  } catch (error) {
    toast.error(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    authDefaultsSaving.value = false
  }
}

async function syncKeys(silent: boolean = false) {
  const keys = authKeys.value
    .filter(e => e.key.trim())
    .map(e => {
      const entry: Record<string, string> = { key: e.key.trim() }
      if (e.model.trim()) entry.model = e.model.trim()
      if (e.base_url.trim()) entry.base_url = e.base_url.trim()
      if (e.runtime.trim()) entry.runtime = e.runtime.trim()
      if (e.custom_name?.trim()) entry.custom_name = e.custom_name.trim()
      if (e.runtime.trim() === 'codex_cli' && e.model_catalog_path?.trim()) {
        entry.model_catalog_path = e.model_catalog_path.trim()
      }
      // 条目里显式配置的协议包（settings.conf 手工纠偏）随条目回传；
      // 探测值只存后端 auth_state.json，不回传以免污染 settings.conf
      if (e.provider_kind?.trim()) entry.provider_kind = e.provider_kind.trim()
      return entry
    })
  const response = await fetch('/api/v1/auth/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.detail || body.error || `HTTP ${response.status}`)
  }
  await loadAuth()
  if (!silent) { await checkAuth(); toast.success(`已保存 ${keys.length} 个密钥`) }
}

// ── Session model state ──────────────────────────────────────────
const sessionProviders = ref<Array<{provider: string, name: string, baseURL: string, models: string[]}>>([])
const sessionModel = ref('')

async function loadSessionProviders() {
  try {
    const r = await fetch('/api/v1/session/providers'); const d = await r.json()
    sessionProviders.value = d.providers || []; sessionModel.value = d.current_model || ''
  } catch (e: any) { toast.error(`加载失败: ${e}`) }
}

// 渲染供应商轮换状态标签。
function providerStatusTag(row: any) {
  const labels: Record<string, string> = {
    active: '默认',
    unused: '备用',
    exhausted: '额度耗尽',
    invalid: '凭据失效',
  }
  const status = row.status || 'unused'
  const type = status === 'active' ? 'success' : status === 'exhausted' ? 'warning' : status === 'invalid' ? 'error' : 'default'
  const title = status === 'active'
    ? '自动轮换时优先参考的全局 Provider'
    : status === 'exhausted'
      ? '额度或限流暂时耗尽'
      : status === 'invalid' ? '凭据认证失败' : '当前未作为自动轮换的默认 Provider'
  return h(NTag, { size: 'small', type, bordered: false, title }, { default: () => labels[status] || status })
}

// ── Provider 表格列定义 ──────────────────────────────────────────
const providerColumns: DataTableColumns<any> = [
  {
    title: () => h('span', { style: 'display:inline-flex;align-items:center;gap:3px' }, [
      '轮换状态',
      h(NTooltip, { trigger: 'hover' }, {
        trigger: () => h('span', {
          style: 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid var(--workflow-controller-border, #999);border-radius:50%;font-size:10px;color:var(--workflow-controller-text-muted, #777);cursor:help',
        }, '?'),
        default: () => '默认表示自动轮换时优先参考的全局 Provider，不代表当前会话正在使用，也不代表检测通过。',
      }),
    ]),
    key: 'status',
    width: 100,
    render: providerStatusTag,
  },
  {
    title: 'Base URL',
    key: 'base_url',
    width: 230,
    ellipsis: { tooltip: true },
    render(row) {
      return h('span', { style: 'font-family:monospace;font-size:11px;color:var(--workflow-controller-primary, #034cff)' }, row.base_url || '(默认)')
    },
  },
  {
    title: 'Model Catalog',
    key: 'model_catalog_path',
    width: 220,
    ellipsis: { tooltip: true },
    render(row) {
      const bound = row.runtime === 'codex_cli' && row.model_catalog_path
      return h('span', { style: 'font-size:11px;color:var(--workflow-controller-text-muted, #6f6f6f)' }, row.runtime === 'codex_cli' ? (bound ? '已绑定' : '内置/自动') : '—')
    },
  },
  {
    title: '模型',
    key: 'model',
    width: 180,
    ellipsis: { tooltip: true },
    render(row) {
      const custom = String(row.custom_name || '').trim()
      const label = custom ? (row.model ? `${custom}（${row.model}）` : custom) : row.model || '(默认)'
      return h('span', { style: 'color:var(--workflow-controller-text-muted, #6f6f6f);font-size:12px' }, label)
    },
  },
  {
    title: '密钥',
    key: 'key',
    width: 110,
    ellipsis: { tooltip: true },
    render(row) {
      return h('span', { style: 'font-family:monospace;font-size:12px' }, row.key || '—')
    },
  },
  {
    title: '运行时',
    key: 'runtime',
    width: 105,
    render(row) {
      const labels: Record<string, string> = {
        claude_sdk: 'Claude SDK', claude_cli: 'Claude CLI', opencode: 'OpenCode',
        codex_cli: 'Codex CLI',
      }
      return h(NTag, { class: 'provider-runtime-tag', size: 'tiny', bordered: false }, { default: () => labels[row.runtime] || row.runtime || '默认' })
    },
  },
  {
    title: '检测',
    key: 'validation',
    width: 185,
    render(row) {
      const worker = row.worker_validation?.status || 'untested'
      const reviewer = row.reviewer_validation?.status || 'untested'
      const tag = (label: string, status: string) => h(NTag, {
        size: 'tiny', bordered: false,
        type: status === 'valid' ? 'success' : status === 'invalid' ? 'error' : 'warning',
        title: providerErrorTooltip(
          status === 'invalid'
            ? (label === 'Worker' ? row.worker_validation?.error : row.reviewer_validation?.error)
            : '',
        ),
      }, { default: () => `${label}:${status}` })
      return h('span', { style: 'display:flex;gap:3px;flex-wrap:wrap' }, [tag('Worker', worker), tag('Reviewer', reviewer)])
    },
  },
  {
    title: '',
    key: 'retest',
    width: 92,
    render(row) {
      return h(NButton, {
        size: 'small', ghost: true,
        loading: providerTestingIndex.value === row.index,
        disabled: providerTestingIndex.value !== null,
        onClick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); void retestProvider(row.index) },
      }, { default: () => '重新测试' })
    },
  },
  {
    title: '',
    key: 'copy',
    width: 64,
    render(row) {
      return h(NButton, { size: 'small', type: 'primary', ghost: true, onClick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); copyProviderToPending(row.index) } }, { default: () => '复制' })
    },
  },
  {
    title: '',
    key: 'delete',
    width: 64,
    render(row) {
      return h(NButton, { size: 'small', type: 'error', ghost: true, disabled: providerTestingIndex.value !== null, onClick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); deleteProvider(row.index) } }, { default: () => '删除' })
    },
  },
]

function browseDir(target: string) {
  browseTarget.value = target
  const cfg = config.value as any
  dirPicker.value?.open(cfg?.[target] || undefined)
}

function onDirSelected(path: string) {
  if (browseTarget.value) { (config.value as any)[browseTarget.value] = path }
}
</script>

<template>
  <n-modal v-model:show="visible" preset="card" title="设置" style="width:min(1600px, 96vw)" :segmented="true" role="dialog">
    <n-flex v-if="config" style="height:65vh">
      <!-- 左侧 tab 导航 -->
      <div style="width:140px;flex-shrink:0;border-right:1px solid var(--workflow-controller-border, #e5e5e5);padding-right:12px">
        <n-tabs v-model:value="activeSection" placement="left" size="small" @update:value="selectSection">
          <n-tab-pane v-for="s in sections" :key="s" :name="s" :tab="s" />
        </n-tabs>
      </div>

      <!-- 右侧内容区 -->
      <div style="flex:1;min-width:0;overflow:auto;padding-left:16px;min-height:0;max-height:65vh">
        <!-- 外观 -->
        <div v-show="activeSection==='外观'">
          <n-flex vertical :size="16">
            <n-card title="主题" size="small" embedded class="appearance-card">
              <n-flex vertical :size="10">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">主题选择后立即生效。</span>
                <n-select v-model:value="draftAppearanceTheme" :options="appearanceThemeOptions" style="width:320px" />
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">当前主题：{{ draftSelectedTheme.label }}（{{ draftSelectedTheme.mode === 'dark' ? '深色' : '浅色' }}）</span>
              </n-flex>
            </n-card>
            <n-card title="字体" size="small" embedded class="appearance-card">
              <n-flex vertical :size="10">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">字体选择后立即应用到整个界面。</span>
                <n-select v-model:value="draftAppearanceFont" :options="APPEARANCE_FONT_OPTIONS" style="width:320px" />
              </n-flex>
            </n-card>
            <n-card title="品牌名称" size="small" embedded class="appearance-card">
              <n-flex align="center" :size="8">
                <n-input v-model:value="draftBrandName" :placeholder="DEFAULT_BRAND_NAME" style="width:280px" />
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">侧边栏标识与浏览器标签标题</span>
              </n-flex>
            </n-card>
            <n-card title="空态背景图" size="small" embedded class="appearance-card">
              <n-flex vertical :size="10">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">未选择会话时显示在主区域，支持图片 URL、data URL 或本地图片。</span>
                <n-input v-model:value="draftAppearanceBackgroundImage" placeholder="https://example.com/background.jpg" clearable />
                <n-flex align="center" :size="8">
                  <n-button size="small" @click="backgroundFileInput?.click()">选择本地图片</n-button>
                  <n-button v-if="draftAppearanceBackgroundImage" size="small" @click="draftAppearanceBackgroundImage = ''">清除背景图</n-button>
                </n-flex>
                <input ref="backgroundFileInput" class="background-file-input" type="file" accept="image/*" @change="onBackgroundImageFile" />
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">显示方式</span>
                <n-select v-model:value="draftAppearanceBackgroundImageFit" :options="backgroundImageFitOptions" style="width:320px" />
                <div v-if="draftAppearanceBackgroundImage" class="background-image-preview" :style="{ backgroundImage: backgroundCss(draftAppearanceBackgroundImage), backgroundSize: draftAppearanceBackgroundImageFit }" aria-label="背景图预览" />
              </n-flex>
            </n-card>
            <n-button type="primary" :disabled="saving" @click="saveAppearance">
              {{ saving ? '保存中...' : '保存外观设置' }}
            </n-button>
          </n-flex>
        </div>

        <!-- 全局设置 -->
        <div v-show="activeSection==='全局设置'">
          <n-flex vertical :size="16">
            <n-form-item label="Skills 路径">
              <n-flex style="width:100%">
                <n-input v-model:value="config.skills_path" style="flex:1" />
                <n-button size="small" @click="($event.currentTarget as HTMLElement).blur(); browseDir('skills_path')">浏览</n-button>
              </n-flex>
            </n-form-item>
            <n-form-item label="Agents 路径">
              <n-flex style="width:100%">
                <n-input v-model:value="config.agents_path" style="flex:1" />
                <n-button size="small" @click="($event.currentTarget as HTMLElement).blur(); browseDir('agents_path')">浏览</n-button>
              </n-flex>
            </n-form-item>

            <n-card title="Hook 服务器" size="small" embedded>
              <n-flex vertical :size="12">
                <n-checkbox v-model:checked="config.hook_server.enabled">启用（保存后重启生效）</n-checkbox>
                <n-form-item label="主机">
                  <n-input v-model:value="config.hook_server.host" placeholder="localhost" style="width:200px" />
                </n-form-item>
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">Hooks 自动生成到项目的 <code style="background:var(--workflow-controller-code, #f3f3f3);color:var(--workflow-controller-code-text, #1f2328);padding:1px 4px;border-radius:3px">.claude/settings.json</code></span>
              </n-flex>
            </n-card>

            <n-card title="审核" size="small" embedded>
              <n-flex vertical :size="12">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">审核模型使用 Dashboard 中选择的供应商的模型。</span>
                <n-form-item label="超时时间（秒）">
                  <n-input-number v-model:value="config.reviewer.timeout_seconds" style="width:150px" />
                </n-form-item>
                <n-form-item label="回复模式">
                  <n-select
                    v-model:value="config.reviewer.mode"
                    :options="[
                      { label: '自动 — 审核模型自动回复，hook 注入提醒', value: 'auto' },
                      { label: '手动 — 审核模型暂停，你在仪表盘回复', value: 'manual' }
                    ]"
                    style="width:400px"
                  />
                </n-form-item>
              </n-flex>
            </n-card>

            <n-button type="primary" :disabled="saving" @click="saveWeb()">{{ saving ? '保存中...' : '保存全局设置' }}</n-button>
          </n-flex>
        </div>

        <!-- Watchdog -->
        <div v-show="activeSection==='Watchdog'">
          <n-flex vertical :size="16">
            <p style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">subagent 异常检测通用能力。在 Session 详情页推送告警徽标，配置实时生效。</p>

            <!-- 规则 1：subagent 超时 -->
            <n-card title="规则 1：subagent 超时检测" size="small" embedded>
              <n-flex vertical :size="12">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">单个 subagent 运行超过阈值时触发告警。</span>
                <n-form-item label="超时阈值（秒）">
                  <n-input-number v-model:value="config.watchdog.subagent_timeout_seconds" :min="0" :step="10" style="width:200px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">设为 0 关闭该规则</span>
                </n-form-item>
              </n-flex>
            </n-card>

            <!-- 规则 2：文件不变 -->
            <n-card title="规则 2：文件不变检测" size="small" embedded>
              <n-flex vertical :size="12">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">连续 N 个 subagent 结束后指定文件内容无变化时触发告警。用于探测"同一 task 反复派发但未收敛"。</span>
                <n-form-item label="追踪文件">
                  <n-input v-model:value="config.watchdog.track_file" placeholder="如 logs/log.md 或 docs/add/develop/STATE.md" style="width:400px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">解析为 &lt;session 目录&gt;/logs/log.md</span>
                </n-form-item>
                <n-form-item label="连续未变化阈值">
                  <n-input-number v-model:value="config.watchdog.file_stall_threshold" :min="0" :step="1" style="width:200px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">设为 0 关闭该规则</span>
                </n-form-item>
              </n-flex>
            </n-card>

            <!-- 规则 3：关键词检测 -->
            <n-card title="规则 3：关键词检测" size="small" embedded>
              <n-flex vertical :size="12">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">每次 subagent 结束后检查指定文件中是否包含某关键词，包含即告警。大小写不敏感。</span>
                <n-form-item label="检测文件">
                  <n-input v-model:value="config.watchdog.track_keyword_file" placeholder="如 logs/log.md 或 docs/add/develop/STATE.md" style="width:400px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">相对 session 目录，不加 /</span>
                </n-form-item>
                <n-form-item label="关键词">
                  <n-input v-model:value="config.watchdog.track_keyword" placeholder="如 membase" style="width:200px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">文件包含此关键词时告警</span>
                </n-form-item>
              </n-flex>
            </n-card>

            <n-button type="primary" :disabled="saving" @click="saveWeb()">{{ saving ? '保存中...' : '保存设置' }}</n-button>
          </n-flex>
        </div>

        <!-- Context Bay 上传 -->
        <div v-show="activeSection==='Context Bay 上传'">
          <n-flex vertical :size="16">
            <n-card title="上传现场切片到 Context Bay" size="small" embedded>
              <n-flex vertical :size="12">
                <span style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">告警时点击「上传现场到 Context Bay」会把下列目录连同 session .db（insight 格式）收集到以 session 名命名的单一文件夹，git commit + push 到 Context Bay 仓。路径相对 session 目录解析。当前项目可在项目 workflow-controller.yaml 的 context_bay 段按项目覆盖。</span>
                <n-form-item label="Context Bay 仓地址">
                  <n-input v-model:value="config.context_bay.repo_url" placeholder="https://gitcode.com/<owner>/<repo>.git" style="width:560px" />
                  <span style="margin-left:8px;font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">留空上传时将报「未配置」</span>
                </n-form-item>
                <n-form-item label="切片目录">
                  <n-flex :size="8" align="center">
                    <n-input v-model:value="pendingSnapshotPath" placeholder="如 operators/add_custom_package/ 或 docs/add/" style="width:400px" @keydown.enter="addSnapshotPath" />
                    <n-button size="small" @click="addSnapshotPath">+ 添加</n-button>
                  </n-flex>
                </n-form-item>
                <div v-if="config.context_bay.snapshot_paths.length" style="display:flex;flex-direction:column;gap:6px">
                  <div v-for="(p, idx) in config.context_bay.snapshot_paths" :key="idx" class="snapshot-path-item" style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--workflow-controller-surface, #fafafa);border:1px solid var(--workflow-controller-border, #e5e5e5);border-radius:4px">
                    <span style="font-size:13px;color:var(--workflow-controller-text, #3a3a3a);flex:1;font-family:monospace">{{ p }}</span>
                    <n-button size="tiny" quaternary type="error" @click="removeSnapshotPath(idx)">删除</n-button>
                  </div>
                </div>
                <n-empty v-else description="未配置切片目录（默认只上传 events.db）" size="small" />
              </n-flex>
            </n-card>

            <n-button type="primary" :disabled="saving" @click="saveWeb()">{{ saving ? '保存中...' : '保存设置' }}</n-button>
          </n-flex>
        </div>

        <!-- 模型供应商 -->
        <div v-show="activeSection==='模型供应商'">
          <n-flex vertical :size="16">
            <p style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">管理 API 密钥池。审核和会话模型从 Dashboard 选择使用哪个供应商。</p>
            <p style="font-size:12px;color:var(--workflow-controller-text-muted, #6f6f6f)">OpenCode 运行时需要模型名带 provider 前缀，如 alibaba-cn/glm-5.2、zhipuai-coding-plan/glm-5.2、deepseek/deepseek-v4-pro。裸模型名会走 opencode 默认 provider。</p>

            <n-card title="全局默认设置" size="small" embedded>
              <n-flex vertical :size="12">
                <n-form-item label="默认模型" :show-feedback="false">
                  <n-input v-model:value="authDefaultModel" placeholder="默认模型，如 claude-sonnet-4-6" />
                </n-form-item>
                <n-form-item label="默认 Base URL" :show-feedback="false">
                  <n-input v-model:value="authDefaultUrl" placeholder="默认 Base URL（留空使用 Anthropic 官方端点）" />
                </n-form-item>
                <n-button type="primary" size="small" :loading="authDefaultsSaving" @click="saveAuthDefaults">
                  保存默认设置
                </n-button>
              </n-flex>
            </n-card>

            <n-card title="添加新供应商" size="small" embedded>
              <n-flex vertical :size="8">
                <n-select
                  v-model:value="pendingRuntime"
                  placeholder="Worker 运行时（必选）"
                  :options="[
                    { label: 'Claude SDK', value: 'claude_sdk' },
                    { label: 'Claude CLI', value: 'claude_cli' },
                    { label: 'OpenCode', value: 'opencode' },
                    { label: 'Codex CLI', value: 'codex_cli' },
                  ]"
                />
                <n-input
                  v-model:value="pendingKey.key"
                  type="password"
                  show-password-on="click"
                  placeholder="API 密钥（必填）"
                />
                <n-input v-model:value="pendingKey.model" :placeholder="authDefaultModel ? `模型（可选，默认 ${authDefaultModel}）` : '模型（可选，使用默认）'" />
                <n-input v-model:value="pendingKey.custom_name" placeholder="自定义名（可选；模型名已被其他自定义名占用时必填）" />
                <n-input v-model:value="pendingKey.base_url" :placeholder="authDefaultUrl ? `Base URL（可选，默认 ${authDefaultUrl}）` : 'Base URL（可选，使用默认）'" />
                <n-alert
                  v-if="pendingRuntime === 'codex_cli' && modelCatalogStatus !== 'hidden'"
                  :type="modelCatalogStatus === 'custom_required' || modelCatalogStatus === 'custom_invalid' ? 'warning' : 'info'"
                  :show-icon="false"
                  style="font-size:12px"
                >
                  {{ modelCatalogStatus === 'builtin'
                    ? '将使用 Codex 内置模型 metadata'
                    : modelCatalogStatus === 'preset'
                      ? `已自动匹配 ${modelCatalogName} 官方 model catalog`
                      : modelCatalogStatus === 'custom'
                        ? '已使用自定义 model catalog'
                        : modelCatalogStatus === 'custom_invalid'
                          ? INVALID_MODEL_CATALOG_ERROR
                          : MODEL_CATALOG_ERROR }}
                </n-alert>
                <n-input
                  v-if="pendingRuntime === 'codex_cli' && showCustomModelCatalog"
                  v-model:value="pendingKey.model_catalog_path"
                  placeholder="第三方 provider 官方 model catalog JSON 绝对路径（必填，支持 ~）"
                />
                <n-flex :size="8" align="center">
                  <n-button size="small" :disabled="pendingKeyTesting" @click="testPendingKey">{{ pendingKeyTesting ? '测试中...' : '测试' }}</n-button>
                  <n-button size="small" type="primary" :disabled="authSaving || !pendingKeyTestOk || providerTestingIndex !== null" @click="addPendingProviderAndSave">{{ authSaving ? '保存中...' : '添加并保存' }}</n-button>
                </n-flex>
              </n-flex>
            </n-card>

            <n-card :title="`已配置（${authStatus.provider_count || 0}）`" size="small" embedded style="min-width:0">
              <div v-if="authStatus.providers?.length" style="overflow-x:auto; max-width:100%">
                <n-data-table
                  :columns="providerColumns"
                  :data="authStatus.providers"
                  :bordered="false"
                  size="small"
                  table-layout="fixed"
                />
              </div>
              <n-empty v-else description="未配置供应商" size="small" />
            </n-card>
          </n-flex>
        </div>

        <!-- 插件 -->
        <div v-show="activeSection==='插件'">
          <n-empty v-if="plugins.length===0" description="未找到插件" size="small" />
          <n-flex v-else vertical :size="12">
            <n-flex v-for="p in plugins" :key="p.name" vertical :size="8">
              <n-flex :size="8" align="center">
                <n-tag :type="p.enabled?'success':'error'" size="small" round>{{ p.enabled?'已启用':'已禁用' }}</n-tag>
                <n-tooltip v-if="pluginPresentation.has(p.name)" trigger="hover">
                  <template #trigger>
                    <strong>{{ pluginPresentation.get(p.name)?.label }}</strong>
                  </template>
                  插件 ID：{{ p.name }}
                </n-tooltip>
                <strong v-else>{{ p.name }}</strong>
                <n-button size="small" :disabled="tokenToggle === p.name" @click="togglePlugin(p.name)" style="margin-left:auto">{{ tokenToggle === p.name ? '...' : (p.enabled ? '禁用' : '启用') }}</n-button>
                <n-button size="small" @click="togglePluginConfig(p.name)">{{ expandedPlugin===p.name ? '收起' : '配置' }}</n-button>
              </n-flex>
              <n-text v-if="pluginPresentation.has(p.name)" :depth="3">
                {{ pluginPresentation.get(p.name)?.description }}
              </n-text>
              <div v-show="expandedPlugin===p.name" style="padding:4px 0 4px 12px;border-left:2px solid var(--workflow-controller-border, #e5e5e5);margin-left:2px">
                <n-spin v-if="pluginConfigLoading===p.name" size="small" />
                <n-alert v-else-if="pluginConfigs[p.name]?.error" type="error" :show-icon="true" style="margin-bottom:8px">{{ pluginConfigs[p.name].error }}</n-alert>
                <n-flex v-else-if="pluginConfigs[p.name] && Object.keys(pluginConfigs[p.name].fields).length>0" vertical :size="10">
                  <template v-if="p.name==='breather'">
                    <n-form-item label="主代理阈值（%）" :show-feedback="false">
                      <n-flex vertical :size="4">
                        <n-input-number v-model:value="pluginConfigs[p.name].fields.context_threshold_pct" :min="0.01" :max="100" :precision="2" style="width:280px;max-width:100%" />
                        <n-text depth="3" style="font-size:12px">设为 100% 时只显示用量，不自动交接；手动交接仍可用。</n-text>
                      </n-flex>
                    </n-form-item>
                    <n-form-item label="子代理阈值（%）" :show-feedback="false">
                      <n-flex vertical :size="4">
                        <n-input-number v-model:value="pluginConfigs[p.name].fields.subagent_context_threshold_pct" :min="0.01" :max="100" :precision="2" clearable placeholder="留空沿用主代理阈值" style="width:280px;max-width:100%" />
                        <n-text depth="3" style="font-size:12px">留空沿用主代理阈值；设为 100% 时不自动交接。</n-text>
                      </n-flex>
                    </n-form-item>
                  </template>
                  <n-form-item v-for="key in pluginFieldKeys(p.name)" :key="key" :label="p.name==='breather' ? (templateFields[key]?.label || breatherFieldLabels[key] || key) : key" :show-feedback="false">
                    <n-flex vertical style="width:100%" :size="4">
                      <n-flex :size="8" style="width:100%">
                        <n-input v-model:value="pluginConfigs[p.name].fields[key]" :placeholder="templateFields[key] ? '填写路径或选择文档' : String(key)" style="flex:1" @update:value="p.name==='breather' && templateFields[key] ? clearPendingTemplate(key) : undefined" />
                        <n-button v-if="p.name==='breather' && templateFields[key]" size="small" @click="chooseTemplate(key)">选择文档</n-button>
                        <n-button v-if="p.name==='breather' && templateFields[key]" size="small" @click="downloadBuiltinInstructions(key)">下载内置指令</n-button>
                      </n-flex>
                      <n-text v-if="p.name==='breather' && pendingTemplateFiles[key]" depth="2" style="font-size:12px">待上传：{{ pendingTemplateFiles[key]?.name }}；点击保存时上传并启用</n-text>
                      <n-text v-if="p.name==='breather' && templateFields[key]" depth="3" style="font-size:12px">{{ templateFields[key].help }}</n-text>
                      <n-text v-if="p.name==='breather' && templateFields[key]" depth="3" style="font-size:12px">{{ templateFields[key].projectHelp }}</n-text>
                    </n-flex>
                  </n-form-item>
                  <n-flex :size="8">
                    <n-button size="small" type="primary" :disabled="pluginSaving===p.name" @click="savePluginConfig(p.name)">{{ pluginSaving===p.name ? '保存中...' : '保存' }}</n-button>
                  </n-flex>
                </n-flex>
                <n-empty v-else-if="pluginConfigs[p.name]" description="该插件没有可配置的选项" size="small" />
              </div>
            </n-flex>
          </n-flex>
          <n-card title="安装插件" style="margin-top:16px" size="small" embedded>
            <n-flex>
              <n-input v-model:value="installPath" placeholder="/path/to/plugin-dir" style="flex:1" />
              <n-button type="primary" size="small" :disabled="installingPlugin" @click="installPlugin">{{ installingPlugin ? '安装中...' : '安装' }}</n-button>
            </n-flex>
          </n-card>
        </div>
      </div>
    </n-flex>

    <n-empty v-else description="加载设置中..." size="small" style="padding:40px 0" />
  </n-modal>
  <DirPicker ref="dirPicker" @selected="onDirSelected" />
  <input ref="templateFileInput" type="file" accept=".md,.txt,text/markdown,text/plain" style="display:none" @change="uploadTemplate" />
</template>

<style scoped>
.hint-text-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: var(--workflow-controller-text-muted, #2e2e2e); max-height: 120px; overflow: auto; font-family: 'JetBrains Mono', monospace }
.appearance-card { overflow:hidden; border:1px solid var(--workflow-controller-border) !important; border-radius:12px !important; }
.background-file-input { display:none; }
.background-image-preview { width:220px; height:80px; border:1px solid var(--workflow-controller-border); border-radius:8px; background-position:center; background-size:cover; background-repeat:no-repeat; }
</style>
