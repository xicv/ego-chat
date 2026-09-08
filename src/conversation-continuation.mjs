import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod/v4"

import { canonicalJsonBytes } from "./attachment-execution-receipt.mjs"
import { createContract, digestJson, validateCodexCandidate } from "./convergence.mjs"
import { DEFAULT_MODEL_POLICY, MAX_REVIEW_PACKET_BYTES } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"

// JSON may encode each raw control byte as six bytes. The remaining allowance
// covers the independently bounded contract, candidate evidence, and identities.
export const MAX_CONTINUATION_CHECKPOINT_BYTES = 6 * MAX_REVIEW_PACKET_BYTES + 512 * 1024
// Paused parents retain both the current candidate and its exact checkpoint,
// along with earlier cycles. Match the store's default hard state-byte ceiling.
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_CHAT_GENERATIONS = 32
const Sha = z.string().regex(/^[a-f0-9]{64}$/)
const Key = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
const Id = z.string().min(1).max(200)
const Timestamp = z.string().refine((value) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
})
const Terminal = z.object({
  schema: z.literal("ego-chat-provider-terminal/v1"),
  kind: z.enum(["stopped", "conversation_exhausted", "provider_error", "quota_limited"]),
  source: z.literal("latest_turn_status"), signalDigest: Sha,
  stableObservations: z.number().int().min(2).max(100), observedAt: Timestamp,
}).strict()
const Binding = z.object({
  key: Key, canonicalUrl: z.string().max(2048), revision: z.number().int().positive(),
  headFingerprint: Sha, headContentDigest: Sha, headMessageId: Id,
  projectScope: z.string().min(1).max(200).nullable(),
  taskSpaceIdentity: z.object({ name: Id, taskId: Id }).strict(),
}).strict()
const Checkpoint = z.object({
  schema: z.literal("ego-chat-conversation-continuation/v1"), digest: Sha,
  workflowId: z.uuid(), originalBindingKey: Key, activeBindingKey: Key,
  generation: z.number().int().min(0).max(MAX_CHAT_GENERATIONS), cycle: z.number().int().positive(),
  createdAt: Timestamp, contract: z.object({
    criteria: z.array(z.object({ id: z.string().regex(/^AC-[1-8]$/), text: z.string().min(1).max(2000) }).strict()).min(1).max(8),
    target: z.string().min(1).max(8000), targetDigest: Sha,
  }).strict(),
  candidate: z.unknown(), candidateDigest: Sha, priorReviewDigest: Sha, requestDigest: Sha,
  codexThreadId: Id, binding: Binding,
  source: z.object({
    workflowId: z.uuid(), operationKey: z.string().min(1).max(300), inputDigest: Sha,
    turnMarker: Id, terminalMarker: Id, reason: z.string().regex(/^[a-z0-9_]{1,100}$/),
    providerTerminal: Terminal.nullable(), confirmedSend: z.boolean(),
  }).strict(),
}).strict()

function fail(code = "invalid_continuation_checkpoint") {
  throw new EgoChatError(code, "The exact durable conversation continuation evidence is invalid or does not authorize this action.")
}

// Snapshot queued comparisons without invoking getters or serialization hooks.
// Undefined object fields are retained for exact in-memory CAS compatibility.
export function snapshotContinuationValue(value) {
  const ancestors = new Set()
  let nodes = 0
  const visit = (entry, depth) => {
    if (++nodes > 40_000 || depth > 64) fail()
    if (entry === undefined || entry === null || typeof entry === "boolean" || typeof entry === "string") return entry
    if (typeof entry === "number" && Number.isFinite(entry)) return entry
    if (typeof entry !== "object" || ancestors.has(entry)) fail()
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== (Array.isArray(entry) ? Array.prototype : Object.prototype) && prototype !== null) fail()
    if (Object.getOwnPropertySymbols(entry).length) fail()
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    const array = Array.isArray(entry)
    const keys = Object.keys(descriptors).filter((key) => !array || key !== "length")
    if (array && (keys.length !== entry.length || keys.some((key, index) => key !== String(index)))) fail()
    ancestors.add(entry)
    const result = array ? [] : {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || (array && descriptor.value === undefined)) fail()
      Object.defineProperty(result, key, { configurable: true, enumerable: true, writable: true, value: visit(descriptor.value, depth + 1) })
    }
    ancestors.delete(entry)
    return result
  }
  const result = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SNAPSHOT_BYTES) fail()
  return result
}

