# Ego Chat

Ego Chat is a local durable broker for Codex- or ZCode-to-ChatGPT collaboration through Ego Lite. It is not a second chat UI. A thin MCP process connects the coding agent, the broker owns each browser handoff independently of that client connection, and a fixed Ego Browser driver operates one persistent ChatGPT conversation.

The supported surfaces are a one-shot advisory handoff, durable broker-owned Codex convergence, and a current-host fallback loop:

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
    -> continue through recoverable faults until explicit settlement

or

current Codex or ZCode task/Goal (A)
    -> schema-constrained candidate
    -> one-candidate Ego Chat review call
    -> persistent ChatGPT web conversation (B)
    -> validated review returned to the same ZCode task
    -> current host submits the next cycle while it remains alive
```

The broker persists a named conversation lease. `create_once` starts from a verified blank ChatGPT page and promotes the lease only after the first confirmed send exposes a canonical conversation URL. `existing` opens and verifies a supplied canonical URL. Later calls need only the binding key; the broker resolves the task space, tab, URL, and expected conversation head.

## Implemented capabilities

- Checkpointed JSONL workflow and binding ledger that avoids rewriting the full state on every transition, compacts after 5,000 events or 8 MiB, and reduces completed convergence cycles to bounded identity/recovery metadata before storing the next candidate.
- Content-addressed private result blobs, 30-day raw-body retention, a 256 MiB default blob quota, and retained metadata for the latest 500 ordinary terminal workflows. Running, `human_required`, and still-reconcilable failed browser workflows retain their bodies or a full-size result reservation.
- One canonical broker identity per real data-directory path, a stable socket independent of `TMPDIR`, an exclusive broker lease, and a monotonic fencing epoch. The canonical broker also reserves known v0.1 socket aliases so a late stale Codex or ZCode facade cannot launch a second daemon.
- Private local state directory, files, token, runtime directory, and Unix socket.
- A private 4 MiB / 16-file driver mailbox with a 512 KiB per-input ceiling, five-minute inactive crash retention, strict lstat ownership/mode/link checks, live-child preservation, and child-owned unlink immediately after a successful read and before browser interaction.
- Authenticated IPC and an independently restartable stdio MCP facade.
- A runtime-contract digest that allows stale facades to inspect status but returns `restart_required` before they mutate durable state.
- Read-only adoption of a supplied private ChatGPT conversation URL, including a broker-owned wait for an already-running response and same-turn return to the invoking coding agent.
- Explicit Token-Saver waits that keep one durable MCP call open, suppress periodic progress notifications, minify the returned text envelope, and direct the bundled skill not to poll from extra model turns.
- One normal `ego_exchange_and_wait` MCP call that returns a long ChatGPT review into the same agent turn.
- One `ego_review_candidate_and_wait` call for a current-host-owned candidate, with exact target/candidate/cycle binding, objective settlement validation, ordinary-prose review support, and local continuation when a legacy response is structurally invalid.
- Detached `ego_start_exchange`, `await_workflow`, `workflow_status`, and `cancel_workflow` operations for recovery, plus an explicit acknowledged recovery-abandonment tool that preserves the at-most-once operation tombstone.
- A staged browser lifecycle that durably records `send_confirmed`, performs response capture read-only, and resumes that capture after a facade or broker restart without resending.
- One broker-wide FIFO browser lane across every binding and supported host. Confirmed-send response capture uses at most 15-second read-only slices, yields between slices, and revalidates the canonical conversation, prior head, prompt message ID, and unique marker before continuing; it never repeats Send.
- A two-hour default broker-owned ChatGPT generation budget, an eight-hour caller-attachment ceiling, and host MCP caps five minutes longer than that attachment while browser-workflow ownership remains durable.
- Compact Token-Saver text summaries plus digest-bound `ego_read_result` ranges for responses larger than 16 KiB.
- Persistent `ego-chat-main` conversation binding with exact canonical-URL verification.
- A durable `strongest_available` / `maximum_available` ChatGPT web policy, enforced immediately before every send.
- Stable conversation-head fingerprints over message IDs, roles, and content hashes before and after each bound send.
- One bounded rich-editor input transaction for large review packets, exact composer-digest verification immediately before each click, unique outbound markers, empty-draft checks, exact send-control checks, and no blind retry after an ambiguous delivery.
- Evidence-only reconciliation for a first confirmed send that exposes its canonical URL late, or for one exact tail-anchored user/assistant pair that completed after capture; reconciliation never clicks Send, stores the response by digest, and completes the original workflow for exact retry.
- Codex App Server spikes for broker-owned thread start/resume and desktop active-writer isolation.
- Broker-owned `ego_start_convergence` and `ego_converge_until_settled` workflows that alternate Codex and ChatGPT without human copy/paste.
- Immutable target and acceptance-contract digests, validated implementing-agent candidates, exact cycle identity, and objective settlement checks.
- A bounded durable task/runner core with immutable acceptance-and-evidence settlement contracts, exact-revision artifacts and evidence, completion-bound fenced verification leases, approval invalidation, and an effect ledger exercised only through fake adapters in this slice.
- Exclusive conversation leases across every cycle, an optional caller-selected cycle budget, caller-attachment deadlines, liveness guidance for repeated state, secret scanning of exact outbound review bytes, and terminal-state compare-and-set protection.
- ChatGPT feedback injected into the next Codex turn as explicitly untrusted App Server context.
- Native Rust setup, conflict-safe MCP configuration, and the same host-aware skill for both Codex and ZCode.

The delivery claim is deliberately limited: automatic sends are fail-closed and effectively at-most-once. Ego Chat does not claim exactly-once delivery across a browser UI and a remote service.

### Concurrent hosts and Ego Spaces

Codex.app and ZCode.app share one authoritative Ego Chat broker and the same default `ego-chat-main` binding. They do not silently create separate conversations or task spaces. One binding remains an exclusive ordered conversation lease: if another host already owns it, a different fresh operation receives `conversation_busy` instead of interleaving a stale prompt. An exact retry with the same operation identity still rediscovers its existing workflow.

Independent host tasks may use explicitly distinct bindings only when they also use different canonical ChatGPT conversations and deterministic Ego task spaces. Ego Chat serializes all of its browser-driver children even across those independent bindings, so Codex and ZCode queue rather than racing Ego Lite's global automation channel. A long confirmed-send capture releases that lane every 15 seconds while ChatGPT keeps thinking remotely; the caller remains in one Token-Saver wait and no second Send is created.

Using another Ego Space manually does not change a durable Ego Chat binding. Do not take over, close, stop, or type into the exact bound Space or its ChatGPT conversation while a workflow is active. Automation started outside Ego Chat is not part of its broker lane; until Ego Lite provides per-task-space CDP channels, simultaneous unrelated agent automation can still interfere despite separate Spaces. Track the upstream limitation in [`citrolabs/ego-lite#213`](https://github.com/citrolabs/ego-lite/issues/213).

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
- redirects only verified older managed daemon launchers to the new runtime, so a still-open older host facade cannot resurrect an obsolete broker;
- hands off an authenticated stale broker only after closing new mutation admission and proving it is idle with no prompt mailbox entry or browser child; current brokers drain atomically, while the one-time legacy path quarantines every authenticated socket before two final identity/idle/lease checks and restores those sockets on any active or ambiguous evidence;
- installs the bundled `ego-chat` skill under `~/.codex/skills/ego-chat`;
- registers the installed executable as the `ego_chat` STDIO MCP server with a timeout of at least 29,100 seconds: the eight-hour attachment plus five minutes of host transport margin.

