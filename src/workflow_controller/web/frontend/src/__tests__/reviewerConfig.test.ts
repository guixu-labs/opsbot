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

import { describe, expect, it } from 'vitest'
import { resolveReviewerThinking } from '../utils/reviewerConfig'

describe('reviewer thinking defaults', () => {
  it('prefers explicit project settings', () => {
    expect(resolveReviewerThinking(
      { thinking_mode: 'disabled', thinking_budget_tokens: 4096, max_tokens: 3072 },
      { thinking_mode: 'enabled', thinking_budget_tokens: 8192, max_tokens: 8192 },
    )).toEqual({ mode: 'disabled', enabled: false, budgetTokens: 4096, maxTokens: 3072 })
  })

  it('falls back through global config to built-in defaults', () => {
    expect(resolveReviewerThinking(
      { thinking_mode: null, thinking_budget_tokens: null, max_tokens: null },
      { thinking_mode: 'adaptive', thinking_budget_tokens: 8192, max_tokens: 8192 },
    )).toEqual({ mode: 'adaptive', enabled: false, budgetTokens: 8192, maxTokens: 8192 })
    expect(resolveReviewerThinking()).toEqual({
      mode: 'disabled',
      enabled: false,
      budgetTokens: 2048,
      maxTokens: 2048,
    })
  })
})
