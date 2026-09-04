import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  ATTACHMENT_EVIDENCE_RESERVATION_BYTES,
  ATTACHMENT_PERMANENT_RESERVATION_BYTES,
  MAX_ATTACHMENT_EVIDENCE_INTENTS,
  MAX_ATTACHMENT_EVIDENCE_RESERVED_BYTES,
  MAX_ATTACHMENT_PERMANENT_BINDINGS,
  MAX_ATTACHMENT_PERMANENT_RESERVED_BYTES,
  MAX_RESULT_BYTES,
} from "./constants.mjs"
import {
  assertValidAttachmentGraphObservation,
  assertValidSignedAttachmentDispositionEnvelope,
  attachmentCaptureOperationKeyDigest,
  buildAttachmentCaptureOperation,
  buildAttachmentExecutionDisposition,
  buildConfirmedSendIdentity,
  canonicalJsonBytes,
  operationKeyDigest,
  sha256Hex,
} from "./attachment-execution-receipt.mjs"
import { assertValidSignedAttachmentConsumerAcknowledgementEnvelope } from "./attachment-consumer-ack.mjs"
import { EgoChatError } from "./errors.mjs"

const DEFAULT_MAX_BINDINGS = 256
const DEFAULT_MAX_MODEL_POLICIES = 8
const DEFAULT_MAX_OPERATIONS = 10_000
const DEFAULT_MAX_RECOVERY_WORKFLOWS = 256
const DEFAULT_MAX_STATE_BYTES = 64 * 1024 * 1024
const RESULT_RECOVERY_KINDS = new Set(["conversation_adoption", "ego_exchange"])
const ATTACHMENT_ATTEMPT_JOURNAL_KEYS = [
  "attempt_number",
  "attempted_at",
  "candidate_generation",
  "dom_snapshot_sha256",
  "graph_snapshot_sha256",
  "reason",
  "response_snapshot_sha256",
  "schema",
  "state",
].sort()
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const LEGACY_ATTACHMENT_SOURCE_RECORD_KEYS = [
  "attachment_capture",
  "attachment_consumer_acknowledgement",
  "attachment_disposition",
  "attachment_evidence_tombstone",
  "attachment_intent",
  "confirmed_send_event",
  "confirmed_send_identity",
  "external_binding",
].sort()

const EMPTY_STATE = Object.freeze({
  attachmentCapacity: {
    liveIntentCount: 0,
    liveReservedBytes: 0,
    permanentEntryCount: 0,
    permanentReservedBytes: 0,
  },
  attachmentConsumerAcknowledgements: {},
  attachmentExternalBindings: {},
  attachmentCaptures: {},
  attachmentDispositions: {},
  attachmentIntents: {},
  attachmentEvidenceTombstones: {},
  legacyAttachmentEvidence: {},
  confirmedSendEvents: {},
  confirmedSendIdentities: {},
  bindings: {},
  modelPolicies: {},
  nextSeq: 1,
  operations: {},
  schemaVersion: 8,
  workflows: {},
})

function clone(value) {
  return structuredClone(value)
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
}

function hasExactKeys(value, expectedKeys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), expectedKeys)
}

function exactTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function attachmentObservationJournalEntry(
  observation,
  candidateGeneration,
  completedPair,
) {
  const entry = {
    attempt_number: observation.observation_sequence,
    attempted_at: observation.observed_at,
    candidate_generation: candidateGeneration,
    dom_snapshot_sha256: sha256Hex(canonicalJsonBytes({
      artifacts: observation.artifacts.map((artifact) => ({
        artifact_id: artifact.artifact_id,
        dom_wrapper_id: artifact.dom_wrapper_id,
      })),
      normal_download_control_count: observation.normal_download_control_count,
      normal_save_control_count: observation.normal_save_control_count,
      save_association_candidates: observation.save_association_candidates,
    })),
    graph_snapshot_sha256: sha256Hex(canonicalJsonBytes(observation)),
    reason: "OBSERVATION_RECORDED",
    response_snapshot_sha256: sha256Hex(canonicalJsonBytes({
      direct_branch_ids: observation.direct_branch_ids,
      response_message_id: observation.response_message_id,
      selected_branch_id: observation.selected_branch_id,
    })),
    schema: "ego-chat-attachment-capture-attempt/v1",
    state: completedPair ? "PAIR_COMPLETED" : "CANDIDATE",
  }
  if (canonicalJsonBytes(entry).length > 768) {
    throw new EgoChatError(
      "attachment_capture_journal_entry_too_large",
      "The attachment capture journal entry exceeds its fixed bound.",
    )
  }
  return entry
}

function attachmentRecoveryJournalEntry({
  attemptNumber,
  attemptedAt,
  candidateGeneration,
  captureOperationKeySha256,
  reason,
}) {
  const digest = sha256Hex(canonicalJsonBytes({
    attempt_number: attemptNumber,
    attempted_at: attemptedAt,
    capture_operation_key_sha256: captureOperationKeySha256,
    reason,
  }))
  const entry = {
    attempt_number: attemptNumber,
    attempted_at: attemptedAt,
    candidate_generation: candidateGeneration,
    dom_snapshot_sha256: digest,
    graph_snapshot_sha256: digest,
    reason,
    response_snapshot_sha256: digest,
    schema: "ego-chat-attachment-capture-attempt/v1",
    state: "RECOVERABLE",
  }
  if (canonicalJsonBytes(entry).length > 768) {
    throw new EgoChatError(
      "attachment_capture_journal_entry_too_large",
      "The attachment capture journal entry exceeds its fixed bound.",
    )
  }
  return entry
}

function isUtf8ContinuationByte(value) {
  return (value & 0b1100_0000) === 0b1000_0000
}

function hasProtectedRecoveryState(workflow) {
  return workflow.status === "human_required"
    || workflow.status === "running"
    || (workflow.status === "failed" && RESULT_RECOVERY_KINDS.has(workflow.kind))
}

function needsResultReservation(workflow) {
  return hasProtectedRecoveryState(workflow)
    && RESULT_RECOVERY_KINDS.has(workflow.kind)
    && !workflow.result?.responseRef
    && typeof workflow.result?.responseText !== "string"
}

async function assertPrivateDirectory(directory) {
  const stat = await fs.stat(directory)
  if (!stat.isDirectory()) {
    throw new EgoChatError("unsafe_data_dir", "The configured data path is not a directory.")
  }

  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError("unsafe_data_dir", "The configured data directory is owned by another user.")
  }

  if ((stat.mode & 0o077) !== 0) {
    throw new EgoChatError(
      "unsafe_data_dir",
      "The configured data directory is accessible to another user or group; set its mode to 0700.",
    )
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700, recursive: true })
  await assertPrivateDirectory(directory)
}

async function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  await fs.rename(temporaryPath, filePath)
  const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

async function writeAtomicText(filePath, value) {
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporaryPath, filePath)
  const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

function validateCheckpoint(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Number.isSafeInteger(value.nextSeq)
    || value.nextSeq < 1
    || !value.workflows
    || !value.bindings
    || !value.modelPolicies
    || ![3, 4, 5, 6, 7, 8].includes(value.schemaVersion)
  ) {
    throw new EgoChatError("corrupt_checkpoint", "The durable state checkpoint is invalid.")
  }
}

function quarantineLegacyAttachmentEvidence(state, sourceSchemaVersion) {
  const ledgers = [
    "attachmentConsumerAcknowledgements",
    "attachmentCaptures",
    "attachmentDispositions",
    "attachmentEvidenceTombstones",
    "attachmentIntents",
    "confirmedSendEvents",
    "confirmedSendIdentities",
  ]
  const workflowIds = new Set(ledgers.flatMap((ledger) => (
    sourceSchemaVersion < 8
      ? Object.keys(state[ledger] ?? {})
      : Object.keys(state[ledger] ?? {}).filter(
          (workflowId) => state.legacyAttachmentEvidence[workflowId],
        )
  )))
  const externalBindingsByWorkflow = new Map()
  for (const [ledgerKey, binding] of Object.entries(
    state.attachmentExternalBindings,
  )) {
    const workflowId = binding?.source_workflow_id
    const expectedLedgerKey = `${binding?.profile}:${binding?.external_binding_sha256}`
    if (
      typeof workflowId !== "string"
      || !workflowId
      || binding.ledger_key !== ledgerKey
      || expectedLedgerKey !== ledgerKey
      || externalBindingsByWorkflow.has(workflowId)
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "A legacy attachment external binding has an inconsistent workflow association.",
      )
    }
    externalBindingsByWorkflow.set(workflowId, binding)
    if (
      sourceSchemaVersion < 8
      || binding.state === "CONSUMED_LEGACY_RECOVERY_REQUIRED"
      || state.legacyAttachmentEvidence[workflowId]
    ) {
      workflowIds.add(workflowId)
    }
  }
  for (const workflowId of workflowIds) {
    const intent = state.attachmentIntents[workflowId]
    const bindingKey = intent
      ? `${intent.profile}:${intent.external_binding_sha256}`
      : null
    const externalBinding = externalBindingsByWorkflow.get(workflowId) ?? null
    if (
      (intent && !externalBinding)
      || (intent && externalBinding.ledger_key !== bindingKey)
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "Legacy attachment intent and external binding associations disagree.",
      )
    }
    const sourceRecords = {
      attachment_consumer_acknowledgement:
        state.attachmentConsumerAcknowledgements[workflowId] ?? null,
      attachment_capture: state.attachmentCaptures[workflowId] ?? null,
      attachment_disposition: state.attachmentDispositions[workflowId] ?? null,
      attachment_evidence_tombstone:
        state.attachmentEvidenceTombstones[workflowId] ?? null,
      attachment_intent: intent ?? null,
      confirmed_send_event: state.confirmedSendEvents[workflowId] ?? null,
      confirmed_send_identity: state.confirmedSendIdentities[workflowId] ?? null,
      external_binding: externalBinding,
    }
    const existing = state.legacyAttachmentEvidence[workflowId]
    const mergedRecords = Object.fromEntries(
      LEGACY_ATTACHMENT_SOURCE_RECORD_KEYS.map((key) => {
        const prior = existing?.source_records?.[key] ?? null
        const incoming = sourceRecords[key]
        if (prior && incoming && !isDeepStrictEqual(prior, incoming)) {
          throw new EgoChatError(
            "corrupt_attachment_evidence_state",
            "Legacy attachment evidence replay conflicts with its immutable quarantine.",
          )
        }
        return [key, prior ?? incoming]
      }),
    )
    state.legacyAttachmentEvidence[workflowId] = {
      reason: "LEGACY_CONTRACT_RECOVERY_ONLY",
      schema: "ego-chat-legacy-attachment-evidence-quarantine/v1",
      source_records: mergedRecords,
      source_records_sha256: sha256Hex(canonicalJsonBytes(mergedRecords)),
      source_schema_version: Math.min(
        sourceSchemaVersion,
        existing?.source_schema_version ?? sourceSchemaVersion,
      ),
      source_workflow_id: workflowId,
    }
    for (const ledger of ledgers) delete state[ledger][workflowId]
    if (externalBinding) {
      state.attachmentExternalBindings[externalBinding.ledger_key] = {
        ...externalBinding,
        state: "CONSUMED_LEGACY_RECOVERY_REQUIRED",
      }
    }
    const workflow = state.workflows[workflowId]
    if (workflow) {
      state.workflows[workflowId] = {
        ...workflow,
        humanRequired: true,
        phase: "attachment_legacy_recovery_required",
        result: {
          reason: "LEGACY_CONTRACT_RECOVERY_ONLY",
          sourceRecordsSha256: state.legacyAttachmentEvidence[workflowId]
            .source_records_sha256,
        },
        status: "failed",
      }
    }
  }
  state.attachmentCapacity = {
    liveIntentCount: Object.keys(state.attachmentIntents).filter(
      (workflowId) => !state.attachmentEvidenceTombstones[workflowId],
    ).length,
    liveReservedBytes: Object.keys(state.attachmentIntents).filter(
      (workflowId) => !state.attachmentEvidenceTombstones[workflowId],
    ).length * ATTACHMENT_EVIDENCE_RESERVATION_BYTES,
    permanentEntryCount: Object.keys(state.attachmentExternalBindings).length,
    permanentReservedBytes: Object.keys(state.attachmentExternalBindings).length
      * ATTACHMENT_PERMANENT_RESERVATION_BYTES,
  }
}