Restart Codex.app after setup and use `/mcp` to verify `ego_chat`. Use `ego-chat setup --skip-codex-config` when configuration is managed separately. Setup refuses to replace a different skill or MCP entry unless `--force` is explicit.

`ego-chat setup-zcode` uses ZCode's native user-level surfaces:

- installs `SKILL.md` under `~/.zcode/skills/ego-chat`;
- semantically merges `mcp.servers.ego_chat` into `~/.zcode/cli/config.json` while preserving existing plugin and server entries;
- registers the absolute installed executable with `args: ["mcp"]` and a timeout of at least 29,100,000 ms: the eight-hour attachment plus five minutes of host transport margin, which `doctor-zcode` also validates;
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

Inspect the authoritative broker generation, runtime-contract digest, active workflows, and bounded-store counters without opening ChatGPT:

```sh
node ./bin/ego-chat.mjs broker-status
```

`ego-chat doctor` and `ego-chat doctor-zcode` also compare any live authoritative broker with the installed runtime. During setup, a protocol-aware stale broker atomically rejects new mutations, waits for already admitted mutation handlers, and rechecks durable workflows, active bindings, and the driver mailbox before gracefully releasing its lease. A legacy v0.2.1 broker has no drain method, so setup temporarily removes its authenticated socket names from ordinary clients, waits for in-flight requests, repeats the idle proof through the quarantined socket, and either stops it or restores every socket without signalling. This makes concurrent Codex/ZCode use fail closed instead of racing shutdown.

After upgrading, restart every open supported host, including both Codex.app and ZCode.app when both are running. A stale facade may read status and existing workflow results, but new mutations fail with `restart_required`; its verified managed daemon launcher points to the current runtime, so it cannot recreate an obsolete broker while waiting to be restarted. Ego Chat never starts a second broker against the same data directory to hide a mismatch.

## Persistent conversation

Inspect the existing default binding without touching the browser:

```sh
node ./bin/ego-chat.mjs conversation ego-chat-main
```

Run a browser-backed maintenance checkpoint of its canonical URL and current conversation head without sending:

```sh
node ./bin/ego-chat.mjs verify ego-chat-main
```

Do not use `verify` as a preflight for an exchange or review. Fresh sends perform their own canonical URL, stable-head, browser-readiness, and live model-policy checks. When an unattended loop has explicit reclaim authorization, the fresh send is also the only path allowed to reclaim the exact binding-owned task space. If you only need to confirm binding identity before a send, use `conversation` or `ego_get_conversation`; both read durable state without touching the browser.

Create-once and existing-URL bindings are accepted through `ego_bind_conversation` or the CLI's `bind <input-json-file>` command. A binding key is immutable: an existing key is never silently replaced. A ChatGPT Project can organize the conversation, but the canonical conversation URL and head fingerprint remain the authoritative identity. Separate workflows may run concurrently only when they use different canonical conversations and different Ego task spaces. The same conversation or task space is rejected before browser work with a reservation error. Continuous convergence reserves its canonical conversation for the whole workflow, so no manual or second automated send can interleave with the A/B loop.

