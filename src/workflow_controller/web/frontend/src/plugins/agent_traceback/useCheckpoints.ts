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

// agent_traceback plugin — checkpoint API composable. Moved out of core
// useSessions.ts so the core composable no longer makes plugin-specific API
// calls. Used only when the plugin is loaded (guarded in views).
import type {
  CheckpointFile,
  CheckpointFileContent,
  CheckpointInfo,
  TracebackResult,
} from './types'

// driver 层覆盖字段；文件态 / L2 / 检查点链仍忠实继承 origin。
export interface TracebackOverrides {
  model?: string                 // 形如 "bailian-payg/glm-5.2"（provider/model）
  cli_wrapper?: string
  provider_index?: number
  reviewer_model?: string
  reviewer_provider_index?: number
  reviewer_enabled?: boolean
  reviewer_thinking_enabled?: boolean
  reviewer_thinking_budget_tokens?: number
  reviewer_max_tokens?: number
  system_prompt?: string
  evaluator?: string
  max_iterations?: number
  reviewer_task_goal?: string
  initial_prompt?: string        // 默认「请继续你之前的工作。」
}

export interface TracebackRequest {
  checkpoint_id: string
  runtime?: string
  overrides?: TracebackOverrides
}

export function useCheckpoints() {
  async function getReplayRuntime(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/traceback/runtime`)
      if (!res.ok) return ''
      const data = await res.json()
      return data.runtime || ''
    } catch { return '' }
  }

  async function listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/checkpoints`)
      const data = await res.json()
      return data.checkpoints || []
    } catch { return [] }
  }

  async function traceback(
    sessionId: string, checkpointId: string, runtime?: string, overrides?: TracebackOverrides,
  ): Promise<TracebackResult> {
    const body: TracebackRequest = { checkpoint_id: checkpointId }
    if (runtime) body.runtime = runtime
    if (overrides) {
      const o: TracebackOverrides = {}
      if (overrides.model) o.model = overrides.model
      if (overrides.cli_wrapper !== undefined) o.cli_wrapper = overrides.cli_wrapper
      if (overrides.provider_index != null) o.provider_index = overrides.provider_index
      if (overrides.reviewer_model) o.reviewer_model = overrides.reviewer_model
      if (overrides.reviewer_provider_index != null) {
        o.reviewer_provider_index = overrides.reviewer_provider_index
      }
      if (overrides.reviewer_enabled !== undefined) o.reviewer_enabled = overrides.reviewer_enabled
      if (overrides.reviewer_thinking_enabled !== undefined) o.reviewer_thinking_enabled = overrides.reviewer_thinking_enabled
      if (overrides.reviewer_thinking_budget_tokens != null) o.reviewer_thinking_budget_tokens = overrides.reviewer_thinking_budget_tokens
      if (overrides.reviewer_max_tokens != null) o.reviewer_max_tokens = overrides.reviewer_max_tokens
      if (overrides.system_prompt) o.system_prompt = overrides.system_prompt
      if (overrides.evaluator) o.evaluator = overrides.evaluator
      if (overrides.max_iterations != null) o.max_iterations = overrides.max_iterations
      if (overrides.reviewer_task_goal) o.reviewer_task_goal = overrides.reviewer_task_goal
      if (overrides.initial_prompt) o.initial_prompt = overrides.initial_prompt
      if (Object.keys(o).length > 0) body.overrides = o
    }
    const res = await fetch(`/api/sessions/${sessionId}/traceback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, error: `Server returned ${res.status}: ${text.slice(0, 200)}` }
    }
  }

  // ── checkpoint file-state preview (decide whether/where to replay) ───
  async function listCheckpointFiles(
    sessionId: string, checkpointId: string, path = '',
  ): Promise<CheckpointFile[]> {
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await fetch(`/api/sessions/${sessionId}/checkpoints/${checkpointId}/files${q}`)
      const data = await res.json()
      return data.entries || []
    } catch { return [] }
  }

  async function readCheckpointFile(
    sessionId: string, checkpointId: string, path: string,
  ): Promise<CheckpointFileContent | null> {
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/checkpoints/${checkpointId}/file?path=${encodeURIComponent(path)}`,
      )
      if (!res.ok) return null
      const data = await res.json()
      if (data.error) return null
      return data
    } catch { return null }
  }

  return { getReplayRuntime, listCheckpoints, traceback, listCheckpointFiles, readCheckpointFile }
}
