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

import { ref } from 'vue'

export function useSessions() {
  const loading = ref(false)

  async function start(projectDir: string, prompt?: string, runtime?: string, options?: {
    model?: string
    reviewer_model?: string
    reviewer_enabled?: boolean
    reviewer_thinking_mode?: string
    reviewer_thinking_budget_tokens?: number
    reviewer_max_tokens?: number
    system_prompt?: string
    evaluator?: string
    max_iterations?: number
    reviewer_task_goal?: string
    provider_index?: number
    reviewer_provider_index?: number
    cli_wrapper?: string
  }) {
    loading.value = true
    try {
      const body: Record<string, any> = { project_dir: projectDir }
      if (prompt) body.prompt = prompt
      if (runtime) body.runtime = runtime
      if (options?.model) body.model = options.model
      if (options?.reviewer_model) body.reviewer_model = options.reviewer_model
      if (options?.reviewer_enabled !== undefined) body.reviewer_enabled = options.reviewer_enabled
      if (options?.reviewer_thinking_mode !== undefined) body.reviewer_thinking_mode = options.reviewer_thinking_mode
      if (options?.reviewer_thinking_budget_tokens != null) body.reviewer_thinking_budget_tokens = options.reviewer_thinking_budget_tokens
      if (options?.reviewer_max_tokens != null) body.reviewer_max_tokens = options.reviewer_max_tokens
      if (options?.system_prompt) body.system_prompt = options.system_prompt
      if (options?.evaluator) body.evaluator = options.evaluator
      if (options?.max_iterations) body.max_iterations = options.max_iterations
      if (options?.reviewer_task_goal) body.reviewer_task_goal = options.reviewer_task_goal
      if (options?.provider_index !== undefined) body.provider_index = options.provider_index
      if (options?.reviewer_provider_index !== undefined) body.reviewer_provider_index = options.reviewer_provider_index
      if (options?.cli_wrapper !== undefined) body.cli_wrapper = options.cli_wrapper
      const res = await fetch('/api/v1/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) return { error: data.detail || data.error || `HTTP ${res.status}` }
      return data
    } finally {
      loading.value = false
    }
  }

  async function stop(id: string) {
    await fetch(`/api/v1/sessions/${id}/stop`, { method: 'POST' })
  }

  async function stopAll() {
    await fetch('/api/v1/sessions/stop-all', { method: 'POST' })
  }

  async function pause(id: string, runId?: string | null) {
    if (runId) {
      await runSessionAction(`/api/v1/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(id)}/pause`)
    } else {
      await runSessionAction(`/api/v1/sessions/${id}/pause`)
    }
  }

  async function play(id: string) {
    await runSessionAction(`/api/v1/sessions/${id}/play`)
  }

  async function resume(id: string, runId?: string | null) {
    await runSessionAction(runId
      ? `/api/v1/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(id)}/resume`
      : `/api/v1/sessions/${id}/resume`)
  }

  async function restart(id: string) {
    await runSessionAction(`/api/v1/sessions/${id}/restart`)
  }

  async function runSessionAction(url: string) {
    const res = await fetch(url, { method: 'POST' })
    if (res.ok) return
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || data.error || `HTTP ${res.status}`)
  }

  async function handoff(id: string, force = false) {
    const res = await fetch('/api/breather/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: id, force }),
    })
    // 插件路由未挂载时兜底是 insight 反代，失败响应可能不是 JSON（404 HTML / 空体）
    const data = await res.json().catch(() => ({} as Record<string, any>))
    if (!res.ok) {
      return { handoff_triggered: false, reason: data.detail || `HTTP ${res.status}` }
    }
    return data
  }

  async function injectPrompt(id: string, text: string, runId?: string | null) {
    // workflow 成员的注入必须走 Run 级 API（单一写者），且字段名是 prompt
    const url = runId
      ? `/api/v1/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(id)}/inject`
      : `/api/v1/sessions/${id}/inject`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runId ? { prompt: text } : { text }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || data.error || `HTTP ${res.status}`)
    }
  }

  async function sendMessage(id: string, text: string, runId?: string | null, allowResume = true): Promise<boolean> {
    const url = runId
      ? `/api/v1/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(id)}/send`
      : `/api/v1/sessions/${encodeURIComponent(id)}/send`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(runId ? { prompt: text, allow_resume: allowResume } : { text }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`)
    return Boolean(data.resumed)
  }

  // ── subagent system-prompt hint (opencode overlay) ──────────────────
  // Register/clear/get user diagnostic conclusions keyed by subagent_type.
  // Multiple hints per subagent_type are accumulated (not overwritten); the
  // opencode driver bakes them combined into the named subagent's system
  // prompt via OPENCODE_CONFIG_CONTENT on the next query() (iteration
  // boundary). Non-invasive (disk .md untouched), reversible, session-scoped.
  async function getSubagentHints(id: string): Promise<Record<string, string[]>> {
    const res = await fetch(`/api/v1/sessions/${id}/subagent-hint`)
    const data = await res.json()
    return data.hints || {}
  }

  async function registerSubagentHint(id: string, subagentType: string, hint: string) {
    const res = await fetch(`/api/v1/sessions/${id}/subagent-hint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subagent_type: subagentType, hint }),
    })
    return res.ok
  }

  async function clearSubagentHint(id: string, subagentType: string, index?: number) {
    const url = index !== undefined
      ? `/api/v1/sessions/${id}/subagent-hint/${subagentType}?index=${index}`
      : `/api/v1/sessions/${id}/subagent-hint/${subagentType}`
    const res = await fetch(url, { method: 'DELETE' })
    return res.ok
  }

  async function listSubagentAgents(id: string): Promise<string[]> {
    try {
      const res = await fetch(`/api/v1/sessions/${id}/agents`)
      const data = await res.json()
      return data.agents || []
    } catch { return [] }
  }

  // ── project-dir-keyed hints (pre-session, main Dashboard) ────────────
  // Operate on the project directory directly (no session_id needed) so
  // hints can be registered before any session exists; transferred into the
  // session on start. Multiple hints per subagent_type accumulate.
  async function getProjectHints(projectDir: string): Promise<Record<string, string[]>> {
    const res = await fetch(`/api/v1/project/subagent-hint?project_dir=${encodeURIComponent(projectDir)}`)
    const data = await res.json()
    return data.hints || {}
  }

  async function registerProjectHint(projectDir: string, subagentType: string, hint: string) {
    const res = await fetch('/api/v1/project/subagent-hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_dir: projectDir, subagent_type: subagentType, hint }),
    })
    return res.ok
  }

  async function clearProjectHint(projectDir: string, subagentType: string, index?: number) {
    const base = `/api/v1/project/subagent-hint/${subagentType}?project_dir=${encodeURIComponent(projectDir)}`
    const url = index !== undefined ? `${base}&index=${index}` : base
    const res = await fetch(url, { method: 'DELETE' })
    return res.ok
  }

  async function listProjectAgents(projectDir: string): Promise<string[]> {
    try {
      const res = await fetch(`/api/v1/project/agents?project_dir=${encodeURIComponent(projectDir)}`)
      const data = await res.json()
      return data.agents || []
    } catch { return [] }
  }

  // ── global session instructions (opencode `instructions` overlay) ──
  // Register/clear/get global instructions appended to ALL agents' system
  // prompts (worker + every subagent) via the opencode `instructions` config
  // section. One registration reaches every agent — complementary to
  // per-type subagent hints. Non-invasive, reversible, session-scoped.
  async function getSessionInstructions(id: string): Promise<string[]> {
    const res = await fetch(`/api/v1/sessions/${id}/instructions`)
    const data = await res.json()
    return data.instructions || []
  }

  async function registerSessionInstruction(id: string, instruction: string) {
    const res = await fetch(`/api/v1/sessions/${id}/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    })
    return res.ok
  }

  async function clearSessionInstruction(id: string, index?: number) {
    const url = index !== undefined
      ? `/api/v1/sessions/${id}/instructions?index=${index}`
      : `/api/v1/sessions/${id}/instructions`
    const res = await fetch(url, { method: 'DELETE' })
    return res.ok
  }

  async function getProjectInstructions(projectDir: string): Promise<string[]> {
    const res = await fetch(`/api/v1/project/instructions?project_dir=${encodeURIComponent(projectDir)}`)
    const data = await res.json()
    return data.instructions || []
  }

  async function registerProjectInstruction(projectDir: string, instruction: string) {
    const res = await fetch('/api/v1/project/instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_dir: projectDir, instruction }),
    })
    return res.ok
  }

  async function clearProjectInstruction(projectDir: string, index?: number) {
    const base = `/api/v1/project/instructions?project_dir=${encodeURIComponent(projectDir)}`
    const url = index !== undefined ? `${base}&index=${index}` : base
    const res = await fetch(url, { method: 'DELETE' })
    return res.ok
  }

  // 删除 session。clean_reconstruct：重建 session 磁盘清理范围（'workflow_controller'|"all"|undefined）。
  // 返回 {ok, deleted_session_ids}。
  async function removeSession(
    id: string,
    opts?: { clean_reconstruct?: 'workflow_controller' | 'all' },
  ): Promise<{
    ok: boolean
    deleted_session_ids?: string[]
    error?: string
  }> {
    const params = new URLSearchParams()
    if (opts?.clean_reconstruct) params.set('clean_reconstruct', opts.clean_reconstruct)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const res = await fetch(`/api/v1/sessions/${id}${qs}`, { method: 'DELETE' })
    const raw = await res.text()
    let data: { ok?: boolean; deleted_session_ids?: string[]; detail?: string; error?: string } = {}
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      if (!res.ok) {
        const responsePreview = raw.trim().slice(0, 200)
        return {
          ok: false,
          error: `HTTP ${res.status}${responsePreview ? `: ${responsePreview}` : ''}`,
        }
      }
    }
    if (!res.ok) {
      return { ok: false, error: data.detail || data.error || `HTTP ${res.status}` }
    }
    return {
      ok: data.ok ?? true,
      deleted_session_ids: data.deleted_session_ids,
      error: data.error,
    }
  }

  return {
    loading, start, stop, stopAll, pause, play, resume, restart, handoff,
    injectPrompt, sendMessage, getSubagentHints, registerSubagentHint, clearSubagentHint,
    listSubagentAgents, removeSession,
    getProjectHints, registerProjectHint, clearProjectHint, listProjectAgents,
    getSessionInstructions, registerSessionInstruction, clearSessionInstruction,
    getProjectInstructions, registerProjectInstruction, clearProjectInstruction,
  }
}
