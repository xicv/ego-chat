import assert from "node:assert/strict"
import test from "node:test"

import { MAX_WAIT_MS } from "../src/constants.mjs"
import {
  AttachmentCaptureRequestSchema,
  AttachmentEvidenceRequestSchema,
  AttachmentEvidenceReleaseRequestSchema,
  CanonicalConversationUrlSchema,
  EgoExchangeSchema,
  StartConvergenceSchema,
  parse,
} from "../src/validation.mjs"

test("canonical conversation inputs reject provisional and malformed locators", () => {
  for (const url of [
    "https://chatgpt.com/c/example",
    "https://chatgpt.com/g/g-p-example/c/6a9e06c4-9860-83ec-8dc7-68af8bbac4bd",
  ]) assert.equal(parse(CanonicalConversationUrlSchema, url), url)
  for (const url of [
    "https://chatgpt.com/c/WEB:temporary",
    "https://chatgpt.com/c/WEB%3Atemporary",
    "https://chatgpt.com/c/example/another-page",
    "https://chatgpt.com/not-a-chat/c/example",
    "https://other.example/c/example",
  ]) assert.throws(() => parse(CanonicalConversationUrlSchema, url), (error) => error.code === "invalid_input", url)
})

function convergenceInput(wallClockTimeoutMs) {
  return {
    acceptanceCriteria: ["The exact attachment bound is accepted."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Validate the convergence attachment bound.",
    wallClockTimeoutMs,
  }
}

test("convergence accepts exactly eight hours and rejects a larger attachment window", () => {
  assert.equal(
    parse(StartConvergenceSchema, convergenceInput(MAX_WAIT_MS)).wallClockTimeoutMs,
    8 * 60 * 60 * 1_000,
  )
  assert.throws(
    () => parse(StartConvergenceSchema, convergenceInput(MAX_WAIT_MS + 1)),
    (error) => error.code === "invalid_input"
      && error.details.issues.some((issue) => issue.path === "wallClockTimeoutMs"),
  )
})

test("answeringModelPolicy defaults to alert and rejects an unknown value on both exchange and convergence input", () => {
  const exchangeInput = {
    bindingKey: "ego-chat-main",
    expectedTerminalMarker: "DONE",
    prompt: "EGO_CHAT_ANSWERING_MODEL_POLICY\nreview",
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_ANSWERING_MODEL_POLICY",
  }
  assert.equal(parse(EgoExchangeSchema, exchangeInput).answeringModelPolicy, "alert")
  assert.equal(
    parse(EgoExchangeSchema, { ...exchangeInput, answeringModelPolicy: "pause" }).answeringModelPolicy,
    "pause",
  )
  assert.throws(
    () => parse(EgoExchangeSchema, { ...exchangeInput, answeringModelPolicy: "ignore" }),
    (error) => error.code === "invalid_input",
  )

  assert.equal(parse(StartConvergenceSchema, convergenceInput(MAX_WAIT_MS)).answeringModelPolicy, "alert")
  assert.equal(
    parse(StartConvergenceSchema, { ...convergenceInput(MAX_WAIT_MS), answeringModelPolicy: "pause" })
      .answeringModelPolicy,
    "pause",
  )
  assert.throws(
    () => parse(StartConvergenceSchema, { ...convergenceInput(MAX_WAIT_MS), answeringModelPolicy: "ignore" }),
    (error) => error.code === "invalid_input",
  )
})

test("receipt-enabled exchange input is closed and selected only before Send", () => {
  const input = {
    bindingKey: "a3k-canary",
    expectedTerminalMarker: "A3K_DONE",
    prompt: "EGO_CHAT_A3K_RECEIPT_12345678\nprepare",
    receiptCapture: {
      consumer_signer_authorization_sha256: "b".repeat(64),
      external_binding_sha256: "a".repeat(64),
      profile: "a3k-manual-canary-v1",
      receipt_capture_requested: true,
      schema: "ego-chat-receipt-enabled-exchange-request/v1",
    },
    timeoutMs: 30_000,
    turnMarker: "EGO_CHAT_A3K_RECEIPT_12345678",
  }

  assert.deepEqual(parse(EgoExchangeSchema, input).receiptCapture, input.receiptCapture)
  for (const receiptCapture of [
    { ...input.receiptCapture, extra: true },
    { ...input.receiptCapture, profile: "unknown-profile" },
    { ...input.receiptCapture, external_binding_sha256: undefined },
    { ...input.receiptCapture, receipt_capture_requested: false },
  ]) {
    assert.throws(
      () => parse(EgoExchangeSchema, { ...input, receiptCapture }),
      (error) => error.code === "invalid_input",
    )
  }
})

test("attachment capture input contains only its schema and source workflow identity", () => {
  const input = {
    schema: "ego-chat-attachment-capture-request/v1",
    source_workflow_id: "4559c675-14a9-4ec0-b5f9-0bb3ec3b73b5",
  }
  assert.deepEqual(parse(AttachmentCaptureRequestSchema, input), input)
  for (const extra of [
    { canonical_url: "https://chatgpt.com/c/forged" },
    { execution_claim_sha256: "a".repeat(64) },
    { output_path: "/tmp/asset.png" },
    { outcome: "EXACTLY_ONE" },
    { runtime_identity_sha256: "b".repeat(64) },
  ]) {
    assert.throws(
      () => parse(AttachmentCaptureRequestSchema, { ...input, ...extra }),
      (error) => error.code === "invalid_input",
    )
  }
})

test("attachment evidence retrieval accepts only its source workflow identity", () => {
  const input = {
    schema: "ego-chat-attachment-evidence-request/v1",
    source_workflow_id: "4559c675-14a9-4ec0-b5f9-0bb3ec3b73b5",
  }
  assert.deepEqual(parse(AttachmentEvidenceRequestSchema, input), input)
  for (const extra of [
    { external_binding_sha256: "a".repeat(64) },
    { output_path: "/tmp/evidence.json" },
    { expected_outcome: "EXACTLY_ONE" },
  ]) {
    assert.throws(
      () => parse(AttachmentEvidenceRequestSchema, { ...input, ...extra }),
      (error) => error.code === "invalid_input",
    )
  }
})

test("attachment evidence release has one closed signed acknowledgement input", () => {
  const acknowledgementEnvelope = {
    authority_domain: "attachment-evidence-retention-release-only",
    media_type: "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs",
    payload_base64url: "e30",
    payload_sha256: "a".repeat(64),
    schema: "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1",
    signature_base64url: "YQ",
    signature_input_domain: "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1",
    signer_key_id: "a3k-human-approval-root-v1",
  }
  const input = {
    acknowledgement_envelope: acknowledgementEnvelope,
    schema: "ego-chat-attachment-evidence-release-request/v1",
    source_workflow_id: "4559c675-14a9-4ec0-b5f9-0bb3ec3b73b5",
  }
  assert.deepEqual(parse(AttachmentEvidenceReleaseRequestSchema, input), input)
  assert.throws(
    () => parse(AttachmentEvidenceReleaseRequestSchema, {
      ...input,
      acknowledgement_envelope: { ...acknowledgementEnvelope, grants_source_approval: true },
    }),
    (error) => error.code === "invalid_input",
  )
})
