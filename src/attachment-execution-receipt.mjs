import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

const MAX_IJSON_INTEGER = 9_007_199_254_740_991
const MAX_ATTACHMENT_EVIDENCE_ITEMS = 64
const MAX_ATTACHMENT_OBSERVATION_BYTES = 128 * 1024
const ATTACHMENT_OBSERVATION_KEYS = [
  "artifacts",
  "asset_pointer_state",
  "canonical_conversation_locator_sha256",
  "capture_operation_key_sha256",
  "continuation_cursor_present",
  "direct_branch_ids",
  "direct_response_branch_count",
  "generated_image_artifact_count",
  "generation_terminal",
  "graph_complete",
  "graph_truncated",
  "hydration_pending",
  "non_image_artifact_count",
  "normal_download_control_count",
  "normal_save_control_count",
  "observation_sequence",
  "observed_at",
  "provider_nodes",
  "provider_prompt_message_id",
  "react_save_download_prop_count",
  "response_message_id",
  "save_association_candidates",
  "save_association_id",
  "schema",
  "selected_branch_id",
  "source_confirmed_send_identity_sha256",
  "total_artifact_count",
  "ui_action_surface_complete",
  "unclassified_artifact_count",
  "visible_attachment_actions",
].sort()
const ATTACHMENT_ARTIFACT_KEYS = [
  "artifact_id",
  "artifact_kind",
  "dom_wrapper_id",
  "file_id",
  "generation_id",
  "graph_attachment_id",
  "image_message_id",
].sort()
const SAVE_ASSOCIATION_CANDIDATE_KEYS = [
  "association_id",
  "control_id",
  "dom_attachment_id",
  "graph_attachment_id",
].sort()
const PROVIDER_NODE_KEYS = [
  "message_id",
  "parent_id",
  "provider_status",
  "terminal",
  "turn_exchange_id",
].sort()
const ATTACHMENT_ACTIONS = new Set([
  "DOWNLOAD_IMAGE",
  "EDIT_IMAGE",
  "SAVE_IMAGE",
  "SHARE_IMAGE",
  "UNKNOWN",
])
const PROVIDER_STATUSES = new Set(["COMPLETE", "FAILED", "IN_PROGRESS", "UNKNOWN"])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SIGNED_ATTACHMENT_ENVELOPE_KEYS = [
  "authority_domain",
  "media_type",
  "payload_base64url",
  "payload_sha256",
  "schema",
  "signature_base64url",
  "signature_input_domain",
  "signer_key_id",
].sort()
const TERMINAL_EVIDENCE_DOES_NOT_GRANT = Object.freeze([
  "send",
  "send-retry",
  "image-generation",
  "image-editing",
  "attachment-capture",
  "save-or-download",
  "binary-measurement",
  "source-approval",
  "runtime-approval",
  "repository-write",
  "scheduler-activation",
  "production-queue-activation",
  "shipping",
])

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true
      index += 1
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return true
    }
  }
  return false
}

function canonicalString(value) {
  if (hasLoneSurrogate(value)) {
    throw new EgoChatError(
      "invalid_canonical_json",
      "Receipt evidence contains an unpaired Unicode surrogate.",
    )
  }
  return JSON.stringify(value)
}

function canonicalize(value, seen) {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") {
    return canonicalString(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_IJSON_INTEGER) {
      throw new EgoChatError(
        "invalid_canonical_json",
        "Receipt evidence permits only interoperable I-JSON integers.",
      )
    }
    return String(value)
  }
  if (typeof value !== "object" || value === undefined) {
    throw new EgoChatError(
      "invalid_canonical_json",
      "Receipt evidence contains a value outside the closed I-JSON domain.",
    )
  }
  if (seen.has(value)) {
    throw new EgoChatError("invalid_canonical_json", "Receipt evidence contains a cycle.")
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length
        || Object.keys(value).some((key, index) => key !== String(index))
      ) {
        throw new EgoChatError(
          "invalid_canonical_json",
          "Receipt evidence arrays must be dense and have no named properties.",
        )
      }
      return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EgoChatError(
        "invalid_canonical_json",
        "Receipt evidence contains a non-JSON object.",
      )
    }
    const keys = Object.keys(value).sort((left, right) => (
      left < right ? -1 : (left > right ? 1 : 0)
    ))
    return `{${keys.map((key) => (
      `${canonicalString(key)}:${canonicalize(value[key], seen)}`
    )).join(",")}}`
  } finally {
    seen.delete(value)
  }
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalize(value, new Set()), "utf8")
}

function isBoundedOpaqueId(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 200
    && !value.includes("\0")
}

function isBoundedUniqueIdArray(value) {
  return Array.isArray(value)
    && value.length <= MAX_ATTACHMENT_EVIDENCE_ITEMS
    && value.every(isBoundedOpaqueId)
    && new Set(value).size === value.length
}

function isNullableOpaqueId(value) {
  return value === null || isBoundedOpaqueId(value)
}

function isCount(value) {
  return value === null || (
    Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_ATTACHMENT_EVIDENCE_ITEMS
  )
}

function unknownAttachmentOutcome(reason) {
  return { outcome: "UNKNOWN", reason }
}

function hasClosedAttachmentObservationShape(observation) {
  if (
    !observation
    || typeof observation !== "object"
    || Array.isArray(observation)
    || observation.schema !== "ego-chat-attachment-graph-observation/v1"
    || !isDeepStrictKeySet(observation, ATTACHMENT_OBSERVATION_KEYS)
  ) {
    throw new EgoChatError(
      "invalid_attachment_observation",
      "The attachment observation is outside the closed evidence schema.",
    )
  }
}

function hasSortedUniqueAttachmentActions(value) {
  return Array.isArray(value)
    && value.length <= ATTACHMENT_ACTIONS.size
    && value.every((action) => ATTACHMENT_ACTIONS.has(action))
    && value.every((action, index) => index === 0 || value[index - 1] < action)
}

function hasValidProviderNodes(value) {
  return Array.isArray(value)
    && value.length <= MAX_ATTACHMENT_EVIDENCE_ITEMS
    && value.every((node) => (
      isDeepStrictKeySet(node, PROVIDER_NODE_KEYS)
      && isBoundedOpaqueId(node.message_id)
      && isNullableOpaqueId(node.parent_id)
      && isNullableOpaqueId(node.turn_exchange_id)
      && PROVIDER_STATUSES.has(node.provider_status)
      && typeof node.terminal === "boolean"
    ))
    && new Set(value.map((node) => node.message_id)).size === value.length
}

