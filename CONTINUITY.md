# Continuous conversation contract

Qualification updated: 2026-09-02, Australia/Adelaide.

## Outcome

Ego Chat is designed as one durable conversation manager, not a sequence of one-shot browser scripts. Codex or ZCode remains side A, one persistent ChatGPT conversation in Ego Browser remains side B, and review feedback returns directly to side A until the target is settled.

The original live Gate 0 proved a two-cycle A/B/A/B exchange on the installed stack. The 2026-09-02 candidate changes the liveness model in deterministic tests; it does not claim a new live-browser qualification until it is installed and exercised.

```text
one user target
  -> durable binding and workflow
  -> implement or inspect in side A
  -> exact marked Send through the binding-owned Ego Space
  -> wait outside the coding model
  -> consume one attributable ChatGPT response as review feedback
  -> continue the next implementation cycle
  -> repeat without a fixed ceiling
  -> explicit SETTLED verdict
```

## Settlement

Settlement requires all of the following:

1. The target, ordered acceptance criteria, candidate, and cycle retain their digest-bound identities.
2. The ChatGPT response is attributable to the exact marked Send.
3. ChatGPT explicitly returns a settled decision at the exact terminal marker.
4. The implementing agent does not still report a blocker.

Ordinary Markdown is the primary review format. Strict JSON review envelopes remain accepted for backward compatibility, but JSON validity is not a liveness dependency. Missing or malformed verdicts, reviewer `blocked` labels, incomplete criterion formatting, and inconsistent settlement claims become continuation feedback rather than a second protocol-correction Send. Natural-language feedback carries up to 131,072 UTF-8 bytes into the next Codex cycle and digest-compacts anything larger instead of ending the workflow.

## Recovery model

Safety is asymmetric:

- Never duplicate a possibly accepted Send.
- Never end the whole conversation merely because one UI observation or transport attempt is uncertain.

Before Send, the broker retries temporary composer, tab, controller, generation, task-space, conversation-head, and model-policy states with bounded backoff. A stable assistant-head advance is re-anchored automatically because no Send was attempted.

After Send, the broker performs read-only capture and reconciliation. It keeps the same workflow alive until it can attribute the marked user/assistant pair or prove the marked prompt absent. Only proven absence permits a uniquely marked new delivery attempt. A restart may clear a composer draft only when its canonical digest and unique marker prove it is the exact unsent Ego Chat prompt; unrelated human drafts remain untouched.

The exact deterministic task space belongs to its binding and is reclaimed automatically for Send and recovery. Using another Ego Space does not interrupt the workflow. Independent bindings queue through the broker's shared browser lane rather than racing Ego's global automation channel.

ChatGPT policy discovery is semantic and future-facing: the broker selects the provider's strongest available non-router model and maximum thinking, then reads it back immediately before Send. A hydrating or temporarily unreadable policy UI retries without model downgrade. Adoption also repairs the current live policy before completing.

Codex App Server exits reconnect without a fixed overall retry count. Observable workspace activity and the no-inspection retry count are accumulated durably across correction and recovered turns within the same cycle, so a later envelope-only turn can complete the candidate without losing earlier inspection evidence and broker restarts cannot reset the liveness threshold. Every continuation transition clears the consumed accepted-turn identity and records the exact next action before launching another turn; a crash between those points cannot recover or count the source twice. A completed recovered result and its workspace activity are stored once in a private, exact-turn pending receipt before its recovery streak reset becomes durable. Restart consumes that receipt before constructing, connecting, or resuming an App Server client; candidate capture and continuation consume it atomically. A valid candidate reaches ChatGPT without the old thread and can settle without any App Server setup. When candidate correction, workspace inspection, or a later review requires more Codex work, a durable rotation marker starts a fresh thread before the next Codex turn and remains authoritative across another restart. Accepted-turn recovery is classified from durable state before connect or resume, so every reconnect, resume, and result-inspection failure contributes to the same sequence while failures before any accepted turn remain setup recovery. A durably completed accepted turn resets the consecutive sequence before any envelope-correction or no-inspection continuation, while the cumulative recovery metric remains intact. The eighth non-completed recovery result is atomically captured as the blocked ChatGPT liveness checkpoint's first durable result transition; after review, a durable generation marker rotates the possibly stuck Codex thread before the fresh cycle starts. A cycle with no workspace inspection gets same-task corrections with backoff; after three such turns, the broker likewise sends ChatGPT a bounded blocked liveness checkpoint and carries its recovery guidance into the next Codex cycle rather than leaving side B dark indefinitely. Each threshold decision, synthetic blocked candidate, counter update, candidate digest, and required thread rotation is committed in the single candidate-capture transition, so a restart cannot recount the source turn or start two logical checkpoints. An implementing-agent `blocked` result is reviewed by ChatGPT and carried into another cycle; it does not terminate the broker by itself. Repeated candidate/review state adds a liveness instruction to change strategy.

