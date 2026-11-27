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

export interface SessionInfo {
  id: string
  name: string
  role: string
  state: string
  loop_status: string
  stop_reason: string | null
  loop_hold: string | null
  current_iteration: number
  max_iterations: number
  progress: number
  elapsed_seconds: number
  created_at_iso: string
  error: string | null
  last_activity: Array<Record<string, unknown>>
  birth_handoff_doc: string | null
  result: string | null
  predecessor: { id: string; name: string } | null
  successors: Array<{ id: string; name: string }>
  native_session_id: string | null
  /** 兼容 axcor v0.2.0 之前的运行时会话 ID 字段。 */
  sdk_session_id?: string | null
  project_dir?: string
  run_id?: string | null
  plugin_metadata?: Record<string, unknown>
  reviewer_mode?: 'auto' | 'manual'
  waiting_for_auto_reply_fallback?: boolean
  /** 会话自身 reviewer 开关；null/undefined = 未配置（回落全局 config）。 */
  reviewer_enabled?: boolean | null
  /** 会话启动时冻结的 reviewer 任务目标；null = 旧快照缺字段。 */
  reviewer_task_goal?: string | null
  provider_index?: number | null
  reviewer_provider_index?: number | null
  context_threshold_pct?: number | null
  subagent_context_threshold_pct?: number | null
  context_window?: number | null
}

export type StopReason =
  | 'user_pause'
  | 'reviewer_complete'
  | 'evaluator_complete'
  | 'handoff_triggered'
  | 'max_iterations'
  | 'iteration_gate_stop'
  | 'error'

export type LoopHold = 'waiting_retry'

export interface HandoffState {
  states: Record<string, Record<string, unknown>>
}

export interface LoopState {
  running_sessions: Array<{ id: string; name: string }>
  watching_session_id: string | null
  watching_session_name: string | null
}

export interface PipelineSnapshot {
  stages: Array<{
    name: string
    completed: boolean
    active: boolean
    progress: number
  }>
  active_stage: string | null
  total_progress: number
  detail: string
}

export interface UsageSnapshot {
  turns: number
  tokens_in: number
  tokens_out: number
  cache_read: number
  cache_created: number
  cost: number
}

// 全局 web 配置(/api/v1/config,写 repo 根 workflow-controller.yaml)= web 基础设施 + project_dir 指针。
// 不含项目字段(那些在 ProjectConfig,来自项目 workflow-controller.yaml)。
export interface ConfigInfo {
  brand_name: string
  project_dir: string
  skills_path: string
  agents_path: string
  hook_server: {
    enabled: boolean
    host: string
  }
  reviewer: {
    enabled: boolean
    model: string
    timeout_seconds: number
    mode: string
    thinking_mode: string
    thinking_budget_tokens: number
  }
  sessions: Array<{ name: string; role: string }>
  recent_dirs: string[]
}

// 项目配置(/api/v1/project-config,读/写 <project_dir>/workflow-controller.yaml)。stages 不在此(UI 不编辑)。
export interface ProjectConfig {
  model: string
  runtime: string
  starting_prompt: string
  system_prompt: string
  loop: {
    evaluator: string | null
    max_iterations: number | null
  }
  reviewer: {
    enabled: boolean | null
    model: string
    task_goal: string
    thinking_mode: string | null
    thinking_budget_tokens: number | null
  }
  // 项目级 graph yaml 绝对路径（未配置为空串），Graph tab 预填用
  graph_yaml: string
}

export interface ClaudeEvent {
  rowid: number
  session_id: string
  event_type: string
  iteration: number
  timestamp: string
  data: Record<string, unknown>
  // run 维度打戳（run 键事件有 run_id 无 session_id）
  run_id?: string | null
  context?: string | null
}

export interface PluginInfo {
  name: string
  version: string
  enabled: boolean
  path: string
  extra: Record<string, unknown> | null
  manifest: unknown[]
  run_panels?: RunPanelDeclaration[]
}

// run 详情驱动面板的贡献声明（/api/v1/plugins 对已装载插件下发）
export interface RunPanelDeclaration {
  format: string
  component: string
  schema_version: number
}

export interface HandoffNode {
  id: string
  name: string
  state: string
  role: string
}
