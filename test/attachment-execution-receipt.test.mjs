import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import {
  assertValidAttachmentExecutionDisposition,
  buildAttachmentEvidenceCapture,
  attachmentCaptureOperationKeyDigest,
  buildAttachmentExecutionDisposition,
  canonicalJsonBytes,
  classifyAttachmentExecutionObservations,
  sha256Hex,
} from "../src/attachment-execution-receipt.mjs"
import { buildA3kAttachmentInteroperabilityVectors } from "./fixtures/build-a3k-attachment-interoperability-v1.mjs"

function imageArtifact(id = "image-1") {
  return {
    artifact_id: id,
    artifact_kind: "GENERATED_IMAGE",
    dom_wrapper_id: `dom-${id}`,
    file_id: `file-${id}`,
    generation_id: `generation-${id}`,
    graph_attachment_id: `graph-${id}`,
    image_message_id: `message-${id}`,
  }
}

function nonImageArtifact(id = "file-1") {
  return {
    artifact_id: id,
    artifact_kind: "NON_IMAGE",
    dom_wrapper_id: null,
    file_id: null,
    generation_id: null,
    graph_attachment_id: null,
    image_message_id: null,
  }
}

function observation(overrides = {}) {
  return {
    artifacts: [imageArtifact()],
    asset_pointer_state: "ABSENT",
    canonical_conversation_locator_sha256: "c".repeat(64),
    capture_operation_key_sha256: "a".repeat(64),
    continuation_cursor_present: false,
    direct_branch_ids: ["branch-1"],
    direct_response_branch_count: 1,
    generated_image_artifact_count: 1,
    generation_terminal: true,
    graph_complete: true,
    graph_truncated: false,
    hydration_pending: false,
    non_image_artifact_count: 0,
    normal_download_control_count: 0,
    normal_save_control_count: 1,
    observation_sequence: 1,
    observed_at: "2026-09-04T05:00:00.000Z",
    provider_nodes: [{
      message_id: "response-1",
      parent_id: "prompt-1",
      provider_status: "COMPLETE",
      terminal: true,
      turn_exchange_id: "exchange-1",
    }],
    provider_prompt_message_id: "prompt-1",
    react_save_download_prop_count: 0,
    response_message_id: "response-1",
    save_association_candidates: [{
      association_id: "save-association-1",
      control_id: "save-control-1",
      dom_attachment_id: "dom-image-1",
      graph_attachment_id: "graph-image-1",
    }],
    save_association_id: "save-association-1",
    schema: "ego-chat-attachment-graph-observation/v1",
    selected_branch_id: "branch-1",
    source_confirmed_send_identity_sha256: "b".repeat(64),
    total_artifact_count: 1,
    ui_action_surface_complete: true,
    unclassified_artifact_count: 0,
    visible_attachment_actions: ["SAVE_IMAGE"],
    ...overrides,
  }
}

function stablePair(overrides = {}) {
  const first = observation(overrides)
  return [
    first,
    {
      ...structuredClone(first),
      observation_sequence: first.observation_sequence + 1,
      observed_at: "2026-09-04T05:00:01.000Z",
    },
  ]
}