function hasLegacyAttachmentEvidenceShape(state) {
  return Object.values(state.attachmentIntents ?? {}).some(
    (intent) => !exactTimestamp(intent?.send_resolution_deadline_at),
  ) || Object.values(state.attachmentCaptures ?? {}).some((capture) => (
    !Array.isArray(capture?.attempt_journal)
    || capture.attempt_journal.some(
      (entry) => !hasExactKeys(entry, ATTACHMENT_ATTEMPT_JOURNAL_KEYS),
    )
    || !Array.isArray(capture?.candidate_observations)
    || capture.candidate_observations.some(
      (observation) => !Object.hasOwn(observation, "save_association_candidates"),
    )
  )) || [
    "attachmentConsumerAcknowledgements",
    "attachmentCaptures",
    "attachmentDispositions",
    "attachmentEvidenceTombstones",
    "attachmentIntents",
    "confirmedSendEvents",
    "confirmedSendIdentities",
  ].some((ledger) => Object.keys(state[ledger] ?? {}).some(
    (workflowId) => state.legacyAttachmentEvidence?.[workflowId],
  ))
}

function normalizeStateForReplay(value) {
  validateCheckpoint(value)
  const state = clone(value)
  state.attachmentCapacity ??= clone(EMPTY_STATE.attachmentCapacity)
  state.attachmentConsumerAcknowledgements ??= {}
  state.attachmentExternalBindings ??= {}
  state.attachmentCaptures ??= {}
  state.attachmentDispositions ??= {}
  state.attachmentIntents ??= {}
  state.attachmentEvidenceTombstones ??= {}
  state.legacyAttachmentEvidence ??= {}
  state.confirmedSendEvents ??= {}
  state.confirmedSendIdentities ??= {}
  state.operations ??= {}
  return state
}

function migrateState(value) {
  const state = normalizeStateForReplay(value)
  const sourceSchemaVersion = state.schemaVersion
  if (sourceSchemaVersion < 8 || hasLegacyAttachmentEvidenceShape(state)) {
    quarantineLegacyAttachmentEvidence(
      state,
      Math.min(sourceSchemaVersion, 7),
    )
  }
  for (const capture of Object.values(state.attachmentCaptures)) {
    capture.candidate_generation ??= 0
    capture.candidate_observations ??= []
    capture.candidate_pair_count ??= 0
    capture.terminal_disposition_sha256 ??= null
    capture.terminal_envelope_sha256 ??= null
  }

  for (const [workflowId, persistedWorkflow] of Object.entries(state.workflows)) {
    const workflow = preserveConvergenceLivenessCheckpoint(persistedWorkflow)
    state.workflows[workflowId] = workflow
    if (
      workflow.kind === "ego_exchange"
      && typeof workflow.operationKey !== "string"
      && typeof workflow.bindingKey === "string"
      && typeof workflow.reconciliation?.turnMarker === "string"
    ) {
      workflow.operationKey = `exchange:${workflow.bindingKey}:${workflow.reconciliation.turnMarker}`
    }
    if (typeof workflow.operationKey !== "string" || typeof workflow.inputDigest !== "string") {
      continue
    }
    const existing = state.operations[workflow.operationKey]
    if (
      existing
      && (
        existing.inputDigest !== workflow.inputDigest
        || existing.workflowId !== workflow.id
      )
    ) {
      throw new EgoChatError(
        "corrupt_operation_ledger",
        "The durable operation ledger contains conflicting at-most-once identities.",
      )
    }
    state.operations[workflow.operationKey] = existing ?? {
      createdAt: workflow.createdAt,
      inputDigest: workflow.inputDigest,
      key: workflow.operationKey,
      workflowId: workflow.id,
    }
  }

  state.schemaVersion = 8
  validateAttachmentEvidenceState(state)
  return state
}

function preserveConvergenceLivenessCheckpoint(workflow, previousWorkflow = undefined) {
  if (workflow?.kind !== "convergence") {
    return workflow
  }
  const recordedCycle = workflow.private?.cycles?.findLast(
    (cycle) => cycle?.livenessCheckpoint,
  )
  const checkpoint = recordedCycle
    ? {
        ...recordedCycle.livenessCheckpoint,
        cycle: recordedCycle.cycle,
      }
    : workflow.lastCodexLivenessCheckpoint
      ?? previousWorkflow?.lastCodexLivenessCheckpoint
  return checkpoint
    ? { ...workflow, lastCodexLivenessCheckpoint: checkpoint }
    : workflow
}