For a bound conversation, the stored numeric Ego task-space ID is a recoverable location hint, not conversation identity. Ego Chat reopens the canonical URL in a deterministic binding-owned agent space when that numeric ID disappears or is recycled for an unrelated user task; it does not seize or disturb the unrelated space. When the user explicitly authorizes an unattended loop or tells Ego Chat to take its space back, a fresh exchange can set `allowTaskSpaceReclaim: true`. The driver then claims a user-owned/inactive exact `ego-chat-bound-*` space, or takes back an exact space previously delegated to the user, verifies agent ownership, and only then begins pre-Send inspection. This authority is limited to that deterministic binding space and that fresh Send. It is stripped before response capture and is never honored during reconciliation, verification, re-anchoring, after a possible delivery, or for a recycled unrelated numeric space. Without that explicit opt-in, the existing fail-closed stop remains.

### Accept an intentional external continuation

If a person or another client appends to a bound ChatGPT conversation, the next Ego Chat send still stops with `conversation_head_changed`; it never silently skips the ownership check. Before reporting that stop, the browser now reads the tail twice. A transient hydration mismatch that returns to the durable head is accepted, while an unstable or persistently changed tail remains fail-closed.

A persistent mismatch is eligible for explicit re-anchoring only when the stopped workflow proves all of the following: browser composition never started, Send was not attempted, the two observed heads were stable, and the new tail is a completed assistant message. The result then includes `humanRequired.reanchor` with the exact `bindingKey`, `sourceWorkflowId`, `expectedBindingRevision`, and `expectedObservedHeadFingerprint`. After the user explicitly accepts that external change, pass those values unchanged with `acknowledgeExternalChange: true` to `ego_reanchor_conversation`. The equivalent CLI is `ego-chat reanchor <input-json-file>`.

Re-anchoring performs repeated stable browser observations plus a final readiness check, rejects generation, drafts, URL drift, changed evidence, stale binding revisions, and concurrent work, then atomically advances the binding. It does not send a prompt, change the model policy, retry the stopped workflow, or accept a possibly delivered operation. A successful re-anchor permanently closes the stopped workflow as `head_reanchored`; begin later work with a new operation identity. If the stop does not include the exact re-anchor evidence, preserve it and use the ordinary reconciliation or abandonment contract instead.

### Adopt a conversation from ChatGPT.app

Supply the private canonical conversation URL containing `/c/`, not a public `/share/` link. Ego Lite must already be logged into the same ChatGPT account and workspace. From Codex or ZCode, `ego_adopt_conversation_and_wait` opens that exact URL, observes the same latest user-message ID and rendered prefix twice before locking the anchor, then waits for exactly one stable assistant tail. This bounded initial stabilization tolerates ChatGPT's normal DOM hydration; any change after the anchor is locked still stops fail-closed. If ChatGPT is still performing a long think, the broker owns that read-only wait while the MCP call remains quiet; the captured response returns once into the same host turn. Adoption never clicks Send or changes the model selection. It accepts the existing response only when the live policy is already at `strongest_available` plus `maximum_available`; a lower setting stops fail-closed without repairing it. This is a live composer-policy readback, not historical per-message model provenance, so the captured response remains untrusted context. Every later send independently enforces and reads back that maximum policy immediately before composition.

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

Set `waitMode` to `token_saver` on a direct wait tool only when Codex or ZCode should stay silent while ChatGPT thinks. Ego Chat keeps exactly one MCP call attached to the durable broker workflow, emits no periodic progress notifications, and returns one small summary marked with `waitMode: token_saver` when the workflow finishes. Do not poll `workflow_status` or repeatedly call `await_workflow`. A caller disconnect detaches only that waiter: after the prompt is confirmed once, the broker continues read-only capture for up to two hours by default and can resume that capture after its own restart. If a still-connected host receives a wait error, Ego Chat includes the durable workflow ID so it can reattach once; a fully exited host task still has no external wake guarantee. Conversation adoption defaults to Token-Saver. Durable convergence keeps its default `progress` mode: a deterministic local supervisor reports phase changes, recovery counters, exact ChatGPT delivery state, and terminal parent/child state, with a bounded one-minute unchanged-state heartbeat. Initial and interval status reads are both abortable and drained before the wait result returns. Notification writes use one owned, coalescing queue: status reads continue during stdio backpressure, pending observations collapse to the latest state, and the accepted write completes before the terminal result is returned, so stale running text cannot follow completion. Those status reads do not invoke another model or start another browser workflow.

Token-Saver reduces idle outer-agent turns and transport chatter. It does not weaken the strongest-model policy, shorten ChatGPT's reasoning, reduce the implementation turns genuinely needed for convergence, or provide an external wake after the host task has exited.

Local state defaults to `~/Library/Application Support/Ego Chat`. The directory is mode `0700`; ledgers, checkpoints, blobs, and the broker token are private. Large responses return an `ego-chat-result:<sha256>` reference; use `ego_read_result` with the originating workflow ID and expected digest when the full body is needed. Raw bodies expire after 30 days or earlier under the 256 MiB blob limit, while bounded excerpts and identity metadata remain.

