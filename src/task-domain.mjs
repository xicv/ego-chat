import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

import { EgoChatError } from "./errors.mjs"

export const TASK_STATE_SCHEMA_VERSION = 1
export const TASK_JSON_MAX_BYTES = 512 * 1024

const ACTIVITY_KINDS = new Set(["implementation", "review", "verification"])
const EFFECT_STATUSES = new Set(["applied", "dispatching", "reserved", "succeeded"])
const REQUIRED_EVIDENCE_KINDS = new Set(["review", "verification"])
const TASK_JSON_MAX_DEPTH = 64
const TASK_JSON_MAX_NODES = 10_000
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

function clone(value) {
  return structuredClone(value)
}

function fail(code, message, details = undefined) {
  throw new EgoChatError(code, message, details)
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_task_command", `${label} must be an object.`)
  }
}

function assertIdentifier(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("invalid_task_command", `${label} must be a non-empty bounded identifier.`)
  }
}

function assertTimestamp(value, label = "at") {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("invalid_task_command", `${label} must be an ISO-8601 timestamp.`)
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail("invalid_task_command", `${label} must be an exact lowercase 40- or 64-character SHA.`)
  }
}

function normalizeJson(value, path = "value") {
  const seen = new Set()
  let nodes = 0
  const visit = (entry, entryPath, depth) => {
    nodes += 1
    if (nodes > TASK_JSON_MAX_NODES || depth > TASK_JSON_MAX_DEPTH) {
      fail("invalid_task_command", `${path} exceeds the durable JSON complexity limit.`)
    }
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry
    if (typeof entry === "number" && Number.isFinite(entry)) return entry
    if (typeof entry !== "object" || seen.has(entry)) {
      fail("invalid_task_command", `${entryPath} must be finite, acyclic JSON data.`)
    }
    seen.add(entry)
    let normalized
    if (Array.isArray(entry)) {
      const descriptors = Object.getOwnPropertyDescriptors(entry)
      const length = descriptors.length?.value
      const elementKeys = Object.keys(descriptors).filter((key) => key !== "length")
      if (
        !Number.isSafeInteger(length)
        || length < 0
        || elementKeys.length !== length
        || Object.getOwnPropertySymbols(entry).length > 0
      ) {
        fail("invalid_task_command", `${entryPath} must be a dense JSON array without extra properties.`)
      }
      normalized = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (
          !descriptor
          || !descriptor.enumerable
          || descriptor.get
          || descriptor.set
          || !("value" in descriptor)
          || descriptor.value === undefined
        ) {
          fail("invalid_task_command", `${entryPath}[${index}] must be an enumerable JSON value.`)
        }
        normalized.push(visit(descriptor.value, `${entryPath}[${index}]`, depth + 1))
      }
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype || Object.getOwnPropertySymbols(entry).length > 0) {
        fail("invalid_task_command", `${entryPath} must contain only plain JSON objects.`)
      }
      normalized = {}
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set || descriptor.value === undefined) {
          fail("invalid_task_command", `${entryPath}.${key} must be an enumerable JSON value.`)
        }
        Object.defineProperty(normalized, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, `${entryPath}.${key}`, depth + 1),
          writable: true,
        })
      }
    }
    seen.delete(entry)
    return normalized
  }

  const normalized = visit(value, path, 0)
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > TASK_JSON_MAX_BYTES) {
    fail("invalid_task_command", `${path} exceeds the durable JSON byte limit.`)
  }
  return normalized
}