function hasValidArtifacts(value) {
  if (
    !Array.isArray(value)
    || value.length > MAX_ATTACHMENT_EVIDENCE_ITEMS
    || new Set(value.map((artifact) => artifact?.artifact_id)).size !== value.length
  ) {
    return false
  }
  return value.every((artifact) => {
    if (
      !isDeepStrictKeySet(artifact, ATTACHMENT_ARTIFACT_KEYS)
      || !isBoundedOpaqueId(artifact.artifact_id)
      || !["GENERATED_IMAGE", "NON_IMAGE", "UNCLASSIFIED"].includes(
        artifact.artifact_kind,
      )
      || !isNullableOpaqueId(artifact.dom_wrapper_id)
      || !isNullableOpaqueId(artifact.file_id)
      || !isNullableOpaqueId(artifact.generation_id)
      || !isNullableOpaqueId(artifact.graph_attachment_id)
      || !isNullableOpaqueId(artifact.image_message_id)
    ) {
      return false
    }
    const imageIds = [
      artifact.dom_wrapper_id,
      artifact.file_id,
      artifact.generation_id,
      artifact.graph_attachment_id,
      artifact.image_message_id,
    ]
    if (artifact.artifact_kind === "GENERATED_IMAGE") {
      return imageIds.every(isBoundedOpaqueId)
    }
    return imageIds.every((value) => value === null)
  })
}

function hasValidSaveAssociationCandidates(value) {
  if (
    !Array.isArray(value)
    || value.length > MAX_ATTACHMENT_EVIDENCE_ITEMS
    || new Set(value.map((candidate) => candidate?.association_id)).size !== value.length
    || new Set(value.map((candidate) => candidate?.control_id)).size !== value.length
  ) return false
  return value.every((candidate) => (
    isDeepStrictKeySet(candidate, SAVE_ASSOCIATION_CANDIDATE_KEYS)
    && Object.values(candidate).every(isBoundedOpaqueId)
  ))
}

function parseObservationTimestamp(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null
}

export function assertValidAttachmentGraphObservation(observation) {
  hasClosedAttachmentObservationShape(observation)
  let serializedBytes
  try {
    serializedBytes = canonicalJsonBytes(observation).length
  } catch {
    throw new EgoChatError(
      "invalid_attachment_observation",
      "The attachment observation is outside the canonical evidence domain.",
    )
  }
  if (
    serializedBytes > MAX_ATTACHMENT_OBSERVATION_BYTES
    || !SHA256_PATTERN.test(observation.source_confirmed_send_identity_sha256)
    || !SHA256_PATTERN.test(observation.capture_operation_key_sha256)
    || !SHA256_PATTERN.test(observation.canonical_conversation_locator_sha256)
    || !Number.isSafeInteger(observation.observation_sequence)
    || observation.observation_sequence < 1
    || parseObservationTimestamp(observation.observed_at) === null
    || !isBoundedOpaqueId(observation.provider_prompt_message_id)
    || !isNullableOpaqueId(observation.response_message_id)
    || !isNullableOpaqueId(observation.selected_branch_id)
    || !isNullableOpaqueId(observation.save_association_id)
    || typeof observation.graph_complete !== "boolean"
    || typeof observation.graph_truncated !== "boolean"
    || typeof observation.continuation_cursor_present !== "boolean"
    || typeof observation.generation_terminal !== "boolean"
    || typeof observation.hydration_pending !== "boolean"
    || typeof observation.ui_action_surface_complete !== "boolean"
    || !isCount(observation.direct_response_branch_count)
    || !isCount(observation.total_artifact_count)
    || !isCount(observation.generated_image_artifact_count)
    || !isCount(observation.non_image_artifact_count)
    || !isCount(observation.unclassified_artifact_count)
    || !isCount(observation.normal_save_control_count)
    || !isCount(observation.normal_download_control_count)
    || !isCount(observation.react_save_download_prop_count)
    || !isBoundedUniqueIdArray(observation.direct_branch_ids)
    || !hasValidProviderNodes(observation.provider_nodes)
    || !hasValidArtifacts(observation.artifacts)
    || !hasValidSaveAssociationCandidates(observation.save_association_candidates)
    || !hasSortedUniqueAttachmentActions(observation.visible_attachment_actions)
    || !["ABSENT", "PRESENT_NON_CONTROL"].includes(observation.asset_pointer_state)
  ) {
    throw new EgoChatError(
      "invalid_attachment_observation",
      "The attachment observation contains unsupported or unbounded evidence.",
    )
  }
  return observation
}

function structuralAttachmentOutcome(observation) {
  try {
    assertValidAttachmentGraphObservation(observation)
  } catch {
    return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")
  }
  if (
    !observation.graph_complete
    || observation.continuation_cursor_present
  ) return unknownAttachmentOutcome("INCOMPLETE_GRAPH")
  if (observation.graph_truncated) return unknownAttachmentOutcome("TRUNCATED_GRAPH")
  if (!observation.generation_terminal) return unknownAttachmentOutcome("GENERATION_ACTIVE")
  if (observation.hydration_pending) return unknownAttachmentOutcome("HYDRATION_PENDING")
  if (!observation.ui_action_surface_complete) {
    return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")
  }
  if (
    observation.provider_nodes.some((node) => (
      node.provider_status === "UNKNOWN"
      || node.provider_status === "IN_PROGRESS"
      || node.provider_status === "FAILED"
      || !node.terminal
    ))
    || observation.visible_attachment_actions.includes("UNKNOWN")
  ) return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")

  const counts = [
    observation.direct_response_branch_count,
    observation.total_artifact_count,
    observation.generated_image_artifact_count,
    observation.non_image_artifact_count,
    observation.unclassified_artifact_count,
    observation.normal_save_control_count,
    observation.normal_download_control_count,
    observation.react_save_download_prop_count,
  ]
  if (counts.includes(null)) return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")
  const artifactKindCounts = observation.artifacts.reduce((result, artifact) => {
    result[artifact.artifact_kind] += 1
    return result
  }, { GENERATED_IMAGE: 0, NON_IMAGE: 0, UNCLASSIFIED: 0 })
  if (
    observation.total_artifact_count
      !== observation.generated_image_artifact_count
        + observation.non_image_artifact_count
        + observation.unclassified_artifact_count
    || observation.artifacts.length !== observation.total_artifact_count
    || artifactKindCounts.GENERATED_IMAGE !== observation.generated_image_artifact_count
    || artifactKindCounts.NON_IMAGE !== observation.non_image_artifact_count
    || artifactKindCounts.UNCLASSIFIED !== observation.unclassified_artifact_count
    || observation.save_association_candidates.length
      !== observation.normal_save_control_count
    || observation.direct_branch_ids.length !== observation.direct_response_branch_count
    || (
      observation.selected_branch_id !== null
      && !observation.direct_branch_ids.includes(observation.selected_branch_id)
    )
    || (
      observation.response_message_id !== null
      && !observation.provider_nodes.some(
        (node) => node.message_id === observation.response_message_id,
      )
    )
  ) {
    return unknownAttachmentOutcome("INCOHERENT_COUNTS")
  }
  if (observation.unclassified_artifact_count > 0) {
    return unknownAttachmentOutcome("UNCLASSIFIED_ARTIFACT")
  }
  return null
}

function stableObservationProjection(observation) {
  const projection = { ...observation }
  delete projection.observation_sequence
  delete projection.observed_at
  return projection
}