Storage admission is fail-closed and happens before policy mutation, composition, or Send. Running, `human_required`, and still-reconcilable failed browser workflows keep their captured bodies protected; a bodyless workflow reserves the full 256 KiB per-result maximum across compaction and restart until exact reconciliation stores its response, delivery absence is proven, or the user explicitly abandons that recovery. The durable state checkpoint is limited to 64 MiB, the active event ledger to 8 MiB, unresolved recovery workflows to 256, bindings to 256, and exact lifetime operation identities to 10,000. The two checkpoint/state copies, event ledger, and blob tree therefore have a bounded persistent-data envelope of about 392 MiB plus small control files.

Prompt-bearing fixed-driver handoff files live in a separate private mailbox capped at 4 MiB, 16 files, and 512 KiB per input, giving the complete bounded local envelope about 396 MiB plus small control files. A browser child is durably registered before its PID-derived input file is created. The child opens that exact regular file with no-follow semantics, validates owner/mode/link count and size, reads it, then unlinks the pathname before the first browser interaction. Startup and every admission lstat only recognized owned inputs, preserve an exact file for a still-live registered process group, and remove inactive crash leftovers after five minutes; legacy UUID-only inputs follow the same short retention rule. A symlink, foreign owner, non-`0600` mode, hard link, oversize input, ambiguous duplicate PID, unknown entry, or exhausted byte/file quota fails closed before a browser process starts. `broker-status` reports mailbox limits, current files/bytes, reservations, and retention without exposing prompt contents or paths.

At an identity, recovery, or mailbox-capacity limit, existing exact retries and evidence remain readable, while a genuinely new operation stops before browser work instead of deleting proof or reopening an old identity. Treat the state directory and driver mailbox as sensitive.

`abandon_workflow_recovery` is a deliberate last-resort capacity release, not a retry mechanism. It requires `acknowledgePotentialDelivery: true`, is valid only for one stopped adoption, browser, or convergence recovery, and never removes any durable operation identity or permits it to run again. Use it only after the user explicitly chooses to stop recovering that exact workflow and understands that a remote ChatGPT turn or Codex turn may still exist; inspect the bound conversation and task evidence before authorizing later work that could duplicate it.

The equivalent direct CLI form is `ego-chat abandon <workflow-id> --acknowledge-potential-delivery`. Omitting the exact acknowledgement flag stops with usage error and does not mutate the workflow.

## Real-world workflows

In these workflows, **the local coding agent** means Codex.app or ZCode.app, and **the web reviewer** means the private ChatGPT web conversation opened through Ego Lite. Ego Chat installs into Codex and ZCode; it does not install an MCP server into ChatGPT.app. If a discussion starts in ChatGPT.app, copy its private canonical `/c/` conversation URL and adopt it from Codex or ZCode while Ego Lite is logged into the same ChatGPT account and workspace.

Ego Chat transports prompts, responses, and bounded review packets. It deliberately does not transport ZIP archives, clone repositories, upload files, create merge requests, or grant commit, merge, deployment, or release authority. For a code handoff, prefer an accessible repository plus an exact commit SHA or merge-request URL over a ZIP because the local agent can verify identity and drift independently.

### Coverage at a glance

| Need | Coverage | Boundary |
| --- | --- | --- |
| Start from Codex or ZCode and ask ChatGPT to research or brainstorm | Supported | Use durable convergence when the request says to continue until settled; use a Token-Saver exchange for one turn. |
| Reuse the same private ChatGPT conversation for later turns | Supported | The durable binding verifies the canonical URL and conversation head before every send. |
| Continue after a deliberate manual or other-client ChatGPT turn | Supported before Ego Chat sends | A proven stable assistant-tail advance is re-anchored automatically. A possibly accepted Ego Chat Send remains in read-only reconciliation so it is never duplicated. |
| Start from ChatGPT web or ChatGPT.app and continue locally from a URL | Supported | Adoption accepts a private canonical `/c/` URL, never a public `/share/` URL. |
| Wait while an already-running ChatGPT response performs a long think | Supported | Adoption waits read-only. For Ego Chat sends, `send_confirmed` is durable and capture continues independently of the caller's original wait. |
| Import the entire earlier transcript into the local task | Not provided | Adoption returns the latest stable assistant tail; the web conversation itself retains the earlier history. Use a self-contained final handoff packet. |
| Iterate implementation and review without human copy and paste | Supported | Codex defaults to broker-owned durable convergence for explicit until-settled requests. A current Codex or ZCode task can submit one candidate per cycle as a fallback. Neither path has an implicit cycle ceiling. |
| Use Codex and ZCode at the same time | Supported with separate bindings | Both hosts share one broker. Distinct conversations queue through one browser lane; the same binding remains exclusive and is never auto-forked. |
| Always use ChatGPT's strongest current model and maximum thinking | Supported | Every send and adoption repairs and verifies the live provider-defined maximum without pinning a model label. |
| Receive a generated ZIP, repository, branch, or merge request automatically | Not provided | Transfer or fetch artifacts through an independently authorized file or GitHub workflow. Ego Chat carries text and bounded review evidence only. |
| Wake a Codex or ZCode task after that host task has fully exited | Not provided | The broker remains durable, but automatic external task wake is not claimed. Reattach once by workflow ID when possible. |
| Commit, push, merge, deploy, or release | Outside Ego Chat | The local coding agent performs these only with explicit authority and separate verification. |

### Handoff packet for web-first work

