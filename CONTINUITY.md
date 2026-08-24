# Continuous convergence qualification

Qualification date: 2026-08-24, Australia/Adelaide.

## Outcome

Gate 0 passes for the bounded Codex-first convergence path on the installed stack. A live workflow completed an A/B/A/B exchange with no human relay: two Codex turns used one dedicated App Server thread, two ChatGPT reviews used one persistent Project conversation, the exact cycle-1 challenge returned to cycle 2 as untrusted context, and the strict cycle-2 review settled all acceptance criteria with no finding.

This is a usability gate, not a claim of transactional browser delivery or unattended production resilience. The broker remains deliberately fail-closed around ambiguous sends, restarts, authentication challenges, and unexpected browser state.

The implemented normal-process contract is:

```text
one start request
  -> durable convergence workflow and exclusive conversation lease
  -> one dedicated Codex App Server thread
  -> schema-bound Codex candidate
  -> exact, secret-scanned ChatGPT review prompt
  -> same canonical ChatGPT conversation through Ego
  -> strict review returned as untrusted context to the same Codex thread
  -> repeat within cycle and wall-clock budgets
  -> SETTLED or HUMAN_REQUIRED
```

Codex App Server is used through its documented initialize, thread start, turn start, event-stream, and turn-completed lifecycle. Every completion is matched to the exact thread and turn identity; ChatGPT output never becomes an App Server instruction or permission source. See the official [Codex App Server lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview).

## Settlement predicate

The broker accepts settlement only when all of these are true:

1. The immutable target and ordered acceptance criteria have the original target digest.
2. Codex returns a schema-valid candidate covering every criterion exactly once, with no unresolved blocker.
3. The ChatGPT response has one unique final terminal marker and one strict JSON review envelope.
4. That review binds the exact target digest, candidate digest, and current cycle.
5. Every criterion is `pass`, the decision is `settled`, and no blocking finding remains.

Neither model can settle by merely saying “done.” A repeated candidate/review signature, invalid identity, incomplete criterion set, non-actionable continuation, secret signature, missing authority, deadline, cycle exhaustion, or browser ambiguity stops in `human_required`.

## Continuity and authority boundaries

- The MCP facade is not the workflow owner. Caller or facade disconnect detaches only the waiter; `await_workflow` can reattach.
- One convergence workflow reserves one canonical ChatGPT binding across all A/B cycles. Interleaved manual or automated broker sends are rejected.
- The strongest-available / maximum-thinking policy is repaired and read back immediately before every ChatGPT send. Versioned labels are observations, not hardcoded selectors.
- ChatGPT review JSON enters the next Codex turn through App Server `additionalContext` with kind `untrusted`.
- `read-only` is the default Codex sandbox. `workspace-write` must be explicit.
- No convergence prompt grants commit, push, PR, deployment, release, production, approval, credential, or permission-expansion authority.
- The exact outbound ChatGPT bytes are size-bounded and scanned for high-confidence private-key, AWS, GitHub, OpenAI, and Slack token signatures before composition.
- Terminal workflow updates use compare-and-set persistence, so a late phase completion cannot resurrect a cancelled or stopped workflow.

The loop is durable across MCP client/facade failure, not across ambiguous side effects. A daemon restart during convergence becomes `human_required`; blindly replaying a possibly accepted browser send would violate the at-most-once boundary.

## Automated evidence

The final complete normal suite passed 24 of 25 tests; the only skipped test is the intentionally opt-in long-duration case. The separately enabled long MCP test passed after 65,302 ms. Covered convergence cases include:

- two Codex candidates and two ChatGPT reviews settling against one binding;
- exact target/candidate/cycle and ordered-criteria validation;
- future strongest-model label adoption without a source change;
- untrusted review context on the second Codex turn;
- protected-secret rejection before browser submission;
- repeated-state stagnation stop;
- exclusive conversation lease rejection;
- terminal-state precedence when an older App Server operation completes after cancellation;
- fail-closed broker restart;
- MCP facade replacement and reattachment;
- exact App Server thread/turn completion identity.

Changed-file-only ESLint passed. `npm audit --audit-level=high` reported zero vulnerabilities.

The installed-version gates also passed after the live fixes:

- `npm run gate0:app-server` proved broker-owned thread start and resume, exact desktop-origin read identity, active-writer isolation, and safe unsubscribe.
- `npm run gate0:codex-mcp` observed the MCP tool and final marker in the same real Codex turn after 75,787 ms.
- A separate live App Server probe used two consecutive structured turns on one thread; its second turn reproduced an exact test token supplied only through `additionalContext` with kind `untrusted`.

## Live qualification record

The final run reused binding `ego-chat-main`, one reserved Ego task space, the immutable test target, and the original canonical ChatGPT Project conversation. Its logical head began at 10 messages with the expected durable tail fingerprint.

Cycle 1 produced a durable candidate digest. ChatGPT derived a unique challenge from it, returned `continue`, and placed that exact challenge in blocking finding `B-CYCLE2_ECHO`. The first browser exchange advanced the logical head from 10 to 12 messages and committed the expected new tail fingerprint.

The broker supplied that review as untrusted context to cycle 2 of the same Codex thread. Codex echoed the exact challenge in a new digested candidate. ChatGPT consulted its immediately preceding review, verified the match, and returned `settled` with AC-1, AC-2, and AC-3 all `pass` and no findings.

The second exchange advanced the logical head to 14 messages and committed the expected new tail fingerprint. Both sends independently read back `GPT-5.6 Sol`, effort `Pro`, and power 5 of 5 immediately before composition. After settlement the same URL and target were verified again; the browser had one retained tab, an empty draft, no active generation, and a durably identified final assistant message.

Qualification itself exposed and fixed additional real-browser boundaries before the passing run:

- ChatGPT virtualizes older message DOM nodes, so durable identity now uses a tail anchor plus a logical message count rather than assuming the full history remains rendered.
- A late accepted send can be reconciled only against the prior assistant anchor, exact prompt digest, unique workflow marker, and stable user/assistant pair.
- The send control uses one raw browser-protocol click after bounded hit-target readiness; ambiguous delivery is never retried.
- ChatGPT is explicitly told the strict `B-...` finding-ID contract before review.
- App Server `additionalContext` is an experimental field in Codex CLI 0.149.0, so the client declares `experimentalApi: true` during initialization and waits for thread idle before the next exact turn.

## Gate decision and remaining scope

The honest Gate 0 claim is now: “live bounded Codex-first continuous conversation proven on the installed stack.” It is ready for supervised use with immutable targets, explicit acceptance criteria, bounded cycles, and the existing fail-closed rules.

Later work is still required for ChatGPT-first initiation, automatic GitHub or attachment context transfer, browser/daemon crash continuation, CAPTCHA/logout/rate-limit recovery, multi-owner fencing, and broader interruption qualification. Those are production-hardening and later-phase features; they do not invalidate this completed two-cycle continuity gate.
