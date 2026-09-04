import { Buffer } from "node:buffer"
import {
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  attachmentCaptureOperationKeyDigest,
  buildAmbiguousSendDisposition,
  buildAttachmentCaptureIntent,
  buildAttachmentCaptureOperation,
  buildAttachmentEvidenceBundle,
  buildAttachmentEvidenceCapture,
  buildAttachmentExecutionDisposition,
  buildConfirmedSendAbsenceDisposition,
  buildConfirmedSendIdentity,
  buildTerminalEvidenceBundle,
  canonicalJsonBytes,
  sha256Hex,
} from "../../src/attachment-execution-receipt.mjs"
import {
  ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
  ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT,
  RECEIPT_RELEVANT_RUNTIME_PATHS,
} from "../../src/attachment-receipt-authority.mjs"

const FIXTURE_NAME = "a3k-attachment-public-boundary-v1.json"
const MANIFEST_NAME = "a3k-attachment-public-boundary-v1.manifest.json"
const RUNTIME_ROOT = "/private/tmp/ego-chat-a3k-public-boundary-v1/runtime"
const EXECUTABLE_PATH = `${RUNTIME_ROOT}/ego-chat`
const WORKFLOW_ID = "4559c675-14a9-4ec0-b5f9-0bb3ec3b73b5"
const OPERATION_KEY = (
  "exchange:adopt-21e6dcece16fa93f24608e53:"
  + "EGO_CHAT_A3K_MANUAL_CANARY_EXECUTE_V1_D749A417"
)
const PROMPT = Buffer.from("EGO_CHAT_A3K_STEP7_CANARY_002\nprepare", "utf8")
const EXTERNAL_BINDING_DIGEST = sha256Hex(Buffer.concat([
  Buffer.from("A3K_EGO_EXTERNAL_BINDING_V1\0", "ascii"),
  canonicalJsonBytes(executionClaim()),
]))
const RSA_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC6MmIqDLOzqRmX
gpO8dCLMFTxIW8oS3iHVX0M0F33GceyGwg5qZspVw1NlNuLy3mPNk2taZcqt18GU
WIyvYDr3Rr8fyCMXNAdn3I412dfLNcNveoWOIr4MrAY2t8F0R4FQD7FZSqLUSRsJ
fTUY4gwMmyydsH6/7hT5V68s98V0F8Xd6b9zWPIxzZCjZ4Ykea3iIgfpkIbgYwET
pRdl+DdYTIqZhx95zzycebGaSScWHkj8flOx+knT3BEhBEA2Rs4LqGCFrrGwmjVn
MsELzLaQb4RI/f1xQFbNoejD1i1jSpLsV9aY3jfCxuvuHFh0jQTqwfXlnyPts2/V
dHqzi/wZAgMBAAECggEAFmgCvRmrNFcIj910RszY9SMnDnQRRKT7gFBG54leJtfF
xU+r6Wz2M0zeh8MLm3tcmjv/wrCWK8ZXcrEXOPGFFwWp8Tql0mB99acqa9uLptYQ
7yTY1opiwWagFsyVGJeUPZyt1FdxccdcXA93qMdm+MthmpZHInSVjI3bNDeayMXw
oL/J6JIbb2qaxY+kBMljBT754q2QmmujKOpGUCzU1h6YO4o5Voauo8e87vjdYynv
EvO6nFvkHSAQMZA/0RxyyvIW/mTJOQ8g2ZEaVJhGz02y28EQVAdavP4OK7AY/AuD
W99oyKUrtGaNJzT+buzK5Ys+BpvXFoPboSVyZsQxKwKBgQD3mZvese5SaFJuWovH
d85AhdWN787oRBWZ/39dSgOf+YnhExFt4YaPrHUz4u5YeRcxJPMozVJRUe11+aWI
qKJHwfc5gvsIcQfxeI2OrJoeOkOkMu60l0uymFV6F2lNwwcTWSDa97ODhlvPTPvA
o1Oc5Yav99N1w1UWkBIJHqtEgwKBgQDAg33I2lh+qQkPvofZFV/Iv7WQLHHvoe0r
uRCzjcYK4e+HCBN43KlOHx8qrOSKrC0lOCs2UQJj843tocOoK+lgYJzqSy1V7VqI
mJw1YmATS2TrYku5Mb09JqY6pcts7A8gWxTxZxitVfkHDQ3HEPQC8ZJ54wXofEz6
Rm/he3lyMwKBgBpVMeibT9df1PR7mMYcDcl68l1oFb9KDmoUbD1Fs+D9rxZK6t2e
0KrTEpv0FJlAN6E4Zsv+GjUf23tik6JXHPs4u8xYC864Bro9sgBshu+UDsGV0SFP
vfM+lEip2L82cLg0EHR5R5RDY9xGObghJrFXD94DI3Aw2AnQRLrHkjt1AoGBAKqJ
0TvEcPCDPYu89QrRbHCho218cdIeV8OLxcfJp86sJ0wvU1CV6UVTPIDJeAuASt3V
zDHpwXxZnTkNPA4WGD9QVrEWt6qPAMxQpNCFvSZae6QpB3ufHEy3mDoL9REgbKX1
CbBv6+RhbKFaZwIZeo/BAEkJW4p/0pFDJIlSoFsRAoGAHnL0OvDcGADhzW3yOUrO
EAF+FRkoxGOr7ZqGgr6GlN5r/BOyZyF3U3NpeaHOAidwwT8tivAMegZOdB2WD+Ug
iYeJbAsGzRe0A5FePfSHUtVUb/pXoRsmt1COtGa6/zaJyg5GE/+heIQziuPfEcxb
HGy1WqJAMGdXJn0xi1XZI8g=
-----END PRIVATE KEY-----
`

const A3K_SCHEMA_FILES = Object.freeze([
  {
    path: "tools/generator/schemas/art_pipeline/ego-attachment-evidence-bundle-v1.schema.json",
    sha256: "3444c93a78c601c930b90bd57b39e08710ce391cc9eb2a804416a22084ce7129",
  },
  {
    path: "tools/generator/schemas/art_pipeline/ego-ambiguous-send-evidence-bundle-v1.schema.json",
    sha256: "4caad5650b1532083fe873013346946a3b9c189fe38f39700ede2ada071b4b17",
  },
  {
    path: "tools/generator/schemas/art_pipeline/ego-confirmed-send-absence-evidence-bundle-v1.schema.json",
    sha256: "3f128fa24e10c2a42e97bface9c66faec6aea2dac3d28b7127c1570a0f29c10c",
  },
  {
    path: "tools/generator/schemas/art_pipeline/ego-attachment-signer-enrollment-v1.schema.json",
    sha256: "740e3a6e9750050e87b8f80a3c4b6c5d4e95ca7edd8a9729a268dc25c7f15c1d",
  },
  {
    path: "tools/generator/schemas/art_pipeline/a3k-attachment-transport-signer-authorization-v1.schema.json",
    sha256: "8248121c1fd320e1868b3f00f4ef4f96f14c9c7d0e3f0a3fba6bb51d8b439d55",
  },
])

function executionClaim() {
  return {
    attempt_number: 1,
    checked_main_sha: "2".repeat(40),
    claimed_at: "2026-09-04T04:59:58.000Z",
    does_not_grant: [
      "source-approval",
      "runtime-approval",
      "scheduler-activation",
      "repository-write",
      "merge-or-shipping-authority",
    ],
    execute_marker: "A3K_MANUAL_CANARY_EXECUTE_V1",
    execute_turn_marker: "EGO_CHAT_A3K_MANUAL_CANARY_EXECUTE_V1_D749A417",
    generation_commit_sha256: "3".repeat(64),
    idempotency_key: "d749a41705f8f0d90ebf14ae241477950882c2639f5ae17ef28caf55a37ee772",
    prepare_turn_marker: "EGO_CHAT_A3K_MANUAL_CANARY_PREPARE_V1_D749A417",
    retry_allowed: false,
    schema: "a3k-manual-canary-execution-claim/v1",
    state: "CLAIMED_BEFORE_WEB_SEND",
    unknown_outcome_state: "RECOVERY_REQUIRED",
    work_order_id: "CANARY-MANUAL-IMAGE-HANDOFF-002",
  }
}

function producerContract() {
  const relativePaths = [
    "src/attachment-execution-receipt.mjs",
    "src/attachment-receipt-authority.mjs",
    "src/broker.mjs",
  ]
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const files = relativePaths.map((relativePath) => ({
    path: relativePath,
    sha256: sha256Hex(fs.readFileSync(path.join(root, relativePath))),
  }))
  return {
    files,
    sha256: sha256Hex(canonicalJsonBytes(files)),
  }
}

function runtimeFixture(contract) {
  const files = Object.fromEntries(RECEIPT_RELEVANT_RUNTIME_PATHS.map((relativePath) => [
    relativePath,
    Buffer.from(`runtime:${relativePath}\n`, "utf8").toString("base64url"),
  ]))
  const inventory = Object.entries(files).map(([relativePath, encoded]) => {
    const bytes = Buffer.from(encoded, "base64url")
    return {
      path: relativePath,
      sha256: sha256Hex(bytes),
      size_bytes: bytes.length,
    }
  })
  const executableBytes = Buffer.from("ego-chat test executable", "utf8")
  const manifest = {
    executable_path: EXECUTABLE_PATH,
    executable_sha256: sha256Hex(executableBytes),
    implementation_git_sha: contract.sha256,
    package_inventory: inventory,
    package_inventory_sha256: sha256Hex(canonicalJsonBytes(inventory)),
    runtime_root: RUNTIME_ROOT,
    schema: "ego-chat-receipt-build-manifest/v1",
  }
  return {
    executable_base64url: executableBytes.toString("base64url"),
    files,
    manifest,
    runtime_root: RUNTIME_ROOT,
  }
}

function fixedKeys() {
  const ed25519Private = createPrivateKey({
    format: "der",
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(Array.from({ length: 32 }, (_unused, index) => index)),
    ]),
    type: "pkcs8",
  })
  const ed25519PublicDer = createPublicKey(ed25519Private).export({
    format: "der",
    type: "spki",
  })
  const rsaPrivate = createPrivateKey(RSA_PRIVATE_KEY_PEM)
  const rsaPublicPem = createPublicKey(rsaPrivate).export({
    format: "pem",
    type: "spki",
  })
  return { ed25519Private, ed25519PublicDer, rsaPrivate, rsaPublicPem }
}

function signerAuthority(runtime, contract) {
  const keys = fixedKeys()
  const manifestBytes = canonicalJsonBytes(runtime.manifest)
  const publicDigest = sha256Hex(keys.ed25519PublicDer)
  const runtimeIdentity = {
    executable_sha256: runtime.manifest.executable_sha256,
    implementation_git_sha: contract.sha256,
    package_inventory_sha256: runtime.manifest.package_inventory_sha256,
  }
  const enrollment = {
    allowed_evidence_types: ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
    created_at: "2026-09-04T04:00:00.000Z",
    executable_sha256: runtimeIdentity.executable_sha256,
    implementation_git_sha: runtimeIdentity.implementation_git_sha,
    package_inventory_sha256: runtimeIdentity.package_inventory_sha256,
    receipt_build_manifest_sha256: sha256Hex(manifestBytes),
    runtime_identity_sha256: sha256Hex(canonicalJsonBytes(runtimeIdentity)),
    schema: "ego-chat-attachment-signer-enrollment/v1",
    signer_key_id: `ed25519-spki-sha256:${publicDigest}`,
    spki_der_base64url: keys.ed25519PublicDer.toString("base64url"),
    spki_der_sha256: publicDigest,
  }
  const authorization = {
    allowed_evidence_types: ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
    authority_domain: "attachment-transport-signer-only",
    authority_key_id: "a3k-human-approval-root-v1",
    does_not_grant: ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT,
    executable_path: EXECUTABLE_PATH,
    executable_sha256: runtimeIdentity.executable_sha256,
    implementation_git_sha: runtimeIdentity.implementation_git_sha,
    package_inventory_sha256: runtimeIdentity.package_inventory_sha256,
    policy_revision: 1,
    receipt_build_manifest_sha256: sha256Hex(manifestBytes),
    revocation_epoch: 0,
    rotation_epoch: 1,
    schema: "a3k-attachment-transport-signer-authorization/v1",
    signer_key_id: enrollment.signer_key_id,
    spki_der_sha256: publicDigest,
    valid_from: "2026-09-04T00:00:00.000Z",
    valid_until: "2026-09-05T00:00:00.000Z",
  }
  const authorizationBytes = canonicalJsonBytes(authorization)
  return {
    authorization_base64url: authorizationBytes.toString("base64url"),
    authorization_signature_base64url: sign(
      "RSA-SHA256",
      authorizationBytes,
      keys.rsaPrivate,
    ).toString("base64url"),
    ed25519_private: keys.ed25519Private,
    enrollment,
    human_public_key_pem_base64url: Buffer.from(keys.rsaPublicPem).toString("base64url"),
    runtime_identity: {
      ...runtimeIdentity,
      runtime_identity_sha256: enrollment.runtime_identity_sha256,
    },
  }
}

function attachmentObservation(identityDigest, captureKey, observedAt, sequence) {
  return {
    artifacts: [{
      artifact_id: "image-1",
      artifact_kind: "GENERATED_IMAGE",
      dom_wrapper_id: "dom-image-1",
      file_id: "file-image-1",
      generation_id: "generation-image-1",
      graph_attachment_id: "graph-image-1",
      image_message_id: "response-1",
    }],
    asset_pointer_state: "ABSENT",
    canonical_conversation_locator_sha256: "5".repeat(64),
    capture_operation_key_sha256: captureKey,
    continuation_cursor_present: false,
    direct_branch_ids: ["branch-1"],
    direct_response_branch_count: 1,
    generated_image_artifact_count: 1,
    generation_terminal: true,
    graph_complete: true,
    graph_truncated: false,
    hydration_pending: false,
    non_image_artifact_count: 0,
    normal_download_control_count: 1,
    normal_save_control_count: 1,
    observation_sequence: sequence,
    observed_at: observedAt,
    provider_nodes: [{
      message_id: "response-1",
      parent_id: "prompt-002",
      provider_status: "COMPLETE",
      terminal: true,
      turn_exchange_id: "exchange-1",
    }],
    provider_prompt_message_id: "prompt-002",
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
    source_confirmed_send_identity_sha256: identityDigest,
    total_artifact_count: 1,
    ui_action_surface_complete: true,
    unclassified_artifact_count: 0,
    visible_attachment_actions: ["SAVE_IMAGE"],
  }
}

function signEnvelope(disposition, authority) {
  const payload = canonicalJsonBytes(disposition)
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from(`${disposition.signature_input_domain}\0`, "ascii"),
      payload,
    ]),
    authority.ed25519_private,
  )
  return {
    authority_domain: disposition.authority_domain,
    media_type: disposition.media_type,
    payload_base64url: payload.toString("base64url"),
    payload_sha256: sha256Hex(payload),
    schema: "ego-chat-signed-attachment-evidence-envelope/v1",
    signature_base64url: signature.toString("base64url"),
    signature_input_domain: disposition.signature_input_domain,
    signer_key_id: disposition.signer_key_id,
  }
}

function intentFor(authority, sourceWorkflowId, sourceOperationKey) {
  return buildAttachmentCaptureIntent({
    authorizationDigest: sha256Hex(Buffer.from(authority.authorization_base64url, "base64url")),
    createdAt: "2026-09-04T04:59:59.000Z",
    externalBindingDigest: EXTERNAL_BINDING_DIGEST,
    operationKey: sourceOperationKey,
    profile: "a3k-manual-canary-v1",
    runtimeIdentity: {
      executable_sha256: authority.runtime_identity.executable_sha256,
      implementation_git_sha: authority.runtime_identity.implementation_git_sha,
      package_inventory_sha256: authority.runtime_identity.package_inventory_sha256,
    },
    signerEnrollmentDigest: sha256Hex(canonicalJsonBytes(authority.enrollment)),
    signerKeyId: authority.enrollment.signer_key_id,
    workflowId: sourceWorkflowId,
  })
}

function externalBinding(intent, intentDigest, state) {
  return {
    created_at: intent.created_at,
    external_binding_sha256: intent.external_binding_sha256,
    intent_sha256: intentDigest,
    ledger_key: `${intent.profile}:${intent.external_binding_sha256}`,
    permanent_reservation_bytes: intent.permanent_reservation_bytes,
    profile: intent.profile,
    schema: "ego-chat-attachment-external-binding-entry/v1",
    source_operation_key_sha256: intent.source_operation_key_sha256,
    source_workflow_id: intent.source_workflow_id,
    state,
  }
}

function fullAttachmentVector(authority) {
  const { digest: intentDigest, intent } = intentFor(authority, WORKFLOW_ID, OPERATION_KEY)
  const workflow = {
    bindingKey: "adopt-21e6dcece16fa93f24608e53",
    id: WORKFLOW_ID,
    inputDigest: sha256Hex(PROMPT),
    operationKey: OPERATION_KEY,
    private: { request: { prompt: PROMPT.toString("utf8") } },
    reconciliation: {
      beforeHead: {
        contentDigest: "3".repeat(64),
        fingerprint: "4".repeat(64),
        fingerprintVersion: "tail-v1",
        messageId: "assistant-before",
        role: "assistant",
      },
      bindingRevision: 1,
      turnMarker: "EGO_CHAT_A3K_MANUAL_CANARY_EXECUTE_V1_D749A417",
    },
  }
  const { event, identity } = buildConfirmedSendIdentity({
    intent,
    intentDigest,
    sequence: 7,
    sent: {
      canonicalUrl: "https://chatgpt.com/c/6a9621cb-1e78-83ec-a6cf-edca598cd527",
      promptMessageId: "prompt-002",
      sentAt: "2026-09-04T05:00:00.000Z",
    },
    workflow,
  })
  const identityDigest = sha256Hex(canonicalJsonBytes(identity))
  const captureKey = attachmentCaptureOperationKeyDigest(identityDigest)
  const observations = [
    attachmentObservation(identityDigest, captureKey, "2026-09-04T05:00:01.000Z", 1),
    attachmentObservation(identityDigest, captureKey, "2026-09-04T05:00:03.000Z", 2),
  ]
  const captureOperation = {
    ...buildAttachmentCaptureOperation({
      confirmedSendIdentityDigest: identityDigest,
      sourceWorkflowId: WORKFLOW_ID,
      startedAt: "2026-09-04T05:00:00.000Z",
    }),
    accumulated_monotonic_ms: 2_000,
    candidate_generation: 2,
    candidate_observations: observations,
    candidate_pair_count: 1,
    state: "TERMINAL",
  }
  const disposition = buildAttachmentExecutionDisposition({
    captureOperation,
    confirmedSendIdentity: identity,
    confirmedSendIdentityDigest: identityDigest,
    observations,
    terminalAt: "2026-09-04T05:00:04.000Z",
  })
  const envelope = signEnvelope(disposition, authority)
  captureOperation.terminal_disposition_sha256 = envelope.payload_sha256
  captureOperation.terminal_envelope_sha256 = sha256Hex(canonicalJsonBytes(envelope))
  return {
    bundle: buildAttachmentEvidenceBundle({
      capture: buildAttachmentEvidenceCapture(captureOperation, {
        outcome: disposition.outcome,
        reason: disposition.reason,
      }),
      confirmedSendEvent: event,
      confirmedSendIdentity: identity,
      dispositionEnvelope: envelope,
      exactPrompt: PROMPT,
      externalBinding: externalBinding(intent, intentDigest, "RESERVED"),
      intent,
      sourceOperationKey: OPERATION_KEY,
      sourceWorkflowId: WORKFLOW_ID,
    }),
    expected: {
      dispatch_attempt_count: null,
      outcome: "EXACTLY_ONE",
      reason: "EXACTLY_ONE_SUPPORTED",
      state: "WAITING_HUMAN_SOURCE_APPROVAL",
      terminal_kind: "attachment-execution-disposition",
    },
    name: "attachment-exactly-one",
  }
}

function terminalVector(authority, name, kind) {
  const sourceWorkflowId = `${WORKFLOW_ID}-${name}`
  const sourceOperationKey = `${OPERATION_KEY}-${name}`
  const { digest: intentDigest, intent } = intentFor(
    authority,
    sourceWorkflowId,
    sourceOperationKey,
  )
  const attempted = kind === "absence-attempted"
  const ambiguous = kind === "ambiguous"
  const disposition = ambiguous
    ? buildAmbiguousSendDisposition({
        brokerEpoch: 7,
        browserFencingGeneration: 11,
        firstObservationAt: "2026-09-04T05:00:00.000Z",
        intent,
        lastObservationAt: "2026-09-04T05:00:01.000Z",
        preDispatchTurnMarker: "EGO_CHAT_A3K_MANUAL_CANARY_EXECUTE_V1_D749A417",
        terminalAt: "2026-09-04T05:00:02.000Z",
      })
    : buildConfirmedSendAbsenceDisposition({
        browserFencingGeneration: 11,
        dispatchAttempts: attempted ? [{
          attempt_number: 1,
          browser_fencing_generation: 11,
          observed_at: "2026-09-04T05:00:00.500Z",
          outcome: "ABSENT",
        }] : [],
        intent,
        observedAt: "2026-09-04T05:00:01.000Z",
        terminalAt: "2026-09-04T05:00:02.000Z",
      })
  const schema = ambiguous
    ? "ego-chat-ambiguous-send-evidence-bundle/v1"
    : "ego-chat-confirmed-send-absence-evidence-bundle/v1"
  return {
    bundle: buildTerminalEvidenceBundle({
      dispositionEnvelope: signEnvelope(disposition, authority),
      externalBinding: externalBinding(
        intent,
        intentDigest,
        ambiguous
          ? "CONSUMED_AMBIGUOUS_PENDING_ACK"
          : "CONSUMED_NOT_SENT_PENDING_ACK",
      ),
      intent,
      schema,
      sourceOperationKey,
      sourceWorkflowId,
    }),
    expected: {
      dispatch_attempt_count: ambiguous ? null : disposition.dispatch_attempts.length,
      outcome: disposition.outcome,
      reason: disposition.reason,
      state: "RECOVERY_REQUIRED",
      terminal_kind: ambiguous
        ? "ambiguous-send-disposition"
        : "confirmed-send-absence",
    },
    name,
  }
}

export function buildA3kPublicBoundaryFixture() {
  const contract = producerContract()
  const runtime = runtimeFixture(contract)
  const authority = signerAuthority(runtime, contract)
  const claimBytes = canonicalJsonBytes(executionClaim())
  return {
    a3k_schema_files: A3K_SCHEMA_FILES,
    execution_claim_base64url: claimBytes.toString("base64url"),
    producer_contract: contract,
    runtime_fixture: runtime,
    schema: "ego-chat-a3k-public-boundary-interoperability/v1",
    signer_authority: {
      authorization_base64url: authority.authorization_base64url,
      authorization_signature_base64url: authority.authorization_signature_base64url,
      enrollment: authority.enrollment,
      human_public_key_pem_base64url: authority.human_public_key_pem_base64url,
    },
    vectors: [
      fullAttachmentVector(authority),
      terminalVector(authority, "ambiguous-send", "ambiguous"),
      terminalVector(authority, "zero-dispatch-confirmed-absence", "absence-zero"),
      terminalVector(authority, "attempted-confirmed-absence", "absence-attempted"),
    ],
  }
}

export function serializeFixture(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function fixtureManifest(fixtureBytes, fixture) {
  return {
    a3k_schema_files: fixture.a3k_schema_files,
    fixture_filename: FIXTURE_NAME,
    fixture_sha256: sha256Hex(fixtureBytes),
    producer_contract_sha256: fixture.producer_contract.sha256,
    schema: "ego-chat-a3k-public-boundary-interoperability-manifest/v1",
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDirectories = process.argv.slice(2)
  if (outputDirectories.length === 0) {
    throw new Error("at least one output directory is required")
  }
  const fixture = buildA3kPublicBoundaryFixture()
  const fixtureBytes = serializeFixture(fixture)
  const manifestBytes = serializeFixture(fixtureManifest(fixtureBytes, fixture))
  for (const directory of outputDirectories) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, FIXTURE_NAME), fixtureBytes, { mode: 0o600 })
    fs.writeFileSync(path.join(directory, MANIFEST_NAME), manifestBytes, { mode: 0o600 })
  }
}
