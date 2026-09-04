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
  signerEnrollmentDigest,
  workflowId,
}) {
  const intent = {
    consumer_signer_authorization_sha256: authorizationDigest,
    created_at: createdAt,
    external_binding_sha256: externalBindingDigest,
    live_reservation_bytes: 1024 * 1024,
    permanent_reservation_bytes: 32 * 1024,
    profile,
    schema: "ego-chat-attachment-capture-intent/v1",
    signer_enrollment_sha256: signerEnrollmentDigest,
    source_operation_key_sha256: operationKeyDigest(operationKey),
    source_workflow_id: workflowId,
    state: "RESERVED",
  }
  return {
    digest: sha256Hex(canonicalJsonBytes(intent)),
    intent,
  }
}
