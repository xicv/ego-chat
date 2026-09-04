import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

const MAX_IJSON_INTEGER = 9_007_199_254_740_991

function canonicalString(value) {
  return JSON.stringify(value)
}

function canonicalize(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
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
      return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`
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

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function operationKeyDigest(operationKey) {
  return sha256Hex(Buffer.concat([
    Buffer.from("EGO_CHAT_OPERATION_KEY_V1\0", "ascii"),
    Buffer.from(operationKey, "utf8"),
  ]))
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
