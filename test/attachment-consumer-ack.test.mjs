import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"

import {
  ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
  assertValidSignedAttachmentConsumerAcknowledgementEnvelope,
  verifyAttachmentConsumerAcknowledgementEnvelope,
} from "../src/attachment-consumer-ack.mjs"
import {
  canonicalJsonBytes,
  sha256Hex,
} from "../src/attachment-execution-receipt.mjs"

function acknowledgement(overrides = {}) {
  return {
    authority_domain: "attachment-evidence-retention-release-only",
    authority_key_id: "a3k-human-approval-root-v1",
    authorized_action: "release-attachment-evidence-reservation",
    confirmed_send_identity_sha256: "1".repeat(64),
    consumer_profile: "a3k-manual-canary-v1",
    consumer_state: "RECOVERY_REQUIRED",
    consumer_state_record_sha256: "2".repeat(64),
    disposition_envelope_sha256: "3".repeat(64),
    does_not_grant: ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
    external_binding_sha256: "4".repeat(64),
    idempotency_key_sha256: "5".repeat(64),
    media_type: "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs",
    recovery_policy_sha256: "6".repeat(64),
    schema: "a3k-attachment-disposition-consumer-acknowledgement/v1",
    signature_input_domain: "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1",
    terminal_evidence_digest: "7".repeat(64),
    terminal_evidence_kind: "attachment-execution-disposition",
    terminal_outcome: "UNKNOWN",
    work_order_id: "CANARY-IMAGE-002",
    ...overrides,
  }
}

function envelope(payload, privateKey) {
  const payloadBytes = canonicalJsonBytes(payload)
  const signature = sign(
    "RSA-SHA256",
    Buffer.concat([
      Buffer.from("A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1\0", "ascii"),
      payloadBytes,
    ]),
    privateKey,
  )
  return {
    authority_domain: payload.authority_domain,
    media_type: payload.media_type,
    payload_base64url: payloadBytes.toString("base64url"),
    payload_sha256: sha256Hex(payloadBytes),
    schema: "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1",
    signature_base64url: signature.toString("base64url"),
    signature_input_domain: payload.signature_input_domain,
    signer_key_id: payload.authority_key_id,
  }
}

test("consumer acknowledgement authorizes only evidence-retention release", () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const signed = envelope(acknowledgement(), keyPair.privateKey)
  assert.equal(
    verifyAttachmentConsumerAcknowledgementEnvelope(signed, keyPair.publicKey)
      .consumer_state,
    "RECOVERY_REQUIRED",
  )
  for (const invalid of [
    acknowledgement({ authorized_action: "source-asset-release" }),
    acknowledgement({ consumer_state: "WAITING_HUMAN_SOURCE_APPROVAL" }),
    acknowledgement({ does_not_grant: ["shipping"] }),
    acknowledgement({ terminal_outcome: "EXACTLY_ONE" }),
  ]) {
    assert.throws(
      () => assertValidSignedAttachmentConsumerAcknowledgementEnvelope(
        envelope(invalid, keyPair.privateKey),
      ),
      (error) => error.code === "invalid_attachment_consumer_acknowledgement",
    )
  }
  const tampered = structuredClone(signed)
  const signature = Buffer.from(tampered.signature_base64url, "base64url")
  signature[0] ^= 0x01
  tampered.signature_base64url = signature.toString("base64url")
  assert.throws(
    () => verifyAttachmentConsumerAcknowledgementEnvelope(tampered, keyPair.publicKey),
    (error) => error.code === "invalid_attachment_consumer_acknowledgement_signature",
  )
})

test("consumer acknowledgement discriminates every terminal evidence kind", () => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const valid = [
    acknowledgement(),
    acknowledgement({
      confirmed_send_identity_sha256: null,
      terminal_evidence_kind: "ambiguous-send-disposition",
      terminal_outcome: "SEND_OUTCOME_UNKNOWN",
    }),
    acknowledgement({
      confirmed_send_identity_sha256: null,
      terminal_evidence_kind: "confirmed-send-absence",
      terminal_outcome: "CONFIRMED_NOT_SENT",
    }),
  ]
  for (const payload of valid) {
    assert.equal(
      verifyAttachmentConsumerAcknowledgementEnvelope(
        envelope(payload, keyPair.privateKey),
        keyPair.publicKey,
      ).terminal_evidence_kind,
      payload.terminal_evidence_kind,
    )
  }

  const outcomes = [
    "EXACTLY_ONE",
    "ZERO",
    "MULTIPLE",
    "UNKNOWN",
    "SEND_OUTCOME_UNKNOWN",
    "CONFIRMED_NOT_SENT",
  ]
  const allowed = new Map([
    ["attachment-execution-disposition", new Set(outcomes.slice(0, 4))],
    ["ambiguous-send-disposition", new Set(["SEND_OUTCOME_UNKNOWN"])],
    ["confirmed-send-absence", new Set(["CONFIRMED_NOT_SENT"])],
  ])
  for (const [kind, allowedOutcomes] of allowed) {
    for (const outcome of outcomes) {
      if (allowedOutcomes.has(outcome)) continue
      const payload = acknowledgement({
        confirmed_send_identity_sha256: kind === "attachment-execution-disposition"
          ? "1".repeat(64)
          : null,
        terminal_evidence_kind: kind,
        terminal_outcome: outcome,
      })
      assert.throws(
        () => verifyAttachmentConsumerAcknowledgementEnvelope(
          envelope(payload, keyPair.privateKey),
          keyPair.publicKey,
        ),
        (error) => error.code === "invalid_attachment_consumer_acknowledgement",
      )
    }
  }
})