function dispositionInput(observationOverrides = {}) {
  const observations = stablePair(observationOverrides)
  const confirmedSendIdentityDigest = "b".repeat(64)
  const captureOperationKeySha256 = attachmentCaptureOperationKeyDigest(
    confirmedSendIdentityDigest,
  )
  for (const current of observations) {
    current.capture_operation_key_sha256 = captureOperationKeySha256
    current.source_confirmed_send_identity_sha256 = confirmedSendIdentityDigest
  }
  const runtimeIdentity = {
    executable_sha256: "1".repeat(64),
    implementation_git_sha: "2".repeat(40),
    package_inventory_sha256: "3".repeat(64),
  }
  return {
    captureOperation: {
      accumulated_monotonic_ms: 1_000,
      attempt_journal: [],
      candidate_generation: 2,
      candidate_observations: observations,
      candidate_pair_count: 1,
      capture_deadline_at: "2026-09-04T05:10:00.000Z",
      capture_operation_key_sha256: captureOperationKeySha256,
      capture_started_at: "2026-09-04T05:00:00.000Z",
      confirmed_send_identity_sha256: confirmedSendIdentityDigest,
      schema: "ego-chat-attachment-capture-operation/v1",
      source_workflow_id: "workflow-1",
      state: "CAPTURING",
      terminal_disposition_sha256: null,
      terminal_envelope_sha256: null,
    },
    confirmedSendIdentity: {
      consumer_signer_authorization_sha256: "d".repeat(64),
      external_binding_sha256: "e".repeat(64),
      qualified_runtime_identity: {
        ...runtimeIdentity,
        runtime_identity_sha256: sha256Hex(canonicalJsonBytes(runtimeIdentity)),
      },
      signer_enrollment_sha256: "f".repeat(64),
      signer_key_id: `ed25519-spki-sha256:${"9".repeat(64)}`,
      source_workflow_id: "workflow-1",
    },
    confirmedSendIdentityDigest,
    observations,
    terminalAt: "2026-09-04T05:00:02.000Z",
  }
}

function outcome(overrides = {}) {
  return classifyAttachmentExecutionObservations(stablePair(overrides))
}

test("stable attachment evidence classifies exact, unsupported-Save, multiple, and zero", () => {
  assert.deepEqual(outcome(), {
    outcome: "EXACTLY_ONE",
    reason: "EXACTLY_ONE_SUPPORTED",
  })
  assert.deepEqual(outcome({
    asset_pointer_state: "PRESENT_NON_CONTROL",
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  }), {
    outcome: "UNKNOWN",
    reason: "UNSUPPORTED_SAVE_ASSOCIATION",
  })
  assert.deepEqual(outcome({
    normal_save_control_count: 2,
    save_association_candidates: [
      {
        association_id: "save-association-1",
        control_id: "save-control-1",
        dom_attachment_id: "dom-image-1",
        graph_attachment_id: "graph-image-1",
      },
      {
        association_id: "save-association-2",
        control_id: "save-control-2",
        dom_attachment_id: "dom-image-1",
        graph_attachment_id: "graph-image-1",
      },
    ],
    save_association_id: null,
  }), {
    outcome: "UNKNOWN",
    reason: "AMBIGUOUS_SAVE_ASSOCIATION",
  })
  assert.deepEqual(outcome({
    direct_branch_ids: ["branch-1", "branch-2"],
    direct_response_branch_count: 2,
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  }), {
    outcome: "MULTIPLE",
    reason: "MULTIPLE_RESPONSE_BRANCHES",
  })
  assert.deepEqual(outcome({
    artifacts: [imageArtifact("image-1"), imageArtifact("image-2")],
    generated_image_artifact_count: 2,
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    total_artifact_count: 2,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  }), {
    outcome: "MULTIPLE",
    reason: "MULTIPLE_GENERATED_IMAGES",
  })
  assert.deepEqual(outcome({
    artifacts: [imageArtifact(), nonImageArtifact()],
    non_image_artifact_count: 1,
    total_artifact_count: 2,
  }), {
    outcome: "MULTIPLE",
    reason: "MULTIPLE_TOTAL_ARTIFACTS",
  })
  assert.deepEqual(outcome({
    artifacts: [],
    generated_image_artifact_count: 0,
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    total_artifact_count: 0,
    visible_attachment_actions: [],
  }), {
    outcome: "ZERO",
    reason: "ZERO_GENERATED_IMAGES",
  })
  assert.deepEqual(outcome({
    artifacts: [nonImageArtifact()],
    generated_image_artifact_count: 0,
    non_image_artifact_count: 1,
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    visible_attachment_actions: [],
  }), {
    outcome: "ZERO",
    reason: "ZERO_GENERATED_IMAGES",
  })
})