function attachmentEvidenceObservation(observation, classification) {
  const exact = classification.outcome === "EXACTLY_ONE"
  const artifact = exact ? observation.artifacts[0] : null
  return {
    artifact_identities: observation.artifacts.map((candidate) => ({
      artifact_id: candidate.artifact_kind === "GENERATED_IMAGE"
        ? candidate.graph_attachment_id
        : candidate.artifact_id,
      artifact_kind: candidate.artifact_kind,
      branch_id: candidate.artifact_kind === "GENERATED_IMAGE"
        ? observation.selected_branch_id
        : null,
      dom_attachment_id: candidate.dom_wrapper_id,
      graph_attachment_id: candidate.graph_attachment_id,
      response_message_id: candidate.artifact_kind === "GENERATED_IMAGE"
        ? observation.response_message_id
        : null,
    })),
    branch_id: exact ? observation.selected_branch_id : null,
    classification_reason: classification.outcome === "UNKNOWN"
      ? classification.reason
      : null,
    direct_response_branch_count: observation.direct_response_branch_count,
    dom_attachment_id: exact ? artifact.dom_wrapper_id : null,
    dom_snapshot_sha256: sha256Hex(canonicalJsonBytes({
      artifacts: observation.artifacts.map((candidate) => ({
        artifact_id: candidate.artifact_id,
        dom_wrapper_id: candidate.dom_wrapper_id,
      })),
      normal_download_control_count: observation.normal_download_control_count,
      normal_save_control_count: observation.normal_save_control_count,
      save_association_candidates: observation.save_association_candidates,
    })),
    generated_image_artifact_count: observation.generated_image_artifact_count,
    graph_attachment_id: exact ? artifact.graph_attachment_id : null,
    graph_complete: observation.graph_complete,
    graph_snapshot_sha256: sha256Hex(
      canonicalJsonBytes(stableObservationProjection(observation)),
    ),
    graph_truncated: observation.graph_truncated,
    non_image_artifact_count: observation.non_image_artifact_count,
    normal_download_control_count: observation.normal_download_control_count,
    normal_save_control_count: observation.normal_save_control_count,
    observed_at: observation.observed_at,
    observed_save_association_id: observation.save_association_id,
    response_message_id: exact ? observation.response_message_id : null,
    response_snapshot_sha256: sha256Hex(canonicalJsonBytes({
      direct_branch_ids: observation.direct_branch_ids,
      response_message_id: observation.response_message_id,
      selected_branch_id: observation.selected_branch_id,
    })),
    save_association_candidates: structuredClone(
      observation.save_association_candidates,
    ),
    save_association_id: exact ? observation.save_association_id : null,
    terminal_generation: observation.generation_terminal,
    total_artifact_count: observation.total_artifact_count,
    unclassified_artifact_count: observation.unclassified_artifact_count,
  }
}

function attachmentEvidenceJournalEntry(entry) {
  const restarted = entry.reason === "BROKER_RESTART"
  const recovering = restarted || entry.reason === "DRIVER_RECOVERY"
  if (!recovering && entry.reason !== "OBSERVATION_RECORDED") {
    throw new EgoChatError(
      "invalid_attachment_capture_operation",
      "The capture journal cannot be projected into consumer evidence.",
    )
  }
  return {
    attempt_number: entry.attempt_number,
    candidate_generation: entry.candidate_generation,
    dom_snapshot_sha256: restarted ? null : entry.dom_snapshot_sha256,
    graph_snapshot_sha256: restarted ? null : entry.graph_snapshot_sha256,
    observed_at: entry.attempted_at,
    reason: restarted
      ? "RESTARTED"
      : (recovering ? "DRIVER_LOST" : "OBSERVED"),
    response_snapshot_sha256: restarted ? null : entry.response_snapshot_sha256,
    state: recovering ? "RECOVERING" : "CANDIDATE",
  }
}

export function buildAttachmentEvidenceCapture(
  captureOperation,
  terminalClassification = undefined,
) {
  if (
    !Number.isSafeInteger(captureOperation?.candidate_generation)
    || captureOperation.candidate_generation < 0
    || captureOperation.candidate_generation > 32
  ) {
    throw new EgoChatError(
      "invalid_attachment_capture_operation",
      "The capture candidate generation is outside the closed 0..32 bound.",
    )
  }
  const retained = captureOperation.candidate_observations.length === 2
    ? captureOperation.candidate_observations
    : []
  const classification = terminalClassification ?? (retained.length === 2
    ? classifyAttachmentExecutionObservations(retained)
    : { outcome: "UNKNOWN", reason: null })
  if (
    !classification
    || !["EXACTLY_ONE", "MULTIPLE", "ZERO", "UNKNOWN"].includes(classification.outcome)
    || (classification.outcome === "UNKNOWN"
      ? !ATTACHMENT_UNKNOWN_REASONS.has(classification.reason)
      : typeof classification.reason !== "string")
  ) {
    throw new EgoChatError(
      "invalid_attachment_capture_operation",
      "The capture terminal classification is invalid.",
    )
  }
  return {
    accumulated_monotonic_ms: captureOperation.accumulated_monotonic_ms,
    attempt_journal: captureOperation.attempt_journal.map(
      attachmentEvidenceJournalEntry,
    ),
    candidate_generation: captureOperation.candidate_generation,
    candidate_observations: retained.map((observation) => (
      attachmentEvidenceObservation(observation, classification)
    )),
    candidate_pair_count: captureOperation.candidate_pair_count,
    capture_deadline_at: captureOperation.capture_deadline_at,
    capture_operation_key_sha256: captureOperation.capture_operation_key_sha256,
    capture_started_at: captureOperation.capture_started_at,
    confirmed_send_identity_sha256:
      captureOperation.confirmed_send_identity_sha256,
    schema: "ego-chat-attachment-capture-operation/v1",
    source_workflow_id: captureOperation.source_workflow_id,
    state: "TERMINAL",
    terminal_disposition_sha256:
      captureOperation.terminal_disposition_sha256,
    terminal_envelope_sha256: captureOperation.terminal_envelope_sha256,
  }
}

function attachmentEvidenceCaptureProjectionDigest(captureOperation, classification) {
  const capture = buildAttachmentEvidenceCapture(captureOperation, classification)
  const projection = { ...capture }
  delete projection.schema
  delete projection.terminal_disposition_sha256
  delete projection.terminal_envelope_sha256
  return sha256Hex(canonicalJsonBytes({
    schema: "ego-chat-attachment-capture-evidence-projection/v1",
    ...projection,
  }))
}