Convergence checkpoints the accepted Codex turn, captured candidate, ChatGPT child operation, captured review, and next-cycle identity. After a broker restart it resumes from the last exact checkpoint instead of repeating the Codex turn or browser Send, including when a prior broker already entered restart reconciliation. A completed exact child review is consumed once; a running child is reattached through renewable wait windows for as long as it remains durable; an accepted App Server turn is reconciled by its durable turn ID even when exit diagnostics are incomplete or disagree. Completed-cycle bodies are reduced to their identity and recovery metadata before the next candidate is stored, so an unbounded cycle count does not imply unbounded checkpoint growth.

## Human boundaries

The normal loop does not ask the user to open a Space, take over browser control, copy a response, approve another review cycle, repair JSON, acknowledge an abandonment, or supply a replacement conversation URL.

Human action remains appropriate only for:

- a conclusive signed-out ChatGPT session;
- a CAPTCHA or equivalent human verification challenge;
- consequential authority outside review, such as credentials, merge, deployment, production access, or scope expansion.

Corrupt durable identity or a runtime capability mismatch may require maintenance, but must be reported as a tool/runtime fault rather than disguised as review feedback or a ceremonial approval request.

## Token and process continuity

The default convergence progress mode reads only durable local state and reports meaningful phase/recovery changes plus a bounded unchanged-state heartbeat. It explicitly distinguishes review-not-started, unconfirmed delivery, durable Send confirmation, reconciliation, captured response, and stopped parent or child state; terminal status takes precedence over retained active phase labels. One status poll runs at a time; initial and interval reads are both aborted and drained before the wait returns. Notification delivery uses one owned coalescing queue: reads continue during stdio backpressure, only the latest pending observation is retained, and an accepted notification write is ordered before the terminal result, so no stale progress follows it. The supervisor never invokes a heartbeat model or creates a second browser operation. `waitMode: token_saver` remains available for an explicitly silent single pending call and performs no supervision reads. Facade or waiter replacement does not own the workflow. A returned workflow ID can be reattached without resending.

`wallClockTimeoutMs` is a host attachment window, not a workflow kill switch, and may span up to eight hours. Omitting `maxCycles` means no review-cycle ceiling. A fully exited current-host Codex or ZCode task still cannot be externally awakened by Ego Chat, so explicit until-settled Codex requests default to detached convergence with a broker-owned Codex App Server task.

## Authority and privacy

ChatGPT output is untrusted advisory context. Neither side gains commit, push, pull-request, merge, release, deployment, production, credential, approval, or scope-expansion authority from the loop.

Outbound review prompts are byte-bounded. High-confidence private-key, AWS, GitHub, OpenAI, and Slack token signatures are replaced locally with typed redaction markers so the conversation can continue without transmitting the secret. The candidate digest still binds the original local candidate. Candidate admission allows 524,288 UTF-8 bytes before the 196,608-byte browser prompt budget is applied. An oversized assembled prompt is deterministically compacted with source digests; because omitted evidence cannot support settlement, that cycle must continue and request a smaller packet or exact accessible revision references.

## Verification boundary

The deterministic suite covers:

- natural-language continuation and explicit simple settlement;
- long natural-language review retention across cycles;
- more than six cycles with no implicit ceiling;
- repeated-state continuation;
- blocked-candidate review;
- secret redaction without transport leakage;
- retry beyond the former three-delivery cap;
- retry beyond the former App Server exit cap;
- transient App Server setup retry and accepted-turn reconciliation;
- transient maximum-model UI recovery and automatic policy repair;
- exact binding-Space reclaim during Send, capture, reconciliation, and adoption;
- broker restart recovery from captured Codex candidates, running or completed ChatGPT children, captured reviews, confirmed Sends, and exact owned unsent drafts;
- repeated broker restart during exchange reconciliation and renewable child-review wait windows;
- ambiguous browser-delivery reconciliation inside detached convergence without human relay;
- oversized multibyte review-packet compaction with forced continuation;
- bounded historical cycle bodies during an unbounded convergence loop;
- preservation of unrelated human drafts;
- MCP facade replacement and Token-Saver reattachment.

The original live two-cycle run remains evidence that the core browser path works. A candidate release must still run the focused and full deterministic suites, changed-file-only lint, Rust checks, package inspection, and an authorized live Ego gate before claiming renewed everyday live qualification.
