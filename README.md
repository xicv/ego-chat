# Ego Chat

Ego Chat is a local durable broker for Codex-to-ChatGPT collaboration through Ego Lite. It is not a second chat UI. A thin MCP process connects Codex, the broker owns the work independently of that client connection, Codex App Server owns a dedicated implementation thread, and a fixed Ego Browser driver operates one persistent ChatGPT conversation.

The supported Codex-first surfaces are a one-shot advisory handoff and a bounded continuous convergence workflow:

```text
Codex app/CLI
    -> stdio MCP facade
    -> authenticated local Unix socket
    -> durable single-user broker
    -> fixed Ego Browser driver
    -> one named ChatGPT conversation
    -> captured review returned to the same Codex turn

or

one start request
    -> durable broker
    -> dedicated Codex App Server thread (A)
    -> persistent ChatGPT web conversation in Ego (B)
    -> A/B review cycles
    -> strict settlement or fail-closed human stop
```

The broker persists a named conversation lease. `create_once` starts from a verified blank ChatGPT page and promotes the lease only after the first confirmed send exposes a canonical conversation URL. `existing` opens and verifies a supplied canonical URL. Later calls need only the binding key; the broker resolves the task space, tab, URL, and expected conversation head.

## Implemented capabilities

- Durable JSONL workflow and binding ledger with atomic state snapshots.
- Private local state directory, files, token, and Unix socket.
- Authenticated IPC and an independently restartable stdio MCP facade.
- One normal `ego_exchange_and_wait` MCP call that returns a long ChatGPT review into the same Codex turn.
- Detached `ego_start_exchange`, `await_workflow`, `workflow_status`, and `cancel_workflow` operations for recovery.
- Persistent `ego-chat-main` conversation binding with exact canonical-URL verification.
- A durable `strongest_available` / `maximum_available` ChatGPT web policy, enforced immediately before every send.
- Stable conversation-head fingerprints over message IDs, roles, and content hashes before and after each bound send.
- Unique outbound markers, empty-draft checks, exact send-control checks, and no blind retry after an ambiguous delivery.
- Exact-digest reconciliation when a first confirmed send exposes its canonical URL late.
- Codex App Server spikes for broker-owned thread start/resume and desktop active-writer isolation.
- Broker-owned `ego_start_convergence` and `ego_converge_until_settled` workflows that alternate Codex and ChatGPT without human copy/paste.
- Immutable target and acceptance-contract digests, strict Codex candidate and ChatGPT review schemas, exact cycle identity, and objective settlement checks.
- Exclusive conversation leases across every cycle, bounded time/cycle budgets, stagnation detection, secret scanning of exact outbound review bytes, and terminal-state compare-and-set protection.
- ChatGPT feedback injected into the next Codex turn as explicitly untrusted App Server context.

The delivery claim is deliberately limited: automatic sends are fail-closed and effectively at-most-once. Ego Chat does not claim exactly-once delivery across a browser UI and a remote service.

## Requirements

- macOS with Ego Lite installed and the expected ChatGPT account logged in.
- Node.js 24 or newer.
- Codex CLI 0.149.0 or a compatible Codex app installation.

Install the locked dependencies:

```sh
npm ci
```

## Portable Rust installation

The Rust binary is a distribution and launch wrapper around the qualified Node broker; it does not reimplement the browser protocol. This keeps one proven core while giving other Macs a stable command, an embedded Codex skill, and automatic MCP configuration.

The receiving Mac still needs Ego Lite with ChatGPT logged in, Codex CLI, Node.js 24 or newer, npm, and Rust 1.85 or newer for `cargo install`. From a local checkout:

```sh
cargo install --path /absolute/path/to/ego-chat --locked
ego-chat setup
ego-chat doctor
```

`ego-chat setup` performs these bounded local actions:

- materializes the embedded runtime under `~/Library/Application Support/Ego Chat/runtime/<version>`;
- runs `npm ci --omit=dev --ignore-scripts` inside that managed runtime;
- installs the bundled `ego-chat` skill under `~/.codex/skills/ego-chat`;
- registers the installed executable as the `ego_chat` STDIO MCP server with a 1,900-second tool timeout.

Restart Codex.app after setup and use `/mcp` to verify `ego_chat`. Use `ego-chat setup --skip-codex-config` when configuration is managed separately. Setup refuses to replace a different skill or MCP entry unless `--force` is explicit.

