import {
  attachmentCaptureOperationKeyDigest,
  buildAttachmentEvidenceCapture,
  buildAttachmentExecutionDisposition,
  canonicalJsonBytes,
  sha256Hex,
} from "../../src/attachment-execution-receipt.mjs"

const CONFIRMED_SEND_IDENTITY_DIGEST = "b".repeat(64)
const CAPTURE_OPERATION_KEY = attachmentCaptureOperationKeyDigest(
  CONFIRMED_SEND_IDENTITY_DIGEST,
)

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
    capture_operation_key_sha256: CAPTURE_OPERATION_KEY,
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
    source_confirmed_send_identity_sha256: CONFIRMED_SEND_IDENTITY_DIGEST,
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
      observation_sequence: 2,
      observed_at: "2026-09-04T05:00:01.000Z",
    },
  ]
}

function confirmedSendIdentity() {
  const runtimeIdentity = {
    executable_sha256: "1".repeat(64),
    implementation_git_sha: "2".repeat(40),
    package_inventory_sha256: "3".repeat(64),
  }
  return {
    consumer_signer_authorization_sha256: "d".repeat(64),
    external_binding_sha256: "e".repeat(64),
    qualified_runtime_identity: {
      ...runtimeIdentity,
      runtime_identity_sha256: sha256Hex(canonicalJsonBytes(runtimeIdentity)),
    },
    signer_enrollment_sha256: "f".repeat(64),
    signer_key_id: `ed25519-spki-sha256:${"9".repeat(64)}`,
    source_workflow_id: "workflow-interop-v1",
  }
}

function captureOperation({
  accumulatedMonotonicMs = 1_000,
  candidateGeneration = 2,
  candidatePairCount = 1,
  journal = [],
  observations = stablePair(),
} = {}) {
  return {
    accumulated_monotonic_ms: accumulatedMonotonicMs,
    attempt_journal: journal,
    candidate_generation: candidateGeneration,
    candidate_observations: observations,
    candidate_pair_count: candidatePairCount,
    capture_deadline_at: "2026-09-04T05:10:00.000Z",
    capture_operation_key_sha256: CAPTURE_OPERATION_KEY,
    capture_started_at: "2026-09-04T05:00:00.000Z",
    confirmed_send_identity_sha256: CONFIRMED_SEND_IDENTITY_DIGEST,
    schema: "ego-chat-attachment-capture-operation/v1",
    source_workflow_id: "workflow-interop-v1",
    state: "TERMINAL",
    terminal_disposition_sha256: "7".repeat(64),
    terminal_envelope_sha256: "8".repeat(64),
  }
}

function publicVector(name, captureOperationValue, options = {}) {
  const identity = confirmedSendIdentity()
  const disposition = buildAttachmentExecutionDisposition({
    captureOperation: captureOperationValue,
    confirmedSendIdentity: identity,
    confirmedSendIdentityDigest: CONFIRMED_SEND_IDENTITY_DIGEST,
    observations: captureOperationValue.candidate_observations,
    terminalAt: options.terminalAt ?? "2026-09-04T05:00:02.000Z",
    terminalReason: options.terminalReason,
  })
  const capture = buildAttachmentEvidenceCapture(captureOperationValue, {
    outcome: disposition.outcome,
    reason: disposition.reason,
  })
  const projection = { ...capture }
  delete projection.schema
  delete projection.terminal_disposition_sha256
  delete projection.terminal_envelope_sha256
  const projectionBytes = canonicalJsonBytes({
    schema: "ego-chat-attachment-capture-evidence-projection/v1",
    ...projection,
  })
  return {
    capture,
    capture_projection_base64url: projectionBytes.toString("base64url"),
    capture_projection_sha256: sha256Hex(projectionBytes),
    disposition,
    expected_consumer_state: disposition.outcome === "EXACTLY_ONE"
      ? "WAITING_HUMAN_SOURCE_APPROVAL"
      : "RECOVERY_REQUIRED",
    name,
  }
}

function recoveryJournal(count, reason = "DRIVER_RECOVERY") {
  return Array.from({ length: count }, (_unused, index) => ({
    attempt_number: index + 1,
    attempted_at: "2026-09-04T05:00:01.000Z",
    candidate_generation: index + 1,
    dom_snapshot_sha256: "4".repeat(64),
    graph_snapshot_sha256: "5".repeat(64),
    reason,
    response_snapshot_sha256: "6".repeat(64),
    schema: "ego-chat-attachment-capture-attempt/v1",
    state: "RECOVERABLE",
  }))
}