export function classifyAttachmentExecutionObservations(observations) {
  if (!Array.isArray(observations) || observations.length !== 2) {
    throw new EgoChatError(
      "invalid_attachment_observation",
      "Attachment classification requires exactly two stable observations.",
    )
  }
  for (const observation of observations) hasClosedAttachmentObservationShape(observation)
  for (const observation of observations) {
    const structural = structuralAttachmentOutcome(observation)
    if (structural) return structural
  }
  const [first, final] = observations
  if (
    final.observation_sequence !== first.observation_sequence + 1
    || parseObservationTimestamp(final.observed_at)
      - parseObservationTimestamp(first.observed_at) < 750
    || parseObservationTimestamp(final.observed_at)
      - parseObservationTimestamp(first.observed_at) > 2_000
    || !canonicalJsonBytes(stableObservationProjection(first)).equals(
      canonicalJsonBytes(stableObservationProjection(final)),
    )
  ) {
    return unknownAttachmentOutcome("UNSTABLE_EVIDENCE")
  }
  const observation = final
  if (observation.direct_response_branch_count > 1) {
    return { outcome: "MULTIPLE", reason: "MULTIPLE_RESPONSE_BRANCHES" }
  }
  if (observation.generated_image_artifact_count > 1) {
    return { outcome: "MULTIPLE", reason: "MULTIPLE_GENERATED_IMAGES" }
  }
  if (
    observation.generated_image_artifact_count === 1
    && observation.total_artifact_count > 1
  ) {
    return { outcome: "MULTIPLE", reason: "MULTIPLE_TOTAL_ARTIFACTS" }
  }
  if (
    observation.direct_response_branch_count === 1
    && observation.total_artifact_count === 1
    && observation.generated_image_artifact_count === 1
    && observation.non_image_artifact_count === 0
  ) {
    if (
      !isBoundedOpaqueId(observation.response_message_id)
      || !isBoundedOpaqueId(observation.selected_branch_id)
    ) {
      return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")
    }
    const [artifact] = observation.artifacts
    const [association] = observation.save_association_candidates
    const associationMatchesArtifact = association
      && association.dom_attachment_id === artifact.dom_wrapper_id
      && association.graph_attachment_id === artifact.graph_attachment_id
      && association.association_id === observation.save_association_id
    if (
      observation.normal_save_control_count > 1
      || observation.save_association_candidates.length > 1
      || (
        observation.save_association_id !== null
        && observation.normal_save_control_count !== 1
      )
      || (
        observation.normal_save_control_count === 1
        && !observation.visible_attachment_actions.includes("SAVE_IMAGE")
      )
      || (
        observation.normal_save_control_count === 0
        && observation.visible_attachment_actions.includes("SAVE_IMAGE")
      )
      || (
        observation.normal_save_control_count === 1
        && !associationMatchesArtifact
      )
    ) {
      return unknownAttachmentOutcome("AMBIGUOUS_SAVE_ASSOCIATION")
    }
    if (
      observation.normal_save_control_count !== 1
      || observation.save_association_candidates.length !== 1
      || !isBoundedOpaqueId(observation.save_association_id)
    ) {
      return unknownAttachmentOutcome("UNSUPPORTED_SAVE_ASSOCIATION")
    }
    return { outcome: "EXACTLY_ONE", reason: "EXACTLY_ONE_SUPPORTED" }
  }
  if (
    observation.generated_image_artifact_count === 0
    && (
      observation.normal_save_control_count !== 0
      || observation.save_association_candidates.length !== 0
      || observation.save_association_id !== null
    )
  ) {
    return unknownAttachmentOutcome("AMBIGUOUS_SAVE_ASSOCIATION")
  }
  if (
    observation.direct_response_branch_count <= 1
    && observation.generated_image_artifact_count === 0
  ) {
    return { outcome: "ZERO", reason: "ZERO_GENERATED_IMAGES" }
  }
  return unknownAttachmentOutcome("INCOHERENT_COUNTS")
}

function isDeepStrictKeySet(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function operationKeyDigest(operationKey) {
  return sha256Hex(Buffer.concat([
    Buffer.from("EGO_CHAT_OPERATION_KEY_V1\0", "ascii"),
    Buffer.from(operationKey, "utf8"),
  ]))
}

export function attachmentCaptureOperationKeyDigest(confirmedSendIdentityDigest) {
  if (!SHA256_PATTERN.test(confirmedSendIdentityDigest)) {
    throw new EgoChatError(
      "invalid_attachment_capture_operation",
      "Confirmed Send identity digest is invalid.",
    )
  }
  return sha256Hex(Buffer.concat([
    Buffer.from("EGO_CHAT_ATTACHMENT_CAPTURE_V1\0", "ascii"),
    Buffer.from(confirmedSendIdentityDigest, "hex"),
  ]))
}

export function buildAttachmentCaptureOperation({
  confirmedSendIdentityDigest,
  sourceWorkflowId,
  startedAt,
}) {
  const startedAtMs = Date.parse(startedAt)
  if (
    !/^[a-f0-9]{64}$/.test(confirmedSendIdentityDigest)
    || !Number.isFinite(startedAtMs)
    || new Date(startedAtMs).toISOString() !== startedAt
  ) {
    throw new EgoChatError(
      "invalid_attachment_capture_operation",
      "Attachment capture operation identity is invalid.",
    )
  }
  return {
    accumulated_monotonic_ms: 0,
    attempt_journal: [],
    candidate_generation: 0,
    candidate_observations: [],
    candidate_pair_count: 0,
    capture_deadline_at: new Date(startedAtMs + 10 * 60 * 1_000).toISOString(),
    capture_operation_key_sha256: attachmentCaptureOperationKeyDigest(
      confirmedSendIdentityDigest,
    ),
    capture_started_at: startedAt,
    confirmed_send_identity_sha256: confirmedSendIdentityDigest,
    schema: "ego-chat-attachment-capture-operation/v1",
    source_workflow_id: sourceWorkflowId,
    state: "CAPTURING",
    terminal_disposition_sha256: null,
    terminal_envelope_sha256: null,
  }
}

export function buildAttachmentCaptureIntent({
  authorizationDigest,
  createdAt,
  externalBindingDigest,
  operationKey,
  profile,
  runtimeIdentity,
  signerEnrollmentDigest,
  signerKeyId,
  workflowId,
}) {
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
    throw new EgoChatError(
      "invalid_attachment_capture_intent",
      "Attachment capture intent creation time is invalid.",
    )
  }
  const qualifiedRuntimeIdentity = {
    ...runtimeIdentity,
    runtime_identity_sha256: sha256Hex(canonicalJsonBytes(runtimeIdentity)),
  }
  const intent = {
    consumer_signer_authorization_sha256: authorizationDigest,
    created_at: createdAt,
    external_binding_sha256: externalBindingDigest,
    live_reservation_bytes: 1024 * 1024,
    permanent_reservation_bytes: 32 * 1024,
    profile,
    qualified_runtime_identity: qualifiedRuntimeIdentity,
    schema: "ego-chat-attachment-capture-intent/v1",
    send_resolution_deadline_at: new Date(createdAtMs + 10 * 60 * 1_000).toISOString(),
    signer_enrollment_sha256: signerEnrollmentDigest,
    signer_key_id: signerKeyId,
    source_operation_key_sha256: operationKeyDigest(operationKey),
    source_workflow_id: workflowId,
    state: "RESERVED",
  }
  return {
    digest: sha256Hex(canonicalJsonBytes(intent)),
    intent,
  }
}