function checked(schema, value) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) fail()
  return parsed.data
}

function checkpointDigest(value) {
  const payload = { ...value }
  delete payload.digest
  return createHash("sha256").update(canonicalJsonBytes(payload)).digest("hex")
}

export function chatgptProjectScope(value, starting = false) {
  let url
  if (typeof value !== "string" || value.length > 2048) return undefined
  try { url = new URL(value) } catch (_error) { return undefined }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password || url.search || url.hash) return undefined
  const match = url.pathname.match(starting
    ? /^\/(?:g\/([A-Za-z0-9_-]+)(?:\/project)?\/?)?$/
    : /^\/(?:g\/([A-Za-z0-9_-]+)\/)?c\/[A-Za-z0-9_-]+$/)
  if (!match) return undefined
  // The browser appends a mutable title slug after the stable Project ID.
  return match[1]?.match(/^(g-p-[a-f0-9]{32})(?:-[A-Za-z0-9_-]+)?$/)?.[1] ?? match[1] ?? null
}

function canonicalScope(value) {
  const scope = chatgptProjectScope(value)
  if (scope === undefined) fail()
  return scope
}

function bindingEvidence(binding) {
  if (binding?.state !== "bound") fail()
  const canonicalProject = canonicalScope(binding.canonicalUrl)
  let declaredProject = null
  if (binding.projectUrl !== null && binding.projectUrl !== undefined) {
    declaredProject = chatgptProjectScope(binding.projectUrl, true)
    if (!declaredProject) fail()
    // Metadata alone cannot establish that a plain /c/ URL belongs to a Project.
    if (!canonicalProject || canonicalProject !== declaredProject) fail()
  }
  return checked(Binding, {
    key: binding.key, canonicalUrl: binding.canonicalUrl, revision: binding.revision,
    headFingerprint: binding.headFingerprint, headContentDigest: binding.headContentDigest,
    headMessageId: binding.headMessageId, taskSpaceIdentity: binding.taskSpaceIdentity,
    projectScope: canonicalProject,
  })
}

export function activeConvergenceBindingKey(workflow) {
  if (workflow?.activeChat !== undefined) {
    checked(z.object({ bindingKey: Key, generation: z.number().int().min(1).max(MAX_CHAT_GENERATIONS) }).strict(), workflow.activeChat)
  }
  return checked(Key, workflow?.activeChat?.bindingKey ?? workflow?.bindingKey)
}

export function convergenceReviewIdentity(workflowId, cycle, generation = 0) {
  checked(z.uuid(), workflowId)
  checked(z.number().int().positive(), cycle)
  checked(z.number().int().min(0).max(MAX_CHAT_GENERATIONS), generation)
  const markerToken = digestJson({ cycle, purpose: "review", workflowId, ...(generation > 0 ? { generation } : {}) }).slice(0, 32).toUpperCase()
  return { terminalMarker: `EGO_CHAT_REVIEW_DONE_${markerToken}`, turnMarker: `EGO_CHAT_CONVERGENCE_${markerToken}_C${cycle}` }
}

const ResumeReceipt = z.object({
  schema: z.literal("ego-chat-convergence-resume/v1"), checkpointDigest: Sha,
  sourceChildWorkflowId: z.uuid(), bindingKey: Key,
  generation: z.number().int().min(0).max(MAX_CHAT_GENERATIONS),
  mode: z.enum(["same_binding", "verified_successor"]), resumedAt: Timestamp,
  bindingRevision: z.number().int().positive(), canonicalUrlDigest: Sha, requestDigest: Sha,
}).strict()