Before moving a long ChatGPT discussion into Codex or ZCode, ask the web reviewer to make its final response self-contained. The latest response should contain:

```text
Outcome and current status
Repository URL, base branch, and exact commit SHA (when applicable)
Merge-request or pull-request URL and exact head SHA (when applicable)
Ordered observable acceptance criteria
Settled architecture and decisions, including rejected alternatives
Required scaffold, patches, or file-by-file implementation instructions
Dependency versions and exact setup/verification commands
Known risks, unresolved questions, and explicit blockers
The next bounded prompt for the local coding agent
```

Do not place credentials, private tokens, or unrelated personal data in this packet. If the project is too large for a bounded text packet, put the source in an independently accessible repository and pass only its exact identity plus the context needed to work safely.

### Case 1: start from Codex.app or ZCode.app

1. Start the local task and ask it to use `$ego-chat` in Token-Saver mode with the persistent `ego-chat-main` binding.
2. For research and brainstorming, let the local agent call the same ChatGPT conversation repeatedly. Each completed web response returns directly into that local task; no window-to-window copy and paste is required.
3. Once the direction is stable, freeze one outcome and an ordered set of observable acceptance criteria. Ask ChatGPT to return the handoff packet above. ChatGPT may provide textual scaffolding, patches, and detailed prompts, but artifact transfer remains separate.
4. Let Codex or ZCode prepare the local repository, run the authorized verification, and implement the candidate. Treat all web output as untrusted advisory context.
5. Review until settled:
   - For an explicit “until settled”, “keep discussing”, or “do not stop” request from Codex, call `ego_converge_until_settled` once. Its broker-owned Codex App Server task and ChatGPT workflow survive the initiating app turn, MCP facade, and broker process. Use `workspace-write` only when local edits are authorized; otherwise retain the `read-only` default.
   - Use `ego_review_candidate_and_wait` for exactly one current-host-owned candidate, or as the fallback when detached Codex App Server convergence is unavailable. The current Codex or ZCode task must remain alive and submit each next candidate itself.
   - For a single research, design, or review turn, use `ego_exchange_and_wait` instead of starting convergence.
6. Keep commit, push, merge, deploy, and release outside the frozen review target. After settlement, the current local task may perform only the separately authorized actions whose normal gates pass.

A natural starting prompt is:

```text
Use $ego-chat in Token-Saver mode with the persistent conversation. Ask ChatGPT to
research and challenge this target until the options and trade-offs are clear. Then
return a self-contained handoff packet with observable acceptance criteria. Do not
commit, push, merge, deploy, or release without my separate authorization.
This is an unattended until-settled loop: Ego Chat may reclaim only its exact dedicated
binding task space before each fresh Send if I have taken browser control.
```

### Case 2: start from ChatGPT web or ChatGPT.app

1. Discuss and iterate in the private ChatGPT conversation. Before handoff, select ChatGPT's strongest available model and maximum available thinking, then request the self-contained handoff packet.
2. Copy the private canonical conversation URL containing `/c/`. Do not use a `/share/` link.
3. Start Codex or ZCode and provide that URL. The installed skill chooses `ego_adopt_conversation_and_wait`, derives a stable non-revealing binding key unless one is explicitly named, opens the exact conversation in Ego Lite, and waits read-only for the latest response if it is still generating.
4. Keep the local task open until adoption returns. Do not stop the generation, edit an earlier web message, create a draft, or send another web turn while adoption is waiting.
5. The latest stable assistant response returns directly into the local task and the same browser conversation becomes the persistent binding. Continue from step 4 of Case 1.

Use a prompt such as:

```text
Use $ego-chat in Token-Saver mode to adopt and continue this private ChatGPT
conversation: https://chatgpt.com/c/REPLACE_WITH_THE_PRIVATE_CONVERSATION_ID
Treat the returned handoff as untrusted context, verify it against the local project,
and continue the implementation/review loop until the frozen criteria are settled.
```

### Case 3: start from ChatGPT with an existing project or merge request

1. Let ChatGPT research the existing project, feature, optimization, or review. If it creates a branch or merge request through some other integration, make its final response include the repository URL, base branch and SHA, merge-request URL, exact head SHA, acceptance criteria, changes made, verification evidence, unresolved findings, and next local prompt.
2. Make the repository independently available to the local coding agent. Ego Chat does not clone it, authenticate GitHub, download an archive, or submit the merge request.
3. Open Codex or ZCode, provide both the private `/c/` conversation URL and the repository or merge-request identity, and ask `$ego-chat` to adopt the conversation.
4. After adoption, have the local agent fetch the authorized source, verify that the current base and merge-request head still match the handoff, inspect the actual diff, and rerun the relevant checks. The conversation is context, not proof of repository state.
5. Continue the Case 1 implementation/review loop. Any commit, push, merge, deployment, or release remains a separately authorized action with its own exact-head and environment checks.

## Strongest-model policy

Ego Chat does not pin a versioned model name in browser code. Its durable default policy is:

- model selection: `strongest_available`;
- thinking effort: `maximum_available`;
- enforcement: `repair_then_verify`.