function terminalEvidenceLineage(intent) {
  if (
    !intent
    || typeof intent !== "object"
    || Array.isArray(intent)
    || !isBoundedOpaqueId(intent.profile)
    || !isBoundedOpaqueId(intent.source_workflow_id)
    || !SHA256_PATTERN.test(intent.source_operation_key_sha256)
    || !SHA256_PATTERN.test(intent.external_binding_sha256)
    || !SHA256_PATTERN.test(intent.consumer_signer_authorization_sha256)
    || !SHA256_PATTERN.test(intent.signer_enrollment_sha256)
    || !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(intent.signer_key_id)
    || !intent.qualified_runtime_identity
  ) {
    throw new EgoChatError(
      "invalid_terminal_evidence_disposition",
      "Terminal evidence intent lineage is invalid.",
    )
  }
  return {
    capture_intent_sha256: sha256Hex(canonicalJsonBytes(intent)),
    consumer_signer_authorization_sha256:
      intent.consumer_signer_authorization_sha256,
    does_not_grant: TERMINAL_EVIDENCE_DOES_NOT_GRANT,
    external_binding_sha256: intent.external_binding_sha256,
    profile: intent.profile,
    qualified_runtime_identity: intent.qualified_runtime_identity,
    signer_enrollment_sha256: intent.signer_enrollment_sha256,
    signer_key_id: intent.signer_key_id,
    source_operation_key_sha256: intent.source_operation_key_sha256,
    source_workflow_id: intent.source_workflow_id,
  }
}

export function buildAmbiguousSendDisposition({
  brokerEpoch,
  browserFencingGeneration,
  firstObservationAt,
  intent,
  lastObservationAt,
  preDispatchTurnMarker,
  terminalAt,
}) {
  if (
    !Number.isSafeInteger(brokerEpoch)
    || brokerEpoch < 0
    || !Number.isSafeInteger(browserFencingGeneration)
    || browserFencingGeneration < 0
    || !isBoundedOpaqueId(preDispatchTurnMarker)
    || ![firstObservationAt, lastObservationAt, terminalAt].every(
      (value) => parseObservationTimestamp(value) !== null,
    )
  ) {
    throw new EgoChatError(
      "invalid_terminal_evidence_disposition",
      "Ambiguous Send evidence is invalid.",
    )
  }
  return {
    authority_domain: "send-ambiguity-observation-only",
    broker_epoch: brokerEpoch,
    browser_fencing_generation: browserFencingGeneration,
    ...terminalEvidenceLineage(intent),
    first_observation_at: firstObservationAt,
    last_observation_at: lastObservationAt,
    media_type: "application/vnd.ego-chat.ambiguous-send-disposition.v1+jcs",
    outcome: "SEND_OUTCOME_UNKNOWN",
    pre_dispatch_turn_marker: preDispatchTurnMarker,
    reason: "SEND_CONFIRMATION_AMBIGUOUS",
    schema: "ego-chat-ambiguous-send-disposition/v1",
    signature_input_domain: "EGO_CHAT_AMBIGUOUS_SEND_DISPOSITION_V1",
    terminal_at: terminalAt,
  }
}

export function buildConfirmedSendAbsenceDisposition({
  browserFencingGeneration,
  dispatchAttempts,
  intent,
  observedAt,
  terminalAt,
}) {
  if (
    !Number.isSafeInteger(browserFencingGeneration)
    || browserFencingGeneration < 0
    || !Array.isArray(dispatchAttempts)
    || dispatchAttempts.length > 32
    || ![observedAt, terminalAt].every(
      (value) => parseObservationTimestamp(value) !== null,
    )
    || dispatchAttempts.some((attempt, index) => (
      !attempt
      || typeof attempt !== "object"
      || Array.isArray(attempt)
      || !isDeepStrictKeySet(attempt, [
        "attempt_number",
        "browser_fencing_generation",
        "observed_at",
        "outcome",
      ])
      || attempt.attempt_number !== index + 1
      || attempt.browser_fencing_generation !== browserFencingGeneration
      || parseObservationTimestamp(attempt.observed_at) === null
      || attempt.outcome !== "ABSENT"
    ))
  ) {
    throw new EgoChatError(
      "invalid_terminal_evidence_disposition",
      "Confirmed Send absence evidence is invalid.",
    )
  }
  return {
    ambiguous_provider_outcome_observed: false,
    authority_domain: "send-absence-observation-only",
    browser_fencing_generation: browserFencingGeneration,
    ...terminalEvidenceLineage(intent),
    confirmed_provider_outcome_observed: false,
    dispatch_attempts: structuredClone(dispatchAttempts),
    media_type: "application/vnd.ego-chat.confirmed-send-absence.v1+jcs",
    observed_at: observedAt,
    outcome: "CONFIRMED_NOT_SENT",
    reason: dispatchAttempts.length === 0
      ? "NO_DISPATCH_ATTEMPT_OCCURRED"
      : "ALL_DISPATCH_ATTEMPTS_PROVEN_ABSENT",
    schema: "ego-chat-confirmed-send-absence/v1",
    signature_input_domain: "EGO_CHAT_CONFIRMED_SEND_ABSENCE_V1",
    terminal_at: terminalAt,
  }
}

export function buildTerminalEvidenceBundle({
  dispositionEnvelope,
  externalBinding,
  intent,
  schema,
  sourceOperationKey,
  sourceWorkflowId,
}) {
  if (
    ![
      "ego-chat-ambiguous-send-evidence-bundle/v1",
      "ego-chat-confirmed-send-absence-evidence-bundle/v1",
    ].includes(schema)
    || sourceWorkflowId !== intent?.source_workflow_id
    || !isBoundedOpaqueId(sourceOperationKey)
  ) {
    throw new EgoChatError(
      "invalid_terminal_evidence_bundle",
      "Terminal evidence bundle lineage is invalid.",
    )
  }
  return {
    disposition_envelope: structuredClone(dispositionEnvelope),
    external_binding: structuredClone(externalBinding),
    intent: structuredClone(intent),
    schema,
    source_operation_key: sourceOperationKey,
    source_workflow_id: sourceWorkflowId,
  }
}

export function buildAttachmentEvidenceBundle({
  capture,
  confirmedSendEvent,
  confirmedSendIdentity,
  dispositionEnvelope,
  exactPrompt,
  externalBinding,
  intent,
  sourceOperationKey,
  sourceWorkflowId,
}) {
  if (
    sourceWorkflowId !== intent?.source_workflow_id
    || sourceWorkflowId !== capture?.source_workflow_id
    || sourceWorkflowId !== confirmedSendIdentity?.source_workflow_id
    || sourceWorkflowId !== confirmedSendEvent?.workflow_id
    || !isBoundedOpaqueId(sourceOperationKey)
    || !(exactPrompt instanceof Uint8Array)
  ) {
    throw new EgoChatError(
      "invalid_terminal_evidence_bundle",
      "Attachment evidence bundle lineage is invalid.",
    )
  }
  return {
    capture: structuredClone(capture),
    confirmed_send_event: structuredClone(confirmedSendEvent),
    confirmed_send_identity: structuredClone(confirmedSendIdentity),
    disposition_envelope: structuredClone(dispositionEnvelope),
    exact_prompt_utf8_base64url: Buffer.from(exactPrompt).toString("base64url"),
    external_binding: structuredClone(externalBinding),
    intent: structuredClone(intent),
    schema: "ego-chat-attachment-evidence-bundle/v1",
    source_operation_key: sourceOperationKey,
    source_workflow_id: sourceWorkflowId,
  }
}