function validateAttachmentEvidenceState(state) {
  const capacity = state.attachmentCapacity
  const captures = state.attachmentCaptures
  const acknowledgements = state.attachmentConsumerAcknowledgements
  const dispositions = state.attachmentDispositions
  const intents = state.attachmentIntents
  const tombstones = state.attachmentEvidenceTombstones
  const bindings = state.attachmentExternalBindings
  const confirmedEvents = state.confirmedSendEvents
  const confirmedIdentities = state.confirmedSendIdentities
  const legacyEvidence = state.legacyAttachmentEvidence
  if (
    !capacity
    || typeof capacity !== "object"
    || Array.isArray(capacity)
    || !intents
    || typeof intents !== "object"
    || Array.isArray(intents)
    || !acknowledgements
    || typeof acknowledgements !== "object"
    || Array.isArray(acknowledgements)
    || !tombstones
    || typeof tombstones !== "object"
    || Array.isArray(tombstones)
    || !captures
    || typeof captures !== "object"
    || Array.isArray(captures)
    || !dispositions
    || typeof dispositions !== "object"
    || Array.isArray(dispositions)
    || !bindings
    || typeof bindings !== "object"
    || Array.isArray(bindings)
    || !confirmedEvents
    || typeof confirmedEvents !== "object"
    || Array.isArray(confirmedEvents)
    || !confirmedIdentities
    || typeof confirmedIdentities !== "object"
    || Array.isArray(confirmedIdentities)
    || !legacyEvidence
    || typeof legacyEvidence !== "object"
    || Array.isArray(legacyEvidence)
  ) {
    throw new EgoChatError(
      "corrupt_attachment_evidence_state",
      "The attachment evidence ledger has an invalid durable shape.",
    )
  }
  for (const [workflowId, quarantine] of Object.entries(legacyEvidence)) {
    const records = quarantine?.source_records
    const intent = records?.attachment_intent
    const sourceBinding = records?.external_binding
    const bindingKey = sourceBinding?.ledger_key ?? (intent
      ? `${intent.profile}:${intent.external_binding_sha256}`
      : null)
    const binding = bindingKey ? bindings[bindingKey] : null
    const retainedWorkflow = state.workflows[workflowId]
    const bindingOnly = Boolean(sourceBinding) && LEGACY_ATTACHMENT_SOURCE_RECORD_KEYS
      .filter((key) => key !== "external_binding")
      .every((key) => records?.[key] === null)
    if (
      !hasExactKeys(quarantine, [
        "reason",
        "schema",
        "source_records",
        "source_records_sha256",
        "source_schema_version",
        "source_workflow_id",
      ].sort())
      || quarantine.schema !== "ego-chat-legacy-attachment-evidence-quarantine/v1"
      || quarantine.reason !== "LEGACY_CONTRACT_RECOVERY_ONLY"
      || quarantine.source_workflow_id !== workflowId
      || !Number.isSafeInteger(quarantine.source_schema_version)
      || quarantine.source_schema_version < 3
      || quarantine.source_schema_version > 7
      || !records
      || typeof records !== "object"
      || Array.isArray(records)
      || !hasExactKeys(records, LEGACY_ATTACHMENT_SOURCE_RECORD_KEYS)
      || quarantine.source_records_sha256
        !== sha256Hex(canonicalJsonBytes(records))
      || (intent && intent.source_workflow_id !== workflowId)
      || (sourceBinding && sourceBinding.source_workflow_id !== workflowId)
      || (sourceBinding && binding?.source_workflow_id !== workflowId)
      || (sourceBinding && sourceBinding.ledger_key !== bindingKey)
      || (sourceBinding && binding?.state !== "CONSUMED_LEGACY_RECOVERY_REQUIRED")
      || (intent && sourceBinding?.ledger_key
        !== `${intent.profile}:${intent.external_binding_sha256}`)
      || (intent && binding?.state !== "CONSUMED_LEGACY_RECOVERY_REQUIRED")
      || (intent && records.external_binding?.intent_sha256
        !== sha256Hex(canonicalJsonBytes(intent)))
      || (!retainedWorkflow && !bindingOnly)
      || (retainedWorkflow && (
        retainedWorkflow.phase !== "attachment_legacy_recovery_required"
        || retainedWorkflow.status !== "failed"
      ))
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The legacy attachment evidence quarantine is invalid.",
      )
    }
  }
  const expectedCapacity = {
    liveIntentCount: Object.keys(intents).filter((workflowId) => !tombstones[workflowId]).length,
    liveReservedBytes: Object.keys(intents).filter(
      (workflowId) => !tombstones[workflowId],
    ).length * ATTACHMENT_EVIDENCE_RESERVATION_BYTES,
    permanentEntryCount: Object.keys(bindings).length,
    permanentReservedBytes: (
      Object.keys(bindings).length * ATTACHMENT_PERMANENT_RESERVATION_BYTES
    ),
  }
  if (!isDeepStrictEqual(capacity, expectedCapacity)) {
    throw new EgoChatError(
      "corrupt_attachment_evidence_state",
      "The attachment evidence capacity counters do not match the durable ledgers.",
    )
  }
  for (const [workflowId, intent] of Object.entries(intents)) {
    const ledgerKey = `${intent?.profile}:${intent?.external_binding_sha256}`
    const entry = bindings[ledgerKey]
    if (
      intent?.source_workflow_id !== workflowId
      || intent.schema !== "ego-chat-attachment-capture-intent/v1"
      || intent.state !== "RESERVED"
      || intent.live_reservation_bytes !== ATTACHMENT_EVIDENCE_RESERVATION_BYTES
      || intent.permanent_reservation_bytes !== ATTACHMENT_PERMANENT_RESERVATION_BYTES
      || !exactTimestamp(intent.created_at)
      || !exactTimestamp(intent.send_resolution_deadline_at)
      || Date.parse(intent.send_resolution_deadline_at) - Date.parse(intent.created_at)
        !== 10 * 60 * 1_000
      || entry?.source_workflow_id !== workflowId
      || entry.intent_sha256 !== sha256Hex(canonicalJsonBytes(intent))
      || entry.state !== (tombstones[workflowId] ? "CONSUMED_RELEASED" : "RESERVED")
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The attachment evidence intent and permanent binding do not match.",
      )
    }
  }
  if (!isDeepStrictEqual(
    Object.keys(confirmedEvents).sort(),
    Object.keys(confirmedIdentities).sort(),
  )) {
    throw new EgoChatError(
      "corrupt_attachment_evidence_state",
      "The confirmed Send event and identity ledgers do not have the same entries.",
    )
  }
  for (const [workflowId, identity] of Object.entries(confirmedIdentities)) {
    const event = confirmedEvents[workflowId]
    const eventProjection = event && {
      event_type: event.event_type,
      operation_key_sha256: event.operation_key_sha256,
      prompt_message_id: event.prompt_message_id,
      schema: event.schema,
      sent_at: event.sent_at,
      sequence: event.sequence,
      workflow_id: event.workflow_id,
    }
    if (
      identity?.source_workflow_id !== workflowId
      || identity.schema !== "ego-chat-confirmed-send-identity/v1"
      || identity.capture_intent_sha256 !== sha256Hex(canonicalJsonBytes(intents[workflowId]))
      || event?.workflow_id !== workflowId
      || event.confirmed_send_identity_sha256 !== sha256Hex(canonicalJsonBytes(identity))
      || identity.send_event_sha256 !== sha256Hex(canonicalJsonBytes(eventProjection))
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The confirmed Send identity and event do not match.",
      )
    }
  }
  for (const [workflowId, capture] of Object.entries(captures)) {
    const identity = confirmedIdentities[workflowId]
    const identityDigest = identity && sha256Hex(canonicalJsonBytes(identity))
    const expectedOperationKeyDigest = identityDigest
      ? attachmentCaptureOperationKeyDigest(identityDigest)
      : undefined
    const candidateObservations = capture?.candidate_observations
    const attemptJournal = capture?.attempt_journal
    const journalValid = Array.isArray(attemptJournal)
      && attemptJournal.length <= 32
      && canonicalJsonBytes(attemptJournal).length <= 32 * 1024
      && attemptJournal.every((entry, index) => (
        hasExactKeys(entry, ATTACHMENT_ATTEMPT_JOURNAL_KEYS)
        && entry.schema === "ego-chat-attachment-capture-attempt/v1"
        && (
          ["CANDIDATE", "PAIR_COMPLETED"].includes(entry.state)
            ? entry.reason === "OBSERVATION_RECORDED"
            : entry.state === "RECOVERABLE"
              && ["BROKER_RESTART", "DRIVER_RECOVERY"].includes(entry.reason)
        )
        && entry.attempt_number === index + 1
        && Number.isSafeInteger(entry.candidate_generation)
        && entry.candidate_generation === index + 1
        && exactTimestamp(entry.attempted_at)
        && SHA256_PATTERN.test(entry.dom_snapshot_sha256)
        && SHA256_PATTERN.test(entry.graph_snapshot_sha256)
        && SHA256_PATTERN.test(entry.response_snapshot_sha256)
        && canonicalJsonBytes(entry).length <= 768
      ))
    const candidatesValid = Array.isArray(candidateObservations)
      && Array.isArray(attemptJournal)
      && candidateObservations.length <= 2
      && candidateObservations.every((observation) => {
        try {
          assertValidAttachmentGraphObservation(observation)
        } catch {
          return false
        }
        return observation.source_confirmed_send_identity_sha256 === identityDigest
          && observation.capture_operation_key_sha256 === expectedOperationKeyDigest
          && attemptJournal.some((entry) => (
            entry.attempt_number === observation.observation_sequence
            && entry.reason === "OBSERVATION_RECORDED"
            && entry.graph_snapshot_sha256
              === sha256Hex(canonicalJsonBytes(observation))
          ))
      })
    const terminalEnvelope = dispositions[workflowId]
    let terminalDispositionValid = false
    if (terminalEnvelope) {
      try {
        const { disposition } = assertValidSignedAttachmentDispositionEnvelope(
          terminalEnvelope,
        )
        const expectedDisposition = buildAttachmentExecutionDisposition({
          captureOperation: capture,
          confirmedSendIdentity: identity,
          confirmedSendIdentityDigest: identityDigest,
          observations: candidateObservations,
          terminalReason: [
            "CAPTURE_ATTEMPT_LIMIT",
            "CAPTURE_DEADLINE_EXPIRED",
          ].includes(disposition.reason) ? disposition.reason : undefined,
          terminalAt: disposition.terminal_at,
        })
        terminalDispositionValid = isDeepStrictEqual(disposition, expectedDisposition)
          && capture.terminal_disposition_sha256 === terminalEnvelope.payload_sha256
          && capture.terminal_envelope_sha256
            === sha256Hex(canonicalJsonBytes(terminalEnvelope))
      } catch {
        terminalDispositionValid = false
      }
    }
    if (
      capture?.source_workflow_id !== workflowId
      || capture.schema !== "ego-chat-attachment-capture-operation/v1"
      || !["CAPTURING", "TERMINAL"].includes(capture.state)
      || capture.confirmed_send_identity_sha256 !== identityDigest
      || capture.capture_operation_key_sha256
        !== expectedOperationKeyDigest
      || !Number.isFinite(Date.parse(capture.capture_started_at))
      || Date.parse(capture.capture_deadline_at) - Date.parse(capture.capture_started_at)
        !== 10 * 60 * 1_000
      || !Number.isSafeInteger(capture.accumulated_monotonic_ms)
      || capture.accumulated_monotonic_ms < 0
      || capture.accumulated_monotonic_ms > 10 * 60 * 1_000
      || !journalValid
      || !candidatesValid
      || capture.candidate_generation !== attemptJournal.length
      || !Number.isSafeInteger(capture.candidate_pair_count)
      || capture.candidate_pair_count < 0
      || capture.candidate_pair_count > 8
      || capture.candidate_pair_count !== attemptJournal.filter(
        (entry) => entry.state === "PAIR_COMPLETED",
      ).length
      || (
        capture.state === "CAPTURING"
        && (
          terminalEnvelope !== undefined
          || capture.terminal_disposition_sha256 !== null
          || capture.terminal_envelope_sha256 !== null
        )
      )
      || (capture.state === "TERMINAL" && !terminalDispositionValid)
      || (
        capture.state === "TERMINAL"
        && (
          ![
            "attachment_disposition_terminal",
            "attachment_evidence_released",
          ].includes(state.workflows[workflowId]?.phase)
          || state.workflows[workflowId]?.status !== "succeeded"
          || state.workflows[workflowId]?.result?.attachmentDispositionEnvelopeSha256
            !== capture.terminal_envelope_sha256
          || state.workflows[workflowId]?.result?.attachmentDispositionPayloadSha256
            !== capture.terminal_disposition_sha256
        )
      )
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The attachment capture operation does not match its confirmed Send identity.",
      )
    }
  }
  if (Object.keys(dispositions).some((workflowId) => !captures[workflowId])) {
    throw new EgoChatError(
      "corrupt_attachment_evidence_state",
      "A terminal attachment disposition has no capture operation.",
    )
  }
  if (!isDeepStrictEqual(
    Object.keys(acknowledgements).sort(),
    Object.keys(tombstones).sort(),
  )) {
    throw new EgoChatError(
      "corrupt_attachment_evidence_state",
      "The attachment consumer acknowledgement and tombstone ledgers differ.",
    )
  }
  for (const [workflowId, envelope] of Object.entries(acknowledgements)) {
    let acknowledgement
    try {
      acknowledgement = assertValidSignedAttachmentConsumerAcknowledgementEnvelope(
        envelope,
      ).acknowledgement
    } catch {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The attachment consumer acknowledgement ledger is invalid.",
      )
    }
    const identity = confirmedIdentities[workflowId]
    const dispositionEnvelope = dispositions[workflowId]
    const disposition = dispositionEnvelope
      && assertValidSignedAttachmentDispositionEnvelope(dispositionEnvelope).disposition
    const intent = intents[workflowId]
    const tombstone = tombstones[workflowId]
    const externalBinding = intent && bindings[`${intent.profile}:${intent.external_binding_sha256}`]
    const acknowledgementEnvelopeDigest = sha256Hex(canonicalJsonBytes(envelope))
    if (
      !intent
      || !identity
      || !dispositionEnvelope
      || externalBinding?.state !== "CONSUMED_RELEASED"
      || acknowledgement.confirmed_send_identity_sha256
        !== sha256Hex(canonicalJsonBytes(identity))
      || acknowledgement.disposition_envelope_sha256
        !== sha256Hex(canonicalJsonBytes(dispositionEnvelope))
      || acknowledgement.terminal_evidence_digest !== dispositionEnvelope.payload_sha256
      || acknowledgement.external_binding_sha256 !== intent.external_binding_sha256
      || acknowledgement.terminal_outcome !== disposition.outcome
      || !tombstone
      || tombstone.schema !== "ego-chat-attachment-evidence-tombstone/v1"
      || tombstone.source_workflow_id !== workflowId
      || tombstone.profile !== intent.profile
      || tombstone.external_binding_sha256 !== intent.external_binding_sha256
      || tombstone.acknowledgement_envelope_sha256 !== acknowledgementEnvelopeDigest
      || tombstone.disposition_envelope_sha256
        !== acknowledgement.disposition_envelope_sha256
      || tombstone.terminal_evidence_digest !== acknowledgement.terminal_evidence_digest
      || tombstone.terminal_outcome !== acknowledgement.terminal_outcome
      || tombstone.consumer_state !== acknowledgement.consumer_state
      || externalBinding.acknowledgement_envelope_sha256 !== acknowledgementEnvelopeDigest
      || externalBinding.tombstone_sha256 !== sha256Hex(canonicalJsonBytes(tombstone))
      || state.workflows[workflowId]?.phase !== "attachment_evidence_released"
    ) {
      throw new EgoChatError(
        "corrupt_attachment_evidence_state",
        "The released attachment evidence does not match its terminal chain.",
      )
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function assertPrivateBlobDirectory(stat, label) {
  if (
    !stat.isDirectory()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o700
  ) {
    throw new EgoChatError(
      "corrupt_result_blob_inventory",
      `The ${label} is not a private current-owner directory.`,
    )
  }
}

function assertPrivateBlobFile(stat) {
  if (
    !stat.isFile()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new EgoChatError(
      "corrupt_result_blob_inventory",
      "A result blob is not a private current-owner regular single-link file.",
    )
  }
}

function applyEvent(state, event, { validateAttachmentEvidence = true } = {}) {
  if (
    !event
    || event.schemaVersion !== 1
    || !Number.isSafeInteger(event.seq)
    || typeof event.type !== "string"
  ) {
    throw new EgoChatError("corrupt_event_log", "The event ledger contains an invalid record.")
  }

  if (event.seq !== state.nextSeq) {
    throw new EgoChatError("corrupt_event_log", "The event ledger sequence is not contiguous.")
  }

  if (event.workflow && typeof event.workflow.id === "string") {
    state.workflows[event.workflow.id] = preserveConvergenceLivenessCheckpoint(
      event.workflow,
      state.workflows[event.workflow.id],
    )
    if (event.operation && typeof event.operation.key === "string") {
      state.operations[event.operation.key] = event.operation
    }
    if (event.attachmentIntent && typeof event.attachmentIntent.source_workflow_id === "string") {
      state.attachmentIntents[event.attachmentIntent.source_workflow_id] = event.attachmentIntent
    }
    if (
      event.attachmentConsumerAcknowledgement
      && typeof event.attachmentConsumerAcknowledgement.source_workflow_id === "string"
      && event.attachmentConsumerAcknowledgement.envelope
    ) {
      state.attachmentConsumerAcknowledgements[
        event.attachmentConsumerAcknowledgement.source_workflow_id
      ] = event.attachmentConsumerAcknowledgement.envelope
    }
    if (
      event.attachmentEvidenceTombstone
      && typeof event.attachmentEvidenceTombstone.source_workflow_id === "string"
    ) {
      state.attachmentEvidenceTombstones[event.attachmentEvidenceTombstone.source_workflow_id]
        = event.attachmentEvidenceTombstone
    }
    if (
      event.attachmentCapture
      && typeof event.attachmentCapture.source_workflow_id === "string"
    ) {
      state.attachmentCaptures[event.attachmentCapture.source_workflow_id]
        = event.attachmentCapture
    }
    if (
      event.attachmentDisposition
      && typeof event.attachmentDisposition.source_workflow_id === "string"
      && event.attachmentDisposition.envelope
    ) {
      state.attachmentDispositions[event.attachmentDisposition.source_workflow_id]
        = event.attachmentDisposition.envelope
    }
    if (
      event.attachmentExternalBinding
      && typeof event.attachmentExternalBinding.ledger_key === "string"
    ) {
      state.attachmentExternalBindings[event.attachmentExternalBinding.ledger_key]
        = event.attachmentExternalBinding
    }
    if (event.attachmentCapacity) {
      state.attachmentCapacity = event.attachmentCapacity
    }
    if (
      event.confirmedSendIdentity
      && typeof event.confirmedSendIdentity.source_workflow_id === "string"
    ) {
      state.confirmedSendIdentities[event.confirmedSendIdentity.source_workflow_id]
        = event.confirmedSendIdentity
    }
    if (event.confirmedSendEvent && typeof event.confirmedSendEvent.workflow_id === "string") {
      state.confirmedSendEvents[event.confirmedSendEvent.workflow_id] = event.confirmedSendEvent
    }
  } else if (event.binding && typeof event.binding.key === "string") {
    state.bindings[event.binding.key] = event.binding
  } else if (event.modelPolicy && typeof event.modelPolicy.key === "string") {
    state.modelPolicies[event.modelPolicy.key] = event.modelPolicy
  } else {
    throw new EgoChatError("corrupt_event_log", "The event ledger contains an invalid record.")
  }
  if (validateAttachmentEvidence) validateAttachmentEvidenceState(state)
  state.nextSeq += 1
}

export class EventStore {
  #blobDirectory
  #blobBytes = 0
  #checkpointManifestPath
  #checkpointPath
  #compactionFaultInjector
  #dataDir
  #eventBytes = 0
  #eventsSinceCheckpoint = 0
  #eventsPath
  #maxBlobBytes
  #maxAttachmentIntents
  #maxAttachmentLiveBytes
  #maxAttachmentPermanentBindings
  #maxAttachmentPermanentBytes
  #maxBindings
  #maxEventBytes
  #maxEvents
  #maxModelPolicies
  #maxOperations
  #maxRecoveryWorkflows
  #maxResultBytes
  #maxStateBytes
  #maxTerminalWorkflows
  #rawRetentionMs
  #state = clone(EMPTY_STATE)
  #statePath
  #tail = Promise.resolve()

  constructor(dataDir, options = {}) {
    this.#dataDir = dataDir
    this.#blobDirectory = path.join(dataDir, "blobs", "sha256")
    this.#checkpointPath = path.join(dataDir, "checkpoint.json")
    this.#checkpointManifestPath = path.join(dataDir, "checkpoint.manifest.json")
    this.#compactionFaultInjector = options.compactionFaultInjector ?? null
    this.#eventsPath = path.join(dataDir, "events.jsonl")
    this.#maxBlobBytes = options.maxBlobBytes ?? 256 * 1024 * 1024
    this.#maxAttachmentIntents = options.maxAttachmentIntents
      ?? MAX_ATTACHMENT_EVIDENCE_INTENTS
    this.#maxAttachmentLiveBytes = options.maxAttachmentLiveBytes
      ?? MAX_ATTACHMENT_EVIDENCE_RESERVED_BYTES
    this.#maxAttachmentPermanentBindings = options.maxAttachmentPermanentBindings
      ?? MAX_ATTACHMENT_PERMANENT_BINDINGS
    this.#maxAttachmentPermanentBytes = options.maxAttachmentPermanentBytes
      ?? MAX_ATTACHMENT_PERMANENT_RESERVED_BYTES
    this.#maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS
    this.#maxEventBytes = options.maxEventBytes ?? 8 * 1024 * 1024
    this.#maxEvents = options.maxEvents ?? 5_000
    this.#maxModelPolicies = options.maxModelPolicies ?? DEFAULT_MAX_MODEL_POLICIES
    this.#maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS
    this.#maxRecoveryWorkflows = options.maxRecoveryWorkflows ?? DEFAULT_MAX_RECOVERY_WORKFLOWS
    this.#maxResultBytes = options.maxResultBytes ?? MAX_RESULT_BYTES
    this.#maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES
    this.#maxTerminalWorkflows = options.maxTerminalWorkflows ?? 500
    this.#rawRetentionMs = options.rawRetentionMs ?? 30 * 24 * 60 * 60 * 1_000
    this.#statePath = path.join(dataDir, "state.json")
  }

  get dataDir() {
    return this.#dataDir
  }

  getMetrics() {
    const capacity = this.#recoveryCapacity()
    return {
      bindingCount: Object.keys(this.#state.bindings).length,
      attachmentIntentCount: this.#state.attachmentCapacity.liveIntentCount,
      attachmentReservedBytes: this.#state.attachmentCapacity.liveReservedBytes,
      attachmentPermanentEntryCount: this.#state.attachmentCapacity.permanentEntryCount,
      attachmentPermanentReservedBytes: (
        this.#state.attachmentCapacity.permanentReservedBytes
      ),
      blobBytes: this.#blobBytes,
      checkpointNextSeq: this.#state.nextSeq,
      eventBytes: this.#eventBytes,
      eventsSinceCheckpoint: this.#eventsSinceCheckpoint,
      modelPolicyCount: Object.keys(this.#state.modelPolicies).length,
      nextSeq: this.#state.nextSeq,
      operationCount: Object.keys(this.#state.operations).length,
      operationLimit: this.#maxOperations,
      operationSlotsRemaining: Math.max(
        0,
        this.#maxOperations - Object.keys(this.#state.operations).length,
      ),
      protectedBlobBytes: capacity.protectedBlobBytes,
      recoveryWorkflowCount: capacity.recoveryWorkflowCount,
      recoveryWorkflowLimit: this.#maxRecoveryWorkflows,
      reservedBlobBytes: capacity.reservedBlobBytes,
      stateBytes: Buffer.byteLength(JSON.stringify(this.#state), "utf8"),
      stateByteLimit: this.#maxStateBytes,
      workflowCount: Object.keys(this.#state.workflows).length,
    }
  }

  async initialize() {
    const operation = this.#tail.then(() => this.#initialize())
    this.#tail = operation.catch(() => {})
    return operation
  }

  async #initialize() {
    await ensurePrivateDirectory(this.#dataDir)
    this.#state = clone(EMPTY_STATE)
    this.#blobBytes = 0
    this.#eventBytes = 0
    this.#eventsSinceCheckpoint = 0

    let durableRepairRequired = false
    let legacyReplay = false
    try {
      const [checkpointText, manifestText] = await Promise.all([
        fs.readFile(this.#checkpointPath, "utf8"),
        fs.readFile(this.#checkpointManifestPath, "utf8"),
      ])
      const checkpoint = JSON.parse(checkpointText)
      const manifest = JSON.parse(manifestText)
      validateCheckpoint(checkpoint)
      if (
        manifest?.digest !== digestJson(checkpoint)
        || manifest?.nextSeq !== checkpoint.nextSeq
      ) {
        throw new EgoChatError("corrupt_checkpoint", "The durable state checkpoint digest does not match its manifest.")
      }
      this.#state = normalizeStateForReplay(checkpoint)
      legacyReplay = this.#state.schemaVersion < 8
        || hasLegacyAttachmentEvidenceShape(this.#state)
    } catch (error) {
      const checkpointMissing = error.code === "ENOENT"
      const checkpointError = error instanceof SyntaxError
        ? new EgoChatError("corrupt_checkpoint", "The durable state checkpoint contains invalid JSON.")
        : error
      if (
        !checkpointMissing
        && (!(checkpointError instanceof EgoChatError) || checkpointError.code !== "corrupt_checkpoint")
      ) {
        throw checkpointError
      }
      try {
        this.#state = normalizeStateForReplay(
          JSON.parse(await fs.readFile(this.#statePath, "utf8")),
        )
        durableRepairRequired = true
        legacyReplay = this.#state.schemaVersion < 8
          || hasLegacyAttachmentEvidenceShape(this.#state)
      } catch (_recoveryError) {
        if (!checkpointMissing) {
          throw checkpointError
        }
      }
    }

    let ledger
    try {
      ledger = await fs.readFile(this.#eventsPath, "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
      ledger = ""
    }

    let skippedEventPrefix = false
    const lines = ledger.split("\n")
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.length === 0) {
        continue
      }

      try {
        const event = JSON.parse(line)
        if (event.seq < this.#state.nextSeq) {
          skippedEventPrefix = true
          continue
        }
        applyEvent(this.#state, event, {
          validateAttachmentEvidence: !legacyReplay,
        })
        this.#eventsSinceCheckpoint += 1
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new EgoChatError("corrupt_event_log", `The event ledger has invalid JSON on line ${index + 1}.`)
        }
        throw error
      }
    }

    this.#state = migrateState(this.#state)

    this.#eventBytes = Buffer.byteLength(ledger, "utf8")
    await this.#reconcileBlobInventory()

    if (
      durableRepairRequired
      || legacyReplay
      || skippedEventPrefix
      || this.#blobBytes > this.#maxBlobBytes
      || Buffer.byteLength(JSON.stringify(this.#state), "utf8") > this.#maxStateBytes
    ) {
      await this.#compact()
    }
    if (this.#blobBytes > this.#maxBlobBytes) {
      throw new EgoChatError(
        "protected_storage_capacity_exhausted",
        "Protected recovery results already exceed the configured hard blob limit; data was preserved and new work is blocked.",
      )
    }
    this.#assertStateCapacity(this.#state)

    await writeAtomicJson(this.#statePath, this.#state)
  }

  listWorkflows() {
    return Object.values(this.#state.workflows).map(clone)
  }

  getWorkflow(workflowId) {
    const workflow = this.#state.workflows[workflowId]
    return workflow ? clone(workflow) : undefined
  }

  getWorkflowByOperationKey(operationKey) {
    const operation = this.#state.operations[operationKey]
    const workflow = operation
      ? this.#state.workflows[operation.workflowId]
      : Object.values(this.#state.workflows).find((candidate) => candidate.operationKey === operationKey)
    return workflow ? clone(workflow) : undefined
  }

  getOperation(operationKey) {
    const operation = this.#state.operations[operationKey]
    return operation ? clone(operation) : undefined
  }

  getAttachmentIntent(workflowId) {
    const intent = this.#state.attachmentIntents[workflowId]
    return intent ? clone(intent) : undefined
  }

  getLegacyAttachmentEvidence(workflowId) {
    const evidence = this.#state.legacyAttachmentEvidence[workflowId]
    return evidence ? clone(evidence) : undefined
  }

  getAttachmentConsumerAcknowledgement(workflowId) {
    const envelope = this.#state.attachmentConsumerAcknowledgements[workflowId]
    return envelope ? clone(envelope) : undefined
  }

  getAttachmentEvidenceTombstone(workflowId) {
    const tombstone = this.#state.attachmentEvidenceTombstones[workflowId]
    return tombstone ? clone(tombstone) : undefined
  }

  getAttachmentExternalBinding(profile, externalBindingDigest) {
    const entry = this.#state.attachmentExternalBindings[
      `${profile}:${externalBindingDigest}`
    ]
    return entry ? clone(entry) : undefined
  }

  getConfirmedSendIdentity(workflowId) {
    const identity = this.#state.confirmedSendIdentities[workflowId]
    return identity ? clone(identity) : undefined
  }

  getConfirmedSendEvent(workflowId) {
    const event = this.#state.confirmedSendEvents[workflowId]
    return event ? clone(event) : undefined
  }

  getAttachmentCapture(workflowId) {
    const capture = this.#state.attachmentCaptures[workflowId]
    return capture ? clone(capture) : undefined
  }

  getAttachmentDisposition(workflowId) {
    const envelope = this.#state.attachmentDispositions[workflowId]
    return envelope ? clone(envelope) : undefined
  }

  listBindings() {
    return Object.values(this.#state.bindings).map(clone)
  }

  getBinding(bindingKey) {
    const binding = this.#state.bindings[bindingKey]
    return binding ? clone(binding) : undefined
  }

  listModelPolicies() {
    return Object.values(this.#state.modelPolicies).map(clone)
  }

  getModelPolicy(policyKey) {
    const modelPolicy = this.#state.modelPolicies[policyKey]
    return modelPolicy ? clone(modelPolicy) : undefined
  }

  async putBlob(text, { mediaType = "text/plain; charset=utf-8" } = {}) {
    const operation = this.#tail.then(() => this.#putBlob(text, mediaType))
    this.#tail = operation.catch(() => {})
    return operation
  }

  async #putBlob(text, mediaType) {
    const bytes = Buffer.from(text, "utf8")
    if (bytes.length > this.#maxResultBytes) {
      throw new EgoChatError(
        "result_too_large",
        "The result body exceeds the reserved per-operation storage capacity.",
        { limitBytes: this.#maxResultBytes, sizeBytes: bytes.length },
      )
    }
    const digest = createHash("sha256").update(bytes).digest("hex")
    const directory = path.join(this.#blobDirectory, digest.slice(0, 2))
    const filePath = path.join(directory, digest)
    await ensurePrivateDirectory(directory)
    try {
      const existing = await fs.readFile(filePath)
      if (!existing.equals(bytes)) {
        throw new EgoChatError("blob_digest_collision", "A stored result blob does not match its content digest.")
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
      if (this.#blobBytes + bytes.length > this.#maxBlobBytes) {
        await this.#compact()
      }
      if (this.#blobBytes + bytes.length > this.#maxBlobBytes) {
        throw new EgoChatError(
          "protected_storage_capacity_exhausted",
          "The hard result-storage limit is reserved by protected recovery evidence.",
          {
            blobBytes: this.#blobBytes,
            limitBytes: this.#maxBlobBytes,
            requestedBytes: bytes.length,
          },
        )
      }
      await writeAtomicText(filePath, text)
      this.#blobBytes += bytes.length
    }
    return {
      digest,
      mediaType,
      sizeBytes: bytes.length,
      uri: `ego-chat-result:${digest}`,
    }
  }

  async readBlob(reference, { maxBytes, offset }) {
    const digest = reference?.digest
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new EgoChatError("invalid_result_ref", "The result reference digest is invalid.")
    }
    const filePath = path.join(this.#blobDirectory, digest.slice(0, 2), digest)
    let bytes
    try {
      bytes = await fs.readFile(filePath)
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new EgoChatError("result_not_found", "The referenced Ego Chat result is no longer available.")
      }
      throw error
    }
    const observed = createHash("sha256").update(bytes).digest("hex")
    if (observed !== digest) {
      throw new EgoChatError("corrupt_result_blob", "The referenced Ego Chat result failed its digest check.")
    }
    if (
      offset > bytes.length
      || (offset < bytes.length && isUtf8ContinuationByte(bytes[offset]))
    ) {
      throw new EgoChatError(
        "invalid_result_range",
        "The requested result offset is not a valid UTF-8 boundary.",
      )
    }
    let end = Math.min(bytes.length, offset + maxBytes)
    while (end > offset && end < bytes.length && isUtf8ContinuationByte(bytes[end])) {
      end -= 1
    }
    if (end === offset && offset < bytes.length) {
      throw new EgoChatError(
        "invalid_result_range",
        "The requested result range is too small to contain the next UTF-8 character.",
      )
    }
    return {
      complete: end === bytes.length,
      digest,
      nextOffset: end === bytes.length ? null : end,
      offset,
      sizeBytes: bytes.length,
      text: bytes.subarray(offset, end).toString("utf8"),
    }
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    return this.#persistEntity(type, "workflow", workflow, expectedWorkflow)
  }

  async persistStarted(type, workflow, receiptAdmission = undefined) {
    const operation = this.#tail.then(async () => {
      const existingOperation = this.#state.operations[workflow.operationKey]
      const existing = existingOperation
        ? this.#state.workflows[existingOperation.workflowId]
        : undefined
      if (existingOperation) {
        if (existingOperation.inputDigest !== workflow.inputDigest) {
          throw new EgoChatError(
            "operation_key_conflict",
            "That durable operation key is already bound to different input.",
            { existingWorkflowId: existingOperation.workflowId, operationKey: workflow.operationKey },
          )
        }
        if (!existing) {
          throw new EgoChatError(
            "operation_already_completed",
            "That durable operation was retained after its detailed workflow metadata expired; it will not be sent again.",
            { existingWorkflowId: existingOperation.workflowId, operationKey: workflow.operationKey },
          )
        }
        return { created: false, workflow: clone(existing) }
      }

      this.#assertNewWorkflowCapacity(workflow, { operation: true })

      const attachmentEvidence = receiptAdmission
        ? this.#prepareAttachmentAdmission(workflow, receiptAdmission)
        : undefined

      await this.#appendStarted(type, workflow, attachmentEvidence)
      return { created: true, workflow: clone(workflow) }
    })

    this.#tail = operation.catch(() => {})
    return operation
  }

  async persistBinding(type, binding, expectedBinding = undefined) {
    return this.#persistEntity(type, "binding", binding, expectedBinding)
  }

  async persistConfirmedAttachmentSend(type, workflow, patch, sent) {
    const operation = this.#tail.then(async () => {
      const current = this.#state.workflows[workflow.id]
      if (!isDeepStrictEqual(current, workflow)) {
        throw new EgoChatError(
          "workflow_transition_conflict",
          "The workflow changed before confirmed Send could be committed.",
        )
      }
      const intent = this.#state.attachmentIntents[workflow.id]
      const entry = intent && this.#state.attachmentExternalBindings[
        `${intent.profile}:${intent.external_binding_sha256}`
      ]
      if (!intent || entry?.source_workflow_id !== workflow.id) {
        throw new EgoChatError(
          "attachment_receipt_intent_missing",
          "Confirmed Send has no exact reserved attachment capture intent.",
        )
      }
      if (this.#state.confirmedSendIdentities[workflow.id]) {
        throw new EgoChatError(
          "confirmed_send_identity_conflict",
          "Confirmed Send identity already exists and cannot be replaced.",
        )
      }
      const intentDigest = sha256Hex(canonicalJsonBytes(intent))
      const confirmed = buildConfirmedSendIdentity({
        intent,
        intentDigest,
        sent,
        sequence: this.#state.nextSeq,
        workflow,
      })
      const next = {
        ...workflow,
        ...patch,
        private: {
          ...patch.private,
          confirmedSendIdentitySha256: sha256Hex(
            canonicalJsonBytes(confirmed.identity),
          ),
        },
        updatedAt: new Date().toISOString(),
      }
      await this.#appendEvent({
        at: new Date().toISOString(),
        confirmedSendEvent: confirmed.event,
        confirmedSendIdentity: confirmed.identity,
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type,
        workflow: next,
      })
      return clone(next)
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async beginAttachmentCapture(workflow, startedAt) {
    const operation = this.#tail.then(async () => {
      const current = this.#state.workflows[workflow.id]
      if (!isDeepStrictEqual(current, workflow)) {
        throw new EgoChatError(
          "workflow_transition_conflict",
          "The workflow changed before attachment capture could begin.",
        )
      }
      const existing = this.#state.attachmentCaptures[workflow.id]
      if (existing) {
        return { capture: clone(existing), created: false, workflow: clone(current) }
      }
      const identity = this.#state.confirmedSendIdentities[workflow.id]
      if (
        current.phase !== "awaiting_attachment_capture"
        || !current.private?.request?.receiptCapture
        || !identity
      ) {
        throw new EgoChatError(
          "attachment_capture_not_ready",
          "The source workflow has no eligible confirmed attachment Send.",
        )
      }
      const identityDigest = sha256Hex(canonicalJsonBytes(identity))
      const capture = buildAttachmentCaptureOperation({
        confirmedSendIdentityDigest: identityDigest,
        sourceWorkflowId: workflow.id,
        startedAt,
      })
      const next = {
        ...current,
        deadlineAt: capture.capture_deadline_at,
        phase: "attachment_capture_started",
        private: {
          ...current.private,
          attachmentCaptureOperationKeySha256: capture.capture_operation_key_sha256,
        },
        updatedAt: new Date().toISOString(),
      }
      await this.#appendEvent({
        at: new Date().toISOString(),
        attachmentCapture: capture,
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type: "attachment.capture_started",
        workflow: next,
      })
      return { capture: clone(capture), created: true, workflow: clone(next) }
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async recordAttachmentCaptureAttempt({
    capture,
    elapsedMonotonicMs,
    observation,
  }) {
    const operation = this.#tail.then(async () => {
      const current = this.#state.attachmentCaptures[capture?.source_workflow_id]
      if (!current || !capture || !isDeepStrictEqual(current, capture)) {
        throw new EgoChatError(
          "attachment_capture_transition_conflict",
          "The attachment capture changed before its observation could be committed.",
        )
      }
      if (current.state !== "CAPTURING") {
        throw new EgoChatError(
          "attachment_capture_terminal",
          "The attachment capture already has terminal evidence.",
        )
      }
      assertValidAttachmentGraphObservation(observation)
      const identity = this.#state.confirmedSendIdentities[current.source_workflow_id]
      const identityDigest = sha256Hex(canonicalJsonBytes(identity))
      const observedAtMs = Date.parse(observation.observed_at)
      if (
        observation.source_confirmed_send_identity_sha256 !== identityDigest
        || observation.capture_operation_key_sha256
          !== current.capture_operation_key_sha256
        || observation.provider_prompt_message_id !== identity.provider_prompt_message_id
        || observation.canonical_conversation_locator_sha256
          !== identity.canonical_conversation_url_sha256
        || observation.observation_sequence !== current.attempt_journal.length + 1
        || observedAtMs < Date.parse(current.capture_started_at)
        || observedAtMs > Date.parse(current.capture_deadline_at)
        || !Number.isSafeInteger(elapsedMonotonicMs)
        || elapsedMonotonicMs < 0
        || current.accumulated_monotonic_ms + elapsedMonotonicMs > 10 * 60 * 1_000
      ) {
        throw new EgoChatError(
          "invalid_attachment_capture_attempt",
          "The attachment observation does not match its fixed capture lineage or bounds.",
        )
      }
      if (current.attempt_journal.length >= 32) {
        throw new EgoChatError(
          "attachment_capture_attempt_limit",
          "The attachment capture attempt limit has been reached.",
        )
      }
      const completingPair = current.candidate_observations.length === 1
      if (completingPair && current.candidate_pair_count >= 8) {
        throw new EgoChatError(
          "attachment_capture_pair_limit",
          "The attachment capture candidate-pair limit has been reached.",
        )
      }
      const candidateGeneration = current.candidate_generation + 1
      const journalEntry = attachmentObservationJournalEntry(
        observation,
        candidateGeneration,
        completingPair,
      )
      const candidateObservations = current.candidate_observations.length >= 2
        ? [clone(observation)]
        : [...current.candidate_observations, clone(observation)]
      const next = {
        ...current,
        accumulated_monotonic_ms: current.accumulated_monotonic_ms + elapsedMonotonicMs,
        attempt_journal: [...current.attempt_journal, journalEntry],
        candidate_generation: candidateGeneration,
        candidate_observations: candidateObservations,
        candidate_pair_count: current.candidate_pair_count + (completingPair ? 1 : 0),
      }
      const workflow = this.#state.workflows[current.source_workflow_id]
      await this.#appendEvent({
        at: observation.observed_at,
        attachmentCapture: next,
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type: "attachment.capture_attempt_recorded",
        workflow,
      })
      return clone(next)
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async recordAttachmentCaptureRecovery({
    attemptedAt,
    capture,
    elapsedMonotonicMs,
    reason,
  }) {
    const operation = this.#tail.then(async () => {
      const current = this.#state.attachmentCaptures[capture?.source_workflow_id]
      if (!current || !capture || !isDeepStrictEqual(current, capture)) {
        throw new EgoChatError(
          "attachment_capture_transition_conflict",
          "The attachment capture changed before its recovery boundary could be committed.",
        )
      }
      if (
        current.state !== "CAPTURING"
        || !["BROKER_RESTART", "DRIVER_RECOVERY"].includes(reason)
        || !exactTimestamp(attemptedAt)
        || Date.parse(attemptedAt) < Date.parse(current.capture_started_at)
        || Date.parse(attemptedAt) > Date.parse(current.capture_deadline_at)
        || !Number.isSafeInteger(elapsedMonotonicMs)
        || elapsedMonotonicMs < 0
        || current.accumulated_monotonic_ms + elapsedMonotonicMs > 10 * 60 * 1_000
      ) {
        throw new EgoChatError(
          "invalid_attachment_capture_recovery",
          "The attachment capture recovery boundary is outside its fixed bounds.",
        )
      }
      if (current.attempt_journal.length >= 32) {
        throw new EgoChatError(
          "attachment_capture_attempt_limit",
          "The attachment capture attempt limit has been reached.",
        )
      }
      const candidateGeneration = current.candidate_generation + 1
      const journalEntry = attachmentRecoveryJournalEntry({
        attemptNumber: current.attempt_journal.length + 1,
        attemptedAt,
        candidateGeneration,
        captureOperationKeySha256: current.capture_operation_key_sha256,
        reason,
      })
      const next = {
        ...current,
        accumulated_monotonic_ms: current.accumulated_monotonic_ms + elapsedMonotonicMs,
        attempt_journal: [...current.attempt_journal, journalEntry],
        candidate_generation: candidateGeneration,
        candidate_observations: [],
      }
      const workflow = this.#state.workflows[current.source_workflow_id]
      await this.#appendEvent({
        at: attemptedAt,
        attachmentCapture: next,
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type: "attachment.capture_recovery_recorded",
        workflow,
      })
      return clone(next)
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async persistAttachmentDisposition({ capture, envelope }) {
    const operation = this.#tail.then(async () => {
      const workflowId = capture?.source_workflow_id
      if (typeof workflowId !== "string") {
        throw new EgoChatError(
          "attachment_capture_transition_conflict",
          "The attachment capture identity is missing.",
        )
      }
      const existing = this.#state.attachmentDispositions[workflowId]
      if (existing) {
        if (!isDeepStrictEqual(existing, envelope)) {
          throw new EgoChatError(
            "attachment_disposition_conflict",
            "A different terminal attachment disposition is already durable.",
          )
        }
        const { disposition } = assertValidSignedAttachmentDispositionEnvelope(existing)
        return {
          created: false,
          disposition: clone(disposition),
          envelope: clone(existing),
          workflow: clone(this.#state.workflows[workflowId]),
        }
      }
      const current = this.#state.attachmentCaptures[workflowId]
      if (!isDeepStrictEqual(current, capture) || current?.state !== "CAPTURING") {
        throw new EgoChatError(
          "attachment_capture_transition_conflict",
          "The attachment capture changed before terminal evidence could be committed.",
        )
      }
      const { disposition } = assertValidSignedAttachmentDispositionEnvelope(envelope)
      const identity = this.#state.confirmedSendIdentities[workflowId]
      const identityDigest = sha256Hex(canonicalJsonBytes(identity))
      const expectedDisposition = buildAttachmentExecutionDisposition({
        captureOperation: current,
        confirmedSendIdentity: identity,
        confirmedSendIdentityDigest: identityDigest,
        observations: current.candidate_observations,
        terminalReason: [
          "CAPTURE_ATTEMPT_LIMIT",
          "CAPTURE_DEADLINE_EXPIRED",
        ].includes(disposition.reason) ? disposition.reason : undefined,
        terminalAt: disposition.terminal_at,
      })
      if (!isDeepStrictEqual(disposition, expectedDisposition)) {
        throw new EgoChatError(
          "attachment_disposition_lineage_mismatch",
          "The terminal disposition does not match the durable capture evidence.",
        )
      }
      const envelopeDigest = sha256Hex(canonicalJsonBytes(envelope))
      const terminalCapture = {
        ...current,
        state: "TERMINAL",
        terminal_disposition_sha256: envelope.payload_sha256,
        terminal_envelope_sha256: envelopeDigest,
      }
      const workflow = this.#state.workflows[workflowId]
      const nextWorkflow = {
        ...workflow,
        phase: "attachment_disposition_terminal",
        result: {
          attachmentDispositionEnvelopeSha256: envelopeDigest,
          attachmentDispositionPayloadSha256: envelope.payload_sha256,
          outcome: disposition.outcome,
          reason: disposition.reason,
        },
        status: "succeeded",
        updatedAt: disposition.terminal_at,
      }
      await this.#appendEvent({
        at: disposition.terminal_at,
        attachmentCapture: terminalCapture,
        attachmentDisposition: {
          envelope: clone(envelope),
          source_workflow_id: workflowId,
        },
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type: "attachment.disposition_persisted",
        workflow: nextWorkflow,
      })
      return {
        created: true,
        disposition: clone(disposition),
        envelope: clone(envelope),
        workflow: clone(nextWorkflow),
      }
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async releaseAttachmentEvidence({ acknowledgement, envelope, workflowId }) {
    const operation = this.#tail.then(async () => {
      const existing = this.#state.attachmentConsumerAcknowledgements[workflowId]
      if (existing) {
        if (!isDeepStrictEqual(existing, envelope)) {
          throw new EgoChatError(
            "attachment_consumer_acknowledgement_conflict",
            "A different attachment evidence consumer acknowledgement is already durable.",
          )
        }
        return {
          acknowledgement: clone(acknowledgement),
          created: false,
          envelope: clone(existing),
          tombstone: clone(this.#state.attachmentEvidenceTombstones[workflowId]),
          workflow: clone(this.#state.workflows[workflowId]),
        }
      }
      const parsed = assertValidSignedAttachmentConsumerAcknowledgementEnvelope(envelope)
      if (!isDeepStrictEqual(parsed.acknowledgement, acknowledgement)) {
        throw new EgoChatError(
          "attachment_consumer_acknowledgement_mismatch",
          "The verified attachment evidence consumer acknowledgement changed before commit.",
        )
      }
      const workflow = this.#state.workflows[workflowId]
      const intent = this.#state.attachmentIntents[workflowId]
      const identity = this.#state.confirmedSendIdentities[workflowId]
      const dispositionEnvelope = this.#state.attachmentDispositions[workflowId]
      const externalBinding = intent && this.#state.attachmentExternalBindings[
        `${intent.profile}:${intent.external_binding_sha256}`
      ]
      const disposition = dispositionEnvelope
        && assertValidSignedAttachmentDispositionEnvelope(dispositionEnvelope).disposition
      if (
        workflow?.phase !== "attachment_disposition_terminal"
        || workflow.status !== "succeeded"
        || !intent
        || !identity
        || !dispositionEnvelope
        || externalBinding?.state !== "RESERVED"
        || acknowledgement.confirmed_send_identity_sha256
          !== sha256Hex(canonicalJsonBytes(identity))
        || acknowledgement.disposition_envelope_sha256
          !== sha256Hex(canonicalJsonBytes(dispositionEnvelope))
        || acknowledgement.terminal_evidence_digest !== dispositionEnvelope.payload_sha256
        || acknowledgement.external_binding_sha256 !== intent.external_binding_sha256
        || acknowledgement.terminal_outcome !== disposition.outcome
      ) {
        throw new EgoChatError(
          "attachment_consumer_acknowledgement_lineage_mismatch",
          "The acknowledgement does not match the immutable terminal attachment evidence.",
        )
      }
      const acknowledgementEnvelopeDigest = sha256Hex(canonicalJsonBytes(envelope))
      const tombstone = {
        acknowledgement_envelope_sha256: acknowledgementEnvelopeDigest,
        consumer_state: acknowledgement.consumer_state,
        disposition_envelope_sha256: acknowledgement.disposition_envelope_sha256,
        external_binding_sha256: intent.external_binding_sha256,
        profile: intent.profile,
        schema: "ego-chat-attachment-evidence-tombstone/v1",
        source_workflow_id: workflowId,
        terminal_evidence_digest: acknowledgement.terminal_evidence_digest,
        terminal_outcome: acknowledgement.terminal_outcome,
      }
      const nextExternalBinding = {
        ...externalBinding,
        acknowledgement_envelope_sha256: acknowledgementEnvelopeDigest,
        consumer_state: acknowledgement.consumer_state,
        state: "CONSUMED_RELEASED",
        tombstone_sha256: sha256Hex(canonicalJsonBytes(tombstone)),
      }
      const nextCapacity = {
        ...this.#state.attachmentCapacity,
        liveIntentCount: this.#state.attachmentCapacity.liveIntentCount - 1,
        liveReservedBytes: (
          this.#state.attachmentCapacity.liveReservedBytes
          - ATTACHMENT_EVIDENCE_RESERVATION_BYTES
        ),
      }
      if (nextCapacity.liveIntentCount < 0 || nextCapacity.liveReservedBytes < 0) {
        throw new EgoChatError(
          "corrupt_attachment_evidence_state",
          "The attachment evidence reservation counters cannot be released safely.",
        )
      }
      const nextWorkflow = {
        ...workflow,
        phase: "attachment_evidence_released",
        result: {
          ...workflow.result,
          attachmentConsumerAcknowledgementEnvelopeSha256:
            acknowledgementEnvelopeDigest,
          attachmentEvidenceTombstoneSha256: sha256Hex(canonicalJsonBytes(tombstone)),
          consumerState: acknowledgement.consumer_state,
        },
        updatedAt: new Date().toISOString(),
      }
      await this.#appendEvent({
        at: nextWorkflow.updatedAt,
        attachmentCapacity: nextCapacity,
        attachmentConsumerAcknowledgement: {
          envelope: clone(envelope),
          source_workflow_id: workflowId,
        },
        attachmentEvidenceTombstone: tombstone,
        attachmentExternalBinding: nextExternalBinding,
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type: "attachment.consumer_acknowledged",
        workflow: nextWorkflow,
      })
      return {
        acknowledgement: clone(acknowledgement),
        created: true,
        envelope: clone(envelope),
        tombstone: clone(tombstone),
        workflow: clone(nextWorkflow),
      }
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async persistModelPolicy(type, modelPolicy) {
    return this.#persistEntity(type, "modelPolicy", modelPolicy)
  }

  async #persistEntity(type, entityName, entity, expectedEntity = undefined) {
    const operation = this.#tail.then(async () => {
      if (entityName === "workflow" && expectedEntity !== undefined) {
        const current = this.#state.workflows[entity.id]
        if (!isDeepStrictEqual(current, expectedEntity)) {
          throw new EgoChatError(
            "workflow_transition_conflict",
            "The workflow changed before this state transition could be committed.",
          )
        }
      }
      if (entityName === "binding" && expectedEntity !== undefined) {
        const current = this.#state.bindings[entity.key]
        if (!isDeepStrictEqual(current, expectedEntity)) {
          throw new EgoChatError(
            "binding_transition_conflict",
            "The conversation binding changed before this state transition could be committed.",
          )
        }
      }
      if (entityName === "workflow" && !this.#state.workflows[entity.id]) {
        this.#assertNewWorkflowCapacity(entity)
      }
      if (
        entityName === "binding"
        && !this.#state.bindings[entity.key]
        && Object.keys(this.#state.bindings).length >= this.#maxBindings
      ) {
        throw new EgoChatError(
          "binding_capacity_exhausted",
          "The durable binding limit has been reached; no browser work was started.",
          { limit: this.#maxBindings },
        )
      }
      if (
        entityName === "modelPolicy"
        && !this.#state.modelPolicies[entity.key]
        && Object.keys(this.#state.modelPolicies).length >= this.#maxModelPolicies
      ) {
        throw new EgoChatError(
          "model_policy_capacity_exhausted",
          "The durable model-policy limit has been reached.",
          { limit: this.#maxModelPolicies },
        )
      }
      await this.#appendEntity(type, entityName, entity)
      return clone(entity)
    })

    this.#tail = operation.catch(() => {})
    return operation
  }

  async #appendEntity(type, entityName, entity) {
    const event = {
      at: new Date().toISOString(),
      [entityName]: clone(entity),
      schemaVersion: 1,
      seq: this.#state.nextSeq,
      type,
    }
    await this.#appendEvent(event)
  }

  async #appendEvent(event) {
    const serializedEvent = `${JSON.stringify(event)}\n`
    if (Buffer.byteLength(serializedEvent, "utf8") > this.#maxEventBytes) {
      throw new EgoChatError(
        "state_capacity_exhausted",
        "One durable event exceeds the hard event-ledger byte limit.",
        { limitBytes: this.#maxEventBytes },
      )
    }
    if (this.#eventBytes + Buffer.byteLength(serializedEvent, "utf8") > this.#maxEventBytes) {
      await this.#compact()
    }
    let prospectiveState = clone(this.#state)
    applyEvent(prospectiveState, event)
    if (Buffer.byteLength(JSON.stringify(prospectiveState), "utf8") > this.#maxStateBytes) {
      await this.#compact()
      prospectiveState = clone(this.#state)
      applyEvent(prospectiveState, event)
    }
    this.#assertStateCapacity(prospectiveState)
    const handle = await fs.open(this.#eventsPath, "a", 0o600)
    try {
      await handle.writeFile(serializedEvent, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }

    applyEvent(this.#state, event)
    this.#eventBytes += Buffer.byteLength(serializedEvent, "utf8")
    this.#eventsSinceCheckpoint += 1
    if (
      this.#blobBytes > this.#maxBlobBytes
      || this.#eventBytes >= this.#maxEventBytes
      || this.#eventsSinceCheckpoint >= this.#maxEvents
    ) {
      await this.#compact()
    }
  }

  async #appendStarted(type, workflow, attachmentEvidence = undefined) {
    const event = {
      at: new Date().toISOString(),
      ...(attachmentEvidence ?? {}),
      operation: {
        createdAt: workflow.createdAt,
        inputDigest: workflow.inputDigest,
        key: workflow.operationKey,
        workflowId: workflow.id,
      },
      schemaVersion: 1,
      seq: this.#state.nextSeq,
      type,
      workflow: clone(workflow),
    }
    await this.#appendEvent(event)
  }

  #prepareAttachmentAdmission(workflow, receiptAdmission) {
    const { intent, intentDigest } = receiptAdmission ?? {}
    if (
      !intent
      || typeof intent !== "object"
      || Array.isArray(intent)
      || intent.schema !== "ego-chat-attachment-capture-intent/v1"
      || intent.source_workflow_id !== workflow.id
      || intent.source_operation_key_sha256 !== operationKeyDigest(workflow.operationKey)
      || intent.live_reservation_bytes !== ATTACHMENT_EVIDENCE_RESERVATION_BYTES
      || intent.permanent_reservation_bytes !== ATTACHMENT_PERMANENT_RESERVATION_BYTES
      || !exactTimestamp(intent.created_at)
      || !exactTimestamp(intent.send_resolution_deadline_at)
      || Date.parse(intent.send_resolution_deadline_at) - Date.parse(intent.created_at)
        !== 10 * 60 * 1_000
      || intent.state !== "RESERVED"
      || sha256Hex(canonicalJsonBytes(intent)) !== intentDigest
    ) {
      throw new EgoChatError(
        "invalid_attachment_receipt_admission",
        "The receipt-enabled exchange admission does not match its durable workflow.",
      )
    }
    const ledgerKey = `${intent.profile}:${intent.external_binding_sha256}`
    if (this.#state.attachmentExternalBindings[ledgerKey]) {
      throw new EgoChatError(
        "attachment_external_binding_consumed",
        "That receipt external binding is already permanently consumed.",
      )
    }
    const capacity = this.#state.attachmentCapacity
    const nextCapacity = {
      liveIntentCount: capacity.liveIntentCount + 1,
      liveReservedBytes: capacity.liveReservedBytes + ATTACHMENT_EVIDENCE_RESERVATION_BYTES,
      permanentEntryCount: capacity.permanentEntryCount + 1,
      permanentReservedBytes: (
        capacity.permanentReservedBytes + ATTACHMENT_PERMANENT_RESERVATION_BYTES
      ),
    }
    if (
      nextCapacity.liveIntentCount > this.#maxAttachmentIntents
      || nextCapacity.liveReservedBytes > this.#maxAttachmentLiveBytes
    ) {
      throw new EgoChatError(
        "attachment_evidence_capacity_exhausted",
        "Attachment evidence capacity is unavailable; no browser work was started.",
      )
    }
    if (
      nextCapacity.permanentEntryCount > this.#maxAttachmentPermanentBindings
      || nextCapacity.permanentReservedBytes > this.#maxAttachmentPermanentBytes
    ) {
      throw new EgoChatError(
        "attachment_permanent_ledger_capacity_exhausted",
        "The permanent attachment-binding ledger is full; no browser work was started.",
      )
    }
    return {
      attachmentCapacity: nextCapacity,
      attachmentExternalBinding: {
        created_at: intent.created_at,
        external_binding_sha256: intent.external_binding_sha256,
        intent_sha256: intentDigest,
        ledger_key: ledgerKey,
        permanent_reservation_bytes: ATTACHMENT_PERMANENT_RESERVATION_BYTES,
        profile: intent.profile,
        schema: "ego-chat-attachment-external-binding-entry/v1",
        source_operation_key_sha256: intent.source_operation_key_sha256,
        source_workflow_id: workflow.id,
        state: "RESERVED",
      },
      attachmentIntent: clone(intent),
    }
  }

  #assertNewWorkflowCapacity(workflow, { operation = false } = {}) {
    if (operation && Object.keys(this.#state.operations).length >= this.#maxOperations) {
      throw new EgoChatError(
        "operation_capacity_exhausted",
        "The bounded at-most-once identity ledger is full. Existing identities remain protected, and no browser work was started.",
        { limit: this.#maxOperations },
      )
    }

    const protectedStatus = hasProtectedRecoveryState(workflow)
    const capacity = this.#recoveryCapacity()
    if (protectedStatus && capacity.recoveryWorkflowCount >= this.#maxRecoveryWorkflows) {
      throw new EgoChatError(
        "recovery_workflow_capacity_exhausted",
        "The bounded recovery-workflow limit is full. Existing evidence remains protected, and no browser work was started.",
        { limit: this.#maxRecoveryWorkflows },
      )
    }

    let additionalProtectedBytes = 0
    let additionalReservedBytes = 0
    const reference = workflow.result?.responseRef
    if (protectedStatus && reference && !capacity.protectedDigests.has(reference.digest)) {
      additionalProtectedBytes = reference.sizeBytes
    } else if (needsResultReservation(workflow)) {
      additionalReservedBytes = this.#maxResultBytes
    }
    const requiredBytes = capacity.protectedBlobBytes
      + capacity.reservedBlobBytes
      + additionalProtectedBytes
      + additionalReservedBytes
    if (requiredBytes > this.#maxBlobBytes) {
      throw new EgoChatError(
        "protected_storage_capacity_exhausted",
        "Worst-case protected result capacity is unavailable. No policy mutation, composition, or browser send was started.",
        {
          limitBytes: this.#maxBlobBytes,
          protectedBlobBytes: capacity.protectedBlobBytes,
          requiredBytes,
          reservedBlobBytes: capacity.reservedBlobBytes,
        },
      )
    }
  }

  #assertStateCapacity(state) {
    const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8")
    if (stateBytes > this.#maxStateBytes) {
      throw new EgoChatError(
        "state_capacity_exhausted",
        "The durable state checkpoint reached its hard byte limit. Existing state was preserved.",
        { limitBytes: this.#maxStateBytes, stateBytes },
      )
    }
  }

  #recoveryCapacity() {
    const protectedDigests = new Map()
    let recoveryWorkflowCount = 0
    let reservedBlobBytes = 0
    for (const workflow of Object.values(this.#state.workflows)) {
      if (!hasProtectedRecoveryState(workflow)) {
        continue
      }
      recoveryWorkflowCount += 1
      const reference = workflow.result?.responseRef
      if (reference) {
        protectedDigests.set(reference.digest, reference.sizeBytes)
      } else if (needsResultReservation(workflow)) {
        reservedBlobBytes += this.#maxResultBytes
      }
    }
    return {
      protectedBlobBytes: [...protectedDigests.values()].reduce((total, size) => total + size, 0),
      protectedDigests,
      recoveryWorkflowCount,
      reservedBlobBytes,
    }
  }

  #referencedBlobMap() {
    const references = new Map()
    const referenceKeys = ["digest", "mediaType", "sizeBytes", "uri"]
    for (const workflow of Object.values(this.#state.workflows)) {
      const reference = workflow.result?.responseRef
      if (!reference) {
        continue
      }
      if (
        !isDeepStrictEqual(Object.keys(reference).sort(), referenceKeys)
        || typeof reference.digest !== "string"
        || !SHA256_PATTERN.test(reference.digest)
        || typeof reference.mediaType !== "string"
        || reference.mediaType.length === 0
        || reference.mediaType.length > 256
        || !Number.isSafeInteger(reference.sizeBytes)
        || reference.sizeBytes < 0
        || reference.sizeBytes > this.#maxResultBytes
        || reference.uri !== `ego-chat-result:${reference.digest}`
        || workflow.result.responseDigest !== reference.digest
      ) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A durable result reference is not canonical.",
        )
      }
      const prior = references.get(reference.digest)
      if (prior && !isDeepStrictEqual(prior, reference)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "Durable result references disagree about one content-addressed blob.",
        )
      }
      references.set(reference.digest, reference)
    }
    return references
  }

  async #readVerifiedBlob(filePath, digest, reference) {
    const namedBefore = await fs.lstat(filePath)
    assertPrivateBlobFile(namedBefore)
    let handle
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      )
    } catch (_error) {
      throw new EgoChatError(
        "corrupt_result_blob_inventory",
        "A result blob could not be opened without following links.",
      )
    }
    try {
      const openedBefore = await handle.stat()
      assertPrivateBlobFile(openedBefore)
      if (!sameFileIdentity(namedBefore, openedBefore)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob changed identity while it was opened.",
        )
      }
      if (openedBefore.size !== reference.sizeBytes) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob size does not match its durable reference.",
        )
      }
      const bytes = await handle.readFile()
      await this.#compactionFaultInjector?.("blob_read", { digest, filePath })
      const openedAfter = await handle.stat()
      const namedAfter = await fs.lstat(filePath)
      assertPrivateBlobFile(openedAfter)
      assertPrivateBlobFile(namedAfter)
      if (
        !sameFileIdentity(openedBefore, openedAfter)
        || !sameFileIdentity(openedAfter, namedAfter)
        || openedAfter.size !== reference.sizeBytes
        || bytes.length !== reference.sizeBytes
      ) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob changed identity or size while it was verified.",
        )
      }
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob content digest does not match its durable reference.",
        )
      }
      return bytes.length
    } finally {
      await handle.close()
    }
  }

  async #removeSafeUnreferencedBlob(filePath) {
    const named = await fs.lstat(filePath)
    assertPrivateBlobFile(named)
    const handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
    try {
      const opened = await handle.stat()
      assertPrivateBlobFile(opened)
      if (!sameFileIdentity(named, opened)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "An unreferenced result blob changed identity before removal.",
        )
      }
      const namedAgain = await fs.lstat(filePath)
      if (!sameFileIdentity(opened, namedAgain)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "An unreferenced result blob changed identity before removal.",
        )
      }
      await this.#compactionFaultInjector?.("before_orphan_quarantine", {
        filePath,
      })
      const quarantineDirectory = path.join(this.#dataDir, "blob-quarantine")
      await ensurePrivateDirectory(quarantineDirectory)
      const quarantinePath = path.join(
        quarantineDirectory,
        `blob-${randomUUID()}`,
      )
      await fs.rename(filePath, quarantinePath)
      const quarantined = await fs.lstat(quarantinePath)
      const openedAfterMove = await handle.stat()
      assertPrivateBlobFile(quarantined)
      assertPrivateBlobFile(openedAfterMove)
      if (
        !sameFileIdentity(opened, openedAfterMove)
        || !sameFileIdentity(openedAfterMove, quarantined)
      ) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "An unreferenced result blob changed identity during quarantine.",
        )
      }
      await fs.unlink(quarantinePath)
    } finally {
      await handle.close()
    }
  }

  async #removeEmptyUnreferencedPrefix(prefixPath) {
    const named = await fs.lstat(prefixPath)
    assertPrivateBlobDirectory(named, "result blob prefix")
    if ((await fs.readdir(prefixPath)).length !== 0) return false
    const handle = await fs.open(
      prefixPath,
      fsConstants.O_RDONLY
        | fsConstants.O_NOFOLLOW
        | (fsConstants.O_DIRECTORY ?? 0),
    )
    try {
      const opened = await handle.stat()
      assertPrivateBlobDirectory(opened, "result blob prefix")
      if (!sameFileIdentity(named, opened)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "An empty result blob prefix changed identity before quarantine.",
        )
      }
      const quarantineDirectory = path.join(this.#dataDir, "blob-quarantine")
      await ensurePrivateDirectory(quarantineDirectory)
      const quarantinePath = path.join(
        quarantineDirectory,
        `prefix-${randomUUID()}`,
      )
      await fs.rename(prefixPath, quarantinePath)
      const quarantined = await fs.lstat(quarantinePath)
      const openedAfterMove = await handle.stat()
      assertPrivateBlobDirectory(quarantined, "quarantined result blob prefix")
      if (
        !sameFileIdentity(opened, openedAfterMove)
        || !sameFileIdentity(openedAfterMove, quarantined)
        || (await fs.readdir(quarantinePath)).length !== 0
      ) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "An empty result blob prefix changed identity during quarantine.",
        )
      }
      await fs.rmdir(quarantinePath)
      return true
    } finally {
      await handle.close()
    }
  }

  async #assertEmptyBlobQuarantine() {
    const quarantineDirectory = path.join(this.#dataDir, "blob-quarantine")
    try {
      const quarantine = await fs.lstat(quarantineDirectory)
      assertPrivateBlobDirectory(quarantine, "result blob quarantine")
      if ((await fs.readdir(quarantineDirectory)).length !== 0) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "The result blob quarantine contains unresolved objects.",
        )
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }

  async #removeUnreferencedBlobInventory(references) {
    let rootEntries
    let rootIdentity
    try {
      const rootBefore = await fs.lstat(this.#blobDirectory)
      assertPrivateBlobDirectory(rootBefore, "result blob root")
      rootIdentity = rootBefore
      rootEntries = await fs.readdir(this.#blobDirectory, { withFileTypes: true })
      await this.#compactionFaultInjector?.("after_blob_root_enumeration", {
        entries: rootEntries.map((entry) => entry.name).sort(),
      })
      const rootAfter = await fs.lstat(this.#blobDirectory)
      assertPrivateBlobDirectory(rootAfter, "result blob root")
      if (!sameFileIdentity(rootBefore, rootAfter)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "The result blob root changed identity during reconciliation.",
        )
      }
    } catch (error) {
      if (error.code === "ENOENT" && references.size === 0) {
        this.#blobBytes = 0
        return
      }
      if (error.code === "ENOENT") {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "The referenced result blob root is missing.",
        )
      }
      throw error
    }

    const seen = new Set()
    let retainedBytes = 0
    for (const prefixEntry of rootEntries) {
      const prefixPath = path.join(this.#blobDirectory, prefixEntry.name)
      const prefixBefore = await fs.lstat(prefixPath)
      if (!/^[a-f0-9]{2}$/.test(prefixEntry.name)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob prefix directory is not canonical.",
        )
      }
      assertPrivateBlobDirectory(prefixBefore, "result blob prefix")
      const blobEntries = await fs.readdir(prefixPath, { withFileTypes: true })
      await this.#compactionFaultInjector?.("after_blob_prefix_enumeration", {
        entries: blobEntries.map((entry) => entry.name).sort(),
        prefix: prefixEntry.name,
      })
      for (const blobEntry of blobEntries) {
        const filePath = path.join(prefixPath, blobEntry.name)
        const reference = references.get(blobEntry.name)
        if (reference && prefixEntry.name !== blobEntry.name.slice(0, 2)) {
          throw new EgoChatError(
            "corrupt_result_blob_inventory",
            "A referenced result blob exists outside its canonical digest prefix.",
          )
        }
        if (reference) {
          if (seen.has(blobEntry.name)) {
            throw new EgoChatError(
              "corrupt_result_blob_inventory",
              "A referenced result blob has duplicate inventory entries.",
            )
          }
          retainedBytes += await this.#readVerifiedBlob(
            filePath,
            blobEntry.name,
            reference,
          )
          seen.add(blobEntry.name)
        } else {
          await this.#removeSafeUnreferencedBlob(filePath)
        }
      }
      const prefixAfter = await fs.lstat(prefixPath)
      assertPrivateBlobDirectory(prefixAfter, "result blob prefix")
      if (!sameFileIdentity(prefixBefore, prefixAfter)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob prefix changed identity during reconciliation.",
        )
      }
      const expectedInPrefix = [...references.keys()].some(
        (digest) => digest.startsWith(prefixEntry.name),
      )
      if (!expectedInPrefix && (await fs.readdir(prefixPath)).length === 0) {
        await this.#removeEmptyUnreferencedPrefix(prefixPath)
      }
    }
    const rootAfterReconciliation = await fs.lstat(this.#blobDirectory)
    assertPrivateBlobDirectory(rootAfterReconciliation, "result blob root")
    if (!sameFileIdentity(rootIdentity, rootAfterReconciliation)) {
      throw new EgoChatError(
        "corrupt_result_blob_inventory",
        "The result blob root changed identity during reconciliation.",
      )
    }
    if (seen.size !== references.size) {
      throw new EgoChatError(
        "corrupt_result_blob_inventory",
        "A referenced result blob is missing from canonical inventory.",
      )
    }
    return retainedBytes
  }

  async #verifyExactBlobInventory(references) {
    let rootBefore
    let rootEntries
    try {
      rootBefore = await fs.lstat(this.#blobDirectory)
      assertPrivateBlobDirectory(rootBefore, "result blob root")
      rootEntries = await fs.readdir(this.#blobDirectory, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT" && references.size === 0) {
        return { exact: true, retainedBytes: 0 }
      }
      if (error.code === "ENOENT") {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "The referenced result blob root is missing.",
        )
      }
      throw error
    }

    const expectedPrefixes = new Set(
      [...references.keys()].map((digest) => digest.slice(0, 2)),
    )
    const seen = new Set()
    let retainedBytes = 0
    let exact = true
    for (const prefixEntry of rootEntries) {
      if (!/^[a-f0-9]{2}$/.test(prefixEntry.name)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob prefix directory is not canonical.",
        )
      }
      const prefixPath = path.join(this.#blobDirectory, prefixEntry.name)
      const prefixBefore = await fs.lstat(prefixPath)
      assertPrivateBlobDirectory(prefixBefore, "result blob prefix")
      const entriesBefore = await fs.readdir(prefixPath, { withFileTypes: true })
      if (!expectedPrefixes.has(prefixEntry.name)) exact = false
      for (const entry of entriesBefore) {
        const filePath = path.join(prefixPath, entry.name)
        const reference = references.get(entry.name)
        if (!reference) {
          assertPrivateBlobFile(await fs.lstat(filePath))
          exact = false
          continue
        }
        if (prefixEntry.name !== entry.name.slice(0, 2) || seen.has(entry.name)) {
          throw new EgoChatError(
            "corrupt_result_blob_inventory",
            "A referenced result blob has a noncanonical or duplicate inventory entry.",
          )
        }
        retainedBytes += await this.#readVerifiedBlob(
          filePath,
          entry.name,
          reference,
        )
        seen.add(entry.name)
      }
      const entriesAfter = await fs.readdir(prefixPath)
      const prefixAfter = await fs.lstat(prefixPath)
      assertPrivateBlobDirectory(prefixAfter, "result blob prefix")
      if (!sameFileIdentity(prefixBefore, prefixAfter)) {
        throw new EgoChatError(
          "corrupt_result_blob_inventory",
          "A result blob prefix changed identity during final verification.",
        )
      }
      if (!isDeepStrictEqual(
        entriesBefore.map((entry) => entry.name).sort(),
        entriesAfter.sort(),
      )) exact = false
    }
    const rootEntriesAfter = await fs.readdir(this.#blobDirectory)
    const rootAfter = await fs.lstat(this.#blobDirectory)
    assertPrivateBlobDirectory(rootAfter, "result blob root")
    if (!sameFileIdentity(rootBefore, rootAfter)) {
      throw new EgoChatError(
        "corrupt_result_blob_inventory",
        "The result blob root changed identity during final verification.",
      )
    }
    if (!isDeepStrictEqual(
      rootEntries.map((entry) => entry.name).sort(),
      rootEntriesAfter.sort(),
    )) exact = false
    if (seen.size !== references.size) {
      throw new EgoChatError(
        "corrupt_result_blob_inventory",
        "A referenced result blob is missing from canonical inventory.",
      )
    }
    return { exact, retainedBytes }
  }

  async #reconcileBlobInventory() {
    const references = this.#referencedBlobMap()
    await this.#assertEmptyBlobQuarantine()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.#removeUnreferencedBlobInventory(references)
      const verified = await this.#verifyExactBlobInventory(references)
      if (verified.exact) {
        await this.#assertEmptyBlobQuarantine()
        this.#blobBytes = verified.retainedBytes
        return
      }
    }
    throw new EgoChatError(
      "corrupt_result_blob_inventory",
      "The result blob inventory did not stabilize after bounded reconciliation.",
    )
  }

  async #compact() {
    this.#applyRetention()
    await this.#compactionFaultInjector?.("before_state")
    await writeAtomicJson(this.#statePath, this.#state)
    await this.#compactionFaultInjector?.("state")
    await writeAtomicJson(this.#checkpointPath, this.#state)
    await this.#compactionFaultInjector?.("checkpoint")
    await writeAtomicJson(this.#checkpointManifestPath, {
      createdAt: new Date().toISOString(),
      digest: digestJson(this.#state),
      nextSeq: this.#state.nextSeq,
    })
    await this.#compactionFaultInjector?.("manifest")
    await writeAtomicText(this.#eventsPath, "")
    await this.#compactionFaultInjector?.("events")
    this.#eventBytes = 0
    this.#eventsSinceCheckpoint = 0
    await this.#reconcileBlobInventory()
    await this.#compactionFaultInjector?.("blobs")
  }

  #applyRetention() {
    const workflows = Object.values(this.#state.workflows)
    const terminal = workflows
      .filter((workflow) => (
        ["cancelled", "failed", "succeeded"].includes(workflow.status)
        && !hasProtectedRecoveryState(workflow)
      ))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    for (const workflow of terminal.slice(this.#maxTerminalWorkflows)) {
      delete this.#state.workflows[workflow.id]
    }

    const now = Date.now()
    const candidates = Object.values(this.#state.workflows)
      .filter((workflow) => workflow.result?.responseRef)
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    const pinnedDigests = new Set()
    const retainedDigests = new Map()
    for (const workflow of candidates) {
      if (hasProtectedRecoveryState(workflow)) {
        const reference = workflow.result.responseRef
        pinnedDigests.add(reference.digest)
        retainedDigests.set(reference.digest, reference.sizeBytes)
      }
    }
    for (const workflow of candidates) {
      if (hasProtectedRecoveryState(workflow)) {
        continue
      }
      const reference = workflow.result.responseRef
      const ageMs = now - Date.parse(workflow.updatedAt)
      if (ageMs <= this.#rawRetentionMs) {
        retainedDigests.set(reference.digest, reference.sizeBytes)
      } else {
        this.#expireWorkflowResult(workflow)
      }
    }

    let retainedBytes = [...retainedDigests.values()].reduce((total, size) => total + size, 0)
    for (const workflow of candidates) {
      if (retainedBytes <= this.#maxBlobBytes) {
        break
      }
      const reference = workflow.result?.responseRef
      if (
        !reference
        || pinnedDigests.has(reference.digest)
        || !retainedDigests.has(reference.digest)
      ) {
        continue
      }
      retainedBytes -= retainedDigests.get(reference.digest)
      retainedDigests.delete(reference.digest)
      for (const shared of candidates) {
        if (
          !hasProtectedRecoveryState(shared)
          && shared.result?.responseRef?.digest === reference.digest
        ) {
          this.#expireWorkflowResult(shared)
        }
      }
    }
    return { retainedDigests }
  }

  #expireWorkflowResult(workflow) {
    const result = workflow.result
    const excerpt = typeof result.responseExcerpt === "string"
      ? result.responseExcerpt
      : (typeof result.responseText === "string" ? result.responseText.slice(0, 4 * 1024) : undefined)
    workflow.result = {
      ...result,
      ...(excerpt ? { responseExcerpt: excerpt } : {}),
      responseExpired: true,
    }
    delete workflow.result.responseRef
    delete workflow.result.responseText
  }
}