function validatedResumeReceipt(value) {
  const receipt = checked(ResumeReceipt, value)
  if (receipt.requestDigest !== digestJson({
    checkpointDigest: receipt.checkpointDigest, bindingKey: receipt.bindingKey,
    bindingRevision: receipt.bindingRevision, canonicalUrlDigest: receipt.canonicalUrlDigest,
    generation: receipt.generation, mode: receipt.mode,
  })) fail()
  return receipt
}

function sameImmutableBinding(left, right) {
  return left.key === right.key && left.canonicalUrl === right.canonicalUrl
    && left.projectScope === right.projectScope
    && isDeepStrictEqual(left.taskSpaceIdentity, right.taskSpaceIdentity)
}

export function validateConvergenceContinuationLineage(value) {
  if (value?.kind !== "convergence") fail()
  if (value.status !== "running" && !(value.status === "human_required" && value.phase === "continuation_paused")) return true
  const workflow = snapshotContinuationValue(value)
  const activeKey = activeConvergenceBindingKey(workflow)
  const generation = workflow.activeChat?.generation ?? 0
  const history = workflow.private?.chatGenerations ?? []
  if (!Array.isArray(history) || history.length !== generation) fail()
  let preceding
  let precedingTime = 0
  let precedingCycle = 0
  const seen = []
  for (let index = 0; index < history.length; index += 1) {
    const record = checked(z.object({
      checkpointDigest: Sha, source: Checkpoint.shape.source,
      predecessor: Binding, successor: Binding, receipt: ResumeReceipt,
    }).strict(), history[index])
    const { predecessor, successor, source } = record
    const receipt = validatedResumeReceipt(record.receipt)
    for (const binding of [predecessor, successor]) {
      if (canonicalScope(binding.canonicalUrl) !== binding.projectScope) fail()
    }
    if (!preceding) {
      if (predecessor.key !== workflow.bindingKey) fail()
      seen.push(predecessor)
    } else if (
      !sameImmutableBinding(predecessor, preceding)
      || predecessor.revision < preceding.revision
      || (predecessor.revision === preceding.revision && (
        predecessor.headFingerprint !== preceding.headFingerprint
        || predecessor.headContentDigest !== preceding.headContentDigest
        || predecessor.headMessageId !== preceding.headMessageId
      ))
    ) fail()
    if (predecessor.projectScope !== successor.projectScope || seen.some((binding) => (
      binding.key === successor.key || binding.canonicalUrl === successor.canonicalUrl
      || binding.taskSpaceIdentity.name === successor.taskSpaceIdentity.name
      || binding.taskSpaceIdentity.taskId === successor.taskSpaceIdentity.taskId
    ))) fail()
    const cycle = Number(source.turnMarker.match(/_C([1-9][0-9]*)$/)?.[1])
    const identity = convergenceReviewIdentity(workflow.id, cycle, index)
    if (
      cycle < precedingCycle || cycle > workflow.cycle
      || source.operationKey !== `exchange:${predecessor.key}:${identity.turnMarker}`
      || source.turnMarker !== identity.turnMarker || source.terminalMarker !== identity.terminalMarker
      || source.reason !== "chatgpt_conversation_exhausted" || !source.confirmedSend
      || source.providerTerminal?.kind !== "conversation_exhausted"
      || receipt.mode !== "verified_successor" || receipt.generation !== index + 1
      || receipt.checkpointDigest !== record.checkpointDigest
      || receipt.sourceChildWorkflowId !== source.workflowId
      || receipt.bindingKey !== successor.key || receipt.bindingRevision !== successor.revision
      || receipt.canonicalUrlDigest !== createHash("sha256").update(successor.canonicalUrl, "utf8").digest("hex")
      || Date.parse(receipt.resumedAt) < precedingTime
      || Date.parse(source.providerTerminal.observedAt) > Date.parse(receipt.resumedAt)
    ) fail()
    preceding = successor
    precedingTime = Date.parse(receipt.resumedAt)
    precedingCycle = cycle
    seen.push(successor)
  }
  if (preceding && preceding.key !== activeKey) fail()
  if (workflow.continuationResume) {
    const latest = validatedResumeReceipt(workflow.continuationResume)
    if (latest.bindingKey !== activeKey || latest.generation !== generation || Date.parse(latest.resumedAt) < precedingTime) fail()
    if (latest.mode === "verified_successor") {
      if (!generation || !isDeepStrictEqual(latest, history.at(-1).receipt)) fail()
    } else if (preceding && (
      latest.bindingRevision < preceding.revision
      || latest.canonicalUrlDigest !== createHash("sha256").update(preceding.canonicalUrl, "utf8").digest("hex")
    )) fail()
  } else if (generation) fail()
  return true
}

