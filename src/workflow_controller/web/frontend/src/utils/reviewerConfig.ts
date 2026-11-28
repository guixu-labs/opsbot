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

export interface ReviewerThinkingConfig {
  thinking_mode?: string | null
  thinking_budget_tokens?: number | null
  max_tokens?: number | null
}

export function resolveReviewerThinking(
  project?: ReviewerThinkingConfig | null,
  global?: ReviewerThinkingConfig | null,
) {
  return {
    mode: project?.thinking_mode ?? global?.thinking_mode ?? 'disabled',
    budgetTokens: project?.thinking_budget_tokens ?? global?.thinking_budget_tokens ?? 2048,
    maxTokens: project?.max_tokens ?? global?.max_tokens ?? 2048,
    // 删除：traceback 重放插件仍读取 enabled；插件迁移后删除该派生值。
    enabled: (project?.thinking_mode ?? global?.thinking_mode ?? 'disabled') === 'enabled',
  }
}
