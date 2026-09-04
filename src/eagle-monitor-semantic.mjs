import { createHash } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

export const EAGLE_SEMANTIC_CHECKPOINT_SCHEMA = "EagleSemanticCheckpoint.v1"
export const EAGLE_SEMANTIC_STATE_SCHEMA = "EagleSemanticState.v1"
export const EAGLE_SEMANTIC_CHECKPOINT_MAX_BYTES = 16 * 1024

const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const CRITERION_PATTERN = /^AC-[1-9][0-9]{0,2}$/
const BLOCKER_PATTERN = /^B-[A-Z0-9_-]{1,40}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const MAX_CHECKPOINT_EVIDENCE = 40
const MAX_EVIDENCE_IDENTITIES = 512
const MAX_EXPECTED_WAIT_MS = 8 * 60 * 60_000
const MAX_EXPECTED_WAIT_HISTORY = 16
const MAX_FINGERPRINT_HISTORY = 12

const PHASE_ORDINALS = Object.freeze({
  browser_owned: 10,
  capture_pending: 50,
  chatgpt_running: 40,
  codex_captured: 30,
  codex_ready: 11,
  codex_recovering: 12,
  codex_running: 20,
  created: 0,
  head_committed: 60,
  model_policy_verified: 20,
  preflight: 30,
  prompt_staged: 40,
  response_captured: 60,
  restart_reconciling: 45,
  review_captured: 50,
  send_confirmed: 50,
  settled: 70,
  stopped: 70,
})

const EVIDENCE_RESULTS_BY_KIND = Object.freeze({
  actionable_review: new Set(["actionable"]),
  blocker_delta: new Set(["added", "removed"]),
  criterion_delta: new Set(["failed", "passed"]),
  relevant_test: new Set(["failed", "passed"]),
  required_verification: new Set(["completed", "failed"]),
  verified_artifact: new Set(["verified"]),
  verified_source: new Set(["verified"]),
})

const QUALIFYING_EVIDENCE_KINDS = new Set(Object.keys(EVIDENCE_RESULTS_BY_KIND))

const SEMANTIC_CLASSIFICATIONS = new Set([
  "expected_wait",
  "human_required",
  "looping",
  "progressing",
  "settled",
  "stagnant",
  "suspect",
])

const LOOP_PATTERNS = new Set(["alternating", "repeated", "short_cycle"])

const WORKSPACE_ACTIVITY_TOOL_CLASSES = Object.freeze({
  collabAgentToolCall: "collab_agent_tool_call",
  commandExecution: "command_execution",
  dynamicToolCall: "dynamic_tool_call",
  fileChange: "file_change",
  imageView: "image_view",
  mcpToolCall: "mcp_tool_call",
})

export const EAGLE_SEMANTIC_POLICY = Object.freeze({
  expectedWaitExtensionMs: 60_000,
  expectedWaitHistoryLimit: MAX_EXPECTED_WAIT_HISTORY,
  expectedWaitMaximumMs: MAX_EXPECTED_WAIT_MS,
  fingerprintHistoryLimit: MAX_FINGERPRINT_HISTORY,
  maxEvidenceIdentities: MAX_EVIDENCE_IDENTITIES,
  usefulProgressLeaseMs: 15 * 60_000,
})

function fail(code, message) {
  throw new EgoChatError(code, message)
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}

function isTimestamp(value) {
  return typeof value === "string"
    && TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value)
}

function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value)
}

function isNullableDigest(value) {
  return value === null || isDigest(value)
}

function isCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value)
}

function isNullableCode(value) {
  return value === null || isCode(value)
}

function safeCode(value) {
  return isCode(value) ? value : null
}

function safeToolClass(value) {
  if (Object.hasOwn(WORKSPACE_ACTIVITY_TOOL_CLASSES, value)) {
    return WORKSPACE_ACTIVITY_TOOL_CLASSES[value]
  }
  return Object.values(WORKSPACE_ACTIVITY_TOOL_CLASSES).includes(value) ? value : null
}

function safeCriterionId(value) {
  return typeof value === "string" && CRITERION_PATTERN.test(value) ? value : null
}

function safeDigest(value) {
  return value === null || value === undefined
    ? null
    : createHash("sha256").update(String(value), "utf8").digest("hex")
}

function digestJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`
  }
  return JSON.stringify(value)
}

function boundedTimestamp(value) {
  return isTimestamp(value) ? new Date(value).toISOString() : null
}

function latestTimestamp(...values) {
  return values
    .map(boundedTimestamp)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null
}

function earliestTimestamp(...values) {
  return values
    .map(boundedTimestamp)
    .filter(Boolean)
    .sort()
    .at(0) ?? null
}

function validDuration(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1_000 && value <= MAX_EXPECTED_WAIT_MS
    ? value
    : fallback
}

function criterionMap(criteria) {
  const result = new Map()
  for (const criterion of Array.isArray(criteria) ? criteria.slice(0, 16) : []) {
    const id = safeCriterionId(criterion?.id)
    const status = ["fail", "pass", "unknown"].includes(criterion?.status)
      ? criterion.status
      : null
    if (id && status && !result.has(id)) {
      result.set(id, { evidenceDigest: safeDigest(criterion.evidence), status })
    }
  }
  return result
}

function criterionDeltas(previousCriteria, currentCriteria) {
  const previous = criterionMap(previousCriteria)
  const current = criterionMap(currentCriteria)
  return [...current]
    .map(([id, value]) => ({
      evidenceDigest: value.evidenceDigest,
      from: previous.get(id)?.status ?? "unknown",
      id,
      to: value.status,
    }))
    .filter((delta) => delta.from !== delta.to && delta.to !== "unknown")
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 16)
}

function blockerDigests(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.length > 0)
    .map(safeDigest))]
    .sort()
    .slice(0, 16)
}

function blockerDeltas(previousValues, currentValues) {
  const previous = new Set(blockerDigests(previousValues))
  const current = new Set(blockerDigests(currentValues))
  return [
    ...[...current].filter((digest) => !previous.has(digest)).map((digest) => ({
      change: "added",
      digest,
    })),
    ...[...previous].filter((digest) => !current.has(digest)).map((digest) => ({
      change: "removed",
      digest,
    })),
  ].sort((left, right) => `${left.change}:${left.digest}`.localeCompare(`${right.change}:${right.digest}`))
    .slice(0, 16)
}

function stableBlockerId(value) {
  if (isRecord(value) && value.severity === "blocking" && BLOCKER_PATTERN.test(value.id ?? "")) {
    return value.id
  }
  if (typeof value !== "string") return null
  return value.match(/^\s*(B-[A-Z0-9_-]{1,40})(?:\s|:|$)/)?.[1] ?? null
}

function stableBlockerDeltas(previousValues, currentValues) {
  const previousSource = Array.isArray(previousValues) ? previousValues.slice(0, 16) : []
  const currentSource = Array.isArray(currentValues) ? currentValues.slice(0, 16) : []
  const previousIds = previousSource.map(stableBlockerId)
  const currentIds = currentSource.map(stableBlockerId)
  if (previousIds.some((id) => id === null) || currentIds.some((id) => id === null)) return []
  const previous = new Set(previousIds)
  const current = new Set(currentIds)
  return [
    ...[...current].filter((id) => !previous.has(id)).map((id) => ({
      change: "added",
      digest: safeDigest(id),
    })),
    ...[...previous].filter((id) => !current.has(id)).map((id) => ({
      change: "removed",
      digest: safeDigest(id),
    })),
  ].sort((left, right) => `${left.change}:${left.digest}`.localeCompare(`${right.change}:${right.digest}`))
    .slice(0, 16)
}

function evidenceIdentity(kind, result, source) {
  return { digest: digestJson({ kind, result, source }), kind, result }
}

function semanticCycle(workflow) {
  const cycle = Number.isSafeInteger(workflow?.cycle) && workflow.cycle >= 0
    ? workflow.cycle
    : 0
  const latest = workflow?.private?.cycles?.at(-1)
  return latest?.cycle === cycle ? latest : null
}

function semanticEvidence(workflow, record, deltas, attributableBlockers, reviewDigest) {
  const evidence = []
  for (const delta of deltas) {
    evidence.push(evidenceIdentity(
      "criterion_delta",
      delta.to === "pass" ? "passed" : "failed",
      { from: delta.from, id: delta.id, to: delta.to },
    ))
  }
  for (const delta of attributableBlockers) {
    evidence.push(evidenceIdentity("blocker_delta", delta.change, delta))
  }
  if (record?.review && reviewDigest && isDigest(record.candidateDigest)) {
    evidence.push(evidenceIdentity("required_verification", "completed", {
      candidateDigest: record.candidateDigest,
    }))
    for (const finding of Array.isArray(record.review.findings) ? record.review.findings.slice(0, 8) : []) {
      if (finding?.severity !== "blocking" || !BLOCKER_PATTERN.test(finding.id ?? "")) continue
      evidence.push(evidenceIdentity("actionable_review", "actionable", {
        candidateDigest: record.candidateDigest,
        findingIdDigest: safeDigest(finding.id),
      }))
    }
  }
  if (!record?.review
    && workflow?.status === "succeeded"
    && isDigest(workflow?.result?.candidateDigest)) {
    evidence.push(evidenceIdentity("required_verification", "completed", {
      candidateDigest: workflow.result.candidateDigest,
    }))
  }
  return [...new Map(evidence.map((entry) => [entry.digest, entry])).values()]
    .sort((left, right) => left.digest.localeCompare(right.digest))
    .slice(0, MAX_CHECKPOINT_EVIDENCE)
}

function semanticActionClass(workflow, delivery) {
  if (workflow?.status !== "running") {
    return workflow?.status === "succeeded" ? "settlement" : "terminal"
  }
  if (workflow.phase === "codex_recovering") return "codex_recovery"
  if (["created", "codex_ready", "codex_running"].includes(workflow.phase)) return "codex_turn"
  if (workflow.phase === "codex_captured") return "candidate_review"
  if (workflow.phase === "review_captured") return "candidate_review"
  if (workflow.phase === "chatgpt_running") {
    return delivery === "sent_waiting_response" ? "response_wait" : "browser_delivery"
  }
  if (["send_confirmed", "capture_pending"].includes(workflow.phase)) return "response_wait"
  if (workflow.phase === "restart_reconciling") return "delivery_reconciliation"
  if (["browser_owned", "model_policy_verified", "preflight", "prompt_staged"].includes(workflow.phase)) {
    return "browser_delivery"
  }
  return "observe"
}

function toolClasses(workflow, record) {
  const types = [
    ...(workflow?.activeCodexWorkspaceActivity?.types ?? []),
    ...(record?.codex?.workspaceActivity?.types ?? []),
  ]
  return [...new Set(types.map(safeToolClass).filter(Boolean))].sort().slice(0, 16)
}

function resultCode(workflow, child, record) {
  return [
    workflow?.humanRequired?.code,
    workflow?.error?.code,
    child?.humanRequired?.code,
    child?.error?.code,
    record?.review?.decision,
  ].map(safeCode).find(Boolean) ?? null
}

function argumentDigest(workflow, child, candidateDigest) {
  const continuation = workflow?.activeCodexTurn?.continuation
  if (isRecord(continuation)) {
    return digestJson({
      cycle: Number.isSafeInteger(continuation.cycle) ? continuation.cycle : null,
      kind: safeCode(continuation.kind),
      reason: safeCode(continuation.reason),
    })
  }
  if (isDigest(child?.inputDigest)) return child.inputDigest
  if (isDigest(candidateDigest)) return candidateDigest
  return isDigest(workflow?.inputDigest) ? workflow.inputDigest : null
}

function resultDigest(workflow, child, record, reviewDigest) {
  for (const candidate of [
    reviewDigest,
    record?.codex?.responseDigest,
    child?.result?.responseDigest,
    child?.responseDigest,
    workflow?.result?.responseDigest,
  ]) {
    if (isDigest(candidate)) return candidate
  }
  return null
}

function noveltyMetric(workflow, record, reviewDigest) {
  const samples = []
  for (const cycle of (workflow?.private?.cycles ?? []).slice(-6)) {
    if (isDigest(cycle?.candidateDigest)) samples.push(cycle.candidateDigest)
    if (isDigest(cycle?.reviewSignature)) samples.push(cycle.reviewSignature)
  }
  if (!record && isDigest(reviewDigest)) samples.push(reviewDigest)
  const bounded = samples.slice(-12)
  return {
    sampleSize: bounded.length,
    score: bounded.length === 0 ? 0 : Number((new Set(bounded).size / bounded.length).toFixed(3)),
  }
}

function expectedWait(workflow, child, delivery, workflowDigest, candidateDigest) {
  if (workflow?.status !== "running") return null
  let durationMs
  let operation
  let startAt = latestTimestamp(workflow.updatedAt, workflow.createdAt)
  let sourceDeadline = boundedTimestamp(workflow.deadlineAt)

  if (["created", "codex_ready", "codex_running"].includes(workflow.phase)) {
    operation = "codex_turn"
    durationMs = validDuration(workflow?.private?.request?.codexTurnTimeoutMs, 15 * 60_000)
  } else if (workflow.phase === "codex_recovering") {
    operation = "codex_recovery"
    durationMs = 5 * 60_000
  } else if (workflow.phase === "codex_captured") {
    operation = "broker_delivery"
    durationMs = 5 * 60_000
  } else if (workflow.phase === "review_captured") {
    operation = "broker_transition"
    durationMs = 60_000
  } else if (workflow.phase === "chatgpt_running") {
    operation = delivery === "sent_waiting_response"
      ? "chatgpt_response"
      : delivery === "reconciling_delivery"
        ? "delivery_reconciliation"
        : "browser_delivery"
    startAt = latestTimestamp(child?.updatedAt, child?.createdAt, workflow.updatedAt)
    sourceDeadline = earliestTimestamp(child?.deadlineAt, workflow.deadlineAt)
    durationMs = operation === "chatgpt_response" ? 15 * 60_000 : 5 * 60_000
  } else if (["send_confirmed", "capture_pending"].includes(workflow.phase)) {
    operation = "chatgpt_response"
    durationMs = 15 * 60_000
  } else if (workflow.phase === "restart_reconciling") {
    operation = "delivery_reconciliation"
    durationMs = 5 * 60_000
  } else if (["browser_owned", "model_policy_verified", "preflight", "prompt_staged"].includes(workflow.phase)) {
    operation = "browser_delivery"
    durationMs = 5 * 60_000
  } else {
    return null
  }

  if (!startAt) return null
  const boundedDeadline = new Date(Date.parse(startAt) + durationMs).toISOString()
  const deadlineAt = earliestTimestamp(sourceDeadline, boundedDeadline) ?? boundedDeadline
  return {
    deadlineAt,
    identityDigest: digestJson({
      candidateDigest,
      childInputDigest: isDigest(child?.inputDigest) ? child.inputDigest : null,
      codexTurnDigest: safeDigest(workflow?.activeCodexTurn?.turnId),
      cycle: Number.isSafeInteger(workflow.cycle) ? workflow.cycle : 0,
      operation,
      workflowDigest,
    }),
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation,
    startAt,
  }
}

function projectionInputs(workflow) {
  const record = semanticCycle(workflow)
  const priorReview = workflow?.private?.priorReview
  if (record?.review) {
    const findings = record.review.findings
      ?.filter((finding) => finding.severity === "blocking") ?? []
    return {
      attributableBlockers: stableBlockerDeltas(record.candidate?.blockers, findings),
      blockers: blockerDeltas(
        record.candidate?.blockers,
        findings.map((finding) => finding.action),
      ),
      criteria: criterionDeltas(record.candidate?.criteria, record.review.criteria),
      record,
    }
  }
  if (record?.candidate) {
    return {
      attributableBlockers: stableBlockerDeltas(
        priorReview?.findings?.filter((finding) => finding.severity === "blocking") ?? [],
        record.candidate.blockers,
      ),
      blockers: blockerDeltas(
        priorReview?.findings
          ?.filter((finding) => finding.severity === "blocking")
          .map((finding) => finding.action),
        record.candidate.blockers,
      ),
      criteria: criterionDeltas(priorReview?.criteria, record.candidate.criteria),
      record,
    }
  }
  if (workflow?.status === "succeeded" && Array.isArray(workflow?.result?.criteria)) {
    return {
      attributableBlockers: [],
      blockers: [],
      criteria: [],
      record: null,
    }
  }
  return { attributableBlockers: [], blockers: [], criteria: [], record: null }
}

function semanticLoopMetadata({
  actionClass,
  blockerDeltas,
  criterionDeltas,
  delivery,
  evidence,
  phase,
  resultCode: observedResultCode,
  resultDigest: observedResultDigest,
  sanitizedArgumentDigest,
  toolClasses,
}) {
  const blockerDeltaDigest = digestJson(blockerDeltas)
  const criterionDeltaDigest = digestJson(criterionDeltas)
  const evidenceDigest = digestJson(evidence.map((entry) => entry.digest))
  return {
    actionClass,
    blockerDeltaDigest,
    criterionDeltaDigest,
    evidenceDigest,
    fingerprint: digestJson({
      actionClass,
      blockerDeltaDigest,
      criterionDeltaDigest,
      delivery,
      evidenceDigest,
      phase,
      resultCode: observedResultCode,
      resultDigest: observedResultDigest,
      sanitizedArgumentDigest,
      toolClasses,
    }),
    resultCode: observedResultCode,
    resultDigest: observedResultDigest,
    sanitizedArgumentDigest,
    toolClasses,
  }
}

export function projectEagleSemanticCheckpoint(workflow, child = null, supervision = null) {
  if (!isRecord(workflow) || typeof workflow.id !== "string" || workflow.id.length === 0) {
    fail("invalid_semantic_source", "A durable workflow identity is required for semantic projection.")
  }
  const workflowDigest = safeDigest(workflow.id)
  const phase = safeCode(workflow.phase)
  const delivery = safeCode(supervision?.chatGpt?.delivery)
  const { attributableBlockers, blockers, criteria, record } = projectionInputs(workflow)
  const candidateDigest = isDigest(record?.candidateDigest)
    ? record.candidateDigest
    : isDigest(workflow.candidateDigest)
      ? workflow.candidateDigest
      : isDigest(workflow?.result?.candidateDigest)
        ? workflow.result.candidateDigest
        : null
  const reviewDigest = isDigest(record?.reviewSignature)
    ? record.reviewSignature
    : workflow?.status === "succeeded" && workflow?.result
      ? digestJson({
          candidateDigest: workflow.result.candidateDigest ?? null,
          criteria: workflow.result.criteria ?? [],
          findings: workflow.result.findings ?? [],
        })
      : null
  const evidence = semanticEvidence(
    workflow,
    record,
    criteria,
    attributableBlockers,
    reviewDigest,
  )
  const actionClass = semanticActionClass(workflow, delivery)
  const tools = toolClasses(workflow, record)
  const sanitizedArgumentDigest = argumentDigest(workflow, child, candidateDigest)
  const observedResultDigest = resultDigest(workflow, child, record, reviewDigest)
  const observedResultCode = resultCode(workflow, child, record)
  const checkpoint = {
    blockerDeltas: blockers,
    candidateDigest,
    criterionDeltas: criteria,
    delivery,
    evidence,
    expectedWait: expectedWait(workflow, child, delivery, workflowDigest, candidateDigest),
    loop: semanticLoopMetadata({
      actionClass,
      blockerDeltas: blockers,
      criterionDeltas: criteria,
      delivery,
      evidence,
      phase,
      resultCode: observedResultCode,
      resultDigest: observedResultDigest,
      sanitizedArgumentDigest,
      toolClasses: tools,
    }),
    novelty: noveltyMetric(workflow, record, reviewDigest),
    phase,
    reviewDigest,
    schema: EAGLE_SEMANTIC_CHECKPOINT_SCHEMA,
    sequence: {
      cycle: Number.isSafeInteger(workflow.cycle) && workflow.cycle >= 0 ? workflow.cycle : 0,
      step: PHASE_ORDINALS[phase] ?? 0,
    },
    timing: {
      deadlineAt: boundedTimestamp(workflow.deadlineAt),
      eventAt: latestTimestamp(workflow.updatedAt, child?.updatedAt, workflow.createdAt),
    },
    workflowDigest,
  }
  serializeEagleSemanticCheckpoint(checkpoint)
  return checkpoint
}

export function validateEagleSemanticCheckpoint(value) {
  if (!hasExactKeys(value, [
    "blockerDeltas",
    "candidateDigest",
    "criterionDeltas",
    "delivery",
    "evidence",
    "expectedWait",
    "loop",
    "novelty",
    "phase",
    "reviewDigest",
    "schema",
    "sequence",
    "timing",
    "workflowDigest",
  ]) || value.schema !== EAGLE_SEMANTIC_CHECKPOINT_SCHEMA) {
    fail("invalid_semantic_checkpoint", "The semantic checkpoint schema or fields are unsupported.")
  }
  if (
    !isDigest(value.workflowDigest)
    || !isNullableDigest(value.candidateDigest)
    || !isNullableDigest(value.reviewDigest)
    || !isNullableCode(value.phase)
    || !isNullableCode(value.delivery)
    || !Array.isArray(value.criterionDeltas)
    || value.criterionDeltas.length > 16
    || !Array.isArray(value.blockerDeltas)
    || value.blockerDeltas.length > 16
    || !Array.isArray(value.evidence)
    || value.evidence.length > MAX_CHECKPOINT_EVIDENCE
  ) fail("invalid_semantic_checkpoint", "The semantic checkpoint contains an invalid bounded value.")

  if (new Set(value.criterionDeltas.map((delta) => delta?.id)).size
      !== value.criterionDeltas.length
    || new Set(value.blockerDeltas.map((delta) => delta?.change + ":" + delta?.digest)).size
      !== value.blockerDeltas.length
    || new Set(value.evidence.map((entry) => entry?.digest)).size !== value.evidence.length) {
    fail("invalid_semantic_checkpoint", "The semantic checkpoint contains duplicate identities.")
  }

  for (const delta of value.criterionDeltas) {
    if (!hasExactKeys(delta, ["evidenceDigest", "from", "id", "to"])
      || !safeCriterionId(delta.id)
      || !isNullableDigest(delta.evidenceDigest)
      || !["fail", "pass", "unknown"].includes(delta.from)
      || !["fail", "pass"].includes(delta.to)
      || delta.from === delta.to) {
      fail("invalid_semantic_checkpoint", "A criterion delta is invalid.")
    }
  }
  for (const delta of value.blockerDeltas) {
    if (!hasExactKeys(delta, ["change", "digest"])
      || !["added", "removed"].includes(delta.change)
      || !isDigest(delta.digest)) {
      fail("invalid_semantic_checkpoint", "A blocker delta is invalid.")
    }
  }
  for (const evidence of value.evidence) {
    if (!hasExactKeys(evidence, ["digest", "kind", "result"])
      || !isDigest(evidence.digest)
      || !QUALIFYING_EVIDENCE_KINDS.has(evidence.kind)
      || !EVIDENCE_RESULTS_BY_KIND[evidence.kind].has(evidence.result)) {
      fail("invalid_semantic_checkpoint", "A semantic evidence identity is invalid.")
    }
  }
  if (!hasExactKeys(value.sequence, ["cycle", "step"])
    || !Number.isSafeInteger(value.sequence.cycle)
    || value.sequence.cycle < 0
    || !Number.isSafeInteger(value.sequence.step)
    || value.sequence.step < 0) {
    fail("invalid_semantic_checkpoint", "Semantic sequence metadata is invalid.")
  }
  if (!hasExactKeys(value.timing, ["deadlineAt", "eventAt"])
    || !isNullableTimestamp(value.timing.deadlineAt)
    || !isNullableTimestamp(value.timing.eventAt)) {
    fail("invalid_semantic_checkpoint", "Semantic timing metadata is invalid.")
  }
  if (!hasExactKeys(value.loop, [
    "actionClass",
    "blockerDeltaDigest",
    "criterionDeltaDigest",
    "evidenceDigest",
    "fingerprint",
    "resultCode",
    "resultDigest",
    "sanitizedArgumentDigest",
    "toolClasses",
  ])
    || !isCode(value.loop.actionClass)
    || !isDigest(value.loop.blockerDeltaDigest)
    || !isDigest(value.loop.criterionDeltaDigest)
    || !isDigest(value.loop.evidenceDigest)
    || !isDigest(value.loop.fingerprint)
    || !isNullableCode(value.loop.resultCode)
    || !isNullableDigest(value.loop.resultDigest)
    || !isNullableDigest(value.loop.sanitizedArgumentDigest)
    || !Array.isArray(value.loop.toolClasses)
    || value.loop.toolClasses.length > 16
    || value.loop.toolClasses.some((entry) => !isCode(entry))
    || new Set(value.loop.toolClasses).size !== value.loop.toolClasses.length) {
    fail("invalid_semantic_checkpoint", "Semantic loop metadata is invalid.")
  }
  const expectedLoop = semanticLoopMetadata({
    actionClass: value.loop.actionClass,
    blockerDeltas: value.blockerDeltas,
    criterionDeltas: value.criterionDeltas,
    delivery: value.delivery,
    evidence: value.evidence,
    phase: value.phase,
    resultCode: value.loop.resultCode,
    resultDigest: value.loop.resultDigest,
    sanitizedArgumentDigest: value.loop.sanitizedArgumentDigest,
    toolClasses: value.loop.toolClasses,
  })
  if (canonicalJson(value.loop) !== canonicalJson(expectedLoop)) {
    fail("invalid_semantic_checkpoint", "Semantic loop metadata is not bound to its components.")
  }
  if (!hasExactKeys(value.novelty, ["sampleSize", "score"])
    || !Number.isSafeInteger(value.novelty.sampleSize)
    || value.novelty.sampleSize < 0
    || value.novelty.sampleSize > 12
    || !Number.isFinite(value.novelty.score)
    || value.novelty.score < 0
    || value.novelty.score > 1) {
    fail("invalid_semantic_checkpoint", "Semantic novelty metadata is invalid.")
  }
  if (value.expectedWait !== null) {
    if (!hasExactKeys(value.expectedWait, [
      "deadlineAt",
      "identityDigest",
      "maxExtensionMs",
      "operation",
      "startAt",
    ])
      || !isTimestamp(value.expectedWait.deadlineAt)
      || !isDigest(value.expectedWait.identityDigest)
      || !Number.isSafeInteger(value.expectedWait.maxExtensionMs)
      || value.expectedWait.maxExtensionMs < 0
      || value.expectedWait.maxExtensionMs > EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs
      || !isCode(value.expectedWait.operation)
      || !isTimestamp(value.expectedWait.startAt)) {
      fail("invalid_semantic_checkpoint", "The expected-wait lease source is invalid.")
    }
    const waitDurationMs = Date.parse(value.expectedWait.deadlineAt)
      - Date.parse(value.expectedWait.startAt)
    if (waitDurationMs < 0 || waitDurationMs > EAGLE_SEMANTIC_POLICY.expectedWaitMaximumMs) {
      fail("invalid_semantic_checkpoint", "The expected-wait lease source exceeds its duration bound.")
    }
  }
  const bytes = Buffer.byteLength(canonicalJson(value), "utf8")
  if (bytes > EAGLE_SEMANTIC_CHECKPOINT_MAX_BYTES) {
    fail("semantic_checkpoint_too_large", "The semantic checkpoint exceeds the hard 16 KiB limit.")
  }
  return value
}

export function serializeEagleSemanticCheckpoint(value) {
  validateEagleSemanticCheckpoint(value)
  return canonicalJson(value)
}

export function digestEagleSemanticCheckpoint(value) {
  return safeDigest(serializeEagleSemanticCheckpoint(value))
}

function loopPattern(history) {
  const repeated = history.slice(-3)
  if (repeated.length === 3 && new Set(repeated).size === 1) return "repeated"
  const alternating = history.slice(-6)
  if (alternating.length === 6
    && alternating[0] !== alternating[1]
    && alternating.every((value, index) => value === alternating[index % 2])) {
    return "alternating"
  }
  const shortCycle = history.slice(-6)
  if (shortCycle.length === 6
    && new Set(shortCycle.slice(0, 3)).size > 1
    && shortCycle.every((value, index) => value === shortCycle[index % 3])) {
    return "short_cycle"
  }
  return null
}

export function deriveEagleSemanticIncidentKey({
  brokerEpoch,
  classification,
  evidenceWindow,
  loopPattern: detectedLoop,
  phase,
  stepFingerprint,
  workflowDigest,
}) {
  return digestJson({
    brokerEpoch,
    classification,
    evidenceWindow,
    loopPattern: detectedLoop,
    phase,
    stepFingerprint,
    workflowDigest,
  })
}

function nextExpectedWait(source, previousLease, previousHistory, nowMs) {
  const history = previousHistory.map((entry) => ({ ...entry }))
  if (!source) {
    return { expectedWaitHistory: history, expectedWaitLease: null, restoredWait: false }
  }

  const historyIndex = history.findIndex((entry) => entry.identityDigest === source.identityDigest)
  const restoredWait = historyIndex >= 0
    && previousLease?.identityDigest !== source.identityDigest
  let entry
  if (historyIndex >= 0) {
    entry = history[historyIndex]
  } else {
    if (history.length >= MAX_EXPECTED_WAIT_HISTORY) {
      return { expectedWaitHistory: history, expectedWaitLease: null, restoredWait: false }
    }
    entry = {
      deadlineAt: source.deadlineAt,
      effectiveDeadlineAt: source.deadlineAt,
      extensionUsed: 0,
      identityDigest: source.identityDigest,
      maxExtensionMs: source.maxExtensionMs,
      operation: source.operation,
      startAt: source.startAt,
    }
    history.push(entry)
  }

  const deadlineMs = Date.parse(entry.deadlineAt)
  const effectiveMs = Date.parse(entry.effectiveDeadlineAt)
  if (nowMs > effectiveMs && entry.extensionUsed === 0) {
    const extensionMs = Math.min(
      entry.maxExtensionMs,
      EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    )
    if (extensionMs > 0 && nowMs <= deadlineMs + extensionMs) {
      entry = {
        ...entry,
        effectiveDeadlineAt: new Date(deadlineMs + extensionMs).toISOString(),
        extensionUsed: 1,
      }
      history[historyIndex >= 0 ? historyIndex : history.length - 1] = entry
    }
  }

  return {
    expectedWaitHistory: history,
    expectedWaitLease: { ...entry, observedAt: new Date(nowMs).toISOString() },
    restoredWait,
  }
}

function isWaitActive(wait, nowMs) {
  return wait !== null
    && nowMs >= Date.parse(wait.startAt)
    && nowMs <= Date.parse(wait.effectiveDeadlineAt)
}

function publicLease(lease, nowMs) {
  if (!lease) return null
  return {
    active: nowMs >= Date.parse(lease.renewedAt)
      && nowMs <= Date.parse(lease.expiresAt),
    evidenceDigest: lease.evidenceDigest,
    expiresAt: lease.expiresAt,
    renewedAt: lease.renewedAt,
  }
}

export function classifyEagleSemanticLiveness({
  brokerEpoch = null,
  checkpoint,
  humanRequired = false,
  nowMs,
  previous = null,
  processHealth = "healthy",
  recoveryActive = false,
  settled = false,
  transportHealth = "healthy",
}) {
  validateEagleSemanticCheckpoint(checkpoint)
  if (previous !== null) validateEagleSemanticState(previous)
  if (!Number.isSafeInteger(nowMs)
    || nowMs < 0
    || !(brokerEpoch === null || (Number.isSafeInteger(brokerEpoch) && brokerEpoch >= 0))
    || !["dead", "healthy", "unknown"].includes(processHealth)
    || !["degraded", "healthy", "unknown"].includes(transportHealth)
    || typeof recoveryActive !== "boolean"
    || typeof settled !== "boolean"
    || typeof humanRequired !== "boolean") {
    fail("invalid_semantic_observation", "Semantic classification requires a valid typed observation.")
  }
  const sameWorkflow = previous?.schema === EAGLE_SEMANTIC_STATE_SCHEMA
    && previous.workflowDigest === checkpoint.workflowDigest
  const priorWorkflow = sameWorkflow ? previous : null
  const priorFence = sameWorkflow && previous.brokerEpoch === brokerEpoch ? previous : null
  const checkpointDigest = digestEagleSemanticCheckpoint(checkpoint)
  const previousWorkflowObservedMs = Date.parse(priorWorkflow?.observedAt ?? "")
  if (Number.isFinite(previousWorkflowObservedMs) && nowMs < previousWorkflowObservedMs) {
    fail(
      "invalid_semantic_observation",
      "Semantic observation time cannot regress within the same workflow.",
    )
  }
  const previousObservedMs = Date.parse(priorFence?.observedAt ?? "")
  const effectiveNowMs = nowMs
  const independentObservation = !priorFence
    || checkpointDigest !== priorFence.checkpointDigest
    || nowMs > previousObservedMs
  const seen = [...new Set(priorWorkflow?.seenEvidenceDigests ?? [])]
    .slice(0, MAX_EVIDENCE_IDENTITIES)
  const seenSet = new Set(seen)
  const qualifying = checkpoint.evidence.filter((entry) => QUALIFYING_EVIDENCE_KINDS.has(entry.kind))
  const unseen = qualifying.filter((entry) => !seenSet.has(entry.digest))
  const admitted = unseen.slice(0, Math.max(0, MAX_EVIDENCE_IDENTITIES - seen.length))
  const newEvidence = admitted.length > 0
  for (const entry of admitted) seen.push(entry.digest)

  const observedAt = new Date(effectiveNowMs).toISOString()
  const admittedEvidenceDigests = admitted.map((entry) => entry.digest).sort()
  const usefulProgressLease = newEvidence
    ? {
        evidenceDigest: digestJson(admittedEvidenceDigests),
        evidenceDigests: admittedEvidenceDigests,
        expiresAt: new Date(
          effectiveNowMs + EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs,
        ).toISOString(),
        renewedAt: observedAt,
      }
    : priorWorkflow?.usefulProgressLease ?? null
  const { expectedWaitHistory, expectedWaitLease, restoredWait } = nextExpectedWait(
    checkpoint.expectedWait,
    priorWorkflow?.expectedWaitLease,
    priorWorkflow?.expectedWaitHistory ?? [],
    effectiveNowMs,
  )
  const waitActive = isWaitActive(expectedWaitLease, effectiveNowMs)
  const waitIdentityChanged = waitActive
    && priorWorkflow?.expectedWaitLease !== null
    && priorWorkflow?.expectedWaitLease !== undefined
    && priorWorkflow.expectedWaitLease.identityDigest !== expectedWaitLease.identityDigest
  const usefulLeaseActive = usefulProgressLease !== null
    && effectiveNowMs <= Date.parse(usefulProgressLease.expiresAt)

  let fingerprintHistory = priorFence?.fingerprintHistory ?? []
  if (newEvidence) fingerprintHistory = []
  if (independentObservation) {
    const recordsMeaningfulWaitTransition = waitActive
      && (
        waitIdentityChanged
        || restoredWait
        || fingerprintHistory.at(-1) !== checkpoint.loop.fingerprint
      )
    if (!waitActive || recordsMeaningfulWaitTransition || fingerprintHistory.length === 0) {
      fingerprintHistory = [...fingerprintHistory, checkpoint.loop.fingerprint]
        .slice(-MAX_FINGERPRINT_HISTORY)
    }
  }
  const fingerprintLoop = newEvidence ? null : loopPattern(fingerprintHistory)
  const detectedLoop = waitActive && !waitIdentityChanged && !restoredWait ? null : fingerprintLoop
  const noveltyScore = Number((new Set(fingerprintHistory).size / fingerprintHistory.length).toFixed(3))

  let classification
  let reasonCode
  let suspectCount = 0
  if (settled) {
    classification = "settled"
    reasonCode = "verified_settlement_observed"
  } else if (humanRequired) {
    classification = "human_required"
    reasonCode = "genuine_human_boundary_observed"
  } else if (newEvidence) {
    classification = "progressing"
    reasonCode = "new_attributable_evidence"
  } else if (waitActive && detectedLoop) {
    classification = "looping"
    reasonCode = `${detectedLoop}_loop_detected`
  } else if (waitActive) {
    classification = "expected_wait"
    reasonCode = expectedWaitLease.extensionUsed === 1
      ? "bounded_wait_extension"
      : "named_wait_active"
  } else if (usefulLeaseActive) {
    classification = "progressing"
    reasonCode = "useful_progress_lease_active"
  } else {
    suspectCount = (priorFence?.suspectCount ?? 0) + (independentObservation ? 1 : 0)
    if (suspectCount < 2) {
      classification = "suspect"
      reasonCode = "useful_progress_unconfirmed"
    } else if (detectedLoop) {
      classification = "looping"
      reasonCode = `${detectedLoop}_loop_detected`
    } else {
      classification = "stagnant"
      reasonCode = "useful_progress_lease_expired"
    }
  }

  const incidentKey = ["human_required", "looping", "stagnant", "suspect"].includes(classification)
    ? deriveEagleSemanticIncidentKey({
        brokerEpoch,
        classification,
        evidenceWindow: usefulProgressLease?.evidenceDigest ?? null,
        loopPattern: classification === "looping" ? detectedLoop : null,
        phase: checkpoint.phase,
        stepFingerprint: checkpoint.loop.fingerprint,
        workflowDigest: checkpoint.workflowDigest,
      })
    : null
  return {
    brokerEpoch,
    checkpointDigest,
    classification,
    dimensions: {
      humanBoundary: humanRequired === true,
      process: processHealth,
      recovery: recoveryActive ? "in_flight" : "idle",
      settlement: settled ? "settled" : "active",
      transport: transportHealth,
    },
    expectedWaitHistory,
    expectedWaitLease,
    fingerprintHistory,
    incidentKey,
    metrics: {
      evidenceCapacityExhausted: unseen.length > admitted.length,
      loopPattern: detectedLoop,
      noveltyScore,
      qualifyingEvidenceCount: qualifying.length,
      unseenEvidenceCount: admitted.length,
    },
    observationCount: (priorFence?.observationCount ?? 0) + (independentObservation ? 1 : 0),
    observedAt,
    reasonCode,
    schema: EAGLE_SEMANTIC_STATE_SCHEMA,
    seenEvidenceDigests: seen,
    suspectCount,
    usefulProgressLease,
    workflowDigest: checkpoint.workflowDigest,
  }
}

export function validateEagleSemanticState(value) {
  if (!hasExactKeys(value, [
    "brokerEpoch",
    "checkpointDigest",
    "classification",
    "dimensions",
    "expectedWaitHistory",
    "expectedWaitLease",
    "fingerprintHistory",
    "incidentKey",
    "metrics",
    "observationCount",
    "observedAt",
    "reasonCode",
    "schema",
    "seenEvidenceDigests",
    "suspectCount",
    "usefulProgressLease",
    "workflowDigest",
  ]) || value.schema !== EAGLE_SEMANTIC_STATE_SCHEMA) {
    fail("corrupt_monitor_state", "The semantic monitor state schema or fields are unsupported.")
  }
  if (!isNullableDigest(value.incidentKey)
    || !isDigest(value.checkpointDigest)
    || !isDigest(value.workflowDigest)
    || !isNullableCode(value.reasonCode)
    || !SEMANTIC_CLASSIFICATIONS.has(value.classification)
    || !isTimestamp(value.observedAt)
    || !Number.isSafeInteger(value.observationCount)
    || value.observationCount < 1
    || !Number.isSafeInteger(value.suspectCount)
    || value.suspectCount < 0
    || value.suspectCount > value.observationCount
    || !(value.brokerEpoch === null || (Number.isSafeInteger(value.brokerEpoch) && value.brokerEpoch >= 0))) {
    fail("corrupt_monitor_state", "The semantic monitor state contains an invalid value.")
  }
  if (!Array.isArray(value.seenEvidenceDigests)
    || value.seenEvidenceDigests.length > MAX_EVIDENCE_IDENTITIES
    || value.seenEvidenceDigests.some((entry) => !isDigest(entry))
    || new Set(value.seenEvidenceDigests).size !== value.seenEvidenceDigests.length
    || !Array.isArray(value.fingerprintHistory)
    || value.fingerprintHistory.length < 1
    || value.fingerprintHistory.length > MAX_FINGERPRINT_HISTORY
    || value.fingerprintHistory.length > value.observationCount
    || value.fingerprintHistory.some((entry) => !isDigest(entry))) {
    fail("corrupt_monitor_state", "The semantic evidence or fingerprint history is invalid.")
  }
  if (!hasExactKeys(value.dimensions, ["humanBoundary", "process", "recovery", "settlement", "transport"])
    || typeof value.dimensions.humanBoundary !== "boolean"
    || !["dead", "healthy", "unknown"].includes(value.dimensions.process)
    || !["idle", "in_flight"].includes(value.dimensions.recovery)
    || !["active", "settled"].includes(value.dimensions.settlement)
    || !["degraded", "healthy", "unknown"].includes(value.dimensions.transport)) {
    fail("corrupt_monitor_state", "Semantic liveness dimensions are invalid.")
  }
  if (!hasExactKeys(value.metrics, [
    "evidenceCapacityExhausted",
    "loopPattern",
    "noveltyScore",
    "qualifyingEvidenceCount",
    "unseenEvidenceCount",
  ])
    || typeof value.metrics.evidenceCapacityExhausted !== "boolean"
    || !(value.metrics.loopPattern === null || LOOP_PATTERNS.has(value.metrics.loopPattern))
    || !Number.isFinite(value.metrics.noveltyScore)
    || value.metrics.noveltyScore < 0
    || value.metrics.noveltyScore > 1
    || !Number.isSafeInteger(value.metrics.qualifyingEvidenceCount)
    || value.metrics.qualifyingEvidenceCount < 0
    || value.metrics.qualifyingEvidenceCount > MAX_CHECKPOINT_EVIDENCE
    || !Number.isSafeInteger(value.metrics.unseenEvidenceCount)
    || value.metrics.unseenEvidenceCount < 0
    || value.metrics.unseenEvidenceCount > MAX_CHECKPOINT_EVIDENCE
    || value.metrics.unseenEvidenceCount > value.metrics.qualifyingEvidenceCount) {
    fail("corrupt_monitor_state", "Semantic liveness metrics are invalid.")
  }
  if (value.usefulProgressLease !== null) {
    if (!hasExactKeys(value.usefulProgressLease, [
      "evidenceDigest",
      "evidenceDigests",
      "expiresAt",
      "renewedAt",
    ])
      || !isDigest(value.usefulProgressLease.evidenceDigest)
      || !Array.isArray(value.usefulProgressLease.evidenceDigests)
      || value.usefulProgressLease.evidenceDigests.length < 1
      || value.usefulProgressLease.evidenceDigests.length > MAX_CHECKPOINT_EVIDENCE
      || value.usefulProgressLease.evidenceDigests.some((entry) => !isDigest(entry))
      || new Set(value.usefulProgressLease.evidenceDigests).size
        !== value.usefulProgressLease.evidenceDigests.length
      || value.usefulProgressLease.evidenceDigests.some((entry) => (
        !value.seenEvidenceDigests.includes(entry)
      ))
      || value.usefulProgressLease.evidenceDigests.join("\0")
        !== [...value.usefulProgressLease.evidenceDigests].sort().join("\0")
      || value.usefulProgressLease.evidenceDigest
        !== digestJson(value.usefulProgressLease.evidenceDigests)
      || !isTimestamp(value.usefulProgressLease.expiresAt)
      || !isTimestamp(value.usefulProgressLease.renewedAt)
      || Date.parse(value.usefulProgressLease.expiresAt)
        - Date.parse(value.usefulProgressLease.renewedAt)
        !== EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs
      || Date.parse(value.usefulProgressLease.renewedAt) > Date.parse(value.observedAt)) {
      fail("corrupt_monitor_state", "The useful-progress lease is invalid.")
    }
  }
  if (!Array.isArray(value.expectedWaitHistory)
    || value.expectedWaitHistory.length > MAX_EXPECTED_WAIT_HISTORY
    || new Set(value.expectedWaitHistory.map((entry) => entry?.identityDigest)).size
      !== value.expectedWaitHistory.length) {
    fail("corrupt_monitor_state", "The persisted expected-wait history is invalid.")
  }
  for (const entry of value.expectedWaitHistory) {
    if (!hasExactKeys(entry, [
      "deadlineAt",
      "effectiveDeadlineAt",
      "extensionUsed",
      "identityDigest",
      "maxExtensionMs",
      "operation",
      "startAt",
    ])
      || !isTimestamp(entry.deadlineAt)
      || !isTimestamp(entry.effectiveDeadlineAt)
      || ![0, 1].includes(entry.extensionUsed)
      || !isDigest(entry.identityDigest)
      || !Number.isSafeInteger(entry.maxExtensionMs)
      || entry.maxExtensionMs < 0
      || entry.maxExtensionMs > EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs
      || !isCode(entry.operation)
      || !isTimestamp(entry.startAt)) {
      fail("corrupt_monitor_state", "A persisted expected-wait history entry is invalid.")
    }
    const startMs = Date.parse(entry.startAt)
    const deadlineMs = Date.parse(entry.deadlineAt)
    const effectiveDeadlineMs = Date.parse(entry.effectiveDeadlineAt)
    const extensionMs = effectiveDeadlineMs - deadlineMs
    if (startMs > deadlineMs
      || deadlineMs - startMs > EAGLE_SEMANTIC_POLICY.expectedWaitMaximumMs
      || extensionMs < 0
      || extensionMs > entry.maxExtensionMs
      || (entry.extensionUsed === 0 && extensionMs !== 0)
      || (entry.extensionUsed === 1
        && (entry.maxExtensionMs === 0 || extensionMs !== entry.maxExtensionMs))) {
      fail("corrupt_monitor_state", "A persisted expected-wait history entry is inconsistent.")
    }
  }
  if (value.expectedWaitLease !== null) {
    if (!hasExactKeys(value.expectedWaitLease, [
      "deadlineAt",
      "effectiveDeadlineAt",
      "extensionUsed",
      "identityDigest",
      "maxExtensionMs",
      "observedAt",
      "operation",
      "startAt",
    ])
      || !isTimestamp(value.expectedWaitLease.deadlineAt)
      || !isTimestamp(value.expectedWaitLease.effectiveDeadlineAt)
      || ![0, 1].includes(value.expectedWaitLease.extensionUsed)
      || !isDigest(value.expectedWaitLease.identityDigest)
      || !Number.isSafeInteger(value.expectedWaitLease.maxExtensionMs)
      || value.expectedWaitLease.maxExtensionMs < 0
      || value.expectedWaitLease.maxExtensionMs > EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs
      || !isTimestamp(value.expectedWaitLease.observedAt)
      || !isCode(value.expectedWaitLease.operation)
      || !isTimestamp(value.expectedWaitLease.startAt)) {
      fail("corrupt_monitor_state", "The persisted expected-wait lease is invalid.")
    }
    const startMs = Date.parse(value.expectedWaitLease.startAt)
    const deadlineMs = Date.parse(value.expectedWaitLease.deadlineAt)
    const effectiveDeadlineMs = Date.parse(value.expectedWaitLease.effectiveDeadlineAt)
    const extensionMs = effectiveDeadlineMs - deadlineMs
    if (startMs > deadlineMs
      || deadlineMs - startMs > EAGLE_SEMANTIC_POLICY.expectedWaitMaximumMs
      || extensionMs < 0
      || extensionMs > value.expectedWaitLease.maxExtensionMs
      || (value.expectedWaitLease.extensionUsed === 0 && extensionMs !== 0)
      || (value.expectedWaitLease.extensionUsed === 1
        && (value.expectedWaitLease.maxExtensionMs === 0
          || extensionMs !== value.expectedWaitLease.maxExtensionMs))
      || value.expectedWaitLease.observedAt !== value.observedAt) {
      fail("corrupt_monitor_state", "The persisted expected-wait lease is inconsistent.")
    }
    const retained = value.expectedWaitHistory.find((entry) => (
      entry.identityDigest === value.expectedWaitLease.identityDigest
    ))
    if (!retained || [
      "deadlineAt",
      "effectiveDeadlineAt",
      "extensionUsed",
      "identityDigest",
      "maxExtensionMs",
      "operation",
      "startAt",
    ].some((key) => retained[key] !== value.expectedWaitLease[key])) {
      fail("corrupt_monitor_state", "The persisted expected-wait lease is not bound to its history.")
    }
  }

  const observedMs = Date.parse(value.observedAt)
  const waitActive = isWaitActive(value.expectedWaitLease, observedMs)
  const usefulLeaseActive = value.usefulProgressLease !== null
    && observedMs >= Date.parse(value.usefulProgressLease.renewedAt)
    && observedMs <= Date.parse(value.usefulProgressLease.expiresAt)
  const incidentRequired = ["human_required", "looping", "stagnant", "suspect"]
    .includes(value.classification)
  const settledDimension = value.dimensions.settlement === "settled"
  const fingerprintLoop = loopPattern(value.fingerprintHistory)
  const expectedNoveltyScore = Number((
    new Set(value.fingerprintHistory).size / value.fingerprintHistory.length
  ).toFixed(3))
  const newlyAttributable = value.classification === "progressing"
    && value.reasonCode === "new_attributable_evidence"
  const retainedProgress = value.classification === "progressing"
    && value.reasonCode === "useful_progress_lease_active"
  const relationallyInvalid = (
    (value.classification === "settled") !== settledDimension
    || (value.classification === "human_required" && !value.dimensions.humanBoundary)
    || (value.classification !== "human_required"
      && value.classification !== "settled"
      && value.dimensions.humanBoundary)
    || (value.incidentKey !== null) !== incidentRequired
    || (value.classification === "expected_wait" && !waitActive)
    || (value.classification === "progressing" && !usefulLeaseActive)
    || (["stagnant", "suspect"].includes(value.classification)
      && (waitActive || usefulLeaseActive))
    || (["expected_wait", "human_required", "progressing", "settled"]
      .includes(value.classification) && value.suspectCount !== 0)
    || (value.classification === "suspect" && value.suspectCount !== 1)
    || (value.classification === "stagnant" && value.suspectCount < 2)
    || (value.classification === "looping" && (
      value.metrics.loopPattern === null
      || value.metrics.loopPattern !== fingerprintLoop
      || value.suspectCount === 1
      || (value.suspectCount === 0 && !waitActive)
      || (value.suspectCount >= 2 && (waitActive || usefulLeaseActive))
    ))
    || (value.classification === "stagnant" && value.metrics.loopPattern !== null)
    || (value.classification === "stagnant" && fingerprintLoop !== null)
    || (value.classification === "expected_wait" && value.metrics.loopPattern !== null)
    || (newlyAttributable && (
      value.metrics.unseenEvidenceCount < 1
      || value.fingerprintHistory.length !== 1
      || value.metrics.loopPattern !== null
      || value.usefulProgressLease === null
      || value.usefulProgressLease.renewedAt !== value.observedAt
      || value.usefulProgressLease.evidenceDigests.length
        !== value.metrics.unseenEvidenceCount
    ))
    || (retainedProgress && (
      value.metrics.unseenEvidenceCount !== 0
      || value.metrics.loopPattern !== fingerprintLoop
    ))
    || (value.classification === "suspect" && value.metrics.loopPattern !== fingerprintLoop)
    || value.metrics.noveltyScore !== expectedNoveltyScore
    || (value.metrics.evidenceCapacityExhausted
      && value.seenEvidenceDigests.length < MAX_EVIDENCE_IDENTITIES)
  )
  if (relationallyInvalid) {
    fail("corrupt_monitor_state", "The semantic classification relations are inconsistent.")
  }

  const expectedReasons = {
    expected_wait: [value.expectedWaitLease?.extensionUsed === 1
      ? "bounded_wait_extension"
      : "named_wait_active"],
    human_required: ["genuine_human_boundary_observed"],
    looping: value.metrics.loopPattern === null
      ? []
      : [`${value.metrics.loopPattern}_loop_detected`],
    progressing: ["new_attributable_evidence", "useful_progress_lease_active"],
    settled: ["verified_settlement_observed"],
    stagnant: ["useful_progress_lease_expired"],
    suspect: ["useful_progress_unconfirmed"],
  }[value.classification]
  if (!expectedReasons.includes(value.reasonCode)) {
    fail("corrupt_monitor_state", "The semantic classification reason is inconsistent.")
  }
  return value
}

export function publicEagleSemanticStatus(value, nowMs = Date.now()) {
  if (!value) {
    return {
      checkpointDigest: null,
      classification: "suspect",
      dimensions: {
        humanBoundary: false,
        process: "unknown",
        recovery: "idle",
        settlement: "active",
        transport: "unknown",
      },
      expectedWaitLease: null,
      metrics: {
        evidenceCapacityExhausted: false,
        loopPattern: null,
        noveltyScore: 0,
        observationCount: 0,
        suspectCount: 0,
      },
      reasonCode: "semantic_monitor_starting",
      schema: EAGLE_SEMANTIC_STATE_SCHEMA,
      usefulProgressLease: null,
    }
  }
  validateEagleSemanticState(value)
  const effectiveNowMs = Math.max(nowMs, Date.parse(value.observedAt))
  return {
    checkpointDigest: value.checkpointDigest,
    classification: value.classification,
    dimensions: value.dimensions,
    expectedWaitLease: value.expectedWaitLease
      ? {
          active: isWaitActive(value.expectedWaitLease, effectiveNowMs),
          deadlineAt: value.expectedWaitLease.deadlineAt,
          effectiveDeadlineAt: value.expectedWaitLease.effectiveDeadlineAt,
          extensionUsed: value.expectedWaitLease.extensionUsed,
          identityDigest: value.expectedWaitLease.identityDigest,
          maxExtensionMs: value.expectedWaitLease.maxExtensionMs,
          operation: value.expectedWaitLease.operation,
          startAt: value.expectedWaitLease.startAt,
        }
      : null,
    metrics: {
      evidenceCapacityExhausted: value.metrics.evidenceCapacityExhausted,
      loopPattern: value.metrics.loopPattern,
      noveltyScore: value.metrics.noveltyScore,
      observationCount: value.observationCount,
      suspectCount: value.suspectCount,
    },
    reasonCode: value.reasonCode,
    schema: value.schema,
    usefulProgressLease: value.usefulProgressLease
      ? publicLease(value.usefulProgressLease, effectiveNowMs)
      : null,
  }
}

export const EAGLE_SEMANTIC_TESTING = Object.freeze({
  canonicalJson,
  loopPattern,
  qualifyingEvidenceKinds: [...QUALIFYING_EVIDENCE_KINDS].sort(),
  semanticLoopMetadata,
})