function currentEvidence(workflow) {
  if (workflow?.kind !== "convergence" || !workflow.private?.request || !Array.isArray(workflow.private.cycles)) fail()
  const { contract } = workflow.private
  if (!contract || !Array.isArray(contract.criteria)) fail()
  if (!isDeepStrictEqual(contract, createContract(contract.target, contract.criteria.map(({ text }) => text)))) fail()
  if (workflow.targetDigest !== contract.targetDigest) fail()
  const record = workflow.private.cycles.at(-1)
  if (!record || record.cycle !== workflow.cycle || record.candidateDigest !== workflow.candidateDigest || digestJson(record.candidate) !== workflow.candidateDigest) fail()
  validateCodexCandidate(record.candidate, contract.criteria)
  return { contract, record }
}

export function buildContinuationCheckpoint({ workflow: sourceWorkflow, child: sourceChild, binding: sourceBinding, at }) {
  const { workflow, child, binding } = snapshotContinuationValue({ workflow: sourceWorkflow, child: sourceChild, binding: sourceBinding })
  validateConvergenceContinuationLineage(workflow)
  const { contract, record } = currentEvidence(workflow)
  if (workflow.status !== "running" || workflow.phase !== "chatgpt_running" || workflow.childWorkflowId !== child?.id) fail()
  if (!child || child.kind !== "ego_exchange" || !["failed", "human_required"].includes(child.status) || child.abandonment || child.private?.request?.receiptCapture) fail()
  const bindingKey = activeConvergenceBindingKey(workflow)
  const generation = workflow.activeChat?.generation ?? 0
  const identity = convergenceReviewIdentity(workflow.id, workflow.cycle, generation)
  if (child.bindingKey !== bindingKey || binding.key !== bindingKey || child.operationKey !== `exchange:${bindingKey}:${identity.turnMarker}`) fail()
  if (child.reconciliation?.turnMarker !== identity.turnMarker || child.reconciliation?.expectedTerminalMarker !== identity.terminalMarker) fail()
  const terminal = child.providerTerminal ? checked(Terminal, child.providerTerminal) : null
  if (terminal && Date.parse(terminal.observedAt) > Date.parse(at)) fail()
  const payload = {
    schema: "ego-chat-conversation-continuation/v1", digest: "0".repeat(64), workflowId: workflow.id,
    originalBindingKey: workflow.bindingKey, activeBindingKey: bindingKey, generation, cycle: workflow.cycle,
    createdAt: at, contract, candidate: record.candidate, candidateDigest: record.candidateDigest,
    priorReviewDigest: digestJson(workflow.private.priorReview ?? null), requestDigest: digestJson(workflow.private.request),
    codexThreadId: workflow.codexThreadId, binding: bindingEvidence(binding),
    source: {
      workflowId: child.id, operationKey: child.operationKey, inputDigest: child.inputDigest,
      turnMarker: identity.turnMarker, terminalMarker: identity.terminalMarker,
      reason: child.humanRequired?.code ?? child.error?.code,
      providerTerminal: terminal,
      confirmedSend: Boolean(
        child.private?.send?.canonicalUrl === binding.canonicalUrl
        && Timestamp.safeParse(child.private.send.sentAt).success,
      ),
    },
  }
  payload.digest = checkpointDigest(payload)
  return validateContinuationCheckpoint(payload, { workflow })
}