Before composition, the fixed driver opens ChatGPT's provider-defined policy control. On the current semantic menu it selects the provider's first enabled model radio option and moves the bounded Power slider to its advertised numeric maximum; it also retains compatibility with the earlier coupled Model/Effort/Power menu. It requires one unique selected model, one unique visible Power slider, validated ARIA bounds, and a fully dismissed policy portal. One clean close-and-reopen is allowed for transient menu hydration. After composing, it opens the control again read-only and requires another maximum readback immediately before Send. It then re-verifies the exact prompt, re-hit-tests the sole visible enabled Send control, and checks the authoritative broker process once more before dispatch. The currently observed resolution is `GPT-5.6 Sol`, effort `Pro`, at power `5/5`; those labels are an observation, not a permanent configuration value.

If ChatGPT later places a stronger model first or renames the maximum effort, the next successful verification records the new labels automatically and marks `selectionChanged`. No source edit or hardcoded model-name replacement is needed. A temporarily hydrating or unreadable policy control is retried with bounded backoff; Ego Chat clears an exact unsent draft when necessary and keeps the workflow alive. It never silently downgrades. Only a conclusive unsupported policy, signed-out session, or human verification challenge crosses the human boundary.

Read the last durable observation without opening the browser:

```sh
node ./bin/ego-chat.mjs model-policy
```

Repair to the provider's current maximum and verify the exact bound chat without sending a prompt:

```sh
node ./bin/ego-chat.mjs ensure-model-policy ego-chat-main
```

The equivalent MCP tools are `ego_get_model_policy` and `ego_ensure_model_policy`. Every normal handoff and every ChatGPT review cycle performs the repair-and-readback before composition plus a fresh read-only maximum check immediately before Send.

## Codex and ZCode MCP configuration

The Cargo wrapper configures this automatically. For development directly from this checkout, add the facade to the Codex configuration using the absolute path:

```toml
[mcp_servers.ego_chat]
command = "node"
args = ["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"]
required = true
tool_timeout_sec = 29100
```

For development directly from this checkout, ZCode's equivalent native user configuration is:

```json
{
  "mcp": {
    "servers": {
      "ego_chat": {
        "command": "node",
        "args": ["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"],
        "timeoutMs": 29100000
      }
    }
  }
}
```

Both values are eight hours plus five minutes of host transport margin. The one-minute supervised heartbeat keeps a healthy attached call observable; these configured host caps only bound that attachment and remain longer than the broker's eight-hour attachment window. Per-review and per-Codex-turn deadlines remain recovery triggers inside the durable workflow rather than limits on the overall workflow.

## Codex and ZCode skill

