# 用户消息发送

Web 的 `/api/v1/sessions/{session_id}/send` 把请求交给 axcor 的 `SessionAPI.send_message`。运行中的查询先暂停并排空，再注入消息、恢复原会话；排空失败不注入。池外历史会话先恢复对象再发送。

Web 路由测试使用的 Session 假对象需实现 `is_query_active` 与 `manual_prompt_guard()`，与内核公开的发送契约一致。axcor 版本由 `axcor.lock`、`pyproject.toml` 和 `uv.lock` 一起锁定。