export function buildA3kAttachmentInteroperabilityVectors() {
  const multipleSaveCandidates = [
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
  ]
  const vectors = [
    publicVector("exactly-one", captureOperation()),
    publicVector("nonimage-zero", captureOperation({
      observations: stablePair({
        artifacts: [nonImageArtifact()],
        generated_image_artifact_count: 0,
        non_image_artifact_count: 1,
        normal_download_control_count: 0,
        normal_save_control_count: 0,
        save_association_candidates: [],
        save_association_id: null,
        total_artifact_count: 1,
        visible_attachment_actions: [],
      }),
    })),
    publicVector("multiple-response-branches", captureOperation({
      observations: stablePair({
        direct_branch_ids: ["branch-1", "branch-2"],
        direct_response_branch_count: 2,
      }),
    })),
    publicVector("multiple-artifacts", captureOperation({
      observations: stablePair({
        artifacts: [imageArtifact("image-1"), imageArtifact("image-2")],
        generated_image_artifact_count: 2,
        normal_download_control_count: 2,
        normal_save_control_count: 0,
        save_association_candidates: [],
        save_association_id: null,
        total_artifact_count: 2,
        visible_attachment_actions: [],
      }),
    })),
    publicVector("unsupported-save", captureOperation({
      observations: stablePair({
        asset_pointer_state: "PRESENT_NON_CONTROL",
        normal_save_control_count: 0,
        save_association_candidates: [],
        save_association_id: null,
        visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
      }),
    })),
    publicVector("one-candidate-save-id-mismatch", captureOperation({
      observations: stablePair({ save_association_id: "save-association-wrong" }),
    })),
    publicVector("one-candidate-save-id-absent", captureOperation({
      observations: stablePair({ save_association_id: null }),
    })),
    publicVector("one-candidate-save-dom-mismatch", captureOperation({
      observations: stablePair({
        save_association_candidates: [{
          association_id: "save-association-1",
          control_id: "save-control-1",
          dom_attachment_id: "dom-wrong",
          graph_attachment_id: "graph-image-1",
        }],
      }),
    })),
    publicVector("one-candidate-save-graph-mismatch", captureOperation({
      observations: stablePair({
        save_association_candidates: [{
          association_id: "save-association-1",
          control_id: "save-control-1",
          dom_attachment_id: "dom-image-1",
          graph_attachment_id: "graph-wrong",
        }],
      }),
    })),
    publicVector("multiple-save-candidates", captureOperation({
      observations: stablePair({
        normal_save_control_count: 2,
        save_association_candidates: multipleSaveCandidates,
        save_association_id: null,
      }),
    })),
    publicVector("incoherent-counts", captureOperation({
      observations: stablePair({ total_artifact_count: 2 }),
    })),
    publicVector("truncated-graph", captureOperation({
      observations: stablePair({ graph_truncated: true }),
    })),
    publicVector("unclassified-artifact", captureOperation({
      observations: stablePair({
        artifacts: [{ ...nonImageArtifact(), artifact_kind: "UNCLASSIFIED" }],
        generated_image_artifact_count: 0,
        non_image_artifact_count: 0,
        normal_download_control_count: 0,
        normal_save_control_count: 0,
        save_association_candidates: [],
        save_association_id: null,
        unclassified_artifact_count: 1,
        visible_attachment_actions: [],
      }),
    })),
    publicVector("unsupported-evidence", captureOperation({
      observations: stablePair({ ui_action_surface_complete: false }),
    })),
    publicVector("attempt-limit-unknown", captureOperation({
      candidateGeneration: 32,
      candidatePairCount: 0,
      journal: recoveryJournal(32),
      observations: [],
    }), { terminalReason: "CAPTURE_ATTEMPT_LIMIT" }),
    publicVector("deadline-unknown-with-stable-pair", captureOperation(), {
      terminalAt: "2026-09-04T05:10:00.000Z",
      terminalReason: "CAPTURE_DEADLINE_EXPIRED",
    }),
    publicVector("restart-recovery-deadline-unknown", captureOperation({
      accumulatedMonotonicMs: 600_000,
      candidateGeneration: 1,
      candidatePairCount: 0,
      journal: recoveryJournal(1, "BROKER_RESTART"),
      observations: [],
    }), {
      terminalAt: "2026-09-04T05:10:00.000Z",
      terminalReason: "CAPTURE_DEADLINE_EXPIRED",
    }),
    publicVector("generation-nine-exactly-one", captureOperation({
      candidateGeneration: 9,
    })),
  ]
  return {
    attachment_vectors: vectors,
    schema: "ego-chat-a3k-attachment-interoperability-v1",
    terminal_state_vectors: [
      {
        dispatch_attempt_count: null,
        expected_consumer_state: "RECOVERY_REQUIRED",
        name: "ambiguous-send",
        outcome: "SEND_OUTCOME_UNKNOWN",
        reason: "SEND_CONFIRMATION_AMBIGUOUS",
        schema: "ego-chat-ambiguous-send-disposition/v1",
      },
      {
        dispatch_attempt_count: 0,
        expected_consumer_state: "RECOVERY_REQUIRED",
        name: "zero-dispatch-confirmed-absence",
        outcome: "CONFIRMED_NOT_SENT",
        reason: "NO_DISPATCH_ATTEMPT_OCCURRED",
        schema: "ego-chat-confirmed-send-absence/v1",
      },
      {
        dispatch_attempt_count: 1,
        expected_consumer_state: "RECOVERY_REQUIRED",
        name: "attempted-confirmed-absence",
        outcome: "CONFIRMED_NOT_SENT",
        reason: "CONFIRMED_SEND_ABSENT",
        schema: "ego-chat-confirmed-send-absence/v1",
      },
    ],
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.stdout.write(
    `${JSON.stringify(buildA3kAttachmentInteroperabilityVectors(), null, 2)}\n`,
  )
}