export function buildConfirmedSendIdentity({ intent, intentDigest, sequence, sent, workflow }) {
  const canonicalUrl = new URL(sent.canonicalUrl)
  const match = canonicalUrl.pathname.match(/(?:^|\/)c\/([^/]+)(?:\/|$)/)
  if (!match || Buffer.byteLength(match[1], "utf8") > 200) {
    throw new EgoChatError(
      "invalid_confirmed_send_identity",
      "Confirmed Send has no bounded canonical conversation identity.",
    )
  }
  const eventProjection = {
    event_type: "send_confirmed",
    operation_key_sha256: operationKeyDigest(workflow.operationKey),
    prompt_message_id: sent.promptMessageId,
    schema: "ego-chat-confirmed-send-event/v1",
    sent_at: sent.sentAt,
    sequence,
    workflow_id: workflow.id,
  }
  const beforeHead = workflow.reconciliation.beforeHead
  const identity = {
    before_head_content_sha256: beforeHead.contentDigest,
    before_head_fingerprint: beforeHead.fingerprint,
    before_head_fingerprint_version: beforeHead.fingerprintVersion,
    before_head_message_id: beforeHead.messageId,
    before_head_role: beforeHead.role,
    binding_key: workflow.bindingKey,
    binding_revision: workflow.reconciliation.bindingRevision,
    canonical_conversation_url_sha256: sha256Hex(
      Buffer.from(sent.canonicalUrl, "utf8"),
    ),
    capture_intent_sha256: intentDigest,
    consumer_signer_authorization_sha256: intent.consumer_signer_authorization_sha256,
    conversation_id: match[1],
    exact_prompt_utf8_byte_length: Buffer.byteLength(workflow.private.request.prompt, "utf8"),
    exact_prompt_utf8_sha256: workflow.inputDigest,
    external_binding_sha256: intent.external_binding_sha256,
    provider_prompt_message_id: sent.promptMessageId,
    qualified_runtime_identity: intent.qualified_runtime_identity,
    schema: "ego-chat-confirmed-send-identity/v1",
    send_event_sequence: sequence,
    send_event_sha256: sha256Hex(canonicalJsonBytes(eventProjection)),
    sent_at: sent.sentAt,
    signer_enrollment_sha256: intent.signer_enrollment_sha256,
    signer_key_id: intent.signer_key_id,
    source_operation_key_sha256: intent.source_operation_key_sha256,
    source_workflow_id: workflow.id,
    turn_marker: workflow.reconciliation.turnMarker,
  }
  return {
    event: {
      ...eventProjection,
      confirmed_send_identity_sha256: sha256Hex(canonicalJsonBytes(identity)),
    },
    identity,
  }
}

const ATTACHMENT_DISPOSITION_KEYS = [
  "authority_domain",
  "capture_evidence_projection_sha256",
  "capture_operation_key_sha256",
  "capture_runtime_identity_sha256",
  "consumer_signer_authorization_sha256",
  "direct_response_branch_count",
  "external_binding_sha256",
  "final_stable_observation_at",
  "first_stable_observation_at",
  "generated_image_artifact_count",
  "media_type",
  "non_image_artifact_count",
  "normal_download_control_count",
  "normal_save_control_count",
  "outcome",
  "qualified_runtime_identity",
  "reason",
  "receipt",
  "save_association_id",
  "schema",
  "signature_input_domain",
  "signer_enrollment_sha256",
  "signer_key_id",
  "source_confirmed_send_identity_sha256",
  "stable_observation_count",
  "stable_observation_sha256",
  "terminal_at",
  "total_artifact_count",
  "unclassified_artifact_count",
].sort()
const ATTACHMENT_RECEIPT_KEYS = [
  "attachment_kind",
  "branch_id",
  "canonical_conversation_locator_sha256",
  "capture_operation_key_sha256",
  "capture_runtime_identity_sha256",
  "dom_attachment_id",
  "external_binding_sha256",
  "final_stable_observation_at",
  "first_stable_observation_at",
  "graph_attachment_id",
  "normalized_complete_graph_sha256",
  "response_message_id",
  "save_association_id",
  "schema",
  "source_confirmed_send_identity_sha256",
  "stable_observation_count",
].sort()
const RUNTIME_IDENTITY_KEYS = [
  "executable_sha256",
  "implementation_git_sha",
  "package_inventory_sha256",
  "runtime_identity_sha256",
].sort()
const ATTACHMENT_UNKNOWN_REASONS = new Set([
  "AMBIGUOUS_SAVE_ASSOCIATION",
  "CAPTURE_ATTEMPT_LIMIT",
  "CAPTURE_DEADLINE_EXPIRED",
  "INCOHERENT_COUNTS",
  "TRUNCATED_GRAPH",
  "UNCLASSIFIED_ARTIFACT",
  "UNSUPPORTED_EVIDENCE",
  "UNSUPPORTED_SAVE_ASSOCIATION",
])
const ATTACHMENT_EXHAUSTION_REASONS = new Set([
  "CAPTURE_ATTEMPT_LIMIT",
  "CAPTURE_DEADLINE_EXPIRED",
])

