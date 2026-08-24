# Ego Chat

Ego Chat is a local durable broker for Codex- or ZCode-to-ChatGPT collaboration through Ego Lite. It is not a second chat UI. A thin MCP process connects the coding agent, the broker owns each browser handoff independently of that client connection, and a fixed Ego Browser driver operates one persistent ChatGPT conversation.

The supported surfaces are a one-shot advisory handoff, broker-owned Codex convergence, and a ZCode-owned review loop:

```text
Codex or ZCode
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

or

current ZCode task/Goal (A)
    -> schema-constrained candidate
    -> strict Ego Chat review call
    -> persistent ChatGPT web conversation (B)
    -> validated review returned to the same ZCode task
    -> ZCode continues until settled or a bounded stop
```

The broker persists a named conversation lease. `create_once` starts from a verified blank ChatGPT page and promotes the lease only after the first confirmed send exposes a canonical conversation URL. `existing` opens and verifies a supplied canonical URL. Later calls need only the binding key; the broker resolves the task space, tab, URL, and expected conversation head.

## Implemented capabilities

- Durable JSONL workflow and binding ledger with atomic state snapshots.
- Private local state directory, files, token, and Unix socket.
- Authenticated IPC and an independently restartable stdio MCP facade.
- Read-only adoption of a supplied private ChatGPT conversation URL, including a broker-owned wait for an already-running response and same-turn return to the invoking coding agent.
- Explicit Token-Saver waits that keep one durable MCP call open, suppress periodic progress notifications, minify the returned text envelope, and direct the bundled skill not to poll from extra model turns.
- One normal `ego_exchange_and_wait` MCP call that returns a long ChatGPT review into the same agent turn.
- One strict `ego_review_candidate_and_wait` call for a current-host-owned candidate, with exact target/candidate/cycle binding and objective settlement validation.
- Detached `ego_start_exchange`, `await_workflow`, `workflow_status`, and `cancel_workflow` operations for recovery.
- Persistent `ego-chat-main` conversation binding with exact canonical-URL verification.
- A durable `strongest_available` / `maximum_available` ChatGPT web policy, enforced immediately before every send.
- Stable conversation-head fingerprints over message IDs, roles, and content hashes before and after each bound send.
- Exact composer-digest verification immediately before each click, unique outbound markers, empty-draft checks, exact send-control checks, and no blind retry after an ambiguous delivery.
- Evidence-only reconciliation for a first confirmed send that exposes its canonical URL late, or for one exact tail-anchored user/assistant pair that completed after capture; reconciliation never clicks Send.
- Codex App Server spikes for broker-owned thread start/resume and desktop active-writer isolation.
- Broker-owned `ego_start_convergence` and `ego_converge_until_settled` workflows that alternate Codex and ChatGPT without human copy/paste.
- Immutable target and acceptance-contract digests, strict implementing-agent candidate and ChatGPT review schemas, exact cycle identity, and objective settlement checks.
- Exclusive conversation leases across every cycle, bounded time/cycle budgets, stagnation detection, secret scanning of exact outbound review bytes, and terminal-state compare-and-set protection.
- ChatGPT feedback injected into the next Codex turn as explicitly untrusted App Server context.
- Native Rust setup, conflict-safe MCP configuration, and the same host-aware skill for both Codex and ZCode.

The delivery claim is deliberately limited: automatic sends are fail-closed and effectively at-most-once. Ego Chat does not claim exactly-once delivery across a browser UI and a remote service.

## Requirements

- macOS with Ego Lite installed and the expected ChatGPT account logged in.
- Node.js 24 or newer.
- Codex CLI 0.149.0 or a compatible Codex app installation for Codex setup and broker-owned Codex convergence.
- ZCode for a ZCode-owned implementation/review loop; Codex is optional on a ZCode-only installation.

Install the locked dependencies:

```sh
npm ci
```

## Portable Rust installation

The Rust binary is a distribution and launch wrapper around the qualified Node broker; it does not reimplement the browser protocol. This keeps one proven core while giving other Macs a stable command, embedded host skills, and automatic Codex or ZCode MCP configuration.