The distributable host-aware skill lives at [`skills/ego-chat`](https://github.com/xicv/ego-chat/tree/main/skills/ego-chat). `ego-chat setup` installs the Codex copy, while `ego-chat setup-zcode` installs the ZCode copy. After restarting the client, invoke it explicitly with `$ego-chat` or ask naturally:

> Use Ego Chat to review this implementation with ChatGPT until the acceptance criteria are settled.

The skill chooses between private conversation adoption, a one-shot review, durable broker-owned Codex convergence, and a current-task-owned Codex or ZCode fallback loop. An explicit until-settled request selects durable convergence by default. It preserves `ego-chat-main`, defaults convergence to read-only, and reconciles ambiguous delivery inside the original durable workflow instead of asking the user to relay or resend anything.

For the normal path, the current agent calls `ego_exchange_and_wait` with:

- `bindingKey: "ego-chat-main"`;
- one unique `EGO_CHAT_...` turn marker present exactly once in the prompt;
- a distinct expected terminal marker that ChatGPT is instructed to emit exactly;
- a bounded timeout.

The tool remains pending and returns the terminal workflow and captured response. Its default `progress` mode emits keepalive notifications; `waitMode: token_saver` stays silent. The browser send and response capture are separate: once `send_confirmed` is durable, capture can be restarted safely because it never composes or clicks. If the facade remains connected long enough to return a wait error, that error includes the workflow ID for one `await_workflow` reattachment; a detached start tool is the reliable choice when caller exit is expected.

## Current-host-owned convergence

When the current Codex or ZCode task must remain side A, keep that task (or ZCode [Goal](https://zcode.z.ai/en/docs/goal)) as the implementation owner. Freeze the stable outcome and ordered acceptance criteria, then call `ego_review_candidate_and_wait` after each candidate. This is a fallback, not the durable default for an unattended multi-cycle Codex request: an exited current-host task cannot submit its next candidate. Put mutable candidate identity such as an exact commit SHA in the candidate summary and review packet, not in the frozen target, so a corrective cycle does not silently change the contract. Finalize the packet before giving each exact candidate call one stable, non-secret `operationId`, then retain that ID until the result is recovered. Reissuing byte-identical arguments with that same ID rediscovers the original workflow after a lost tool result; reusing it with changed input fails closed. Ego Chat derives stable unique markers from that identity, redacts high-confidence secret signatures, verifies the exact composer contents, and repairs then verifies the strongest-model policy before every Send.

A candidate review packet admits up to 524,288 UTF-8 bytes, while the complete generated browser prompt is limited to 196,608 UTF-8 bytes. This exceeds the old 28,000-character and 65,536-byte admission ceilings without allowing an oversized browser transaction. When the assembled prompt exceeds its smaller transport budget, Ego Chat deterministically compacts its largest fields, includes digests and a transport note, and sends the bounded review automatically. A compacted review cannot settle the target by itself: it continues the loop and asks the next Codex cycle for a smaller evidence packet or exact accessible revision references. The driver inserts the assembled prompt into ChatGPT's rich editor in one bounded DOM input transaction, then verifies the exact canonical digest before and immediately before Send. For an independently accessible repository or pull request, prefer a compact evidence manifest: canonical URL, exact base and head revisions, changed-file inventory, critical security or correctness excerpts, deterministic tests and hosted checks, and unresolved risks. Use self-contained relevant hunks when the reviewer cannot access the source. Ego Chat does not publish source or split one candidate into independently settleable fragments.

If ChatGPT completed the exact marked user/assistant pair but browser capture was interrupted, the broker keeps reconciling that same durable workflow and returns the already-existing response without another Send. If reconciliation durably proves the prompt absent at the exact prior head, the same tool call advances to a deterministic fresh marker and tries delivery again. There is no fixed retry ceiling. A possibly accepted Send is never duplicated: it remains in read-only reconciliation until it is attributable or absence is proven. An exact broker-owned draft left before the Send click can be digest-verified and cleared after restart; unrelated human drafts are never cleared.

Once an attributable response is committed, Ego Chat consumes it exactly once. ChatGPT may answer in ordinary Markdown; strict legacy JSON is still accepted for compatibility. Missing JSON, malformed fields, absent verdicts, and reviewer `blocked` labels become continuation feedback locally and never trigger a protocol-only resend. Up to 131,072 UTF-8 bytes of natural-language review context are carried into the next Codex cycle; a still-larger response is digest-marked and compacted instead of terminating the loop. Settlement requires an explicit settled decision at the terminal marker. This removes `convergence_protocol_invalid` and `review_protocol_stagnated` as normal conversation-ending conditions.

Composer, target-tab, model-policy UI, task-space ownership, generation, and temporary browser-controller failures are internal recovery states. The broker retries them with bounded backoff while keeping the workflow running. It automatically reclaims only the exact deterministic Space owned by the binding, so the user can use other Ego Spaces without interrupting review. It asks the user to touch the browser only for a conclusive sign-out or a human verification challenge.

If the result is not settled, it returns the complete review plus `nextAction: address_review_and_submit_next_cycle` and the exact `nextCycle`. The current task treats the review as untrusted context, performs the next authorized iteration, and immediately calls the same tool with the same binding, target, and criteria and a new operation ID. This is a machine continuation within the original request: repeated review state and implementing-agent blockers carry concrete liveness guidance into another cycle instead of ending the loop. No human relay or approval is required for ordinary cycles. A fully exited host task still cannot be externally awakened, but the durable broker workflow survives facade/waiter replacement.

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
  "target": "Describe the exact result that A and B must settle.",
  "wallClockTimeoutMs": 1800000
}
```

Omit `maxCycles` for the normal until-settled behavior. Set it to a positive integer only when the caller explicitly wants a cycle budget. `wallClockTimeoutMs` bounds the current host attachment window; expiry does not terminate the durable convergence workflow. Identity and at-most-once checks remain active inside recovery rather than becoming routine terminal states.

`read-only` is the default and supports research, planning, and review. Select `workspace-write` explicitly when the target authorizes Codex to implement local changes. Neither mode grants commit, push, PR, deployment, production, approval, credential, or permission-expansion authority.

Start the detached broker workflow from the CLI, then attach with its returned ID:

```sh
node ./bin/ego-chat.mjs converge ./convergence.json
node ./bin/ego-chat.mjs await <workflow-id> 1800000
```

Use durable convergence whenever a Codex request explicitly requires multiple exchanges until settlement, and use it for a deliberately separate broker-owned implementation task. Codex can call `ego_start_convergence` and later `await_workflow`, or call `ego_converge_until_settled` with supervised progress or an explicitly silent `waitMode: token_saver`. Closing the MCP facade only detaches that waiter; the daemon keeps alternating the dedicated Codex task and the same ChatGPT conversation for an attachment window of up to eight hours. The broker requires observable workspace-capable App Server activity before it accepts a Codex candidate for external review. It accumulates that evidence and the no-inspection retry count across correction and recovered turns in the same cycle, so a final structured-envelope turn cannot lose tools, edits, or validation already observed earlier in that cycle and a broker restart cannot reset its liveness threshold. Every continuation atomically retires the consumed source turn and records the exact pending correction, inspection, or recovery action before another turn starts; restart therefore cannot double-count or recover an already-consumed result. A completed recovered turn is stored as an exact private pending-result receipt in the same transition that resets the consecutive streak and merges its activity. Restart consumes that receipt before constructing, connecting, or resuming an App Server client. A valid candidate reaches ChatGPT without the old thread and may settle without App Server setup; if candidate correction, workspace inspection, or later review requires more Codex work, a durable rotation marker starts a fresh thread before the next turn and remains authoritative across restart. Candidate capture or continuation clears the receipt atomically. If three turns in one cycle still have no workspace activity, the broker atomically captures a bounded blocked liveness candidate and its counters for ChatGPT recovery guidance, then carries that feedback into the next Codex cycle instead of retrying side A invisibly forever. If App Server exits during setup or any accepted turn, the broker determines accepted-turn recovery from durable state before connecting, so connect, resume, and result-inspection failures all count toward the same sequence while initial setup failures remain separate. Every durably completed accepted turn resets the consecutive streak before any correction or inspection continuation, without resetting the cumulative recovery metric. The eighth non-completed result is itself captured as the checkpoint's first durable result transition. After ChatGPT responds, the broker durably rotates away from the possibly stuck thread and starts the next cycle on a new generation. There is no fixed overall recovery or convergence ceiling. A Codex `blocked` result is sent to ChatGPT as review evidence rather than terminalizing convergence.

Each cycle is bound as follows:

1. Codex returns a schema-constrained candidate and evidence for every criterion; unresolved blockers remain explicit review evidence.
2. The broker redacts high-confidence secret signatures, creates unique turn and terminal markers, selects the strongest available model with maximum thinking, and sends through the reserved canonical conversation.
3. ChatGPT returns ordinary review prose and a simple settled-or-continue verdict; strict legacy envelopes remain accepted.
4. Settlement is accepted only for an explicit settled decision with no implementing-agent blocker. Otherwise the complete review enters the same Codex task as untrusted context for the next cycle.

The broker has no implicit cycle ceiling. Repeated candidate/review state adds a liveness instruction and continues. Browser/model-policy/transient UI failures retry; App Server exits reconnect; stable pre-Send assistant-head advances re-anchor; potentially accepted Sends stay in read-only reconciliation; proven absences get a uniquely marked new attempt. A running ChatGPT child is reattached through renewable wait windows, restart reconciliation can itself survive another broker restart, and completed cycle bodies are compacted before the next candidate is persisted. Only conclusive authentication/CAPTCHA, explicit caller budgets, unrecoverable durable corruption, or authority genuinely required outside review need to stop useful progress. App Server diagnostics retain only bounded identity, exit, signal, status, and digest fields; raw stderr is not stored in workflow state.

The original live two-cycle ChatGPT qualification remains the browser baseline. The current deterministic suite additionally covers unbounded protocol-free continuation, bounded historical cycle storage, repeated-state progress, App Server setup and accepted-turn reconnection, renewable child-review waits, exact task-space reclaim, transient model-policy recovery, repeated broker restart during reconciliation, ambiguous-delivery reconciliation, oversized-packet admission and compaction, and exact-owned unsent-draft cleanup. See [CONTINUITY.md](https://github.com/xicv/ego-chat/blob/main/CONTINUITY.md) for the contract and evidence boundary.

### Durable task and runner spine

The daemon now constructs a separate durable task spine beside the existing browser workflow store. The local `createDurableTaskSpine` entry point can also be used without the daemon or ChatGPT. Its pure reducer owns logical conversations, tasks, activities, exact base/head pull-request artifacts, capability-checked runner registrations and fenced leases, revision-bound approvals, adapter-bound effect reservations, bounded JSON inputs, and ordered cursor-addressed conversation events. The existing Ego Browser and Codex App Server workflow paths do not call the new task transitions; the broker exposes the spine through a narrow compatibility boundary for later slices.

This first slice has fake remote, runner, and effect adapters only. It cannot write to GitHub, merge, deploy, access production, retrieve credentials, or grant real-world authority. See [`docs/durable-task-runner-spine.md`](docs/durable-task-runner-spine.md) for the invariants, effect reconciliation protocol, local API example, and explicit limitations.

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

See [GATE0.md](https://github.com/xicv/ego-chat/blob/main/GATE0.md) for the original component qualification, [CONTINUITY.md](https://github.com/xicv/ego-chat/blob/main/CONTINUITY.md) for the convergence contract and evidence, and [RESEARCH.md](https://github.com/xicv/ego-chat/blob/main/RESEARCH.md) for the research and architectural decision record.

## Release verification

The crate carries the MIT license and canonical repository metadata needed for publication. Before every release, inspect the exact archive with `cargo package --list` and run `cargo publish --dry-run --locked`. A crates.io version is permanent and cannot be overwritten, so publishing always requires explicit authorization for that exact version.

## Not yet supported

- Direct MCP hosting inside ChatGPT.app; a ChatGPT.app conversation can only be continued by adopting its private `/c/` URL from Codex or ZCode.
- Full historical transcript import into the local coding task during URL adoption; only the latest stable assistant tail is returned, while the browser conversation retains its full history.
- ChatGPT-first initiation through a private plugin and Secure MCP Tunnel.
- Automatic GitHub push, repository upload, or attachment transfer.
- Automatic attachment/context-capsule construction beyond the bounded, secret-scanned implementing-agent review packet.
- Externally waking a Codex desktop task after its MCP adoption waiter has exited; adoption continues the same task while `ego_adopt_conversation_and_wait` remains open, while convergence owns a dedicated App Server thread.
- Externally waking or resuming a ZCode task after ZCode exits; ZCode-owned loops remain continuous while their current task or Goal is active.
- True simultaneous CDP automation between Ego Chat and unrelated external `ego-browser` clients. Ego Chat serializes its own children, but cannot serialize another process outside its authoritative broker while upstream per-Space CDP isolation remains unresolved.
- Blind replay of a possibly accepted browser Send. Ego Chat instead keeps the original workflow in read-only reconciliation and retries delivery only after exact absence proof.
- Automatic bypass of CAPTCHA or a conclusive sign-out. These are the intended browser-level human boundaries. Unknown or hydrating model/UI state retries without downgrading.

Those are later phases. Consequential repository and remote operations remain outside the browser reviewer's authority.