export function validateContinuationCheckpoint(value, { workflow, child, binding } = {}) {
  const checkpoint = checked(Checkpoint, snapshotContinuationValue(value))
  if (canonicalJsonBytes(checkpoint).length > MAX_CONTINUATION_CHECKPOINT_BYTES || checkpointDigest(checkpoint) !== checkpoint.digest) fail()
  if (
    checkpoint.binding.key !== checkpoint.activeBindingKey
    || checkpoint.candidateDigest !== digestJson(checkpoint.candidate)
  ) fail()
  if (!isDeepStrictEqual(checkpoint.contract, createContract(checkpoint.contract.target, checkpoint.contract.criteria.map(({ text }) => text)))) fail()
  validateCodexCandidate(checkpoint.candidate, checkpoint.contract.criteria)
  canonicalScope(checkpoint.binding.canonicalUrl)
  const identity = convergenceReviewIdentity(checkpoint.workflowId, checkpoint.cycle, checkpoint.generation)
  if (
    checkpoint.source.operationKey !== `exchange:${checkpoint.activeBindingKey}:${identity.turnMarker}`
    || checkpoint.source.turnMarker !== identity.turnMarker
    || checkpoint.source.terminalMarker !== identity.terminalMarker
  ) fail()
  if (workflow) {
    const { contract, record } = currentEvidence(workflow)
    if (
      workflow.id !== checkpoint.workflowId
      || workflow.bindingKey !== checkpoint.originalBindingKey
      || activeConvergenceBindingKey(workflow) !== checkpoint.activeBindingKey
      || (workflow.activeChat?.generation ?? 0) !== checkpoint.generation
      || workflow.cycle !== checkpoint.cycle
      || workflow.childWorkflowId !== checkpoint.source.workflowId
      || workflow.codexThreadId !== checkpoint.codexThreadId
      || !isDeepStrictEqual(record.candidate, checkpoint.candidate)
      || !isDeepStrictEqual(contract, checkpoint.contract)
      || digestJson(workflow.private.request) !== checkpoint.requestDigest
      || digestJson(workflow.private.priorReview ?? null) !== checkpoint.priorReviewDigest
    ) fail()
  }
  if (child && (
    child.id !== checkpoint.source.workflowId
    || child.kind !== "ego_exchange"
    || child.bindingKey !== checkpoint.activeBindingKey
    || child.operationKey !== checkpoint.source.operationKey
    || child.inputDigest !== checkpoint.source.inputDigest
    || child.reconciliation?.turnMarker !== checkpoint.source.turnMarker
    || child.reconciliation?.expectedTerminalMarker !== checkpoint.source.terminalMarker
  )) fail()
  if (binding && !isDeepStrictEqual(bindingEvidence(binding), checkpoint.binding)) fail()
  return checkpoint
}

function successorAllowed(checkpoint) {
  return checkpoint.source.reason === "chatgpt_conversation_exhausted"
    && checkpoint.source.providerTerminal?.kind === "conversation_exhausted"
    && checkpoint.source.confirmedSend
}

export function automaticSuccessorEnabled(workflow) {
  return workflow?.private?.request?.conversationContinuation === "same_project_on_exhaustion"
    && (workflow.activeChat?.generation ?? 0) < MAX_CHAT_GENERATIONS
    && !workflow.abandonment
}

export function automaticSuccessorPhase(workflow) {
  return automaticSuccessorEnabled(workflow) && workflow.status === "running"
    && ["successor_preparing", "successor_reviewing"].includes(workflow.phase)
}