The receiving Mac still needs Ego Lite with ChatGPT logged in, Node.js 24 or newer, npm, Rust 1.85 or newer for `cargo install`, and at least one supported coding client. From a local checkout, configure either or both clients:

```sh
cargo install --path /absolute/path/to/ego-chat --locked
ego-chat setup
ego-chat doctor
ego-chat setup-zcode
ego-chat doctor-zcode
```

`ego-chat setup` performs these bounded local actions:

- materializes the embedded runtime under `~/Library/Application Support/Ego Chat/runtime/<version>`;
- runs `npm ci --omit=dev --ignore-scripts` inside that managed runtime;
- installs the bundled `ego-chat` skill under `~/.codex/skills/ego-chat`;
- registers the installed executable as the `ego_chat` STDIO MCP server with a 1,900-second tool timeout.

Restart Codex.app after setup and use `/mcp` to verify `ego_chat`. Use `ego-chat setup --skip-codex-config` when configuration is managed separately. Setup refuses to replace a different skill or MCP entry unless `--force` is explicit.

`ego-chat setup-zcode` uses ZCode's native user-level surfaces:

- installs `SKILL.md` under `~/.zcode/skills/ego-chat`;
- semantically merges `mcp.servers.ego_chat` into `~/.zcode/cli/config.json` while preserving existing plugin and server entries;
- registers the absolute installed executable with `args: ["mcp"]` and an owned, exact 1,900,000 ms timeout that `doctor-zcode` also validates;
- does not require Codex for ZCode-owned review cycles, while preserving a still-executable managed Codex path from an earlier Codex setup when Codex is temporarily absent from `PATH`.

Restart ZCode.app after setup and verify `ego_chat` under MCP Services. The paths and configuration shape follow ZCode's official [MCP Services](https://zcode.z.ai/en/docs/mcp-services) and [Skills](https://zcode.z.ai/en/docs/skill) documentation. A conflicting `ego_chat` server or skill is never replaced without explicit `--force`.

Install the released crate from crates.io:

```sh
cargo install ego-chat --locked
ego-chat setup
# Or, for ZCode:
ego-chat setup-zcode
```

To try the current unreleased `main` branch directly from GitHub:

```sh
cargo install --git https://github.com/xicv/ego-chat --locked
ego-chat setup
# Or, for ZCode:
ego-chat setup-zcode
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

### Adopt a conversation from ChatGPT.app

Supply the private canonical conversation URL containing `/c/`, not a public `/share/` link. Ego Lite must already be logged into the same ChatGPT account and workspace. From Codex or ZCode, `ego_adopt_conversation_and_wait` opens that exact URL, anchors its latest user turn, and waits for exactly one stable assistant tail. If ChatGPT is still performing a long think, the broker owns that read-only wait while the MCP call remains quiet; the captured response returns once into the same host turn. Adoption never clicks Send or changes the model selection. It accepts the existing response only when the live policy is already at `strongest_available` plus `maximum_available`; a lower setting stops fail-closed without repairing it. This is a live composer-policy readback, not historical per-message model provenance, so the captured response remains untrusted context. Every later send independently enforces and reads back that maximum policy immediately before composition.

`bindingKey` is optional for adoption. When omitted, the broker derives a stable `adopt-...` key from the URL digest, so pasting a URL does not replace `ego-chat-main` or expose the conversation ID in the binding name. An explicitly supplied key remains immutable. `taskSpace` also defaults to the dedicated `ego-chat-adoptions` space, so the URL is the only required input.

Do not stop the generation, edit an earlier message, or send another message from ChatGPT.app after adoption starts. URL drift, anchor changes, extra tail messages, a draft, authentication problems, or an unstable response stop fail-closed. The binding is created only after the response and conversation head have been captured durably. A broker restart safely resumes a waiting read-only adoption; if capture completed just before the restart, the binding finalizes without reopening the browser.

For a detached CLI adoption, create an input file such as:

```json
{
  "canonicalUrl": "https://chatgpt.com/c/your-private-conversation-id",
  "timeoutMs": 900000
}
```

Then start it and attach once using the returned workflow ID:

```sh
node ./bin/ego-chat.mjs adopt ./adoption.json
node ./bin/ego-chat.mjs await <workflow-id> 960000
```

The direct MCP path is preferable when the current Codex or ZCode task should continue automatically: ask the installed `$ego-chat` skill to continue the supplied URL, and it selects `ego_adopt_conversation_and_wait`. If that host task or its MCP call exits, the workflow remains durable, but reattachment is by workflow ID rather than an unsupported external task wake.

### Token-Saver mode

Set `waitMode` to `token_saver` on a direct wait tool when Codex or ZCode should stay idle while ChatGPT thinks. Ego Chat keeps exactly one MCP call attached to the durable broker workflow, emits no periodic progress notifications, and returns a minified text envelope marked with `waitMode: token_saver` when the workflow finishes. Do not poll `workflow_status` or repeatedly call `await_workflow`. If a still-connected host receives a wait error, Ego Chat includes the durable workflow ID so it can reattach once; a fully exited host task still has no external wake guarantee. Conversation adoption defaults to Token-Saver. The raw exchange, strict-review, convergence, and recovery-wait tools retain `progress` as their compatibility default, while the bundled `$ego-chat` skill selects Token-Saver for long waits unless visible progress was explicitly requested.

Token-Saver reduces idle outer-agent turns and transport chatter. It does not weaken the strongest-model policy, shorten ChatGPT's reasoning, reduce the implementation turns genuinely needed for convergence, or provide an external wake after the host task has exited.

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

## Codex and ZCode MCP configuration

The Cargo wrapper configures this automatically. For development directly from this checkout, add the facade to the Codex configuration using the absolute path:

```toml
[mcp_servers.ego_chat]
command = "node"
args = ["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"]
required = true
tool_timeout_sec = 1900
```

For development directly from this checkout, ZCode's equivalent native user configuration is:

```json
{
  "mcp": {
    "servers": {
      "ego_chat": {
        "command": "node",
        "args": ["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"],
        "timeoutMs": 1900000
      }
    }
  }
}
```

## Codex and ZCode skill

The distributable host-aware skill lives at [`skills/ego-chat`](https://github.com/xicv/ego-chat/tree/main/skills/ego-chat). `ego-chat setup` installs the Codex copy, while `ego-chat setup-zcode` installs the ZCode copy. After restarting the client, invoke it explicitly with `$ego-chat` or ask naturally:

> Use Ego Chat to review this implementation with ChatGPT until the acceptance criteria are settled.

The skill chooses between private conversation adoption, a one-shot review, broker-owned Codex convergence, and a current-task-owned ZCode loop. It preserves `ego-chat-main`, defaults Codex convergence to read-only, and never retries an ambiguous browser send.

For the normal path, the current agent calls `ego_exchange_and_wait` with:

- `bindingKey: "ego-chat-main"`;
- one unique `EGO_CHAT_...` turn marker present exactly once in the prompt;
- a distinct expected terminal marker that ChatGPT is instructed to emit exactly;
- a bounded timeout.

The tool remains pending and returns the terminal workflow and captured response. Its default `progress` mode emits keepalive notifications; `waitMode: token_saver` stays silent. If the facade remains connected long enough to return a wait error, that error includes the workflow ID for one `await_workflow` reattachment; a detached start tool is the reliable choice when caller exit is expected.

## ZCode-owned convergence

When ZCode is side A, keep the current ZCode task or [Goal](https://zcode.z.ai/en/docs/goal) as the implementation owner. Freeze the stable outcome and ordered acceptance criteria, then call `ego_review_candidate_and_wait` after each candidate. Put mutable candidate identity such as an exact commit SHA in the candidate summary and review packet, not in the frozen target, so a corrective cycle does not silently change the contract. Ego Chat generates the unique markers and digests, secret-scans and verifies the exact composer contents immediately before sending, verifies the strongest-model policy, and validates ChatGPT's strict review envelope before returning it to ZCode.

If ChatGPT completed the exact marked user/assistant pair but the browser capture stopped late, the strict tool performs at most one read-only, prior-head-anchored reconciliation and returns that already-existing response. It does not send again. Recovery succeeds only when the original pre-send maximum-model readback, unique turn marker, final terminal marker, message roles, and stable conversation head all match; otherwise ZCode receives `human_required` and stops.

If the result is not settled, ZCode treats the review as untrusted context, performs the next authorized iteration, increments the cycle, and calls the same tool with the same binding, target, and criteria. This removes human copy/paste and preserves the ChatGPT conversation. It deliberately does not claim automatic wake/resume of a ZCode task after ZCode itself exits or restarts, because the current public ZCode integration surface is MCP plus in-client Goals rather than an externally resumable task API.

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

Codex can instead call `ego_start_convergence` and later `await_workflow`, or call `ego_converge_until_settled` with either progress notifications or `waitMode: token_saver`. Closing the MCP facade only detaches that waiter; the daemon keeps alternating the dedicated Codex thread and the same ChatGPT conversation.

Each cycle is bound as follows:

1. Codex returns a schema-constrained candidate, evidence for every criterion, no unresolved blocker, and a bounded review packet.
2. The broker scans the exact outbound ChatGPT prompt, creates unique turn and terminal markers, and sends it through the reserved canonical conversation.
3. ChatGPT returns one strict review bound to the target digest, candidate digest, and cycle number.
4. `settled` is accepted only when every criterion is `pass` and no blocking finding remains. Otherwise the review enters the same Codex thread as untrusted context for the next cycle.

The broker stops rather than loops indefinitely when either side reports a blocker, an identity or schema is invalid, a secret signature is detected, the same candidate/review state repeats, the cycle/deadline budget expires, browser delivery is ambiguous, or the broker restarts during an in-flight convergence operation. This is deliberate: automatic crash replay across a possibly accepted browser send could duplicate a message.

Current qualification status: the deterministic path, interruption behavior, long-lived MCP transport, and a fresh live two-cycle ChatGPT run all pass. The recorded run used one Codex App Server thread and the existing persistent ChatGPT Project conversation, returned the first review as untrusted context without human relay, and settled every criterion on cycle 2. See [CONTINUITY.md](https://github.com/xicv/ego-chat/blob/main/CONTINUITY.md) for exact identities, digests, and remaining fail-closed boundaries.

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

See [GATE0.md](https://github.com/xicv/ego-chat/blob/main/GATE0.md) for the original component qualification, [CONTINUITY.md](https://github.com/xicv/ego-chat/blob/main/CONTINUITY.md) for the bounded convergence contract and evidence, and [RESEARCH.md](https://github.com/xicv/ego-chat/blob/main/RESEARCH.md) for the research and architectural decision record.

## Release verification

The crate carries the MIT license and canonical repository metadata needed for publication. Before every release, inspect the exact archive with `cargo package --list` and run `cargo publish --dry-run --locked`. A crates.io version is permanent and cannot be overwritten, so publishing always requires explicit authorization for that exact version.

## Not yet supported

- ChatGPT-first initiation through a private plugin and Secure MCP Tunnel.
- Automatic GitHub push, repository upload, or attachment transfer.
- Automatic attachment/context-capsule construction beyond the bounded, secret-scanned implementing-agent review packet.
- Externally waking a Codex desktop task after its MCP adoption waiter has exited; adoption continues the same task while `ego_adopt_conversation_and_wait` remains open, while convergence owns a dedicated App Server thread.
- Externally waking or resuming a ZCode task after ZCode exits; ZCode-owned loops remain continuous while their current task or Goal is active.
- Monotonic fencing epochs across stale or suspended broker owners.
- Automatic replay after broker/browser restart, CAPTCHA, login, unexpected history, or an unattributable send. The one supported late-response path is evidence-only reconciliation and never resubmits a prompt.

Those are later phases. Consequential repository and remote operations remain outside the browser reviewer's authority.
