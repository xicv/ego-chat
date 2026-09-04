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

function parseObservationTimestamp(value) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null
}

function structuralAttachmentOutcome(observation) {
  let serializedBytes
  try {
    serializedBytes = canonicalJsonBytes(observation).length
  } catch {
    return unknownAttachmentOutcome("UNSUPPORTED_EVIDENCE")
  }
  const supportedShape = {
    artifact_shape: hasValidArtifacts(observation.artifacts),
    branch_shape: isBoundedUniqueIdArray(observation.direct_branch_ids),
    conversation_digest: SHA256_PATTERN.test(
      observation.canonical_conversation_locator_sha256,
    ),
    node_shape: hasValidProviderNodes(observation.provider_nodes),
    operation_digest: SHA256_PATTERN.test(observation.capture_operation_key_sha256),
    source_digest: SHA256_PATTERN.test(observation.source_confirmed_send_identity_sha256),
  }
  if (
    serializedBytes > MAX_ATTACHMENT_OBSERVATION_BYTES
    || !supportedShape.source_digest
    || !supportedShape.operation_digest
    || !supportedShape.conversation_digest
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
    || !supportedShape.branch_shape
    || !supportedShape.node_shape
    || !supportedShape.artifact_shape
    || !hasSortedUniqueAttachmentActions(observation.visible_attachment_actions)
    || !["ABSENT", "PRESENT_NON_CONTROL"].includes(observation.asset_pointer_state)
  ) {
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
    || parseObservationTimestamp(final.observed_at) <= parseObservationTimestamp(first.observed_at)
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
    if (
      observation.normal_save_control_count > 1
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
    ) {
      return unknownAttachmentOutcome("AMBIGUOUS_SAVE_ASSOCIATION")
    }
    if (
      observation.normal_save_control_count !== 1
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
  return sha256Hex(Buffer.concat([
    Buffer.from("EGO_CHAT_ATTACHMENT_CAPTURE_OPERATION_V1\0", "ascii"),
    Buffer.from(confirmedSendIdentityDigest, "ascii"),
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
    capture_deadline_at: new Date(startedAtMs + 10 * 60 * 1_000).toISOString(),
    capture_operation_key_sha256: attachmentCaptureOperationKeyDigest(
      confirmedSendIdentityDigest,
    ),
    capture_started_at: startedAt,
    confirmed_send_identity_sha256: confirmedSendIdentityDigest,
    schema: "ego-chat-attachment-capture-operation/v1",
    source_workflow_id: sourceWorkflowId,
    state: "CAPTURING",
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
