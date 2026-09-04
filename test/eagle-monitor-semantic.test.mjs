import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  classifyEagleSemanticLiveness,
  digestEagleSemanticCheckpoint,
  EAGLE_SEMANTIC_CHECKPOINT_MAX_BYTES,
  EAGLE_SEMANTIC_CHECKPOINT_SCHEMA,
  EAGLE_SEMANTIC_POLICY,
  EAGLE_SEMANTIC_STATE_SCHEMA,
  EAGLE_SEMANTIC_TESTING,
  projectEagleSemanticCheckpoint,
  publicEagleSemanticStatus,
  serializeEagleSemanticCheckpoint,
  validateEagleSemanticCheckpoint,
  validateEagleSemanticState,
} from "../src/eagle-monitor-semantic.mjs"

const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001"
const START_MS = Date.parse("2026-09-04T00:00:00.000Z")

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function bareCheckpoint({
  candidateDigest = null,
  evidence = [],
  expectedWait = null,
  fingerprint = digest("step-a"),
  phase = "working",
} = {}) {
  const checkpoint = projectEagleSemanticCheckpoint({
    createdAt: "2026-09-04T00:00:00.000Z",
    id: WORKFLOW_ID,
    inputDigest: digest("input"),
    phase,
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  checkpoint.candidateDigest = candidateDigest
  checkpoint.evidence = evidence
  checkpoint.expectedWait = expectedWait
  checkpoint.loop = EAGLE_SEMANTIC_TESTING.semanticLoopMetadata({
    actionClass: checkpoint.loop.actionClass,
    blockerDeltas: checkpoint.blockerDeltas,
    criterionDeltas: checkpoint.criterionDeltas,
    delivery: checkpoint.delivery,
    evidence: checkpoint.evidence,
    phase: checkpoint.phase,
    resultCode: checkpoint.loop.resultCode,
    resultDigest: checkpoint.loop.resultDigest,
    sanitizedArgumentDigest: fingerprint,
    toolClasses: checkpoint.loop.toolClasses,
  })
  return validateEagleSemanticCheckpoint(checkpoint)
}

function classify(checkpoint, previous = null, nowMs = START_MS) {
  return classifyEagleSemanticLiveness({
    brokerEpoch: 7,
    checkpoint,
    nowMs,
    previous,
  })
}

function evidence(kind, result, identity) {
  return { digest: digest(identity), kind, result }
}

test("EagleSemanticCheckpoint.v1 is deterministic, stable, and below the hard 16 KiB limit", () => {
  const workflow = {
    activeCodexTurn: { continuation: { cycle: 2, kind: "cycle" } },
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 2,
    deadlineAt: "2026-09-04T01:00:00.000Z",
    id: WORKFLOW_ID,
    phase: "codex_captured",
    private: {
      contract: { target: "raw target must not escape" },
      cycles: [{
        candidate: {
          blockers: ["Fix /Users/example/private.js using cookie=super-secret"],
          criteria: [{
            evidence: "Tested https://private.example/path with bearer-secret",
            id: "AC-1",
            status: "pass",
          }],
        },
        candidateDigest: digest("candidate"),
        codex: {
          responseDigest: digest("response"),
          workspaceActivity: { count: 9_999_999, types: ["command_execution"] },
        },
        cycle: 2,
      }],
      request: {
        codexTurnTimeoutMs: 120_000,
        cwd: "/Users/example/private",
        prompt: "raw prompt",
      },
    },
    prompt: "unbounded raw prompt",
    responseText: "unbounded raw response",
    shellOutput: "PRIVATE_UNBOUNDED_OUTPUT".repeat(10_000),
    status: "running",
    updatedAt: "2026-09-04T00:01:00.000Z",
  }
  const checkpoint = projectEagleSemanticCheckpoint(workflow)
  const serialized = serializeEagleSemanticCheckpoint(checkpoint)
  const reordered = Object.fromEntries(Object.entries(checkpoint).reverse())

  assert.equal(checkpoint.schema, EAGLE_SEMANTIC_CHECKPOINT_SCHEMA)
  assert.equal(serialized, serializeEagleSemanticCheckpoint(reordered))
  assert.equal(digestEagleSemanticCheckpoint(checkpoint), digest(serialized))
  assert.equal(Buffer.byteLength(serialized, "utf8") <= EAGLE_SEMANTIC_CHECKPOINT_MAX_BYTES, true)
  for (const privateValue of [
    "raw target",
    "raw prompt",
    "raw response",
    "/Users/example",
    "private.example",
    "bearer-secret",
    "super-secret",
    "9_999_999",
    "PRIVATE_UNBOUNDED_OUTPUT",
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue)
  }
  assert.equal(checkpoint.criterionDeltas[0].evidenceDigest.length, 64)
  assert.equal(checkpoint.blockerDeltas[0].digest.length, 64)
})

test("the checkpoint schema rejects extra content fields and malformed typed data", () => {
  const checkpoint = bareCheckpoint()
  assert.throws(
    () => validateEagleSemanticCheckpoint({ ...checkpoint, prompt: "do not persist" }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      evidence: [{ digest: digest("x"), kind: "heartbeat", result: "completed" }],
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      evidence: [{ digest: digest("x"), kind: "verified_source", result: "removed" }],
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  const duplicateEvidence = evidence("relevant_test", "passed", "duplicate-test")
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      evidence: [duplicateEvidence, duplicateEvidence],
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      loop: { ...checkpoint.loop, toolClasses: ["command_execution", "command_execution"] },
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      novelty: { sampleSize: 1, score: Number.NaN },
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      expectedWait: {
        deadlineAt: "2026-09-04T00:00:00.000Z",
        identityDigest: digest("backwards-wait"),
        maxExtensionMs: 60_000,
        operation: "relevant_test",
        startAt: "2026-09-04T00:00:01.000Z",
      },
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      expectedWait: {
        deadlineAt: "2099-09-04T00:00:00.000Z",
        identityDigest: digest("unbounded-wait"),
        maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
        operation: "relevant_test",
        startAt: "2026-09-04T00:00:00.000Z",
      },
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.throws(
    () => validateEagleSemanticCheckpoint({
      ...checkpoint,
      blockerDeltas: [{ change: "narrowed", digest: digest("unsupported-narrowing") }],
    }),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  for (const field of [
    "blockerDeltaDigest",
    "criterionDeltaDigest",
    "evidenceDigest",
    "fingerprint",
  ]) {
    assert.throws(
      () => validateEagleSemanticCheckpoint({
        ...checkpoint,
        loop: { ...checkpoint.loop, [field]: digest(`forged-${field}`) },
      }),
      (error) => error.code === "invalid_semantic_checkpoint",
    )
  }
})

test("the loop fingerprint covers phase, action, tool, argument, result, evidence, and criterion deltas", () => {
  const baseline = {
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    id: WORKFLOW_ID,
    phase: "codex_captured",
    private: {
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [{ evidence: "one", id: "AC-1", status: "pass" }],
        },
        candidateDigest: digest("candidate-a"),
        codex: {
          responseDigest: digest("result-a"),
          workspaceActivity: { count: 1, types: ["command_execution"] },
        },
        cycle: 1,
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:01:00.000Z",
  }
  const variants = [
    baseline,
    { ...baseline, phase: "review_captured" },
    { ...baseline, phase: "codex_recovering" },
    {
      ...baseline,
      private: {
        cycles: [{
          ...baseline.private.cycles[0],
          codex: {
            ...baseline.private.cycles[0].codex,
            workspaceActivity: { count: 1, types: ["mcp_tool_call"] },
          },
        }],
      },
    },
    {
      ...baseline,
      error: { code: "app_server_unavailable" },
    },
    { ...baseline, activeCodexTurn: { continuation: { cycle: 1, kind: "workspace_inspection" } } },
    {
      ...baseline,
      private: {
        cycles: [{
          ...baseline.private.cycles[0],
          codex: { ...baseline.private.cycles[0].codex, responseDigest: digest("result-b") },
        }],
      },
    },
    {
      ...baseline,
      private: {
        cycles: [{
          ...baseline.private.cycles[0],
          candidate: {
            blockers: [],
            criteria: [{ evidence: "two", id: "AC-1", status: "fail" }],
          },
        }],
      },
    },
  ]
  const fingerprints = variants.map((workflow) => (
    projectEagleSemanticCheckpoint(workflow).loop.fingerprint
  ))
  assert.equal(new Set(fingerprints).size, fingerprints.length)
})

test("production App Server activity types become closed typed loop classes", () => {
  const checkpoint = projectEagleSemanticCheckpoint({
    activeCodexWorkspaceActivity: {
      count: 6,
      types: [
        "collabAgentToolCall",
        "commandExecution",
        "dynamicToolCall",
        "fileChange",
        "imageView",
        "mcpToolCall",
        "secret_token",
        "untrusted/private/path",
      ],
    },
    createdAt: "2026-09-04T00:00:00.000Z",
    id: WORKFLOW_ID,
    phase: "codex_running",
    status: "running",
    updatedAt: "2026-09-04T00:01:00.000Z",
  })

  assert.deepEqual(checkpoint.loop.toolClasses, [
    "collab_agent_tool_call",
    "command_execution",
    "dynamic_tool_call",
    "file_change",
    "image_view",
    "mcp_tool_call",
  ])
  assert.equal(JSON.stringify(checkpoint).includes("untrusted/private/path"), false)
  assert.equal(JSON.stringify(checkpoint).includes("secret_token"), false)
})

test("checkpoint novelty counts each durable candidate and review once", () => {
  const checkpoint = projectEagleSemanticCheckpoint({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 2,
    id: WORKFLOW_ID,
    phase: "codex_captured",
    private: {
      cycles: [1, 2].map((cycle) => ({
        candidateDigest: digest(`candidate-${cycle}`),
        cycle,
        reviewSignature: digest(`review-${cycle}`),
      })),
    },
    status: "running",
    updatedAt: "2026-09-04T00:01:00.000Z",
  })

  assert.deepEqual(checkpoint.novelty, { sampleSize: 4, score: 1 })
})

test("only new attributable evidence renews useful progress", () => {
  const identity = evidence("relevant_test", "passed", "test-result-1")
  const first = classify(bareCheckpoint({ evidence: [identity] }))
  assert.equal(first.classification, "progressing")
  assert.equal(first.reasonCode, "new_attributable_evidence")

  const repeated = classify(bareCheckpoint({ evidence: [identity] }), first, START_MS + 1_000)
  assert.equal(repeated.classification, "progressing")
  assert.equal(repeated.reasonCode, "useful_progress_lease_active")
  assert.equal(repeated.usefulProgressLease.renewedAt, first.usefulProgressLease.renewedAt)
  assert.equal(repeated.metrics.unseenEvidenceCount, 0)

  const next = classify(bareCheckpoint({
    evidence: [identity, evidence("verified_artifact", "verified", "artifact-2")],
  }), repeated, START_MS + 2_000)
  assert.equal(next.reasonCode, "new_attributable_evidence")
  assert.notEqual(next.usefulProgressLease.renewedAt, first.usefulProgressLease.renewedAt)
})

test("a useful-progress lease is bound to its retained attributable evidence identities", () => {
  const checkpoint = bareCheckpoint({
    evidence: [
      evidence("relevant_test", "passed", "lease-test"),
      evidence("verified_source", "verified", "lease-source"),
    ],
  })
  const state = classify(checkpoint)
  const expectedIdentities = checkpoint.evidence.map((entry) => entry.digest).sort()

  assert.deepEqual(state.usefulProgressLease.evidenceDigests, expectedIdentities)
  assert.equal(
    state.usefulProgressLease.evidenceDigest,
    digest(JSON.stringify(expectedIdentities)),
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...state,
      usefulProgressLease: {
        ...state.usefulProgressLease,
        evidenceDigests: [digest("not-retained")],
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
})

test("a prose-only re-review of the same candidate cannot renew required verification", () => {
  const candidateDigest = digest("same-candidate")
  const workflow = (reviewSignature) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    id: WORKFLOW_ID,
    phase: "working",
    private: {
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [{ evidence: "same evidence", id: "AC-1", status: "pass" }],
        },
        candidateDigest,
        cycle: 1,
        review: {
          criteria: [{ evidence: "same evidence", id: "AC-1", status: "pass" }],
          findings: [],
        },
        reviewSignature,
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const firstCheckpoint = projectEagleSemanticCheckpoint(workflow(digest("review-prose-a")))
  const first = classify(firstCheckpoint)
  const repeatedCheckpoint = projectEagleSemanticCheckpoint(workflow(digest("review-prose-b")))
  const repeated = classify(
    repeatedCheckpoint,
    first,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )

  assert.equal(first.reasonCode, "new_attributable_evidence")
  assert.deepEqual(repeatedCheckpoint.evidence, firstCheckpoint.evidence)
  assert.equal(repeated.metrics.unseenEvidenceCount, 0)
  assert.equal(repeated.classification, "suspect")
})

test("rephrased findings and unstructured blockers cannot manufacture useful progress", () => {
  const candidateDigest = digest("stable-candidate")
  const reviewedWorkflow = ({ action, title }) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    id: WORKFLOW_ID,
    phase: "review_captured",
    private: {
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [{ evidence: "same", id: "AC-1", status: "fail" }],
        },
        candidateDigest,
        cycle: 1,
        review: {
          criteria: [{ evidence: "same", id: "AC-1", status: "fail" }],
          findings: [{ action, id: "B-TIMEOUT", severity: "blocking", title }],
        },
        reviewSignature: digest(`${action}:${title}`),
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const firstFinding = projectEagleSemanticCheckpoint(reviewedWorkflow({
    action: "Fix the timeout",
    title: "Timeout remains",
  }))
  const first = classify(firstFinding)
  const rephrasedFinding = projectEagleSemanticCheckpoint(reviewedWorkflow({
    action: "Resolve the timeout issue",
    title: "Request expiry is unresolved",
  }))
  const rephrased = classify(
    rephrasedFinding,
    first,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )
  assert.deepEqual(rephrasedFinding.evidence, firstFinding.evidence)
  assert.equal(rephrased.metrics.unseenEvidenceCount, 0)
  assert.equal(rephrased.classification, "suspect")

  const candidateWorkflow = (blocker) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 2,
    id: WORKFLOW_ID,
    phase: "codex_captured",
    private: {
      priorReview: {
        criteria: [{ evidence: "same", id: "AC-1", status: "fail" }],
        findings: [{
          action: "Fix the timeout",
          id: "B-TIMEOUT",
          severity: "blocking",
          title: "Timeout remains",
        }],
      },
      cycles: [{
        candidate: {
          blockers: [blocker],
          criteria: [{ evidence: "same", id: "AC-1", status: "fail" }],
        },
        candidateDigest: digest(blocker),
        cycle: 2,
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const firstBlocker = projectEagleSemanticCheckpoint(candidateWorkflow("Fix the timeout"))
  const blockerState = classify(firstBlocker)
  const rephrasedBlocker = projectEagleSemanticCheckpoint(candidateWorkflow(
    "Resolve the timeout issue",
  ))
  const blockerRepeat = classify(
    rephrasedBlocker,
    blockerState,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )
  assert.deepEqual(rephrasedBlocker.evidence, firstBlocker.evidence)
  assert.equal(blockerRepeat.metrics.unseenEvidenceCount, 0)
  assert.equal(blockerRepeat.usefulProgressLease, null)
  assert.notEqual(blockerRepeat.classification, "progressing")
  assert.notEqual(rephrasedBlocker.loop.fingerprint, firstBlocker.loop.fingerprint)
})

test("rephrased criterion evidence cannot renew the same structured transition", () => {
  const reviewWorkflow = (evidenceText) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    id: WORKFLOW_ID,
    phase: "review_captured",
    private: {
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [{ evidence: "still failing", id: "AC-1", status: "fail" }],
        },
        candidateDigest: digest("same-reviewed-candidate"),
        cycle: 1,
        review: {
          criteria: [{ evidence: evidenceText, id: "AC-1", status: "pass" }],
          findings: [],
        },
        reviewSignature: digest(evidenceText),
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const firstReview = projectEagleSemanticCheckpoint(reviewWorkflow("timeout regression passed"))
  const firstReviewState = classify(firstReview)
  const rephrasedReview = projectEagleSemanticCheckpoint(reviewWorkflow(
    "the regression covering the timeout now succeeds",
  ))
  const repeatedReview = classify(
    rephrasedReview,
    firstReviewState,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )
  assert.equal(repeatedReview.metrics.unseenEvidenceCount, 0)
  assert.notEqual(repeatedReview.classification, "progressing")

  const candidateWorkflow = (evidenceText) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 2,
    id: WORKFLOW_ID,
    phase: "codex_captured",
    private: {
      priorReview: {
        criteria: [{ evidence: "still failing", id: "AC-1", status: "fail" }],
        findings: [],
      },
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [{ evidence: evidenceText, id: "AC-1", status: "pass" }],
        },
        candidateDigest: digest(evidenceText),
        cycle: 2,
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const firstCandidate = projectEagleSemanticCheckpoint(candidateWorkflow("test passed"))
  const firstCandidateState = classify(firstCandidate)
  const rephrasedCandidate = projectEagleSemanticCheckpoint(candidateWorkflow(
    "the same test now passes",
  ))
  const repeatedCandidate = classify(
    rephrasedCandidate,
    firstCandidateState,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )
  assert.equal(repeatedCandidate.metrics.unseenEvidenceCount, 0)
  assert.notEqual(repeatedCandidate.classification, "progressing")
})

test("terminal fallback reuses live verification identity without inventing criterion deltas", () => {
  const candidateDigest = digest("terminal-reviewed-candidate")
  const reviewed = projectEagleSemanticCheckpoint({
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    id: WORKFLOW_ID,
    phase: "review_captured",
    private: {
      cycles: [{
        candidate: {
          blockers: [],
          criteria: [
            { evidence: "failing before review", id: "AC-1", status: "fail" },
            { evidence: "already passing", id: "AC-2", status: "pass" },
          ],
        },
        candidateDigest,
        cycle: 1,
        review: {
          criteria: [
            { evidence: "review proves pass", id: "AC-1", status: "pass" },
            { evidence: "still passes", id: "AC-2", status: "pass" },
          ],
          findings: [],
        },
        reviewSignature: digest("terminal-review"),
      }],
    },
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  const reviewedState = classify(reviewed)
  const terminalWorkflow = (criteria) => ({
    createdAt: "2026-09-04T00:00:00.000Z",
    id: WORKFLOW_ID,
    phase: "settled",
    result: { candidateDigest, criteria, findings: [] },
    status: "succeeded",
    updatedAt: "2026-09-04T00:00:01.000Z",
  })
  const terminalCriteria = [
    { evidence: "terminal wording one", id: "AC-1", status: "pass" },
    { evidence: "terminal wording two", id: "AC-2", status: "pass" },
  ]
  const terminal = projectEagleSemanticCheckpoint(terminalWorkflow(terminalCriteria))
  assert.deepEqual(terminal.criterionDeltas, [])
  assert.equal(terminal.evidence.length, 1)
  assert.equal(
    terminal.evidence[0].digest,
    reviewed.evidence.find((entry) => entry.kind === "required_verification").digest,
  )
  const settledState = classifyEagleSemanticLiveness({
    brokerEpoch: 7,
    checkpoint: terminal,
    nowMs: START_MS + 1_000,
    previous: reviewedState,
    settled: true,
  })
  assert.equal(settledState.classification, "settled")
  assert.equal(settledState.metrics.unseenEvidenceCount, 0)
  assert.deepEqual(settledState.seenEvidenceDigests, reviewedState.seenEvidenceDigests)
  assert.deepEqual(settledState.usefulProgressLease, reviewedState.usefulProgressLease)

  const rephrasedAndReordered = projectEagleSemanticCheckpoint(terminalWorkflow([
    { evidence: "same AC-2 with different prose", id: "AC-2", status: "pass" },
    { evidence: "same AC-1 with different prose", id: "AC-1", status: "pass" },
  ]))
  assert.deepEqual(rephrasedAndReordered.criterionDeltas, [])
  assert.deepEqual(rephrasedAndReordered.evidence, terminal.evidence)
  const repeatedTerminal = classifyEagleSemanticLiveness({
    brokerEpoch: 7,
    checkpoint: rephrasedAndReordered,
    nowMs: START_MS + 2_000,
    previous: settledState,
    settled: true,
  })
  assert.equal(repeatedTerminal.metrics.unseenEvidenceCount, 0)
  assert.deepEqual(repeatedTerminal.usefulProgressLease, reviewedState.usefulProgressLease)
})

test("the same expected-wait identity cannot regain time after a source gap", () => {
  const identityDigest = digest("stable-wait-x")
  const source = {
    deadlineAt: "2026-09-04T00:00:10.000Z",
    identityDigest,
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation: "relevant_test",
    startAt: "2026-09-04T00:00:00.000Z",
  }
  const extended = classify(bareCheckpoint({ expectedWait: source }), null, START_MS + 11_000)
  assert.equal(extended.expectedWaitLease.extensionUsed, 1)
  const absent = classify(bareCheckpoint(), extended, START_MS + 12_000)
  assert.equal(absent.expectedWaitLease, null)
  const reconstructed = validateEagleSemanticState(JSON.parse(JSON.stringify(absent)))
  const restored = classify(bareCheckpoint({
    expectedWait: {
      ...source,
      deadlineAt: "2026-09-04T00:05:10.000Z",
      startAt: "2026-09-04T00:05:00.000Z",
    },
  }), reconstructed, START_MS + 13_000)
  assert.equal(restored.expectedWaitLease.deadlineAt, source.deadlineAt)
  assert.equal(restored.expectedWaitLease.extensionUsed, 1)
  assert.equal(restored.expectedWaitLease.effectiveDeadlineAt, "2026-09-04T00:01:10.000Z")
  const expired = classify(
    bareCheckpoint({ expectedWait: source }),
    restored,
    START_MS + 71_000,
  )
  assert.equal(expired.expectedWaitLease.deadlineAt, source.deadlineAt)
  assert.equal(expired.expectedWaitLease.effectiveDeadlineAt, "2026-09-04T00:01:10.000Z")
  assert.notEqual(expired.classification, "expected_wait")

  const waitCheckpoint = bareCheckpoint({ expectedWait: source, fingerprint: digest("wait-x") })
  const noWaitCheckpoint = bareCheckpoint({ fingerprint: digest("no-wait") })
  let state = classify(waitCheckpoint)
  for (let index = 1; index <= 3; index += 1) {
    state = classify(noWaitCheckpoint, state, START_MS + index * 2_000 - 1_000)
    state = classify(waitCheckpoint, state, START_MS + index * 2_000)
  }
  assert.equal(state.classification, "looping")
  assert.equal(state.metrics.loopPattern, "alternating")
})

test("expected-wait tombstones are bounded and never evicted for a fresh identity", () => {
  let state = null
  for (let index = 0; index < EAGLE_SEMANTIC_POLICY.expectedWaitHistoryLimit; index += 1) {
    state = classify(bareCheckpoint({
      expectedWait: {
        deadlineAt: "2026-09-04T00:00:10.000Z",
        identityDigest: digest(`bounded-wait-${index}`),
        maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
        operation: "relevant_test",
        startAt: "2026-09-04T00:00:00.000Z",
      },
    }), state, START_MS + index * 1_000)
  }
  const retained = state.expectedWaitHistory.map((entry) => entry.identityDigest)
  assert.equal(retained.length, EAGLE_SEMANTIC_POLICY.expectedWaitHistoryLimit)

  const exhausted = classify(bareCheckpoint({
    expectedWait: {
      deadlineAt: "2026-09-04T00:00:30.000Z",
      identityDigest: digest("bounded-wait-overflow"),
      maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
      operation: "relevant_test",
      startAt: "2026-09-04T00:00:00.000Z",
    },
  }), state, START_MS + 16_000)
  assert.equal(exhausted.expectedWaitLease, null)
  assert.deepEqual(
    exhausted.expectedWaitHistory.map((entry) => entry.identityDigest),
    retained,
  )
})

test("candidate digests, timestamps, counters, and repeated prose cannot create useful progress", () => {
  const candidateOnly = bareCheckpoint({ candidateDigest: digest("candidate") })
  const first = classify(candidateOnly)
  assert.equal(first.classification, "suspect")
  assert.equal(first.usefulProgressLease, null)

  const changedNoise = projectEagleSemanticCheckpoint({
    appServerRecoveryCount: 1_000,
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 10,
    id: WORKFLOW_ID,
    phase: "working",
    prompt: "same repeated prose",
    status: "running",
    tokenCount: 1_000_000,
    updatedAt: "2026-09-04T00:10:00.000Z",
  })
  const second = classify(changedNoise, first, START_MS + 10_000)
  assert.equal(second.classification, "stagnant")
  assert.equal(second.usefulProgressLease, null)
})

test("two independent observations are required before stagnant or looping", () => {
  const checkpoint = bareCheckpoint()
  const first = classify(checkpoint)
  const duplicate = classify(checkpoint, first, START_MS)
  const second = classify(checkpoint, duplicate, START_MS + 1_000)
  const third = classify(checkpoint, second, START_MS + 2_000)
  assert.equal(first.classification, "suspect")
  assert.equal(duplicate.classification, "suspect")
  assert.equal(duplicate.observationCount, first.observationCount)
  assert.equal(duplicate.suspectCount, first.suspectCount)
  assert.equal(second.classification, "stagnant")
  assert.equal(third.classification, "looping")
  assert.equal(third.metrics.loopPattern, "repeated")
})

test("alternating and short-cycle fingerprints are detected in a bounded window", () => {
  const run = (labels) => labels.reduce((previous, label, index) => classify(
    bareCheckpoint({ fingerprint: digest(label) }),
    previous,
    START_MS + index * 1_000,
  ), null)

  const alternating = run(["a", "b", "a", "b", "a", "b"])
  assert.equal(alternating.classification, "looping")
  assert.equal(alternating.metrics.loopPattern, "alternating")
  const shortCycle = run(["a", "b", "c", "a", "b", "c"])
  assert.equal(shortCycle.classification, "looping")
  assert.equal(shortCycle.metrics.loopPattern, "short_cycle")
  assert.equal(shortCycle.fingerprintHistory.length <= EAGLE_SEMANTIC_POLICY.fingerprintHistoryLimit, true)
})

test("new evidence and valid expected waits suppress loop classification", () => {
  const loopingCheckpoint = bareCheckpoint()
  const first = classify(loopingCheckpoint)
  const second = classify(loopingCheckpoint, first, START_MS + 1_000)
  const looping = classify(loopingCheckpoint, second, START_MS + 2_000)
  assert.equal(looping.classification, "looping")

  const progressing = classify(bareCheckpoint({
    evidence: [evidence("verified_source", "verified", "source-1")],
  }), looping, START_MS + 3_000)
  assert.equal(progressing.classification, "progressing")
  assert.equal(progressing.metrics.loopPattern, null)

  const waitingCheckpoint = bareCheckpoint({
    expectedWait: {
      deadlineAt: "2026-09-04T00:05:00.000Z",
      identityDigest: digest("wait-1"),
      maxExtensionMs: 60_000,
      operation: "relevant_test",
      startAt: "2026-09-04T00:00:00.000Z",
    },
  })
  let waiting = null
  for (let index = 0; index < 8; index += 1) {
    waiting = classify(waitingCheckpoint, waiting, START_MS + index * 1_000)
  }
  assert.equal(waiting.classification, "expected_wait")
  assert.equal(waiting.metrics.loopPattern, null)
  assert.equal(waiting.fingerprintHistory.length, 1)
})

test("valid waits retain only meaningful cross-step history and defer loop classification", () => {
  const wait = {
    deadlineAt: "2026-09-04T00:00:10.000Z",
    identityDigest: digest("cross-step-wait"),
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation: "required_verification",
    startAt: "2026-09-04T00:00:00.000Z",
  }
  let state = null
  const fingerprints = []
  for (const [index, label] of ["a", "b", "a", "b", "a", "b"].entries()) {
    const checkpoint = bareCheckpoint({
      expectedWait: wait,
      fingerprint: digest(label),
    })
    fingerprints.push(checkpoint.loop.fingerprint)
    state = classify(checkpoint, state, START_MS + index * 1_000)
  }
  assert.equal(state.classification, "expected_wait")
  assert.deepEqual(state.fingerprintHistory, fingerprints)

  state = classify(bareCheckpoint({
    expectedWait: wait,
    fingerprint: digest("a"),
  }), state, START_MS + 11_000)
  assert.equal(state.classification, "expected_wait")
  assert.equal(state.expectedWaitLease.extensionUsed, 1)

  state = classify(bareCheckpoint({
    expectedWait: wait,
    fingerprint: digest("b"),
  }), state, START_MS + 70_001)
  assert.equal(state.classification, "suspect")
  state = classify(bareCheckpoint({
    expectedWait: wait,
    fingerprint: digest("a"),
  }), state, START_MS + 70_002)
  assert.equal(state.classification, "looping")
  assert.equal(state.metrics.loopPattern, "alternating")
})

test("cycling through newly named waits cannot hide a no-evidence loop", () => {
  let state = null
  for (const [index, label] of ["a", "b", "a", "b", "a", "b"].entries()) {
    state = classify(bareCheckpoint({
      expectedWait: {
        deadlineAt: "2026-09-04T00:05:00.000Z",
        identityDigest: digest(`wait-${label}`),
        maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
        operation: `operation_${label}`,
        startAt: "2026-09-04T00:00:00.000Z",
      },
      fingerprint: digest(label),
    }), state, START_MS + index * 1_000)
  }

  assert.equal(state.classification, "looping")
  assert.equal(state.metrics.loopPattern, "alternating")
})

test("a named expected wait is deadline-bounded and receives at most one small extension", () => {
  const waitingCheckpoint = bareCheckpoint({
    expectedWait: {
      deadlineAt: "2026-09-04T00:00:10.000Z",
      identityDigest: digest("same-wait"),
      maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
      operation: "relevant_test",
      startAt: "2026-09-04T00:00:00.000Z",
    },
  })
  const beforeDeadline = classify(waitingCheckpoint, null, START_MS + 9_000)
  assert.equal(beforeDeadline.classification, "expected_wait")
  const extended = classify(waitingCheckpoint, beforeDeadline, START_MS + 11_000)
  assert.equal(extended.classification, "expected_wait")
  assert.equal(extended.expectedWaitLease.extensionUsed, 1)
  assert.equal(
    Date.parse(extended.expectedWaitLease.effectiveDeadlineAt) - Date.parse(extended.expectedWaitLease.deadlineAt),
    EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
  )

  const sourceTriesToRenew = structuredClone(waitingCheckpoint)
  sourceTriesToRenew.expectedWait.deadlineAt = "2026-09-04T01:00:00.000Z"
  const expired = classify(
    sourceTriesToRenew,
    extended,
    Date.parse(extended.expectedWaitLease.effectiveDeadlineAt) + 1,
  )
  assert.equal(expired.classification, "suspect")
  assert.equal(expired.expectedWaitLease.extensionUsed, 1)
  assert.equal(expired.expectedWaitLease.deadlineAt, "2026-09-04T00:00:10.000Z")
})

test("a named wait cannot become active before its declared start", () => {
  const checkpoint = bareCheckpoint({
    expectedWait: {
      deadlineAt: "2026-09-04T00:02:00.000Z",
      identityDigest: digest("future-wait"),
      maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
      operation: "required_verification",
      startAt: "2026-09-04T00:01:00.000Z",
    },
  })
  const beforeStart = classify(checkpoint, null, START_MS)

  assert.equal(beforeStart.classification, "suspect")
  assert.equal(beforeStart.expectedWaitLease.operation, "required_verification")
})

test("a fresh Codex turn receives a distinct expected-wait identity within one cycle", () => {
  const workflow = {
    activeCodexTurn: {
      continuation: { cycle: 1, kind: "cycle" },
      cycle: 1,
      turnId: "codex-turn-one",
    },
    createdAt: "2026-09-04T00:00:00.000Z",
    cycle: 1,
    deadlineAt: "2026-09-04T01:00:00.000Z",
    id: WORKFLOW_ID,
    phase: "codex_running",
    status: "running",
    updatedAt: "2026-09-04T00:01:00.000Z",
  }
  const first = projectEagleSemanticCheckpoint(workflow)
  const second = projectEagleSemanticCheckpoint({
    ...workflow,
    activeCodexTurn: { ...workflow.activeCodexTurn, turnId: "codex-turn-two" },
    updatedAt: "2026-09-04T00:02:00.000Z",
  })

  assert.notEqual(first.expectedWait.identityDigest, second.expectedWait.identityDigest)
  assert.equal(JSON.stringify(first).includes("codex-turn-one"), false)
  assert.equal(JSON.stringify(second).includes("codex-turn-two"), false)
})

test("process, transport, recovery, settlement, and human boundaries remain separate dimensions", () => {
  const checkpoint = bareCheckpoint()
  const degraded = classifyEagleSemanticLiveness({
    brokerEpoch: 8,
    checkpoint,
    nowMs: START_MS,
    processHealth: "dead",
    recoveryActive: true,
    transportHealth: "unknown",
  })
  assert.deepEqual(degraded.dimensions, {
    humanBoundary: false,
    process: "dead",
    recovery: "in_flight",
    settlement: "active",
    transport: "unknown",
  })
  assert.equal(degraded.classification, "suspect")

  const human = classifyEagleSemanticLiveness({
    brokerEpoch: 8,
    checkpoint,
    humanRequired: true,
    nowMs: START_MS,
    settled: false,
  })
  assert.equal(human.classification, "human_required")
  assert.equal(human.dimensions.humanBoundary, true)
  const settled = classifyEagleSemanticLiveness({
    brokerEpoch: 8,
    checkpoint,
    nowMs: START_MS,
    settled: true,
  })
  assert.equal(settled.classification, "settled")
  assert.equal(settled.dimensions.settlement, "settled")
})

test("broker epoch changes reset hysteresis but retain exact evidence-identity history", () => {
  const checkpoint = bareCheckpoint({
    evidence: [evidence("required_verification", "completed", "verification-1")],
  })
  const first = classify(checkpoint)
  const nextEpoch = classifyEagleSemanticLiveness({
    brokerEpoch: 8,
    checkpoint: bareCheckpoint(),
    nowMs: START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
    previous: first,
  })
  assert.equal(nextEpoch.classification, "suspect")
  assert.equal(nextEpoch.observationCount, 1)
  assert.deepEqual(nextEpoch.seenEvidenceDigests, [checkpoint.evidence[0].digest])
  assert.equal(nextEpoch.metrics.unseenEvidenceCount, 0)
})

test("same-workflow time cannot regress across broker epochs or revive expired leases", () => {
  const progressing = classify(bareCheckpoint({
    evidence: [evidence("verified_source", "verified", "time-floor-evidence")],
  }))
  const expiredProgress = classify(
    bareCheckpoint(),
    progressing,
    START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1,
  )
  const reconstructedProgress = validateEagleSemanticState(
    JSON.parse(JSON.stringify(expiredProgress)),
  )
  assert.throws(
    () => classifyEagleSemanticLiveness({
      brokerEpoch: 8,
      checkpoint: bareCheckpoint(),
      nowMs: START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs - 1,
      previous: reconstructedProgress,
    }),
    (error) => error.code === "invalid_semantic_observation",
  )
  assert.equal(
    publicEagleSemanticStatus(
      reconstructedProgress,
      START_MS + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs - 1,
    ).usefulProgressLease.active,
    false,
  )

  const wait = {
    deadlineAt: "2026-09-04T00:00:10.000Z",
    identityDigest: digest("time-floor-wait"),
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation: "relevant_test",
    startAt: "2026-09-04T00:00:00.000Z",
  }
  const extended = classify(bareCheckpoint({ expectedWait: wait }), null, START_MS + 11_000)
  const expiredWait = classify(bareCheckpoint({ expectedWait: wait }), extended, START_MS + 71_000)
  const reconstructedWait = validateEagleSemanticState(JSON.parse(JSON.stringify(expiredWait)))
  assert.equal(
    publicEagleSemanticStatus(reconstructedWait, START_MS + 60_000).expectedWaitLease.active,
    false,
  )
  assert.throws(
    () => classifyEagleSemanticLiveness({
      brokerEpoch: 8,
      checkpoint: bareCheckpoint({ expectedWait: wait }),
      nowMs: START_MS + 60_000,
      previous: reconstructedWait,
    }),
    (error) => error.code === "invalid_semantic_observation",
  )
})

test("semantic state validation rejects unsupported restart state", () => {
  const state = classify(bareCheckpoint())
  assert.equal(validateEagleSemanticState(state), state)
  assert.equal(state.schema, EAGLE_SEMANTIC_STATE_SCHEMA)
  assert.throws(
    () => validateEagleSemanticState({ ...state, schema: "EagleSemanticState.v2" }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({ ...state, rawResponse: "private" }),
    (error) => error.code === "corrupt_monitor_state",
  )
})

test("semantic state validation rejects forged or relationally corrupt leases", () => {
  const wait = {
    deadlineAt: "2026-09-04T00:00:10.000Z",
    identityDigest: digest("persisted-wait"),
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation: "relevant_test",
    startAt: "2026-09-04T00:00:00.000Z",
  }
  const waiting = classify(bareCheckpoint({ expectedWait: wait }), null, START_MS + 1_000)
  assert.throws(
    () => validateEagleSemanticState({
      ...waiting,
      expectedWaitLease: {
        ...waiting.expectedWaitLease,
        effectiveDeadlineAt: "2027-09-04T00:00:10.000Z",
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...waiting,
      expectedWaitHistory: waiting.expectedWaitHistory.map((entry) => ({
        ...entry,
        operation: "required_verification",
      })),
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...waiting,
      expectedWaitLease: {
        ...waiting.expectedWaitLease,
        deadlineAt: "2099-09-04T00:00:00.000Z",
        effectiveDeadlineAt: "2099-09-04T00:00:00.000Z",
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...waiting,
      expectedWaitLease: {
        ...waiting.expectedWaitLease,
        observedAt: "2026-09-04T00:00:02.000Z",
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )

  const progressing = classify(bareCheckpoint({
    evidence: [evidence("verified_source", "verified", "bounded-lease")],
  }))
  assert.throws(
    () => validateEagleSemanticState({
      ...progressing,
      usefulProgressLease: {
        ...progressing.usefulProgressLease,
        expiresAt: "2027-09-04T00:00:00.000Z",
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...progressing,
      usefulProgressLease: {
        ...progressing.usefulProgressLease,
        expiresAt: "2099-09-04T00:15:00.000Z",
        renewedAt: "2099-09-04T00:00:00.000Z",
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )

  assert.throws(
    () => validateEagleSemanticState({
      ...progressing,
      metrics: {
        ...progressing.metrics,
        qualifyingEvidenceCount: 41,
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.throws(
    () => validateEagleSemanticState({
      ...progressing,
      metrics: {
        ...progressing.metrics,
        qualifyingEvidenceCount: 0,
        unseenEvidenceCount: 1,
      },
    }),
    (error) => error.code === "corrupt_monitor_state",
  )
})