function assertJson(value, path = "value") {
  normalizeJson(value, path)
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`
}

export function digestTaskValue(value) {
  const normalized = cloneTaskValue(value)
  return createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex")
}

export function cloneTaskValue(value) {
  return normalizeJson(value)
}

export function createEmptyTaskState() {
  return {
    activities: {},
    approvals: {},
    artifacts: {},
    conversations: {},
    effects: {},
    events: [],
    leases: {},
    nextEventSeq: 1,
    revision: 0,
    runners: {},
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    tasks: {},
  }
}

const ACTIVITY_STATUSES = new Set(["failed", "leased", "pending", "stale", "succeeded"])
const APPROVAL_STATUSES = new Set(["current", "stale"])
const LEASE_STATUSES = new Set(["active", "completed", "expired", "reassigned", "stale"])
const TASK_STATUSES = new Set([
  "awaiting_implementation",
  "ready_to_merge",
  "waiting_approval",
  "waiting_evidence",
  "waiting_verification",
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function corrupt(condition, message) {
  if (!condition) fail("corrupt_task_state", message)
}

function isStoredIdentifier(value, maximum = 200) {
  return (
    typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isStoredTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isStoredSha(value) {
  return typeof value === "string" && SHA_PATTERN.test(value)
}

function isStoredRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasUniqueStoredIds(values) {
  return (
    Array.isArray(values)
    && values.every((value) => isStoredIdentifier(value))
    && new Set(values).size === values.length
  )
}

function storedDigest(value, label) {
  try {
    return digestTaskValue(value)
  } catch {
    fail("corrupt_task_state", `The durable ${label} is not bounded JSON data.`)
  }
}

function validateStoredCollection(collection, label, validate) {
  for (const [key, value] of Object.entries(collection)) {
    corrupt(isStoredIdentifier(key) && isStoredRecord(value) && value.id === key, (
      `The durable ${label} identity is invalid.`
    ))
    validate(value)
  }
}

export function validateTaskState(state) {
  corrupt(isStoredRecord(state), "The durable task state must be an object.")
  if (
    state.schemaVersion !== TASK_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0
    || !Number.isSafeInteger(state.nextEventSeq)
    || state.nextEventSeq < 1
    || !Array.isArray(state.events)
  ) {
    fail("corrupt_task_state", "The durable task state header is invalid.")
  }
  for (const key of [
    "activities",
    "approvals",
    "artifacts",
    "conversations",
    "effects",
    "leases",
    "runners",
    "tasks",
  ]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) {
      fail("corrupt_task_state", `The durable task state ${key} collection is invalid.`)
    }
  }

  validateStoredCollection(state.conversations, "conversation", (conversation) => {
    corrupt(
      isStoredTimestamp(conversation.createdAt)
      && hasUniqueStoredIds(conversation.taskIds)
      && conversation.acceptanceContract !== null
      && typeof conversation.acceptanceContract === "object"
      && SHA256_PATTERN.test(conversation.acceptanceContractDigest)
      && storedDigest(conversation.acceptanceContract, "acceptance contract")
        === conversation.acceptanceContractDigest,
      "The durable conversation acceptance contract is invalid.",
    )
  })

  validateStoredCollection(state.runners, "runner", (runner) => {
    corrupt(
      runner.status === "available"
      && isStoredTimestamp(runner.registeredAt)
      && Array.isArray(runner.capabilities)
      && runner.capabilities.length >= 1
      && runner.capabilities.every((capability) => isStoredIdentifier(capability, 100))
      && new Set(runner.capabilities).size === runner.capabilities.length,
      "The durable runner registration is invalid.",
    )
  })

  validateStoredCollection(state.artifacts, "artifact", (artifact) => {
    corrupt(
      artifact.kind === "pull_request"
      && isStoredIdentifier(artifact.taskId)
      && isStoredSha(artifact.baseSha)
      && isStoredSha(artifact.headSha)
      && isStoredTimestamp(artifact.createdAt)
      && Number.isSafeInteger(artifact.revision)
      && artifact.revision >= 1
      && (artifact.supersedesArtifactId === null || isStoredIdentifier(artifact.supersedesArtifactId)),
      "The durable artifact revision is invalid.",
    )
    storedDigest(artifact.remoteRef, "artifact remote reference")
  })

  validateStoredCollection(state.activities, "activity", (activity) => {
    corrupt(
      ACTIVITY_KINDS.has(activity.kind)
      && ACTIVITY_STATUSES.has(activity.status)
      && isStoredIdentifier(activity.taskId)
      && isStoredSha(activity.baseSha)
      && isStoredSha(activity.headSha)
      && isStoredTimestamp(activity.createdAt)
      && isStoredTimestamp(activity.updatedAt)
      && Number.isSafeInteger(activity.lastFencingToken)
      && activity.lastFencingToken >= 0
      && hasUniqueStoredIds(activity.leaseIds),
      "The durable activity is invalid.",
    )
    if (activity.evidence === null) {
      corrupt(
        !["failed", "succeeded"].includes(activity.status),
        "A completed durable activity is missing its evidence.",
      )
    } else {
      corrupt(
        isStoredRecord(activity.evidence)
        && activity.evidence.baseSha === activity.baseSha
        && activity.evidence.headSha === activity.headSha
        && typeof activity.evidence.digest === "string"
        && SHA256_PATTERN.test(activity.evidence.digest)
        && storedDigest(activity.evidence.value, "activity evidence") === activity.evidence.digest,
        "The durable activity evidence binding is invalid.",
      )
    }
    if (activity.status === "stale") {
      corrupt(
        isStoredTimestamp(activity.staleAt) && activity.staleReason === "revision_changed",
        "A stale durable activity is missing its revision-change record.",
      )
    }
    if (activity.kind !== "verification") {
      corrupt(
        activity.lastFencingToken === 0 && activity.leaseIds.length === 0,
        "A non-verification durable activity contains verification leases.",
      )
    }
  })

  validateStoredCollection(state.leases, "lease", (lease) => {
    corrupt(
      LEASE_STATUSES.has(lease.status)
      && isStoredIdentifier(lease.activityId)
      && isStoredIdentifier(lease.runnerId)
      && isStoredIdentifier(lease.taskId)
      && isStoredSha(lease.baseSha)
      && isStoredSha(lease.headSha)
      && isStoredTimestamp(lease.createdAt)
      && isStoredTimestamp(lease.expiresAt)
      && Date.parse(lease.expiresAt) > Date.parse(lease.createdAt)
      && Number.isSafeInteger(lease.fencingToken)
      && lease.fencingToken >= 1,
      "The durable verification lease is invalid.",
    )
    if (["completed"].includes(lease.status)) {
      corrupt(isStoredTimestamp(lease.completedAt), "A completed durable lease has no completion time.")
    }
    if (["expired", "reassigned"].includes(lease.status)) {
      corrupt(isStoredTimestamp(lease.endedAt), "An ended durable lease has no end time.")
    }
    if (lease.status === "stale") {
      corrupt(isStoredTimestamp(lease.staleAt), "A stale durable lease has no stale time.")
    }
  })

  validateStoredCollection(state.approvals, "approval", (approval) => {
    corrupt(
      APPROVAL_STATUSES.has(approval.status)
      && isStoredIdentifier(approval.approver)
      && isStoredIdentifier(approval.taskId)
      && isStoredSha(approval.baseSha)
      && isStoredSha(approval.headSha)
      && isStoredTimestamp(approval.createdAt)
      && Array.isArray(approval.evidenceBindings)
      && approval.evidenceBindings.length >= 1,
      "The durable approval is invalid.",
    )
    const boundActivityIds = new Set()
    for (const binding of approval.evidenceBindings) {
      corrupt(
        isStoredRecord(binding)
        && isStoredIdentifier(binding.activityId)
        && ACTIVITY_KINDS.has(binding.kind)
        && typeof binding.evidenceDigest === "string"
        && SHA256_PATTERN.test(binding.evidenceDigest)
        && !boundActivityIds.has(binding.activityId),
        "The durable approval evidence binding is invalid.",
      )
      boundActivityIds.add(binding.activityId)
    }
    if (approval.status === "stale") {
      corrupt(
        isStoredTimestamp(approval.staleAt) && approval.staleReason === "revision_changed",
        "A stale durable approval is missing its revision-change record.",
      )
    }
  })

  validateStoredCollection(state.effects, "effect", (effect) => {
    corrupt(
      EFFECT_STATUSES.has(effect.status)
      && isStoredIdentifier(effect.adapterId)
      && isStoredIdentifier(effect.kind)
      && isStoredIdentifier(effect.taskId)
      && isStoredTimestamp(effect.createdAt)
      && isStoredTimestamp(effect.updatedAt)
      && Number.isSafeInteger(effect.attemptCount)
      && effect.attemptCount >= 0
      && Number.isSafeInteger(effect.reconciliationCount)
      && effect.reconciliationCount >= 0
      && typeof effect.inputDigest === "string"
      && SHA256_PATTERN.test(effect.inputDigest)
      && storedDigest(effect.input, "effect input") === effect.inputDigest,
      "The durable effect reservation is invalid.",
    )
    if (effect.status === "reserved") {
      corrupt(
        effect.attemptCount === 0
        && effect.reconciliationCount === 0
        && effect.lastReconciledAt === null
        && effect.result === null
        && effect.resultDigest === null,
        "The reserved durable effect state is invalid.",
      )
    } else {
      corrupt(effect.attemptCount >= 1, "A dispatched durable effect has no attempt.")
    }
    if (["applied", "succeeded"].includes(effect.status)) {
      corrupt(
        effect.reconciliationCount >= 1
        && isStoredTimestamp(effect.lastReconciledAt)
        && typeof effect.resultDigest === "string"
        && SHA256_PATTERN.test(effect.resultDigest)
        && storedDigest(effect.result, "effect result") === effect.resultDigest,
        "The durable effect result is invalid.",
      )
    } else {
      corrupt(
        effect.result === null && effect.resultDigest === null,
        "An incomplete durable effect contains a result.",
      )
      if (effect.lastReconciledAt !== null) {
        corrupt(
          effect.status === "dispatching"
          && effect.reconciliationCount >= 1
          && isStoredTimestamp(effect.lastReconciledAt),
          "The durable effect reconciliation record is invalid.",
        )
      }
    }
  })

  validateStoredCollection(state.tasks, "task", (task) => {
    corrupt(
      TASK_STATUSES.has(task.status)
      && isStoredIdentifier(task.conversationId)
      && isStoredTimestamp(task.createdAt)
      && isStoredTimestamp(task.updatedAt)
      && hasUniqueStoredIds(task.activityIds)
      && hasUniqueStoredIds(task.approvalIds)
      && hasUniqueStoredIds(task.artifactIds)
      && hasUniqueStoredIds(task.effectIds)
      && Array.isArray(task.requiredEvidenceKinds)
      && task.requiredEvidenceKinds.length >= 1
      && task.requiredEvidenceKinds.every((kind) => REQUIRED_EVIDENCE_KINDS.has(kind))
      && new Set(task.requiredEvidenceKinds).size === task.requiredEvidenceKinds.length,
      "The durable task is invalid.",
    )
    const conversation = state.conversations[task.conversationId]
    corrupt(
      conversation
      && isStoredRecord(task.settlementContract)
      && Array.isArray(task.settlementContract.requiredEvidenceKinds)
      && task.settlementContract.requiredEvidenceKinds.length === task.requiredEvidenceKinds.length
      && task.settlementContract.requiredEvidenceKinds.every((kind, index) => (
        kind === task.requiredEvidenceKinds[index]
      ))
      && storedDigest(task.settlementContract.acceptanceContract, "task acceptance contract")
        === conversation.acceptanceContractDigest
      && typeof task.settlementContractDigest === "string"
      && SHA256_PATTERN.test(task.settlementContractDigest)
      && storedDigest(task.settlementContract, "task settlement contract")
        === task.settlementContractDigest,
      "The durable task settlement contract is invalid.",
    )
    if (task.currentArtifactId === null) {
      corrupt(
        task.artifactIds.length === 0
        && task.currentBaseSha === null
        && task.currentHeadSha === null,
        "The durable task has a revision without a current artifact.",
      )
    } else {
      corrupt(
        isStoredIdentifier(task.currentArtifactId)
        && isStoredSha(task.currentBaseSha)
        && isStoredSha(task.currentHeadSha)
        && task.artifactIds.at(-1) === task.currentArtifactId,
        "The durable task current artifact binding is invalid.",
      )
    }
  })

  for (const conversation of Object.values(state.conversations)) {
    for (const taskId of conversation.taskIds) {
      const task = state.tasks[taskId]
      corrupt(
        task?.conversationId === conversation.id,
        "A durable conversation references a missing or foreign task.",
      )
    }
  }

  for (const task of Object.values(state.tasks)) {
    const conversation = state.conversations[task.conversationId]
    corrupt(
      conversation?.taskIds.includes(task.id),
      "A durable task references a missing or foreign conversation.",
    )
    for (const [ids, collection, label] of [
      [task.activityIds, state.activities, "activity"],
      [task.approvalIds, state.approvals, "approval"],
      [task.artifactIds, state.artifacts, "artifact"],
      [task.effectIds, state.effects, "effect"],
    ]) {
      for (const id of ids) {
        corrupt(collection[id]?.taskId === task.id, `A durable task references a missing or foreign ${label}.`)
      }
      corrupt(
        Object.values(collection).filter((entity) => entity.taskId === task.id).length === ids.length,
        `The durable task ${label} index is incomplete.`,
      )
    }
    for (const [index, artifactId] of task.artifactIds.entries()) {
      const artifact = state.artifacts[artifactId]
      corrupt(
        artifact.revision === index + 1
        && artifact.supersedesArtifactId === (index === 0 ? null : task.artifactIds[index - 1]),
        "The durable artifact history is not a monotonic chain.",
      )
    }
    if (task.currentArtifactId !== null) {
      const artifact = state.artifacts[task.currentArtifactId]
      corrupt(
        artifact?.baseSha === task.currentBaseSha && artifact?.headSha === task.currentHeadSha,
        "The durable task revision differs from its current artifact.",
      )
    }
  }

  for (const activity of Object.values(state.activities)) {
    const task = state.tasks[activity.taskId]
    corrupt(task?.activityIds.includes(activity.id), "A durable activity references a missing task.")
    if (activity.status !== "stale") {
      corrupt(
        activity.baseSha === task.currentBaseSha && activity.headSha === task.currentHeadSha,
        "A current durable activity does not match its task revision.",
      )
    }
    const leases = activity.leaseIds.map((leaseId) => state.leases[leaseId])
    corrupt(leases.every(Boolean), "A durable activity references a missing lease.")
    for (const [index, lease] of leases.entries()) {
      corrupt(
        lease.activityId === activity.id
        && lease.taskId === activity.taskId
        && lease.baseSha === activity.baseSha
        && lease.headSha === activity.headSha
        && lease.fencingToken === index + 1,
        "A durable activity lease binding or fencing sequence is invalid.",
      )
    }
    const activeLeases = leases.filter((lease) => lease.status === "active")
    corrupt(activeLeases.length <= 1, "A durable activity has multiple active leases.")
    corrupt(
      activity.lastFencingToken === leases.length
      && (activeLeases.length === 0 || activeLeases[0].fencingToken === activity.lastFencingToken),
      "The durable activity fencing token is not monotonic.",
    )
    corrupt(
      (activity.status === "leased") === (activeLeases.length === 1),
      "The durable activity and lease statuses disagree.",
    )
    const finalLease = leases.at(-1)
    if (["failed", "succeeded"].includes(activity.status)) {
      corrupt(
        isStoredTimestamp(activity.completedAt)
        && activity.completedAt === activity.updatedAt,
        "A completed durable activity has no consistent completion time.",
      )
      if (activity.kind === "verification") {
        corrupt(
          finalLease?.status === "completed"
          && finalLease.fencingToken === activity.lastFencingToken
          && finalLease.completedAt === activity.completedAt,
          "Completed verification evidence is not bound to its final fenced lease.",
        )
      }
    } else if (["leased", "pending"].includes(activity.status)) {
      corrupt(
        activity.completedAt === null && activity.evidence === null,
        "An incomplete durable activity contains completion evidence.",
      )
    } else if (activity.status === "stale") {
      corrupt(
        (activity.evidence === null && activity.completedAt === null)
        || (
          activity.evidence !== null
          && isStoredTimestamp(activity.completedAt)
          && activity.completedAt === activity.updatedAt
        ),
        "A stale durable activity has inconsistent completion evidence.",
      )
      if (activity.kind === "verification") {
        corrupt(
          activity.evidence === null
            ? finalLease?.status === "stale"
            : finalLease?.status === "completed" && finalLease.completedAt === activity.completedAt,
          "A stale durable verification does not match its final lease history.",
        )
      }
    }
    if (activity.status === "leased") {
      corrupt(
        finalLease?.status === "active"
        && finalLease.createdAt === activity.updatedAt,
        "A leased durable verification is not bound to its latest active lease.",
      )
    }
  }

  for (const lease of Object.values(state.leases)) {
    const activity = state.activities[lease.activityId]
    corrupt(
      activity?.leaseIds.includes(lease.id)
      && state.runners[lease.runnerId]
      && state.tasks[lease.taskId]?.id === activity?.taskId,
      "A durable lease references a missing activity, task, or runner.",
    )
    corrupt(
      state.runners[lease.runnerId].capabilities.includes("verification"),
      "A durable verification lease references an incapable runner.",
    )
  }

  for (const approval of Object.values(state.approvals)) {
    const task = state.tasks[approval.taskId]
    corrupt(task?.approvalIds.includes(approval.id), "A durable approval references a missing task.")
    for (const binding of approval.evidenceBindings) {
      const activity = state.activities[binding.activityId]
      corrupt(
        activity?.taskId === approval.taskId
        && activity.kind === binding.kind
        && activity.evidence?.digest === binding.evidenceDigest
        && activity.baseSha === approval.baseSha
        && activity.headSha === approval.headSha,
        "A durable approval references invalid evidence.",
      )
      if (approval.status === "current") {
        corrupt(activity.status === "succeeded", "A current durable approval references stale evidence.")
      }
    }
    if (approval.status === "current") {
      corrupt(
        approval.baseSha === task.currentBaseSha
        && approval.headSha === task.currentHeadSha
        && task.requiredEvidenceKinds.every((kind) => approval.evidenceBindings.some(
          (binding) => binding.kind === kind,
        )),
        "A current durable approval is not bound to the complete current revision evidence.",
      )
    }
  }

  for (const effect of Object.values(state.effects)) {
    corrupt(
      state.tasks[effect.taskId]?.effectIds.includes(effect.id),
      "A durable effect references a missing task.",
    )
  }

  let previous = 0
  for (const event of state.events) {
    if (
      !isStoredRecord(event)
      || !Number.isSafeInteger(event.seq)
      || event.seq !== previous + 1
      || !isStoredIdentifier(event.conversationId)
      || !state.conversations[event.conversationId]
      || !isStoredIdentifier(event.entityId)
      || !isStoredIdentifier(event.type)
      || !isStoredTimestamp(event.at)
    ) {
      fail("corrupt_task_state", "The durable conversation event order is invalid.")
    }
    storedDigest(event.data, "conversation event data")
    previous = event.seq
  }
  if (state.nextEventSeq !== previous + 1) {
    fail("corrupt_task_state", "The durable conversation cursor does not match its event ledger.")
  }
  for (const task of Object.values(state.tasks)) {
    corrupt(task.status === deriveTaskStatus(state, task), "The durable task status is inconsistent with its evidence.")
    const creationEvents = state.events.filter((event) => (
      event.type === "task.created" && event.entityId === task.id
    ))
    corrupt(
      creationEvents.length === 1
      && creationEvents[0].conversationId === task.conversationId
      && creationEvents[0].data?.settlementContractDigest === task.settlementContractDigest,
      "The durable task creation event is not bound to its settlement contract.",
    )
  }
  return state
}

function requireEntity(collection, id, kind) {
  const entity = collection[id]
  if (!entity) fail(`${kind}_not_found`, `The requested ${kind} does not exist.`, { id })
  return entity
}

function assertNewEntity(collection, id, kind) {
  if (collection[id]) fail(`${kind}_already_exists`, `The requested ${kind} identity already exists.`, { id })
}

function currentArtifact(state, task) {
  if (!task.currentArtifactId) return undefined
  return requireEntity(state.artifacts, task.currentArtifactId, "artifact")
}

function evidenceForCurrentRevision(state, task, kind) {
  return Object.values(state.activities).filter((activity) => (
    activity.taskId === task.id
    && activity.kind === kind
    && activity.status === "succeeded"
    && activity.baseSha === task.currentBaseSha
    && activity.headSha === task.currentHeadSha
  ))
}

function deriveTaskStatus(state, task) {
  if (!task.currentHeadSha) return "awaiting_implementation"
  const currentApproval = Object.values(state.approvals).find((approval) => (
    approval.taskId === task.id
    && approval.status === "current"
    && approval.baseSha === task.currentBaseSha
    && approval.headSha === task.currentHeadSha
  ))
  if (currentApproval) return "ready_to_merge"
  const hasRequiredEvidence = task.requiredEvidenceKinds.every((kind) => (
    evidenceForCurrentRevision(state, task, kind).length > 0
  ))
  if (hasRequiredEvidence) return "waiting_approval"
  if (task.requiredEvidenceKinds.includes("verification") && evidenceForCurrentRevision(
    state,
    task,
    "verification",
  ).length === 0) return "waiting_verification"
  return "waiting_evidence"
}

function taskFor(state, taskId) {
  assertIdentifier(taskId, "taskId")
  return requireEntity(state.tasks, taskId, "task")
}

function conversationForTask(state, task) {
  return requireEntity(state.conversations, task.conversationId, "conversation")
}

function createTransition(state, at) {
  validateTaskState(state)
  assertTimestamp(at)
  const next = clone(state)
  const emitted = []
  const emit = (conversationId, type, entityId, data = {}) => {
    const event = {
      at,
      conversationId,
      data: clone(data),
      entityId,
      seq: next.nextEventSeq,
      type,
    }
    next.nextEventSeq += 1
    next.events.push(event)
    emitted.push(clone(event))
  }
  return { emit, emitted, next }
}

function createConversationAndTask(state, command) {
  const { acceptanceContract, at, conversationId, requiredEvidenceKinds, taskId } = command
  assertIdentifier(conversationId, "conversationId")
  assertIdentifier(taskId, "taskId")
  assertNewEntity(state.conversations, conversationId, "conversation")
  assertNewEntity(state.tasks, taskId, "task")
  assertJson(acceptanceContract, "acceptanceContract")
  if (!acceptanceContract || typeof acceptanceContract !== "object") {
    fail("invalid_task_command", "acceptanceContract must be a JSON object or array.")
  }
  const required = requiredEvidenceKinds ?? ["verification"]
  if (
    !Array.isArray(required)
    || required.length < 1
    || new Set(required).size !== required.length
    || required.some((kind) => !REQUIRED_EVIDENCE_KINDS.has(kind))
  ) {
    fail("invalid_task_command", "requiredEvidenceKinds must contain unique supported activity kinds.")
  }

  const { emit, emitted, next } = createTransition(state, at)
  const contract = clone(acceptanceContract)
  const settlementContract = {
    acceptanceContract: clone(contract),
    requiredEvidenceKinds: [...required],
  }
  const settlementContractDigest = digestTaskValue(settlementContract)
  next.conversations[conversationId] = {
    acceptanceContract: contract,
    acceptanceContractDigest: digestTaskValue(contract),
    createdAt: at,
    id: conversationId,
    taskIds: [taskId],
  }
  next.tasks[taskId] = {
    activityIds: [],
    approvalIds: [],
    artifactIds: [],
    conversationId,
    createdAt: at,
    currentArtifactId: null,
    currentBaseSha: null,
    currentHeadSha: null,
    effectIds: [],
    id: taskId,
    requiredEvidenceKinds: [...required],
    settlementContract,
    settlementContractDigest,
    status: "awaiting_implementation",
    updatedAt: at,
  }
  emit(conversationId, "conversation.created", conversationId, {
    acceptanceContractDigest: next.conversations[conversationId].acceptanceContractDigest,
  })
  emit(conversationId, "task.created", taskId, {
    settlementContractDigest,
  })
  return { emitted, next }
}

function registerRunner(state, command) {
  const { at, capabilities = [], runnerId } = command
  assertIdentifier(runnerId, "runnerId")
  assertNewEntity(state.runners, runnerId, "runner")
  if (
    !Array.isArray(capabilities)
    || capabilities.length < 1
    || capabilities.some((value) => typeof value !== "string" || value.length < 1 || value.length > 100)
  ) {
    fail("invalid_task_command", "A runner must register at least one bounded capability.")
  }
  const { emitted, next } = createTransition(state, at)
  next.runners[runnerId] = {
    capabilities: [...new Set(capabilities)].sort(),
    id: runnerId,
    registeredAt: at,
    status: "available",
  }
  return { emitted, next }
}

function publishPullRequest(state, command) {
  const { artifactId, at, baseSha, headSha, remoteRef, taskId } = command
  assertIdentifier(artifactId, "artifactId")
  assertNewEntity(state.artifacts, artifactId, "artifact")
  assertSha(baseSha, "baseSha")
  assertSha(headSha, "headSha")
  assertJson(remoteRef, "remoteRef")
  const task = taskFor(state, taskId)
  const conversation = conversationForTask(state, task)
  const previousArtifact = currentArtifact(state, task)
  const baseChanged = previousArtifact !== undefined && previousArtifact.baseSha !== baseSha
  const headChanged = previousArtifact !== undefined && previousArtifact.headSha !== headSha
  const revisionChanged = baseChanged || headChanged
  const { emit, emitted, next } = createTransition(state, at)
  const nextTask = next.tasks[taskId]
  const invalidatedActivityIds = []
  const invalidatedApprovalIds = []

  if (revisionChanged) {
    for (const activity of Object.values(next.activities)) {
      if (
        activity.taskId === taskId
        && ["review", "verification"].includes(activity.kind)
        && activity.status !== "stale"
        && (activity.baseSha !== baseSha || activity.headSha !== headSha)
      ) {
        activity.status = "stale"
        activity.staleAt = at
        activity.staleReason = "revision_changed"
        invalidatedActivityIds.push(activity.id)
        for (const lease of Object.values(next.leases)) {
          if (lease.activityId === activity.id && lease.status === "active") {
            lease.status = "stale"
            lease.staleAt = at
          }
        }
      }
    }
    for (const approval of Object.values(next.approvals)) {
      if (
        approval.taskId === taskId
        && approval.status === "current"
        && (approval.baseSha !== baseSha || approval.headSha !== headSha)
      ) {
        approval.status = "stale"
        approval.staleAt = at
        approval.staleReason = "revision_changed"
        invalidatedApprovalIds.push(approval.id)
      }
    }
  }

  next.artifacts[artifactId] = {
    baseSha,
    createdAt: at,
    headSha,
    id: artifactId,
    kind: "pull_request",
    remoteRef: clone(remoteRef),
    revision: previousArtifact ? previousArtifact.revision + 1 : 1,
    supersedesArtifactId: previousArtifact?.id ?? null,
    taskId,
  }
  nextTask.artifactIds.push(artifactId)
  nextTask.currentArtifactId = artifactId
  nextTask.currentBaseSha = baseSha
  nextTask.currentHeadSha = headSha
  nextTask.updatedAt = at
  nextTask.status = deriveTaskStatus(next, nextTask)
  emit(conversation.id, previousArtifact ? "artifact.updated" : "artifact.published", artifactId, {
    baseChanged,
    baseSha,
    headChanged,
    headSha,
    invalidatedActivityIds,
    invalidatedApprovalIds,
    supersedesArtifactId: previousArtifact?.id ?? null,
  })
  return { emitted, next }
}

function leaseVerification(state, command) {
  const {
    activityId,
    at,
    expiresAt,
    leaseId,
    reassign = false,
    runnerId,
    taskId,
  } = command
  assertIdentifier(activityId, "activityId")
  assertIdentifier(leaseId, "leaseId")
  assertIdentifier(runnerId, "runnerId")
  assertTimestamp(expiresAt, "expiresAt")
  if (Date.parse(expiresAt) <= Date.parse(at)) {
    fail("invalid_task_command", "expiresAt must be later than the lease time.")
  }
  const task = taskFor(state, taskId)
  const conversation = conversationForTask(state, task)
  const runner = requireEntity(state.runners, runnerId, "runner")
  if (!runner.capabilities.includes("verification")) {
    fail("runner_capability_missing", "The runner is not registered for verification work.", { runnerId })
  }
  if (typeof reassign !== "boolean") {
    fail("invalid_task_command", "reassign must be a boolean.")
  }
  assertNewEntity(state.leases, leaseId, "lease")
  if (!task.currentHeadSha) fail("artifact_not_found", "Verification cannot be leased before a current artifact exists.")

  const existingActivity = state.activities[activityId]
  if (existingActivity && (
    existingActivity.taskId !== taskId
    || existingActivity.kind !== "verification"
    || existingActivity.headSha !== task.currentHeadSha
    || ["stale", "succeeded"].includes(existingActivity.status)
  )) {
    fail("verification_activity_conflict", "The verification activity cannot be leased for the current head.")
  }
  const activeLease = existingActivity?.leaseIds
    .map((id) => state.leases[id])
    .find((lease) => lease.status === "active")
  if (activeLease && Date.parse(activeLease.expiresAt) > Date.parse(at) && !reassign) {
    fail("verification_lease_active", "The verification activity already has an unexpired lease.", {
      leaseId: activeLease.id,
    })
  }

  const { emit, emitted, next } = createTransition(state, at)
  let activity = next.activities[activityId]
  if (!activity) {
    activity = {
      completedAt: null,
      createdAt: at,
      evidence: null,
      baseSha: task.currentBaseSha,
      headSha: task.currentHeadSha,
      id: activityId,
      kind: "verification",
      lastFencingToken: 0,
      leaseIds: [],
      status: "pending",
      taskId,
      updatedAt: at,
    }
    next.activities[activityId] = activity
    next.tasks[taskId].activityIds.push(activityId)
    emit(conversation.id, "activity.created", activityId, {
      headSha: task.currentHeadSha,
      kind: "verification",
    })
  }
  const previousActive = activity.leaseIds
    .map((id) => next.leases[id])
    .find((lease) => lease.status === "active")
  if (previousActive) {
    previousActive.status = Date.parse(previousActive.expiresAt) <= Date.parse(at)
      ? "expired"
      : "reassigned"
    previousActive.endedAt = at
    emit(conversation.id, `lease.${previousActive.status}`, previousActive.id, {
      activityId,
      fencingToken: previousActive.fencingToken,
    })
  }

  const fencingToken = activity.lastFencingToken + 1
  next.leases[leaseId] = {
    activityId,
    createdAt: at,
    expiresAt,
    fencingToken,
    baseSha: task.currentBaseSha,
    headSha: task.currentHeadSha,
    id: leaseId,
    runnerId,
    status: "active",
    taskId,
  }
  activity.lastFencingToken = fencingToken
  activity.leaseIds.push(leaseId)
  activity.completedAt = null
  activity.evidence = null
  activity.status = "leased"
  activity.updatedAt = at
  emit(conversation.id, "lease.assigned", leaseId, {
    activityId,
    baseSha: task.currentBaseSha,
    expiresAt,
    fencingToken,
    headSha: task.currentHeadSha,
    runnerId,
  })
  return { emitted, next }
}

function completeVerification(state, command) {
  const { at, evidence, fencingToken, leaseId, runnerId, success } = command
  assertIdentifier(leaseId, "leaseId")
  assertIdentifier(runnerId, "runnerId")
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1 || typeof success !== "boolean") {
    fail("invalid_task_command", "A completion needs a positive fencing token and boolean success value.")
  }
  assertJson(evidence, "evidence")
  const lease = requireEntity(state.leases, leaseId, "lease")
  const activity = requireEntity(state.activities, lease.activityId, "activity")
  const task = taskFor(state, lease.taskId)
  const conversation = conversationForTask(state, task)
  if (
    lease.status !== "active"
    || lease.runnerId !== runnerId
    || lease.fencingToken !== fencingToken
    || activity.lastFencingToken !== fencingToken
  ) {
    fail("stale_fencing_token", "The verification completion came from a stale worker lease.", {
      currentFencingToken: activity.lastFencingToken,
      fencingToken,
      leaseStatus: lease.status,
    })
  }
  if (Date.parse(lease.expiresAt) <= Date.parse(at)) {
    fail("verification_lease_expired", "The verification lease expired before completion.")
  }
  if (
    lease.baseSha !== task.currentBaseSha
    || activity.baseSha !== task.currentBaseSha
    || lease.headSha !== task.currentHeadSha
    || activity.headSha !== task.currentHeadSha
  ) {
    fail("stale_revision_evidence", "Verification evidence does not match the task's current revision.")
  }

  const { emit, emitted, next } = createTransition(state, at)
  const nextLease = next.leases[leaseId]
  const nextActivity = next.activities[activity.id]
  const nextTask = next.tasks[task.id]
  nextLease.completedAt = at
  nextLease.status = "completed"
  nextActivity.completedAt = at
  nextActivity.evidence = {
    baseSha: task.currentBaseSha,
    digest: digestTaskValue(evidence),
    headSha: task.currentHeadSha,
    value: clone(evidence),
  }
  nextActivity.status = success ? "succeeded" : "failed"
  nextActivity.updatedAt = at
  nextTask.updatedAt = at
  nextTask.status = deriveTaskStatus(next, nextTask)
  emit(conversation.id, "verification.completed", activity.id, {
    evidenceDigest: nextActivity.evidence.digest,
    fencingToken,
    baseSha: task.currentBaseSha,
    headSha: task.currentHeadSha,
    leaseId,
    success,
  })
  return { emitted, next }
}

function recordReview(state, command) {
  const { activityId, at, baseSha, evidence, headSha, outcome, taskId } = command
  assertIdentifier(activityId, "activityId")
  assertNewEntity(state.activities, activityId, "activity")
  assertSha(baseSha, "baseSha")
  assertSha(headSha, "headSha")
  if (!["accepted", "changes_requested"].includes(outcome)) {
    fail("invalid_task_command", "A review outcome must be accepted or changes_requested.")
  }
  assertJson(evidence, "evidence")
  const task = taskFor(state, taskId)
  const conversation = conversationForTask(state, task)
  if (baseSha !== task.currentBaseSha || headSha !== task.currentHeadSha) {
    fail("stale_revision_evidence", "Review evidence must bind to the exact current base and head.")
  }
  const { emit, emitted, next } = createTransition(state, at)
  next.activities[activityId] = {
    baseSha,
    completedAt: at,
    createdAt: at,
    evidence: {
      baseSha,
      digest: digestTaskValue(evidence),
      headSha,
      value: clone(evidence),
    },
    headSha,
    id: activityId,
    kind: "review",
    lastFencingToken: 0,
    leaseIds: [],
    status: outcome === "accepted" ? "succeeded" : "failed",
    taskId,
    updatedAt: at,
  }
  next.tasks[taskId].activityIds.push(activityId)
  next.tasks[taskId].status = deriveTaskStatus(next, next.tasks[taskId])
  next.tasks[taskId].updatedAt = at
  emit(conversation.id, "review.recorded", activityId, {
    baseSha,
    evidenceDigest: next.activities[activityId].evidence.digest,
    headSha,
    outcome,
  })
  return { emitted, next }
}

function grantApproval(state, command) {
  const { approvalId, approver, at, baseSha, evidenceActivityIds, headSha, taskId } = command
  assertIdentifier(approvalId, "approvalId")
  assertIdentifier(approver, "approver")
  assertNewEntity(state.approvals, approvalId, "approval")
  assertSha(baseSha, "baseSha")
  assertSha(headSha, "headSha")
  if (!Array.isArray(evidenceActivityIds) || new Set(evidenceActivityIds).size !== evidenceActivityIds.length) {
    fail("invalid_task_command", "evidenceActivityIds must be a unique array.")
  }
  const task = taskFor(state, taskId)
  const conversation = conversationForTask(state, task)
  if (baseSha !== task.currentBaseSha || headSha !== task.currentHeadSha) {
    fail("stale_revision_approval", "Approval must bind to the exact current base and head.")
  }
  const evidence = evidenceActivityIds.map((id) => {
    assertIdentifier(id, "evidenceActivityId")
    return requireEntity(state.activities, id, "activity")
  })
  for (const activity of evidence) {
    if (
      activity.taskId !== taskId
      || activity.status !== "succeeded"
      || activity.baseSha !== baseSha
      || activity.headSha !== headSha
      || !activity.evidence?.digest
    ) {
      fail("approval_evidence_invalid", "Approval evidence must be successful and current for the exact head.")
    }
  }
  for (const requiredKind of task.requiredEvidenceKinds) {
    if (!evidence.some((activity) => activity.kind === requiredKind)) {
      fail("approval_evidence_missing", "Approval is missing required current-head evidence.", { requiredKind })
    }
  }

  const { emit, emitted, next } = createTransition(state, at)
  next.approvals[approvalId] = {
    approver,
    baseSha,
    createdAt: at,
    evidenceBindings: evidence.map((activity) => ({
      activityId: activity.id,
      evidenceDigest: activity.evidence.digest,
      kind: activity.kind,
    })),
    headSha,
    id: approvalId,
    status: "current",
    taskId,
  }
  next.tasks[taskId].approvalIds.push(approvalId)
  next.tasks[taskId].status = "ready_to_merge"
  next.tasks[taskId].updatedAt = at
  emit(conversation.id, "approval.granted", approvalId, {
    approver,
    baseSha,
    evidenceActivityIds,
    headSha,
  })
  return { emitted, next }
}

function reserveEffect(state, command) {
  const { adapterId, at, effectId, input, inputDigest, kind, taskId } = command
  assertIdentifier(adapterId, "adapterId")
  assertIdentifier(effectId, "effectId")
  assertIdentifier(kind, "kind")
  assertJson(input, "input")
  if (digestTaskValue(input) !== inputDigest) {
    fail("effect_input_digest_mismatch", "The supplied effect input digest does not match its input.")
  }
  const existing = state.effects[effectId]
  if (existing) {
    if (
      existing.adapterId !== adapterId
      || existing.taskId !== taskId
      || existing.kind !== kind
      || existing.inputDigest !== inputDigest
    ) {
      fail("effect_identity_conflict", "An effect identity cannot be reused with different inputs.", { effectId })
    }
    return { emitted: [], next: state }
  }
  const task = taskFor(state, taskId)
  const conversation = conversationForTask(state, task)
  const { emit, emitted, next } = createTransition(state, at)
  next.effects[effectId] = {
    adapterId,
    attemptCount: 0,
    createdAt: at,
    id: effectId,
    input: clone(input),
    inputDigest,
    kind,
    lastReconciledAt: null,
    reconciliationCount: 0,
    result: null,
    resultDigest: null,
    status: "reserved",
    taskId,
    updatedAt: at,
  }
  next.tasks[taskId].effectIds.push(effectId)
  next.tasks[taskId].updatedAt = at
  emit(conversation.id, "effect.reserved", effectId, { adapterId, inputDigest, kind })
  return { emitted, next }
}

function dispatchEffect(state, command) {
  const { at, effectId } = command
  assertIdentifier(effectId, "effectId")
  const effect = requireEntity(state.effects, effectId, "effect")
  if (effect.status !== "reserved") fail("effect_state_conflict", "Only a reserved effect can begin dispatch.")
  const task = taskFor(state, effect.taskId)
  const conversation = conversationForTask(state, task)
  const { emit, emitted, next } = createTransition(state, at)
  next.effects[effectId].attemptCount += 1
  next.effects[effectId].status = "dispatching"
  next.effects[effectId].updatedAt = at
  emit(conversation.id, "effect.dispatching", effectId, {
    attemptCount: next.effects[effectId].attemptCount,
    inputDigest: effect.inputDigest,
  })
  return { emitted, next }
}

function noteEffectAbsent(state, command) {
  const { at, effectId } = command
  const effect = requireEntity(state.effects, effectId, "effect")
  if (effect.status !== "dispatching") fail("effect_state_conflict", "Only a dispatching effect can be reconciled absent.")
  const task = taskFor(state, effect.taskId)
  const conversation = conversationForTask(state, task)
  const { emit, emitted, next } = createTransition(state, at)
  next.effects[effectId].lastReconciledAt = at
  next.effects[effectId].reconciliationCount += 1
  next.effects[effectId].updatedAt = at
  emit(conversation.id, "effect.reconciled_absent", effectId, { inputDigest: effect.inputDigest })
  return { emitted, next }
}

function recordEffectApplied(state, command) {
  const { at, effectId, result } = command
  assertJson(result, "result")
  const effect = requireEntity(state.effects, effectId, "effect")
  if (effect.status !== "dispatching") fail("effect_state_conflict", "Only a dispatching effect can record an outcome.")
  const task = taskFor(state, effect.taskId)
  const conversation = conversationForTask(state, task)
  const { emit, emitted, next } = createTransition(state, at)
  next.effects[effectId].lastReconciledAt = at
  next.effects[effectId].reconciliationCount += 1
  next.effects[effectId].result = clone(result)
  next.effects[effectId].resultDigest = digestTaskValue(result)
  next.effects[effectId].status = "applied"
  next.effects[effectId].updatedAt = at
  emit(conversation.id, "effect.applied", effectId, {
    inputDigest: effect.inputDigest,
    resultDigest: next.effects[effectId].resultDigest,
  })
  return { emitted, next }
}

function completeEffect(state, command) {
  const { at, effectId } = command
  const effect = requireEntity(state.effects, effectId, "effect")
  if (effect.status !== "applied") fail("effect_state_conflict", "Only an applied effect can be completed.")
  const task = taskFor(state, effect.taskId)
  const conversation = conversationForTask(state, task)
  const { emit, emitted, next } = createTransition(state, at)
  next.effects[effectId].status = "succeeded"
  next.effects[effectId].updatedAt = at
  emit(conversation.id, "effect.succeeded", effectId, {
    inputDigest: effect.inputDigest,
    resultDigest: effect.resultDigest,
  })
  return { emitted, next }
}

export function reduceTaskCommand(state, command) {
  assertRecord(command, "command")
  const normalizedCommand = cloneTaskValue(command)
  assertTimestamp(normalizedCommand.at)
  const handlers = {
    complete_effect: completeEffect,
    complete_verification: completeVerification,
    create_conversation_and_task: createConversationAndTask,
    dispatch_effect: dispatchEffect,
    grant_approval: grantApproval,
    lease_verification: leaseVerification,
    note_effect_absent: noteEffectAbsent,
    publish_pull_request: publishPullRequest,
    record_effect_applied: recordEffectApplied,
    record_review: recordReview,
    register_runner: registerRunner,
    reserve_effect: reserveEffect,
  }
  const handler = handlers[normalizedCommand.type]
  if (!handler) fail("unknown_task_command", "The durable task command type is not supported.")
  const transition = handler(state, normalizedCommand)
  if (transition.next !== state) {
    transition.next.revision = state.revision + 1
    validateTaskState(transition.next)
  }
  return transition
}

export function selectConversation(state, conversationId, cursor = 0) {
  validateTaskState(state)
  assertIdentifier(conversationId, "conversationId")
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    fail("invalid_task_cursor", "The conversation cursor must be a non-negative safe integer.")
  }
  if (cursor >= state.nextEventSeq) {
    fail("invalid_task_cursor", "The conversation cursor cannot be ahead of the durable event ledger.")
  }
  const conversation = requireEntity(state.conversations, conversationId, "conversation")
  const taskIds = new Set(conversation.taskIds)
  const tasks = Object.values(state.tasks).filter((task) => taskIds.has(task.id))
  const activityIds = new Set(tasks.flatMap((task) => task.activityIds))
  const artifactIds = new Set(tasks.flatMap((task) => task.artifactIds))
  const effectIds = new Set(tasks.flatMap((task) => task.effectIds))
  const approvalIds = new Set(tasks.flatMap((task) => task.approvalIds))
  const leases = Object.values(state.leases).filter((lease) => activityIds.has(lease.activityId))
  const events = state.events.filter((event) => event.conversationId === conversationId && event.seq > cursor)
  return clone({
    activities: Object.values(state.activities).filter((activity) => activityIds.has(activity.id)),
    approvals: Object.values(state.approvals).filter((approval) => approvalIds.has(approval.id)),
    artifacts: Object.values(state.artifacts).filter((artifact) => artifactIds.has(artifact.id)),
    conversation,
    cursor: events.at(-1)?.seq ?? cursor,
    effects: Object.values(state.effects).filter((effect) => effectIds.has(effect.id)),
    events,
    leases,
    runners: Object.values(state.runners).filter((runner) => (
      leases.some((lease) => lease.runnerId === runner.id)
    )),
    tasks,
  })
}

export function assertEffectStatus(effect) {
  if (!effect || !EFFECT_STATUSES.has(effect.status)) {
    fail("corrupt_task_state", "The durable effect status is invalid.")
  }
  return effect
}
