import { Buffer } from "node:buffer"
import { verify } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import {
  canonicalJsonBytes,
  sha256Hex,
} from "./attachment-execution-receipt.mjs"
import { EgoChatError } from "./errors.mjs"

export const ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT = Object.freeze([
  "image-generation",
  "image-editing",
  "source-approval",
  "runtime-approval",
  "source-asset-release",
  "runtime-asset-release",
  "software-or-production-release",
  "repository-write",
  "scheduler-activation",
  "production-queue-activation",
  "shipping",
])

const ACKNOWLEDGEMENT_KEYS = [
  "authority_domain",
  "authority_key_id",
  "authorized_action",
  "confirmed_send_identity_sha256",
  "consumer_profile",
  "consumer_state",
  "consumer_state_record_sha256",
  "disposition_envelope_sha256",
  "does_not_grant",
  "external_binding_sha256",
  "idempotency_key_sha256",
  "media_type",
  "recovery_policy_sha256",
  "schema",
  "signature_input_domain",
  "terminal_evidence_digest",
  "terminal_evidence_kind",
  "terminal_outcome",
  "work_order_id",
]
const ENVELOPE_KEYS = [
  "authority_domain",
  "media_type",
  "payload_base64url",
  "payload_sha256",
  "schema",
  "signature_base64url",
  "signature_input_domain",
  "signer_key_id",
]
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_PAYLOAD_BYTES = 16 * 1024
const MAX_ENVELOPE_BYTES = 24 * 1024

function fail(code, message) {
  throw new EgoChatError(code, message)
}

function hasExactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

export function assertValidAttachmentConsumerAcknowledgement(value) {
  if (
    !hasExactKeys(value, ACKNOWLEDGEMENT_KEYS)
    || value.schema !== "a3k-attachment-disposition-consumer-acknowledgement/v1"
    || value.media_type
      !== "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs"
    || value.signature_input_domain
      !== "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1"
    || value.authority_domain !== "attachment-evidence-retention-release-only"
    || value.authority_key_id !== "a3k-human-approval-root-v1"
    || value.authorized_action !== "release-attachment-evidence-reservation"
    || value.consumer_profile !== "a3k-manual-canary-v1"
    || value.terminal_evidence_kind !== "attachment-execution-disposition"
    || !["EXACTLY_ONE", "ZERO", "MULTIPLE", "UNKNOWN"].includes(
      value.terminal_outcome,
    )
    || value.consumer_state !== (
      value.terminal_outcome === "EXACTLY_ONE"
        ? "WAITING_HUMAN_SOURCE_APPROVAL"
        : "RECOVERY_REQUIRED"
    )
    || !isDeepStrictEqual(
      value.does_not_grant,
      ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
    )
    || !ID_PATTERN.test(value.work_order_id)
    || ![
      value.confirmed_send_identity_sha256,
      value.consumer_state_record_sha256,
      value.disposition_envelope_sha256,
      value.external_binding_sha256,
      value.idempotency_key_sha256,
      value.recovery_policy_sha256,
      value.terminal_evidence_digest,
    ].every((candidate) => SHA256_PATTERN.test(candidate))
  ) {
    fail(
      "invalid_attachment_consumer_acknowledgement",
      "The attachment evidence consumer acknowledgement is invalid or grants excess authority.",
    )
  }
  if (canonicalJsonBytes(value).length > MAX_PAYLOAD_BYTES) {
    fail(
      "attachment_consumer_acknowledgement_too_large",
      "The attachment evidence consumer acknowledgement exceeds its size bound.",
    )
  }
  return value
}

export function assertValidSignedAttachmentConsumerAcknowledgementEnvelope(envelope) {
  if (
    !hasExactKeys(envelope, ENVELOPE_KEYS)
    || envelope.schema
      !== "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1"
    || envelope.media_type
      !== "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs"
    || envelope.signature_input_domain
      !== "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1"
    || envelope.authority_domain !== "attachment-evidence-retention-release-only"
    || envelope.signer_key_id !== "a3k-human-approval-root-v1"
    || !SHA256_PATTERN.test(envelope.payload_sha256)
    || !BASE64URL_PATTERN.test(envelope.payload_base64url)
    || !BASE64URL_PATTERN.test(envelope.signature_base64url)
    || canonicalJsonBytes(envelope).length > MAX_ENVELOPE_BYTES
  ) {
    fail(
      "invalid_attachment_consumer_acknowledgement_envelope",
      "The signed attachment evidence consumer acknowledgement envelope is invalid.",
    )
  }
  const payloadBytes = Buffer.from(envelope.payload_base64url, "base64url")
  const signature = Buffer.from(envelope.signature_base64url, "base64url")
  if (
    payloadBytes.length > MAX_PAYLOAD_BYTES
    || payloadBytes.toString("base64url") !== envelope.payload_base64url
    || signature.length < 64
    || signature.length > 1024
    || signature.toString("base64url") !== envelope.signature_base64url
    || sha256Hex(payloadBytes) !== envelope.payload_sha256
  ) {
    fail(
      "invalid_attachment_consumer_acknowledgement_envelope",
      "The signed attachment evidence consumer acknowledgement envelope encoding is invalid.",
    )
  }
  let acknowledgement
  try {
    acknowledgement = JSON.parse(payloadBytes.toString("utf8"))
  } catch {
    fail(
      "invalid_attachment_consumer_acknowledgement_envelope",
      "The attachment evidence consumer acknowledgement payload is not JSON.",
    )
  }
  if (!payloadBytes.equals(canonicalJsonBytes(acknowledgement))) {
    fail(
      "invalid_attachment_consumer_acknowledgement_envelope",
      "The attachment evidence consumer acknowledgement payload is not canonical.",
    )
  }
  assertValidAttachmentConsumerAcknowledgement(acknowledgement)
  if (
    envelope.authority_domain !== acknowledgement.authority_domain
    || envelope.media_type !== acknowledgement.media_type
    || envelope.signature_input_domain !== acknowledgement.signature_input_domain
    || envelope.signer_key_id !== acknowledgement.authority_key_id
  ) {
    fail(
      "invalid_attachment_consumer_acknowledgement_envelope",
      "The acknowledgement envelope and payload authority fields do not match.",
    )
  }
  return { acknowledgement, payloadBytes, signature }
}

export function verifyAttachmentConsumerAcknowledgementEnvelope(envelope, publicKey) {
  const parsed = assertValidSignedAttachmentConsumerAcknowledgementEnvelope(envelope)
  let valid = false
  try {
    valid = verify(
      "RSA-SHA256",
      Buffer.concat([
        Buffer.from(`${envelope.signature_input_domain}\0`, "ascii"),
        parsed.payloadBytes,
      ]),
      publicKey,
      parsed.signature,
    )
  } catch {
    valid = false
  }
  if (!valid) {
    fail(
      "invalid_attachment_consumer_acknowledgement_signature",
      "The attachment evidence consumer acknowledgement signature is invalid.",
    )
  }
  return parsed.acknowledgement
}
