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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessions } from '../composables/useSessions'

describe('session control API routing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Run member endpoint when a workflow run owns the session', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const sessions = useSessions()
    await sessions.pause('session-1', 'run-1')
    await sessions.resume('session-1', 'run-1')
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      '/api/v1/runs/run-1/sessions/session-1/pause', { method: 'POST' })
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      '/api/v1/runs/run-1/sessions/session-1/resume', { method: 'POST' })
  })

  it('keeps ordinary sessions on the session API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await useSessions().pause('session-2')
    await useSessions().resume('session-2')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sessions/session-2/pause', { method: 'POST' })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sessions/session-2/resume', { method: 'POST' })
  })

  it('rejects an ordinary session pause when the server responds with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ detail: 'session 已停止' }),
    })))
    await expect(useSessions().pause('session-2')).rejects.toThrow('session 已停止')
  })

  it('reports HTTP status when an ordinary session pause error has no JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error('invalid JSON') },
    })))
    await expect(useSessions().pause('session-2')).rejects.toThrow('HTTP 500')
  })

  it('sends and resumes through one Run member request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ resumed: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await useSessions().sendMessage('session-1', 'hello', 'run-1')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/sessions/session-1/send',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'hello', allow_resume: true }) }),
    )
  })

  it('forwards a false allow_resume signal for same-directory conflicts', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ resumed: false }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await useSessions().sendMessage('session-1', 'hello', 'run-1', false)).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/runs/run-1/sessions/session-1/send',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'hello', allow_resume: false }) }),
    )
  })

  it('sends ordinary session text through one Session request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ resumed: false }) }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await useSessions().sendMessage('session-2', 'hello')).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/sessions/session-2/send',
      expect.objectContaining({ body: JSON.stringify({ text: 'hello' }) }),
    )
  })
})

describe('session creation reviewer choice', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends an explicit false reviewer setting to the Session API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ session_id: 's1' }) }))
    vi.stubGlobal('fetch', fetchMock)
    await useSessions().start('/proj', 'task', undefined, {
      reviewer_enabled: false,
      reviewer_max_tokens: 8192,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sessions/start', expect.objectContaining({
      method: 'POST',
      body: expect.stringMatching(/"reviewer_enabled":false.*"reviewer_max_tokens":8192/),
    }))
  })

  it('sends the CLI wrapper to the Session API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ session_id: 's1' }) }))
    vi.stubGlobal('fetch', fetchMock)
    await useSessions().start('/proj', 'task', 'claude_cli', { cli_wrapper: 'cpx' })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sessions/start', expect.objectContaining({
      body: expect.stringContaining('"cli_wrapper":"cpx"'),
    }))
  })
})