export function buildSuccessorPreparation({ workflow, child, binding, expectedCheckpointDigest, acknowledgeNewChat, at }) {
  bindingEvidence(binding)
  validateConvergenceContinuationLineage(workflow)
  const checkpoint = validateContinuationCheckpoint(workflow?.private?.continuationCheckpoint, { workflow, child, binding })
  checked(Timestamp, at)
  if (acknowledgeNewChat !== true || expectedCheckpointDigest !== checkpoint.digest
    || workflow.private.successorReview
    || (!(workflow.status === "human_required" && workflow.phase === "continuation_paused") && !automaticSuccessorPhase(workflow))
    || workflow.abandonment || /cancel|abandon/.test(workflow.humanRequired?.code ?? "")
    || !successorAllowed(checkpoint) || checkpoint.generation >= MAX_CHAT_GENERATIONS
    || child?.status !== "human_required" || child.phase !== "provider_paused" || child.abandonment
    || child.humanRequired?.code !== checkpoint.source.reason
    || !isDeepStrictEqual(child.providerTerminal, checkpoint.source.providerTerminal)
    || child.private?.send?.canonicalUrl !== binding.canonicalUrl
    || Date.parse(at) < Date.parse(checkpoint.createdAt)) fail("continuation_not_authorized")
  const token = digestJson({ purpose: "blank-successor/v1", workflowId: workflow.id, checkpointDigest: checkpoint.digest }).slice(0, 32)
  const plan = {
    schema: "ego-chat-successor-preparation/v1", checkpointDigest: checkpoint.digest,
    bindingKey: `successor-${token}`, taskSpaceName: `ego-chat-successor-${token}`,
    startUrl: checkpoint.binding.projectScope ? `https://chatgpt.com/g/${checkpoint.binding.projectScope}` : "https://chatgpt.com/",
    state: "dispatched", createdAt: at,
  }
  const previous = workflow.private.successorPreparation
  if (previous) {
    if (!isDeepStrictEqual({ ...previous, preparedBinding: undefined, state: "dispatched", createdAt: at }, { ...plan, preparedBinding: undefined })
      || !["dispatched", "prepared"].includes(previous.state)
      || !Timestamp.safeParse(previous.createdAt).success
      || Date.parse(previous.createdAt) < Date.parse(checkpoint.createdAt)
      || Date.parse(previous.createdAt) > Date.parse(at)
      || (previous.state === "prepared") !== Boolean(previous.preparedBinding)) fail("continuation_not_authorized")
    return snapshotContinuationValue(previous)
  }
  return plan
}

export function buildSuccessorPromotion({ workflow, child, binding, successorBinding, successorChild, at }) {
  const eligible = (automaticSuccessorPhase(workflow) && workflow.phase === "successor_reviewing")
    || (automaticSuccessorEnabled(workflow) && workflow.status === "human_required" && workflow.phase === "continuation_paused"
      && !/cancel|abandon/.test(workflow.humanRequired?.code ?? ""))
  if (!eligible) fail("continuation_not_authorized")
  const checkpoint = validateContinuationCheckpoint(workflow.private.continuationCheckpoint, { workflow, child, binding })
  const plan = workflow.private.successorPreparation
  const intent = workflow.private.successorReview
  const identity = convergenceReviewIdentity(workflow.id, workflow.cycle, checkpoint.generation + 1)
  if (plan?.state !== "prepared" || plan.checkpointDigest !== checkpoint.digest
    || plan.bindingKey !== successorBinding?.key
    || !isDeepStrictEqual(plan.preparedBinding.taskSpaceIdentity, successorBinding.taskSpaceIdentity)
    || successorBinding.targetId !== plan.preparedBinding.targetId
    || intent?.bindingKey !== plan.bindingKey || intent.turnMarker !== identity.turnMarker
    || intent.terminalMarker !== identity.terminalMarker || intent.candidateDigest !== checkpoint.candidateDigest
    || successorChild?.kind !== "ego_exchange" || successorChild.successorParentId !== workflow.id || successorChild.bindingKey !== plan.bindingKey
    || successorChild.operationKey !== `exchange:${plan.bindingKey}:${identity.turnMarker}`
    || successorChild.inputDigest !== intent.promptDigest
    || successorChild.reconciliation?.turnMarker !== identity.turnMarker
    || successorChild.reconciliation?.expectedTerminalMarker !== identity.terminalMarker
    || successorChild.status !== "succeeded" || successorChild.phase !== "head_committed"
    || successorChild.result?.canonicalUrl !== successorBinding.canonicalUrl
    || successorChild.result?.providerTerminal || successorChild.result?.captureState === "provider_terminal"
    || successorChild.result?.head?.fingerprint !== successorBinding.headFingerprint
    || successorChild.result?.responseDigest !== successorBinding.headContentDigest
    || successorChild.result?.head?.lastMessageId !== successorBinding.headMessageId
    || (successorBinding.lastExchangeWorkflowId !== successorChild.id
      && !(successorChild.result?.reconciled === true && successorBinding.lastReconciledWorkflowId === successorChild.id))) fail("continuation_not_authorized")
  const ready = { ...workflow, status: "human_required", phase: "continuation_paused", private: { ...workflow.private } }
  delete ready.private.successorReview
  const resumed = buildConvergenceResume({
    workflow: ready,
    child, binding, successorBinding, at,
    expectedCheckpointDigest: checkpoint.digest, acknowledgeConversationChange: true,
  })
  resumed.workflow.phase = "chatgpt_running"
  resumed.workflow.childWorkflowId = successorChild.id
  resumed.workflow.successorResumeCheckpointDigest = checkpoint.digest
  delete resumed.workflow.private.successorReview
  return resumed
}