function exactTimestamp(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function validRuntimeIdentity(value) {
  if (!isDeepStrictKeySet(value, RUNTIME_IDENTITY_KEYS)) return false
  const projection = {
    executable_sha256: value.executable_sha256,
    implementation_git_sha: value.implementation_git_sha,
    package_inventory_sha256: value.package_inventory_sha256,
  }
  return SHA256_PATTERN.test(value.executable_sha256)
    && /^[a-f0-9]{40,64}$/.test(value.implementation_git_sha)
    && SHA256_PATTERN.test(value.package_inventory_sha256)
    && value.runtime_identity_sha256 === sha256Hex(canonicalJsonBytes(projection))
}

function validPositiveReceipt(receipt, disposition) {
  if (!isDeepStrictKeySet(receipt, ATTACHMENT_RECEIPT_KEYS)) return false
  return receipt.schema === "ego-chat-attachment-execution-receipt/v1"
    && receipt.attachment_kind === "GENERATED_IMAGE"
    && isBoundedOpaqueId(receipt.branch_id)
    && isBoundedOpaqueId(receipt.response_message_id)
    && isBoundedOpaqueId(receipt.graph_attachment_id)
    && isBoundedOpaqueId(receipt.dom_attachment_id)
    && isBoundedOpaqueId(receipt.save_association_id)
    && SHA256_PATTERN.test(receipt.canonical_conversation_locator_sha256)
    && SHA256_PATTERN.test(receipt.normalized_complete_graph_sha256)
    && receipt.capture_operation_key_sha256 === disposition.capture_operation_key_sha256
    && receipt.capture_runtime_identity_sha256 === disposition.capture_runtime_identity_sha256
    && receipt.external_binding_sha256 === disposition.external_binding_sha256
    && receipt.first_stable_observation_at === disposition.first_stable_observation_at
    && receipt.final_stable_observation_at === disposition.final_stable_observation_at
    && receipt.save_association_id === disposition.save_association_id
    && receipt.normalized_complete_graph_sha256 === disposition.stable_observation_sha256
    && receipt.source_confirmed_send_identity_sha256
      === disposition.source_confirmed_send_identity_sha256
    && receipt.stable_observation_count === 2
}

export function assertValidAttachmentExecutionDisposition(disposition) {
  const counts = [
    disposition?.direct_response_branch_count,
    disposition?.total_artifact_count,
    disposition?.generated_image_artifact_count,
    disposition?.non_image_artifact_count,
    disposition?.unclassified_artifact_count,
    disposition?.normal_save_control_count,
    disposition?.normal_download_control_count,
  ]
  if (
    !isDeepStrictKeySet(disposition, ATTACHMENT_DISPOSITION_KEYS)
    || disposition.schema !== "ego-chat-attachment-execution-disposition/v1"
    || disposition.media_type
      !== "application/vnd.ego-chat.attachment-execution-disposition.v1+jcs"
    || disposition.signature_input_domain !== "EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1"
    || disposition.authority_domain !== "attachment-observation-only"
    || !SHA256_PATTERN.test(disposition.capture_evidence_projection_sha256)
    || !SHA256_PATTERN.test(disposition.capture_operation_key_sha256)
    || !SHA256_PATTERN.test(disposition.capture_runtime_identity_sha256)
    || !SHA256_PATTERN.test(disposition.consumer_signer_authorization_sha256)
    || !SHA256_PATTERN.test(disposition.signer_enrollment_sha256)
    || !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(disposition.signer_key_id)
    || !SHA256_PATTERN.test(disposition.source_confirmed_send_identity_sha256)
    || !(disposition.external_binding_sha256 === null
      || SHA256_PATTERN.test(disposition.external_binding_sha256))
    || !validRuntimeIdentity(disposition.qualified_runtime_identity)
    || disposition.capture_runtime_identity_sha256
      !== disposition.qualified_runtime_identity.runtime_identity_sha256
    || !exactTimestamp(disposition.terminal_at)
    || !Number.isSafeInteger(disposition.stable_observation_count)
    || ![0, 2].includes(disposition.stable_observation_count)
    || !isNullableOpaqueId(disposition.save_association_id)
    || counts.some((value) => !isCount(value))
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "The attachment execution disposition is outside its closed evidence schema.",
    )
  }
  if (
    disposition.stable_observation_count === 0
      ? disposition.first_stable_observation_at !== null
        || disposition.final_stable_observation_at !== null
        || disposition.stable_observation_sha256 !== null
      : !exactTimestamp(disposition.first_stable_observation_at)
        || !exactTimestamp(disposition.final_stable_observation_at)
        || !SHA256_PATTERN.test(disposition.stable_observation_sha256)
        || Date.parse(disposition.first_stable_observation_at)
          > Date.parse(disposition.final_stable_observation_at)
        || Date.parse(disposition.final_stable_observation_at)
          > Date.parse(disposition.terminal_at)
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "The attachment execution disposition has invalid retained observations.",
    )
  }
  const nonNullArtifactCounts = counts.slice(1, 5)
  const artifactCountMismatch = (
    nonNullArtifactCounts.every((value) => value !== null)
    && disposition.total_artifact_count
      !== disposition.generated_image_artifact_count
        + disposition.non_image_artifact_count
        + disposition.unclassified_artifact_count
  )
  if (
    artifactCountMismatch
    && !(
      disposition.outcome === "UNKNOWN"
      && disposition.reason === "INCOHERENT_COUNTS"
    )
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "The attachment execution disposition has incoherent artifact counts.",
    )
  }
  if (disposition.outcome === "EXACTLY_ONE") {
    if (
      disposition.reason !== "EXACTLY_ONE_SUPPORTED"
      || disposition.direct_response_branch_count !== 1
      || disposition.total_artifact_count !== 1
      || disposition.generated_image_artifact_count !== 1
      || disposition.non_image_artifact_count !== 0
      || disposition.unclassified_artifact_count !== 0
      || disposition.normal_download_control_count === null
      || disposition.normal_save_control_count !== 1
      || disposition.stable_observation_count !== 2
      || !isBoundedOpaqueId(disposition.save_association_id)
      || !validPositiveReceipt(disposition.receipt, disposition)
    ) {
      throw new EgoChatError(
        "invalid_attachment_disposition",
        "The positive attachment execution disposition is incomplete.",
      )
    }
  } else if (disposition.outcome === "MULTIPLE") {
    const reasonMatchesCounts = (
      disposition.reason === "MULTIPLE_RESPONSE_BRANCHES"
        ? disposition.direct_response_branch_count > 1
        : disposition.reason === "MULTIPLE_GENERATED_IMAGES"
          ? disposition.generated_image_artifact_count > 1
          : disposition.reason === "MULTIPLE_TOTAL_ARTIFACTS"
            ? disposition.generated_image_artifact_count === 1
              && disposition.total_artifact_count > 1
            : false
    )
    if (
      !reasonMatchesCounts
      || disposition.stable_observation_count !== 2
      || counts.slice(0, 5).includes(null)
      || disposition.receipt !== null
      || disposition.save_association_id !== null
    ) {
      throw new EgoChatError(
        "invalid_attachment_disposition",
        "The multiple attachment execution disposition is inconsistent.",
      )
    }
  } else if (disposition.outcome === "ZERO") {
    if (
      disposition.reason !== "ZERO_GENERATED_IMAGES"
      || disposition.stable_observation_count !== 2
      || disposition.direct_response_branch_count === null
      || disposition.direct_response_branch_count > 1
      || counts.slice(1, 5).includes(null)
      || disposition.generated_image_artifact_count !== 0
      || disposition.unclassified_artifact_count !== 0
      || disposition.normal_save_control_count !== 0
      || disposition.receipt !== null
      || disposition.save_association_id !== null
    ) {
      throw new EgoChatError(
        "invalid_attachment_disposition",
        "The zero attachment execution disposition is inconsistent.",
      )
    }
  } else {
    if (
      disposition.outcome !== "UNKNOWN"
      || disposition.receipt !== null
      || disposition.save_association_id !== null
      || !ATTACHMENT_UNKNOWN_REASONS.has(disposition.reason)
      || (
        disposition.stable_observation_count === 0
        && !ATTACHMENT_EXHAUSTION_REASONS.has(disposition.reason)
      )
      || (
        disposition.reason === "INCOHERENT_COUNTS"
        && !artifactCountMismatch
      )
      || (
        disposition.reason === "UNCLASSIFIED_ARTIFACT"
        && disposition.unclassified_artifact_count === 0
      )
    ) {
      throw new EgoChatError(
        "invalid_attachment_disposition",
        "The nonpositive attachment execution disposition is inconsistent.",
      )
    }
  }
  return disposition
}