test("UNKNOWN dominates incomplete, unsupported, unclassified, and incoherent evidence", () => {
  const cases = [
    [{ graph_complete: false }, "INCOMPLETE_GRAPH"],
    [{ graph_truncated: true }, "TRUNCATED_GRAPH"],
    [{ continuation_cursor_present: true }, "INCOMPLETE_GRAPH"],
    [{ generation_terminal: false }, "GENERATION_ACTIVE"],
    [{ hydration_pending: true }, "HYDRATION_PENDING"],
    [{ ui_action_surface_complete: false }, "UNSUPPORTED_EVIDENCE"],
    [{ total_artifact_count: null }, "UNSUPPORTED_EVIDENCE"],
    [{ total_artifact_count: 65 }, "UNSUPPORTED_EVIDENCE"],
    [{ visible_attachment_actions: ["UNKNOWN"] }, "UNSUPPORTED_EVIDENCE"],
    [{ provider_nodes: [{
      message_id: "response-1",
      parent_id: "prompt-1",
      provider_status: "FAILED",
      terminal: true,
      turn_exchange_id: "exchange-1",
    }] }, "UNSUPPORTED_EVIDENCE"],
    [{ total_artifact_count: 2 }, "INCOHERENT_COUNTS"],
    [{ response_message_id: null }, "UNSUPPORTED_EVIDENCE"],
    [{
      artifacts: [{ ...nonImageArtifact(), artifact_kind: "UNCLASSIFIED" }],
      generated_image_artifact_count: 0,
      unclassified_artifact_count: 1,
    }, "UNCLASSIFIED_ARTIFACT"],
  ]
  for (const [overrides, reason] of cases) {
    assert.deepEqual(outcome(overrides), { outcome: "UNKNOWN", reason })
  }
})

test("save-action conflicts are ambiguous and nullable canonical evidence is stable", () => {
  assert.deepEqual(outcome({ visible_attachment_actions: ["EDIT_IMAGE"] }), {
    outcome: "UNKNOWN",
    reason: "AMBIGUOUS_SAVE_ASSOCIATION",
  })
  assert.equal(
    canonicalJsonBytes({ enabled: true, missing: null }).toString("utf8"),
    '{"enabled":true,"missing":null}',
  )
  assert.deepEqual(outcome({
    save_association_candidates: [{
      association_id: "save-association-1",
      control_id: "save-control-1",
      dom_attachment_id: "dom-wrong",
      graph_attachment_id: "graph-image-1",
    }],
  }), {
    outcome: "UNKNOWN",
    reason: "AMBIGUOUS_SAVE_ASSOCIATION",
  })
})

test("public evidence retains raw Save identity independently from authoritative pointers", () => {
  for (const observedId of [null, "save-association-wrong"]) {
    const input = dispositionInput({ save_association_id: observedId })
    const disposition = buildAttachmentExecutionDisposition(input)
    assert.deepEqual(
      { outcome: disposition.outcome, reason: disposition.reason },
      { outcome: "UNKNOWN", reason: "AMBIGUOUS_SAVE_ASSOCIATION" },
    )
    const capture = buildAttachmentEvidenceCapture(
      input.captureOperation,
      { outcome: disposition.outcome, reason: disposition.reason },
    )
    for (const publicObservation of capture.candidate_observations) {
      assert.equal(publicObservation.classification_reason, disposition.reason)
      assert.equal(publicObservation.observed_save_association_id, observedId)
      assert.equal(publicObservation.save_association_id, null)
    }
  }
})

test("forced terminal classification and public capture use the same projection", () => {
  const input = dispositionInput()
  const disposition = buildAttachmentExecutionDisposition({
    ...input,
    terminalReason: "CAPTURE_ATTEMPT_LIMIT",
  })
  const capture = buildAttachmentEvidenceCapture(
    input.captureOperation,
    { outcome: disposition.outcome, reason: disposition.reason },
  )
  assert.equal(capture.candidate_observations.length, 2)
  assert.equal(
    capture.candidate_observations[0].classification_reason,
    "CAPTURE_ATTEMPT_LIMIT",
  )
  const projection = { ...capture }
  delete projection.schema
  delete projection.terminal_disposition_sha256
  delete projection.terminal_envelope_sha256
  assert.equal(
    disposition.capture_evidence_projection_sha256,
    sha256Hex(canonicalJsonBytes({
      schema: "ego-chat-attachment-capture-evidence-projection/v1",
      ...projection,
    })),
  )
})

