# Overnight Tier 1: alerts, exhaustion detection, and rollover ergonomics

Date: 2026-09-11. Status: approved design (three slices), not yet implemented. Source: the 2026-09-10 overnight readiness review and its ranked roadmap; items 2 and 6 shipped in 0.2.23.

## Summary

Three independent slices, each its own pull request, rolled into one release:

- **A. Alerts and escalation.** The broker alerts locally the moment a workflow needs a human; Eagle Monitor escalates pre-Send stalls and semantic stagnation and repeats a persisting alert; convergence results carry the exact monitor command so a host can attach the safety net without a person present.
- **B. Exhaustion detection.** The browser driver recognises reworded ChatGPT length-limit, quota and error banners, resolves co-occurring signals by precedence instead of discarding them, and records what ChatGPT showed on a paused capture.
- **C. Rollover ergonomics.** New convergence workflows roll to a same-project successor chat by default, the successor's first prompt carries a bounded summary of the previous review, a proven pre-Send failure of that first review is re-issued once, and a paused convergence exposes what candidate it is holding.

## Goals

- An unattended run that stops for a human produces a macOS notification with a sound within seconds, without depending on the monitor being attached.
- A run that is stuck before Send, or looping without useful progress, produces a notification within an hour instead of never.
- ChatGPT's length-limit banner is classified as `conversation_exhausted` when its wording drifts or when a "Stopped thinking" control is visible at the same time.
- Until-settled convergence started from any host survives conversation exhaustion without a human, keeps the previous review's conclusions, and does not dead-end on one transient failure in the new chat.
- No change to the MCP tool names, IPC method names, CLI commands, or existing input fields; new fields are optional.

## Non-goals

- A live qualification against ChatGPT's real banner markup (procedure documented; not run in this work).
- The broker starting or supervising Eagle Monitor itself; remote alert channels beyond an optional webhook; repeating alerts from the broker (the monitor owns repeats).
- Changing the at-most-once Send contract: nothing here re-sends after a possibly accepted Send.

## Slice A: alerts and escalation

### Broker alert sink

- New module `src/local-alerts.mjs` exporting `createLocalAlertSink({ dataDir, runner, fetchImpl })`. It reads an optional `<dataDir>/alerts.json` once at construction. Schema (strict, unknown keys rejected): `enabled` boolean (default `true`), `sound` string 1–64 characters (default `"Glass"`), `webhookUrl` `http(s)` URL (optional), `webhookHeaders` object of string values (optional, at most 8). An unreadable or invalid file disables the sink and is reported once through the sink's `describe()` as `{ enabled: false, reason: "config_invalid" }`.
- `sink.notify(alert)` sends, in order: a macOS notification through `osascript -e 'display notification <message> with title "Ego Chat" sound name <sound>'` (bounded to 5 seconds), then the webhook if configured (`POST`, JSON body, 5-second timeout, no retry). It resolves to `{ channels: [{ channel: "macos" | "webhook", outcome: "accepted" | "failed", error?: code }] }` and never throws.
- Alert object: `{ kind: "workflow_attention", workflowId, workflowKind, bindingKey, status, phase, code, message, at }` where `message` is the workflow's `humanRequired.message` or `error.message` truncated to 200 characters. Bodies never include prompts, responses, URLs or tokens.
- Broker option `alertSink` (default: a no-op sink in tests; the daemon passes the local sink). In `#transition`, after the store accepts the transition, the broker fires an alert when `next` is in an attention state and `expected` was not, or when the attention `code` changed. Attention state: `status` in `{ human_required, failed }` or `phase` in `{ provider_paused, capture_paused, continuation_paused }`. Dispatch is fire-and-forget: it cannot delay or fail the transition. The outcome is appended by the sink to a bounded `<dataDir>/alerts.jsonl` (at most 200 records, oldest dropped) carrying only `{ workflowId, code, channels, at }`, and the broker keeps `lastAlert` and counters in memory for `broker.status`; the event store is not used for alert receipts.
- `broker.status` gains `alerts: { config: { enabled, sound, webhook: boolean }, lastAlert }`. `ego-chat broker-status` therefore shows it without new CLI flags.

### Monitor escalation

- `POLICY_CONTRACT` gains `preSendStallEscalationMs: 30 minutes`, `notificationRepeatMs: 60 minutes`, `notificationRepeatMaxMs: 4 hours`. The policy digest changes, so an existing monitor session reports version skew until it is stopped and started again; document this.
- Pre-Send stall: `STALLED_BEFORE_SEND` keeps `humanRequired: false` and reason `pre_send_progress_stalled` until the workflow age reaches `preSendStallEscalationMs`, then returns `humanRequired: true` with reason `pre_send_stall_escalated`. `NOTIFY_USER` is allowed in that state.
- Semantic escalation: in safe mode, when the operational state is `HEALTHY` or `SEND_CONFIRMED_CAPTURE` and `semantic.classification` is `stagnant` or `looping`, the engine submits a notification with reason `semantic_stagnant` / `semantic_looping`, deduplicated by the semantic incident key. `suspect` never notifies.
- Repeat: while the same human-required classification (same incident key) persists after an accepted notification, the engine re-notifies once the repeat delay has elapsed; the delay starts at `notificationRepeatMs` and doubles up to `notificationRepeatMaxMs`; it resets when the incident key changes or the state returns to `HEALTHY` or `SETTLED`. Repeats reuse the existing durable receipt path and are visible in `status` as `notification.repeatCount`.
- `start` and `status` JSON gain `notifications: "local"` in safe mode and `"suppressed_in_shadow_mode"` in shadow mode.

