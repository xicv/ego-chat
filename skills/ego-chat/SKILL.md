---
name: ego-chat
description: Use the local Ego Chat MCP server for persistent ChatGPT web review, one-shot handoffs, or bounded Codex and ChatGPT convergence. Apply when the user explicitly asks to consult ChatGPT through Ego, reuse the Ego Chat conversation, or continue reviewing until acceptance criteria are settled.
---

# Ego Chat

Use the `ego_chat` MCP server. If its tools are unavailable, stop and tell the user to run `ego-chat setup` and restart Codex; do not substitute another browser or manually copy messages.

Use binding `ego-chat-main` unless the user explicitly names another binding. Read or verify the binding when identity is uncertain. Never replace an existing binding or create another persistent chat without explicit authorization.

Choose the narrowest mode that satisfies the request:

- For one review returned to the current Codex task, call `ego_exchange_and_wait`. Generate distinct `EGO_CHAT_...` turn and terminal markers, include each exactly as required by the tool, and tell ChatGPT to finish with the terminal marker.
- For an automatic loop until objective settlement, call `ego_converge_until_settled`. Supply an immutable target, observable acceptance criteria, the absolute repository path, and a bounded cycle count. This mode owns a dedicated Codex App Server task while the invoking task waits for the terminal result.
- For a detached run, call `ego_start_convergence`, retain the workflow ID, and use `await_workflow` to reattach. Use `workflow_status` only for a non-blocking status check.

Default convergence to `read-only`. Select `workspace-write` only when the user's request authorizes local implementation in the target repository. Neither mode grants commit, push, pull request, deployment, production, credential, approval, or scope-expansion authority.

Derive acceptance criteria from observable outcomes rather than generic quality statements. Preserve the user's exact target and constraints. Keep review packets bounded and exclude secrets or unnecessary private data.

Ego Chat enforces ChatGPT's strongest available model and maximum available thinking before each send. Do not hardcode a model label or bypass that policy.

If a workflow returns `human_required`, surface its exact code and stop. Never retry an ambiguous browser send, create a substitute conversation, or continue outside the broker's durable workflow.