test("public capture enforces the single 0..32 candidate-generation bound", () => {
  const input = dispositionInput()
  for (const candidateGeneration of [8, 9, 32]) {
    assert.equal(
      buildAttachmentEvidenceCapture({
        ...input.captureOperation,
        candidate_generation: candidateGeneration,
      }).candidate_generation,
      candidateGeneration,
    )
  }
  assert.throws(
    () => buildAttachmentEvidenceCapture({
      ...input.captureOperation,
      candidate_generation: 33,
    }),
    (error) => error.code === "invalid_attachment_capture_operation",
  )
})

test("terminal dispositions reject retry-only observation reasons", () => {
  for (const terminalReason of [
    "GENERATION_ACTIVE",
    "HYDRATION_PENDING",
    "INCOMPLETE_GRAPH",
    "UNSTABLE_EVIDENCE",
  ]) {
    assert.throws(
      () => buildAttachmentExecutionDisposition({
        ...dispositionInput(),
        terminalReason,
      }),
      (error) => error.code === "invalid_attachment_disposition",
    )
  }
})

test("positive disposition validation rejects a rebound nullable download count", () => {
  const disposition = buildAttachmentExecutionDisposition(dispositionInput())
  assert.equal(disposition.outcome, "EXACTLY_ONE")
  assert.throws(
    () => assertValidAttachmentExecutionDisposition({
      ...disposition,
      normal_download_control_count: null,
    }),
    (error) => error.code === "invalid_attachment_disposition",
  )
})

test("committed A3K interoperability vectors are exact producer output", () => {
  const fixture = JSON.parse(fs.readFileSync(
    new URL("./fixtures/a3k-attachment-interoperability-v1.json", import.meta.url),
    "utf8",
  ))
  assert.deepEqual(fixture, buildA3kAttachmentInteroperabilityVectors())
})