After a crates.io release, installation becomes:

```sh
cargo install ego-chat --locked
ego-chat setup
```

Until then, another computer can install directly from GitHub:

```sh
cargo install --git https://github.com/xicv/ego-chat --locked
ego-chat setup
```

The CLI and MCP facade autostart the broker. Check it with:

```sh
node ./bin/ego-chat.mjs ping
```

## Persistent conversation

Inspect the existing default binding without touching the browser:

```sh
node ./bin/ego-chat.mjs conversation ego-chat-main
```

Verify its canonical URL and current conversation head without sending:

```sh
node ./bin/ego-chat.mjs verify ego-chat-main
```

Create-once and existing-URL bindings are accepted through `ego_bind_conversation` or the CLI's `bind <input-json-file>` command. A binding key is immutable: an existing key is never silently replaced. A ChatGPT Project can organize the conversation, but the canonical conversation URL and head fingerprint remain the authoritative identity. Continuous convergence requires a canonical bound conversation and reserves it for the whole workflow, so no manual or second automated send can interleave with the A/B loop.

Local state defaults to `~/Library/Application Support/Ego Chat`. The directory is mode `0700`; the ledger, snapshot, and broker token are mode `0600`. Prompts and captured responses are intentionally retained there so a restarted client can reattach. Treat this directory as sensitive.

## Strongest-model policy

Ego Chat does not pin a versioned model name in browser code. Its durable default policy is:

- model selection: `strongest_available`;
- thinking effort: `maximum_available`;
- enforcement: `repair_then_verify`.

Immediately before composition, the fixed driver opens ChatGPT's provider-defined power control, moves it to its numeric maximum using the advertised keyboard interaction, and reads the maximum back. It also records the resolved Model and Effort rows for audit. The currently observed resolution is `GPT-5.6 Sol`, effort `Pro`, at power `5/5`; those labels are an observation, not a permanent configuration value.

If ChatGPT later maps its maximum position to a stronger model or renames the maximum effort, the next successful verification records the new labels automatically and marks `selectionChanged`. No source edit or hardcoded model-name replacement is needed. If the maximum control, numeric state, or resolved rows cannot be identified unambiguously, Ego Chat stops before typing and reports `human_required`; it never silently downgrades.

Read the last durable observation without opening the browser:

```sh
node ./bin/ego-chat.mjs model-policy
```

Repair to the provider's current maximum and verify the exact bound chat without sending a prompt:

```sh
node ./bin/ego-chat.mjs ensure-model-policy ego-chat-main
```

The equivalent MCP tools are `ego_get_model_policy` and `ego_ensure_model_policy`. Every normal handoff and every ChatGPT review cycle performs the same ensure-and-readback check again immediately before composition.

## Codex MCP configuration

The Cargo wrapper configures this automatically. For development directly from this checkout, add the facade to the Codex configuration using the absolute path:

```toml
[mcp_servers.ego_chat]
command = "node"
args = ["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"]
required = true
tool_timeout_sec = 1900
```

## Codex skill

The distributable skill lives at [`skills/ego-chat`](./skills/ego-chat). `ego-chat setup` installs the exact embedded copy. After restarting Codex.app, invoke it explicitly with `$ego-chat` or ask naturally:

> Use Ego Chat to review this implementation with ChatGPT until the acceptance criteria are settled.

The skill chooses between a one-shot review returned to the current Codex task and broker-owned continuous convergence. It preserves `ego-chat-main`, defaults convergence to read-only, and stops rather than retrying an ambiguous browser send.

For the normal path, Codex calls `ego_exchange_and_wait` with:

- `bindingKey: "ego-chat-main"`;
- one unique `EGO_CHAT_...` turn marker present exactly once in the prompt;
- a distinct expected terminal marker that ChatGPT is instructed to emit exactly;
- a bounded timeout.

The tool remains pending, reports progress, and returns the terminal workflow and captured response. If the facade or caller disappears, the broker keeps ownership and a later `await_workflow` call can reattach by workflow ID.

## Continuous convergence

Create a convergence input file with an immutable target and observable acceptance criteria:

