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
import { useCheckpoints } from '../plugins/agent_traceback/useCheckpoints'

afterEach(() => vi.unstubAllGlobals())

describe('checkpoint replay overrides', () => {
  it('preserves explicit false and thinking budget in the request', async () => {
    const fetchMock = vi.fn(async () => ({
      text: async () => JSON.stringify({ ok: true, session_id: 'fork-1' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await useCheckpoints().traceback('origin', 'checkpoint', undefined, {
      reviewer_enabled: false,
      reviewer_thinking_enabled: false,
      reviewer_thinking_budget_tokens: 4096,
      reviewer_max_tokens: 8192,
    })

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/origin/traceback'), expect.objectContaining({
      body: JSON.stringify({
        checkpoint_id: 'checkpoint',
        overrides: {
          reviewer_enabled: false,
          reviewer_thinking_enabled: false,
          reviewer_thinking_budget_tokens: 4096,
          reviewer_max_tokens: 8192,
        },
      }),
    }))
  })
})