test("stable-pair identity includes action, wrapper, control, and pointer evidence", () => {
  for (const finalPatch of [
    { visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"] },
    { asset_pointer_state: "PRESENT_NON_CONTROL" },
    {
      normal_save_control_count: 0,
      save_association_candidates: [],
      save_association_id: null,
    },
    { artifacts: [{ ...imageArtifact(), dom_wrapper_id: "dom-drift" }] },
  ]) {
    const observations = stablePair()
    observations[1] = { ...observations[1], ...finalPatch }
    assert.deepEqual(classifyAttachmentExecutionObservations(observations), {
      outcome: "UNKNOWN",
      reason: "UNSTABLE_EVIDENCE",
    })
  }
})

test("closed observation evidence rejects pointer values and caller-selected fields", () => {
  for (const extra of [
    { asset_pointer_url: "https://example.invalid/signed" },
    { caller_selected_path: "/tmp/a" },
    { screenshot_digest: "d".repeat(64) },
  ]) {
    assert.throws(
      () => outcome(extra),
      (error) => error.code === "invalid_attachment_observation",
    )
  }
})

test("capture operation identity decodes the confirmed-Send digest under its fixed domain", () => {
  assert.equal(
    attachmentCaptureOperationKeyDigest("ab".repeat(32)),
    "97aa6ccf9c8cc9564e32b470c1a137a93362fb5a2920df9c63a146d7c59ac9ee",
  )
})

test("terminal disposition binds a stable unsupported-Save observation pair", () => {
  const observations = stablePair({
    asset_pointer_state: "PRESENT_NON_CONTROL",
    normal_save_control_count: 0,
    save_association_candidates: [],
    save_association_id: null,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  })
  const confirmedSendIdentityDigest = "b".repeat(64)
  const captureOperationKeySha256 = attachmentCaptureOperationKeyDigest(
    confirmedSendIdentityDigest,
  )
  const runtimeIdentity = {
    executable_sha256: "1".repeat(64),
    implementation_git_sha: "2".repeat(40),
    package_inventory_sha256: "3".repeat(64),
  }
  for (const current of observations) {
    current.capture_operation_key_sha256 = captureOperationKeySha256
    current.source_confirmed_send_identity_sha256 = confirmedSendIdentityDigest
  }
  const captureOperation = {
    accumulated_monotonic_ms: 1_000,
    attempt_journal: [],
    candidate_generation: 2,
    candidate_observations: observations,
    candidate_pair_count: 1,
    capture_deadline_at: "2026-09-04T05:10:00.000Z",
    capture_operation_key_sha256: captureOperationKeySha256,
    capture_started_at: "2026-09-04T05:00:00.000Z",
    confirmed_send_identity_sha256: confirmedSendIdentityDigest,
    schema: "ego-chat-attachment-capture-operation/v1",
    source_workflow_id: "workflow-1",
    state: "CAPTURING",
    terminal_disposition_sha256: null,
    terminal_envelope_sha256: null,
  }
  const confirmedSendIdentity = {
      consumer_signer_authorization_sha256: "d".repeat(64),
      external_binding_sha256: "e".repeat(64),
      qualified_runtime_identity: {
        ...runtimeIdentity,
        runtime_identity_sha256: sha256Hex(canonicalJsonBytes(runtimeIdentity)),
      },
      signer_enrollment_sha256: "f".repeat(64),
      signer_key_id: `ed25519-spki-sha256:${"9".repeat(64)}`,
      source_workflow_id: "workflow-1",
  }
  const disposition = buildAttachmentExecutionDisposition({
    captureOperation,
    confirmedSendIdentity,
    confirmedSendIdentityDigest,
    observations,
    terminalAt: "2026-09-04T05:00:02.000Z",
  })

  assert.equal(disposition.outcome, "UNKNOWN")
  assert.equal(disposition.reason, "UNSUPPORTED_SAVE_ASSOCIATION")
  assert.equal(disposition.receipt, null)
  assert.equal(disposition.save_association_id, null)
  assert.equal(disposition.stable_observation_count, 2)
  assert.equal(disposition.first_stable_observation_at, observations[0].observed_at)
  assert.equal(disposition.final_stable_observation_at, observations[1].observed_at)
  assert.equal(disposition.capture_operation_key_sha256, captureOperationKeySha256)
  assert.match(disposition.capture_evidence_projection_sha256, /^[a-f0-9]{64}$/)
  assert.match(disposition.stable_observation_sha256, /^[a-f0-9]{64}$/)

  const publicCapture = buildAttachmentEvidenceCapture({
    ...captureOperation,
    state: "TERMINAL",
    terminal_disposition_sha256: "4".repeat(64),
    terminal_envelope_sha256: "5".repeat(64),
  })
  assert.equal(publicCapture.state, "TERMINAL")
  assert.equal(publicCapture.candidate_observations.length, 2)
  assert.deepEqual(
    publicCapture.candidate_observations[0].save_association_candidates,
    observations[0].save_association_candidates,
  )

  const exhaustedCapture = {
    ...captureOperation,
    candidate_generation: 0,
    candidate_observations: [],
    candidate_pair_count: 0,
  }

  const exhausted = buildAttachmentExecutionDisposition({
    captureOperation: exhaustedCapture,
    confirmedSendIdentity,
    confirmedSendIdentityDigest,
    observations: [],
    terminalAt: "2026-09-04T05:00:02.000Z",
    terminalReason: "CAPTURE_ATTEMPT_LIMIT",
  })
  assert.equal(exhausted.outcome, "UNKNOWN")
  assert.equal(exhausted.reason, "CAPTURE_ATTEMPT_LIMIT")
  assert.equal(exhausted.stable_observation_count, 0)
  assert.equal(exhausted.total_artifact_count, null)
})