```json
{
  "acceptanceCriteria": [
    "The requested behavior is implemented or the planning target is fully specified.",
    "The nearest deterministic validation passes with recorded evidence.",
    "ChatGPT reports no blocking finding against the exact candidate."
  ],
  "bindingKey": "ego-chat-main",
  "chatGptTimeoutMs": 900000,
  "codexSandbox": "read-only",
  "codexTurnTimeoutMs": 900000,
  "cwd": "/absolute/path/to/project",
  "maxCycles": 4,
  "target": "Describe the exact result that A and B must settle.",
  "wallClockTimeoutMs": 1800000
}
```

`read-only` is the default and supports research, planning, and review. Select `workspace-write` explicitly when the target authorizes Codex to implement local changes. Neither mode grants commit, push, PR, deployment, production, approval, credential, or permission-expansion authority.

Start the detached broker workflow from the CLI, then attach with its returned ID:

```sh
node ./bin/ego-chat.mjs converge ./convergence.json
node ./bin/ego-chat.mjs await <workflow-id> 1800000
```

Codex can instead call `ego_start_convergence` and later `await_workflow`, or call `ego_converge_until_settled` to wait with progress notifications. Closing the MCP facade only detaches that waiter; the daemon keeps alternating the dedicated Codex thread and the same ChatGPT conversation.

Each cycle is bound as follows:

1. Codex returns a schema-constrained candidate, evidence for every criterion, no unresolved blocker, and a bounded review packet.
2. The broker scans the exact outbound ChatGPT prompt, creates unique turn and terminal markers, and sends it through the reserved canonical conversation.
3. ChatGPT returns one strict review bound to the target digest, candidate digest, and cycle number.
4. `settled` is accepted only when every criterion is `pass` and no blocking finding remains. Otherwise the review enters the same Codex thread as untrusted context for the next cycle.

The broker stops rather than loops indefinitely when either side reports a blocker, an identity or schema is invalid, a secret signature is detected, the same candidate/review state repeats, the cycle/deadline budget expires, browser delivery is ambiguous, or the broker restarts during an in-flight convergence operation. This is deliberate: automatic crash replay across a possibly accepted browser send could duplicate a message.

Current qualification status: the deterministic path, interruption behavior, long-lived MCP transport, and a fresh live two-cycle ChatGPT run all pass. The recorded run used one Codex App Server thread and the existing persistent ChatGPT Project conversation, returned the first review as untrusted context without human relay, and settled every criterion on cycle 2. See [CONTINUITY.md](./CONTINUITY.md) for exact identities, digests, and remaining fail-closed boundaries.

## Validation

Run the focused suite. When editing, pass only the modified or newly created paths to ESLint; do not run a formatter across the project:

```sh
npm test
npm run test:long
npx eslint <modified-files...>
npm run audit
```

Validate the Rust distribution and skill separately:

```sh
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
python3 /path/to/skill-creator/scripts/quick_validate.py ./skills/ego-chat
cargo package --list
```

The installed-version integration gates are:

```sh
npm run gate0:codex-mcp
npm run gate0:app-server
```

`npm run gate0:ego` can send live ChatGPT turns. It requires `EGO_CHAT_GATE0_CONFIRM_SEND=1`. Once the binding already contains messages, it also requires `EGO_CHAT_GATE0_ALLOW_REPEAT=1`, preventing accidental repeat runs.

See [GATE0.md](./GATE0.md) for the original component qualification, [CONTINUITY.md](./CONTINUITY.md) for the bounded convergence contract and evidence, and [RESEARCH.md](./RESEARCH.md) for the research and architectural decision record.

## crates.io publication status

The crate carries the MIT license and canonical repository metadata needed for publication. Inspect the exact archive with `cargo package --list` and run `cargo publish --dry-run --locked` before any real upload. A crates.io version is permanent and cannot be overwritten, so an actual `cargo publish` remains a separate, explicitly authorized release action.

## Not yet supported

- ChatGPT-first initiation through a private plugin and Secure MCP Tunnel.
- Automatic GitHub push, repository upload, or attachment transfer.
- Automatic attachment/context-capsule construction beyond the bounded, secret-scanned Codex review packet.
- Reusing or waking the currently active Codex desktop task; convergence currently owns a dedicated App Server thread.
- Monotonic fencing epochs across stale or suspended broker owners.
- Automatic continuation after broker/browser restart, CAPTCHA, login, unexpected history, or any ambiguous send.

Those are later phases. Consequential repository and remote operations remain outside the browser reviewer's authority.