export function buildPreparedSuccessorBinding(plan, value, at) {
  checked(Timestamp, at)
  const result = checked(z.object({
    canonicalUrl: z.null(), startUrl: z.string().refine(value => chatgptProjectScope(value, true) !== undefined
      && chatgptProjectScope(value, true) === chatgptProjectScope(plan.startUrl, true)), targetId: Id,
    taskSpaceId: z.number().int().positive().safe(),
    taskSpaceIdentity: z.object({ name: z.literal(plan.taskSpaceName), taskId: Id }).strict(),
    head: z.object({
      fingerprint: z.literal(createHash("sha256").update("null").digest("hex")),
      fingerprintVersion: z.literal("tail-v1"), lastContentDigest: z.null(),
      lastMessageId: z.null(), lastRole: z.null(), messageCount: z.literal(0), renderedMessageCount: z.literal(0),
    }).strict(),
    snapshotDigest: Sha.optional(), durationMs: z.number().nonnegative().optional(),
  }).strict(), snapshotContinuationValue(value))
  if (Date.parse(at) < Date.parse(plan.createdAt)
    || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(result.taskSpaceIdentity.taskId)) fail()
  return {
    canonicalUrl: null, createdAt: plan.createdAt, key: plan.bindingKey,
    headContentDigest: null, headFingerprint: result.head.fingerprint, headFingerprintVersion: "tail-v1",
    headMessageId: null, headRole: null, messageCount: 0, mode: "create_once",
    modelPolicyKey: DEFAULT_MODEL_POLICY.key,
    projectUrl: result.startUrl === "https://chatgpt.com/" ? null : result.startUrl,
    revision: 1, startUrl: result.startUrl, state: "unbound", targetId: result.targetId,
    taskSpaceId: result.taskSpaceId, taskSpaceIdentity: result.taskSpaceIdentity,
    updatedAt: at, verifiedAt: at,
  }
}

export function publicContinuationCheckpoint(value) {
  const checkpoint = validateContinuationCheckpoint(value)
  return {
    schema: "ego-chat-continuation-receipt/v1", checkpointDigest: checkpoint.digest,
    cycle: checkpoint.cycle, generation: checkpoint.generation, reasonCode: checkpoint.source.reason,
    allowedActions: successorAllowed(checkpoint) ? ["resume_with_verified_successor"] : [],
  }
}