export function assertValidSignedAttachmentDispositionEnvelope(envelope) {
  let envelopeBytes
  if (
    !isDeepStrictKeySet(envelope, SIGNED_ATTACHMENT_ENVELOPE_KEYS)
    || envelope.schema !== "ego-chat-signed-attachment-evidence-envelope/v1"
    || typeof envelope.payload_base64url !== "string"
    || typeof envelope.signature_base64url !== "string"
    || !SHA256_PATTERN.test(envelope.payload_sha256)
    || !/^ed25519-spki-sha256:[a-f0-9]{64}$/.test(envelope.signer_key_id)
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed attachment disposition envelope has an invalid shape.",
    )
  }
  try {
    envelopeBytes = canonicalJsonBytes(envelope)
  } catch {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed attachment disposition envelope is not canonical evidence.",
    )
  }
  const payloadBytes = Buffer.from(envelope.payload_base64url, "base64url")
  const signatureBytes = Buffer.from(envelope.signature_base64url, "base64url")
  if (
    envelopeBytes.length > 384 * 1024
    || payloadBytes.length > 256 * 1024
    || payloadBytes.toString("base64url") !== envelope.payload_base64url
    || signatureBytes.length !== 64
    || signatureBytes.toString("base64url") !== envelope.signature_base64url
    || sha256Hex(payloadBytes) !== envelope.payload_sha256
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed attachment disposition envelope failed its encoding or size bounds.",
    )
  }
  let disposition
  try {
    disposition = JSON.parse(payloadBytes.toString("utf8"))
  } catch {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed attachment disposition payload is not valid JSON.",
    )
  }
  if (!payloadBytes.equals(canonicalJsonBytes(disposition))) {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed attachment disposition payload is not canonical JSON.",
    )
  }
  assertValidAttachmentExecutionDisposition(disposition)
  if (
    envelope.authority_domain !== disposition.authority_domain
    || envelope.media_type !== disposition.media_type
    || envelope.signature_input_domain !== disposition.signature_input_domain
    || envelope.signer_key_id !== disposition.signer_key_id
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition_envelope",
      "The signed envelope metadata does not match its disposition payload.",
    )
  }
  return { disposition, envelopeBytes, payloadBytes, signatureBytes }
}

export function buildAttachmentExecutionDisposition({
  captureOperation,
  confirmedSendIdentity,
  confirmedSendIdentityDigest,
  observations,
  terminalReason = undefined,
  terminalAt,
}) {
  const forcedUnknownReason = terminalReason !== undefined
    && ATTACHMENT_EXHAUSTION_REASONS.has(terminalReason)
  if (terminalReason !== undefined && !forcedUnknownReason) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "The forced terminal disposition reason is invalid.",
    )
  }
  if (
    captureOperation?.source_workflow_id !== confirmedSendIdentity?.source_workflow_id
    || captureOperation?.confirmed_send_identity_sha256 !== confirmedSendIdentityDigest
    || captureOperation?.capture_operation_key_sha256
      !== attachmentCaptureOperationKeyDigest(confirmedSendIdentityDigest)
    || !Array.isArray(observations)
    || observations.some((observation) => (
      observation.source_confirmed_send_identity_sha256 !== confirmedSendIdentityDigest
      || observation.capture_operation_key_sha256
        !== captureOperation.capture_operation_key_sha256
    ))
  ) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "The disposition lineage does not match its confirmed Send.",
    )
  }
  if (!forcedUnknownReason && observations.length !== 2) {
    throw new EgoChatError(
      "invalid_attachment_disposition",
      "A non-exhaustion disposition requires exactly two observations.",
    )
  }
  for (const observation of observations) assertValidAttachmentGraphObservation(observation)
  const classification = forcedUnknownReason
    ? { outcome: "UNKNOWN", reason: terminalReason }
    : classifyAttachmentExecutionObservations(observations)
  const retainedObservations = observations.length === 2 ? observations : []
  const first = retainedObservations[0]
  const final = retainedObservations.at(-1)
  const firstObservedAt = first?.observed_at ?? null
  const finalObservedAt = final?.observed_at ?? null
  const graphDigest = final
    ? sha256Hex(canonicalJsonBytes(stableObservationProjection(final)))
    : null
  const runtimeIdentity = confirmedSendIdentity.qualified_runtime_identity
  const artifact = classification.outcome === "EXACTLY_ONE" ? final.artifacts[0] : null
  const receipt = artifact
    ? {
        attachment_kind: "GENERATED_IMAGE",
        branch_id: final.selected_branch_id,
        canonical_conversation_locator_sha256:
          final.canonical_conversation_locator_sha256,
        capture_operation_key_sha256: captureOperation.capture_operation_key_sha256,
        capture_runtime_identity_sha256: runtimeIdentity.runtime_identity_sha256,
        dom_attachment_id: artifact.dom_wrapper_id,
        external_binding_sha256: confirmedSendIdentity.external_binding_sha256 ?? null,
        final_stable_observation_at: finalObservedAt,
        first_stable_observation_at: firstObservedAt,
        graph_attachment_id: artifact.graph_attachment_id,
        normalized_complete_graph_sha256: graphDigest,
        response_message_id: final.response_message_id,
        save_association_id: final.save_association_id,
        schema: "ego-chat-attachment-execution-receipt/v1",
        source_confirmed_send_identity_sha256: confirmedSendIdentityDigest,
        stable_observation_count: 2,
      }
    : null
  const disposition = {
    authority_domain: "attachment-observation-only",
    capture_evidence_projection_sha256:
      attachmentEvidenceCaptureProjectionDigest(captureOperation, classification),
    capture_operation_key_sha256: captureOperation.capture_operation_key_sha256,
    capture_runtime_identity_sha256: runtimeIdentity.runtime_identity_sha256,
    consumer_signer_authorization_sha256:
      confirmedSendIdentity.consumer_signer_authorization_sha256,
    direct_response_branch_count: final?.direct_response_branch_count ?? null,
    external_binding_sha256: confirmedSendIdentity.external_binding_sha256 ?? null,
    final_stable_observation_at: finalObservedAt,
    first_stable_observation_at: firstObservedAt,
    generated_image_artifact_count: final?.generated_image_artifact_count ?? null,
    media_type: "application/vnd.ego-chat.attachment-execution-disposition.v1+jcs",
    non_image_artifact_count: final?.non_image_artifact_count ?? null,
    normal_download_control_count: final?.normal_download_control_count ?? null,
    normal_save_control_count: final?.normal_save_control_count ?? null,
    outcome: classification.outcome,
    qualified_runtime_identity: runtimeIdentity,
    reason: classification.reason,
    receipt,
    save_association_id: classification.outcome === "EXACTLY_ONE"
      ? final.save_association_id
      : null,
    schema: "ego-chat-attachment-execution-disposition/v1",
    signature_input_domain: "EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1",
    signer_enrollment_sha256: confirmedSendIdentity.signer_enrollment_sha256,
    signer_key_id: confirmedSendIdentity.signer_key_id,
    source_confirmed_send_identity_sha256: confirmedSendIdentityDigest,
    stable_observation_count: retainedObservations.length,
    stable_observation_sha256: graphDigest,
    terminal_at: terminalAt,
    total_artifact_count: final?.total_artifact_count ?? null,
    unclassified_artifact_count: final?.unclassified_artifact_count ?? null,
  }
  return assertValidAttachmentExecutionDisposition(disposition)
}