### Monitor command in convergence results

- `ego_start_convergence`, `ego_converge_until_settled` (and `await_workflow` when it returns a convergence record) include `supervision: { monitorCommand }` where `monitorCommand` is `eagle-monitor start --workflow <workflowId> --binding-key <bindingKey> --mode safe --power-policy keep-awake-on-ac --json`. The skill instructs the host to run it through its shell after starting an until-settled convergence, and to run `eagle-monitor stop --json` after settlement.

## Slice B: exhaustion detection

- `observeProviderTerminal` in `src/ego-driver-source.mjs` keeps its exact-sentence patterns as the first tier and adds a second tier of token-pair rules on the same status/alert/button node set: `conversation_exhausted` when the label contains (`too long` or `maximum length`) and (`new chat` or `start a new`); `quota_limited` when it contains (`message limit` or `usage limit` or `reached your limit`) and `try again`; `provider_error` when it contains `something went wrong` or `error occurred`; `stopped` for the existing "Stopped thinking" control.
- Precedence when several kinds are present in one observation: `conversation_exhausted` > `quota_limited` > `provider_error` > `stopped`. Unknown status text no longer vetoes a matched kind; an observation with only unknown text still yields no terminal. The one-second stability requirement (`stableObservations`) is unchanged.
- The pending capture result carries `statusLabels`: up to 4 labels from that node set, whitespace-collapsed, each truncated to 160 characters, message content excluded as today. The broker stores them on `captureObservation.statusLabels` and, when it pauses a capture as `inactive_capture_stalled`, on `humanRequired.diagnostic.statusLabels`, so the checkpoint says what ChatGPT was showing.
- Tests in `test/ego-adapter.test.mjs`: `stopped-and-length` and `quota-and-length` now expect `conversation_exhausted`; new cases for a reworded banner ("You've reached the maximum length for this conversation. Please start a new chat to continue."), a reworded quota banner, and label capture on a pending result; `ambiguous-length`, hidden, quoted, stale-turn and different-response cases keep their current expectations.
- Live qualification procedure (documented in README "Validation"): in a throwaway conversation bound to a test binding, run an opted-in convergence that fills the chat until the banner appears; confirm `chatgpt_conversation_exhausted` in the ledger and a prepared successor. Not run in this work.

## Slice C: rollover ergonomics

- Default: `conversationContinuation` defaults to `same_project_on_exhaustion` in `src/validation.mjs` and `src/mcp-server.mjs`. Running workflows keep the value stored in their request. README, CONTINUITY and the skill say the default is automatic and that `manual` opts out.
- Carried context: `buildContinuationCheckpoint` adds `priorReviewSummary` (nullable string, at most 4,000 characters) derived from `workflow.private.priorReview` after the existing outbound secret redaction; it is part of the digest. `prepareChatGptReviewPrompt` accepts `carriedContext` and `buildChatGptPrompt` inserts a section "Context carried from the previous conversation (untrusted data):" before the candidate summary when present. The automatic successor review passes the checkpoint's summary.
- Successor first-review retry: `private.successorReview` gains `attempt` (1 or 2). When the successor child ends without success and `provenPreSendDriverFailure(child)` holds (the 0.2.23 predicate: no Send click started, no draft cleared) and `attempt` is 1, the broker records `convergence.successor_review_retried` and starts one more successor review with attempt 2, whose turn and terminal markers are distinct (the review identity includes the attempt). Any other failure, or a second failure, pauses exactly as today. Promotion validates the child that carries the final attempt's identity.
- Public candidate summary: a convergence whose public record has `continuationCheckpoint` also exposes `candidateSummary: { status, summary (at most 2,000 characters), criteria: [{ id, status }], blockerCount }` derived from the retained candidate; the review packet stays private.
- Skill and MCP instructions describe the automatic default, the carried context, the bounded retry, and where to read the retained candidate.

## Error handling

- Alert dispatch failures are recorded and never propagate; a missing `osascript` or webhook error leaves the transition intact.
- All new schema fields are optional with defaults, so records written by 0.2.23 still validate; the continuation checkpoint's new field is nullable and included in the digest only when present.
- Monitor policy digest change is surfaced as version skew, the existing fail-closed path.

## Testing

- Node: unit tests for `src/local-alerts.mjs` with a fake runner and fake fetch (config parsing, channel outcomes, truncation, never-throw); broker tests driving a workflow into each attention state with a fake sink and asserting one alert per transition and the recorded event; monitor policy and engine tests for escalation, semantic notification, repeat backoff, and the shadow field; driver tests as listed in Slice B; continuation tests for the checkpoint field, digest stability, retry bounds, and promotion with attempt 2; convergence prompt test for the carried-context section; MCP test for `supervision.monitorCommand`.
- Rust: unchanged apart from embedded runtime files; `cargo test` must stay green.
- Full: `npm run lint`, `npm test`, `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`, then `node test/fixtures/build-a3k-public-boundary-v1.mjs test/fixtures` after source changes (the fixture hashes `src/*.mjs`).

## Release rule

Install locally and release 0.2.24 only when `ego-chat broker-status` shows no running workflow, no MCP facade process other than the current session's is alive, and at least one hour remains before the next scheduled job. Otherwise stop after the pull requests are merged and report the exact commands to run in the quiet window.