export function buildConvergenceResume({ workflow: sourceWorkflow, child: sourceChild, binding: sourceBinding, successorBinding: sourceSuccessor, expectedCheckpointDigest, acknowledgeConversationChange = false, at }) {
  const { workflow, child, binding, successorBinding } = snapshotContinuationValue({ workflow: sourceWorkflow, child: sourceChild, binding: sourceBinding, successorBinding: sourceSuccessor })
  validateConvergenceContinuationLineage(workflow)
  checked(Timestamp, at)
  const checkpoint = validateContinuationCheckpoint(workflow?.private?.continuationCheckpoint, { workflow, child })
  if (
    workflow.status !== "human_required"
    || workflow.private.successorReview
    || workflow.phase !== "continuation_paused"
    || workflow.abandonment
    || checkpoint.digest !== expectedCheckpointDigest
    || /cancel|abandon/.test(workflow.humanRequired?.code ?? "")
    || /cancel|abandon/.test(checkpoint.source.reason)
  ) fail("continuation_not_authorized")
  if (Date.parse(at) < Date.parse(checkpoint.createdAt) || child.abandonment) fail("continuation_not_authorized")
  let nextBinding = binding
  let generation = checkpoint.generation
  let phase = "chatgpt_running"
  const mode = successorBinding ? "verified_successor" : "same_binding"
  if (successorBinding) {
    validateContinuationCheckpoint(checkpoint, { binding })
    const successorEvidence = bindingEvidence(successorBinding)
    if (
      acknowledgeConversationChange !== true
      || !successorAllowed(checkpoint)
      || child.status !== "human_required"
      || child.phase !== "provider_paused"
      || child.humanRequired?.code !== checkpoint.source.reason
      || !isDeepStrictEqual(child.providerTerminal, checkpoint.source.providerTerminal)
      || child.private?.send?.canonicalUrl !== binding.canonicalUrl
      || generation >= MAX_CHAT_GENERATIONS
    ) fail("continuation_not_authorized")
    if (
      successorBinding.key === binding.key
      || successorBinding.canonicalUrl === binding.canonicalUrl
      || successorBinding.taskSpaceIdentity.name === binding.taskSpaceIdentity.name
      || successorBinding.taskSpaceIdentity.taskId === binding.taskSpaceIdentity.taskId
      || successorEvidence.projectScope !== checkpoint.binding.projectScope
    ) fail("continuation_not_authorized")
    nextBinding = successorBinding
    generation += 1
    phase = "codex_captured"
  } else {
    bindingEvidence(binding)
    const result = child.result
    if (
      binding.key !== checkpoint.activeBindingKey
      || binding.canonicalUrl !== checkpoint.binding.canonicalUrl
      || !isDeepStrictEqual(binding.taskSpaceIdentity, checkpoint.binding.taskSpaceIdentity)
      || child.status !== "succeeded"
      || child.phase !== "head_committed"
      || result?.reconciled !== true
      || result?.captureState === "provider_terminal"
      || result?.providerTerminal
      || !Sha.safeParse(result?.responseDigest).success
      || result?.canonicalUrl !== binding.canonicalUrl
      || result?.head?.fingerprint !== binding.headFingerprint
      || result?.head?.lastContentDigest !== binding.headContentDigest
      || result?.head?.lastMessageId !== binding.headMessageId
    ) fail("continuation_not_authorized")
    if (typeof result.responseText === "string" ? createHash("sha256").update(result.responseText, "utf8").digest("hex") !== result.responseDigest : result.responseRef?.digest !== result.responseDigest) fail()
  }
  const receipt = {
    schema: "ego-chat-convergence-resume/v1", checkpointDigest: checkpoint.digest,
    sourceChildWorkflowId: child.id, bindingKey: nextBinding.key, generation, mode, resumedAt: at,
    bindingRevision: nextBinding.revision,
    canonicalUrlDigest: createHash("sha256").update(nextBinding.canonicalUrl, "utf8").digest("hex"),
  }
  receipt.requestDigest = digestJson({
    checkpointDigest: checkpoint.digest, bindingKey: nextBinding.key,
    bindingRevision: receipt.bindingRevision, canonicalUrlDigest: receipt.canonicalUrlDigest,
    generation, mode,
  })
  const next = { ...workflow, phase, status: "running", updatedAt: at,
    ...(generation > 0 ? { activeChat: { bindingKey: nextBinding.key, generation } } : {}),
    continuationResume: receipt,
    private: { ...workflow.private },
  }
  delete next.humanRequired
  delete next.error
  delete next.private.continuationCheckpoint
  delete next.private.successorPreparation
  if (successorBinding) {
    const history = workflow.private.chatGenerations ?? []
    if (!Array.isArray(history) || history.length >= MAX_CHAT_GENERATIONS) fail()
    next.private.chatGenerations = [...history, {
      checkpointDigest: checkpoint.digest, source: checkpoint.source, predecessor: checkpoint.binding,
      successor: bindingEvidence(successorBinding), receipt,
    }]
    delete next.childWorkflowId
  }
  validateConvergenceContinuationLineage(next)
  return { workflow: next, receipt }
}
