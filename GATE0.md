# Gate 0 qualification

Qualification date: 2026-08-24, Australia/Adelaide.

This document preserves the original component-gate result. The later bounded A/B/A implementation and its separate guarantees are recorded in [CONTINUITY.md](./CONTINUITY.md).

Installed versions exercised:

- Node.js 24.19.0
- Ego Lite 0.4.7.1, Chromium 150
- Codex CLI 0.149.0
- `@modelcontextprotocol/sdk` 1.30.0
- Zod 4.4.3
- ESLint 10.9.0

## Outcome

Gate 0 is a conditional go for the Codex-first Phase 1 spike. The durable Codex-to-Ego-to-ChatGPT-to-Codex path is feasible on the installed versions. It is not evidence that the full bidirectional, multi-cycle product is complete.

| Gate | Result | Evidence |
| --- | --- | --- |
| Ego task space inherits the logged-in ChatGPT account | Pass | An isolated inherited task space reported an authenticated account, one composer, and an empty draft. |
| One marked prompt is sent once and a long response is captured | Pass | A live follow-up completed in 217,471 ms, returned the exact terminal marker, and produced a durable response digest recorded in private qualification state. |
| Strongest available model and maximum thinking are enforced before send | Pass | The final no-send policy ensure resolved `GPT-5.6 Sol`, effort `Pro`, at power `5/5` with `adjusted: false`, then durably recorded policy revision 2. |
| MCP remains active beyond the default timeout and returns in the same Codex turn | Pass | A final isolated real `codex exec` run completed after 83,604 ms with both the tool event and final marker observed. |
| Killing the MCP facade does not kill broker work | Pass | Automated test closed the first facade, connected a second facade, and reattached to the same durable workflow. |
| App Server starts/resumes the intended thread without crossing an active client | Partial | A broker-owned thread started and resumed in a fresh App Server process. Exact desktop thread read passed; concurrent desktop resume was correctly rejected as `active_writer`. Resume of this desktop-origin thread after it becomes inactive is not yet recorded. |
| ChatGPT-first private plugin reaches the broker | Deferred | The current supported surface is Codex-first. No Secure MCP Tunnel, Platform key, or ChatGPT developer-mode mutation was authorized or attempted. |

## Persistent-conversation evidence

A dedicated ChatGPT Project named `Ego Chat` was created once. Its blank project chat was persisted under binding key `ego-chat-main` before any message was sent.

The first marked send exposed an important real-world race: the user marker was confirmed once, but the Project conversation took longer than the original two-second window to expose a canonical URL. Ego Chat stopped in `human_required` and did not retry. After the URL settled, reconciliation promoted the lease only after exactly one rendered user-turn content boundary matched the durable prompt SHA-256 digest.

The subsequent live review supplied only `ego-chat-main` to the broker. The broker resolved the stored task space, target, canonical URL, and expected head. It completed on the same URL, with the URL digest retained only in private qualification state.

The stable head advanced from two messages to four messages and was committed with a durable fingerprint. After final broker restarts, browser verification reproduced that same URL, message count, and head fingerprint; the binding advanced to revision 6 without sending.

## Model-policy evidence

The browser policy is intentionally semantic: `strongest_available`, `maximum_available`, and `repair_then_verify`. It does not embed `GPT-5.6 Sol` or `Pro` as selection constants. Before every exchange, the fixed driver moves ChatGPT's own numeric Power control to its maximum, reads that equality back, records the resolved Model and Effort rows, closes the menu, and rechecks the conversation head before composition.

The final live no-send ensure on `ego-chat-main` observed model `GPT-5.6 Sol`, effort and pill `Pro`, and power level 5 of 5. `adjusted: false` proves that run did not need to change the already-maximum selection. The durable global policy advanced to revision 2.

Two earlier no-send qualification attempts encountered transient menu structure/close states and stopped in `human_required` before any draft or send. The driver now uses bounded semantic observation and bounded close verification around those transitions. A unit gate also substitutes a future `GPT-6 Sol` / `Ultra` / `6-of-6` observation and proves that the durable policy adopts it with `selectionChanged: true` without a source or policy-name edit.

The ChatGPT review itself identified three risks: stale-owner split brain, logical conversation drift despite the same URL, and the non-atomic browser-send/broker-commit gap. Gate 0 fed that review back into implementation:

- stable message-ID/role/content head fingerprints now fence later sends against visible thread drift;
- active generation and unexpected drafts block submission;
- the broker writes a unique workflow and prompt digest before browser work;
- a completed send must append exactly one user/assistant pair before the new head is committed;
- canonical-URL appearance is observed for up to 30 seconds after confirmed send;
- a delayed first send can be reconciled only by one exact rendered prompt digest;
- ambiguous operations are never retried automatically.

## Security and authority boundary

- The broker listens only on an `egc-*.sock` path directly inside the system temporary directory.
- The socket is created under a `077` umask and then verified mode `0600`.
- IPC uses a private 256-bit token and timing-safe comparison.
- Browser input crosses a mode-`0700` mailbox directory and a mode-`0600`, exclusive-create file.
- URLs accept only HTTPS `chatgpt.com`; canonical bindings require a conversation path.
- Child processes receive argument vectors, not shell command strings.
- No cookie, account identifier, credential, git push, commit, PR, deployment, or repository upload is performed.
- The local ledger intentionally contains prompts and captured responses. Its private filesystem boundary is part of the design.

## Honest guarantees and remaining later-phase work

Ego Chat provides fail-closed, effectively at-most-once automatic browser submission. It does not provide a transaction or idempotency key spanning the local broker, ChatGPT UI, and remote service. An accepted-but-uncommitted send can still require human reconciliation.

The later bounded Codex-first A/B/A/B continuity gate now passes and is recorded in [CONTINUITY.md](./CONTINUITY.md). The following evidence is still required before broader production or ChatGPT-first claims:

1. Resume this exact desktop-origin Codex task after its active writer is gone, then prove exact identity and safe unsubscribe.
2. Decide whether ChatGPT-first is still required; if so, qualify a private plugin and Secure MCP Tunnel under the actual account without exposing a public inbound listener.
3. Add monotonically increasing fencing epochs enforced by the sole browser worker before supporting lease takeover or multiple broker owners.
4. Run the interruption matrix at every compose/send/capture/persist boundary, plus browser restart, refresh, logout, CAPTCHA, rate limit, and network loss.
5. Add automatic bounded repository context capsules and qualify a real implementation/review loop that mutates an explicitly authorized disposable repository.

Until those items pass, this is a live bounded continuity proof—not a claim that the browser workflow is production-resilient or ChatGPT-first.
