import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const FIXED_NOW = "2026-09-04T05:00:00.000Z"
const FIXTURE_NAME = "a3k-legacy-attachment-provenance-v2.json"
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const VERSIONS = [
  {
    commit: "6e129a8b4fa49871f9a7c2664d8e29cc9805b0f2",
    maxEvents: 2,
    schemaVersion: 5,
  },
  {
    commit: "1db80aa9a646de1a16bbb7b92108deb19cd0c1bf",
    maxEvents: 5,
    schemaVersion: 6,
  },
  {
    commit: "3cfabcb5fbd67c6bcc004ac8ee581308724c0ed8",
    maxEvents: 6,
    schemaVersion: 7,
  },
]
const ARTIFACT_FILES = [
  "state.json",
  "checkpoint.json",
  "checkpoint.manifest.json",
  "events.jsonl",
]

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalJsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
}

function fixedDate() {
  const NativeDate = globalThis.Date
  return class FixedDate extends NativeDate {
    constructor(...args) {
      super(args.length === 0 ? FIXED_NOW : args[0])
    }

    static now() {
      return NativeDate.parse(FIXED_NOW)
    }
  }
}

function attachmentGraphObservation({
  canonicalConversationLocatorSha256,
  captureOperationKeySha256,
  observedAt,
  sequence,
  sourceConfirmedSendIdentitySha256,
}) {
  return {
    artifacts: [{
      artifact_id: "generation-1",
      artifact_kind: "GENERATED_IMAGE",
      dom_wrapper_id: "image-message-1",
      file_id: "file-1",
      generation_id: "generation-1",
      graph_attachment_id: "image-message-1:part:0",
      image_message_id: "image-message-1",
    }],
    asset_pointer_state: "PRESENT_NON_CONTROL",
    canonical_conversation_locator_sha256: canonicalConversationLocatorSha256,
    capture_operation_key_sha256: captureOperationKeySha256,
    continuation_cursor_present: false,
    direct_branch_ids: ["response-1"],
    direct_response_branch_count: 1,
    generated_image_artifact_count: 1,
    generation_terminal: true,
    graph_complete: true,
    graph_truncated: false,
    hydration_pending: false,
    non_image_artifact_count: 0,
    normal_download_control_count: 0,
    normal_save_control_count: 0,
    observation_sequence: sequence,
    observed_at: observedAt,
    provider_nodes: [{
      message_id: "response-1",
      parent_id: "prompt-confirmed",
      provider_status: "COMPLETE",
      terminal: true,
      turn_exchange_id: "exchange-1",
    }],
    provider_prompt_message_id: "prompt-confirmed",
    react_save_download_prop_count: 0,
    response_message_id: "response-1",
    save_association_id: null,
    schema: "ego-chat-attachment-graph-observation/v1",
    selected_branch_id: "response-1",
    source_confirmed_send_identity_sha256: sourceConfirmedSendIdentitySha256,
    total_artifact_count: 1,
    ui_action_surface_complete: true,
    unclassified_artifact_count: 0,
    visible_attachment_actions: ["EDIT_IMAGE", "SHARE_IMAGE"],
  }
}

function signedAttachmentEnvelope(receiptModule, disposition) {
  const payloadBytes = receiptModule.canonicalJsonBytes(disposition)
  return {
    authority_domain: disposition.authority_domain,
    media_type: disposition.media_type,
    payload_base64url: payloadBytes.toString("base64url"),
    payload_sha256: receiptModule.sha256Hex(payloadBytes),
    schema: "ego-chat-signed-attachment-evidence-envelope/v1",
    signature_base64url: Buffer.alloc(64, 1).toString("base64url"),
    signature_input_domain: disposition.signature_input_domain,
    signer_key_id: disposition.signer_key_id,
  }
}

function consumerAcknowledgement(receiptModule, ackModule, evidence) {
  const disposition = JSON.parse(
    Buffer.from(evidence.disposition_envelope.payload_base64url, "base64url"),
  )
  return {
    authority_domain: "attachment-evidence-retention-release-only",
    authority_key_id: "a3k-human-approval-root-v1",
    authorized_action: "release-attachment-evidence-reservation",
    confirmed_send_identity_sha256: receiptModule.sha256Hex(
      receiptModule.canonicalJsonBytes(evidence.confirmed_send_identity),
    ),
    consumer_profile: "a3k-manual-canary-v1",
    consumer_state: "RECOVERY_REQUIRED",
    consumer_state_record_sha256: "a".repeat(64),
    disposition_envelope_sha256: receiptModule.sha256Hex(
      receiptModule.canonicalJsonBytes(evidence.disposition_envelope),
    ),
    does_not_grant: ackModule.ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT,
    external_binding_sha256: evidence.intent.external_binding_sha256,
    idempotency_key_sha256: "b".repeat(64),
    media_type: "application/vnd.a3k.attachment-disposition-consumer-acknowledgement.v1+jcs",
    recovery_policy_sha256: "c".repeat(64),
    schema: "a3k-attachment-disposition-consumer-acknowledgement/v1",
    signature_input_domain: "A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1",
    terminal_evidence_digest: evidence.disposition_envelope.payload_sha256,
    terminal_evidence_kind: "attachment-execution-disposition",
    terminal_outcome: disposition.outcome,
    work_order_id: "CANARY-IMAGE-LEGACY-PROVENANCE",
  }
}

function signedConsumerAcknowledgement(receiptModule, acknowledgement) {
  const payloadBytes = receiptModule.canonicalJsonBytes(acknowledgement)
  return {
    authority_domain: acknowledgement.authority_domain,
    media_type: acknowledgement.media_type,
    payload_base64url: payloadBytes.toString("base64url"),
    payload_sha256: receiptModule.sha256Hex(payloadBytes),
    schema: "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1",
    signature_base64url: Buffer.alloc(256, 2).toString("base64url"),
    signature_input_domain: acknowledgement.signature_input_domain,
    signer_key_id: acknowledgement.authority_key_id,
  }
}

async function snapshotArtifacts(dataDir) {
  return Object.fromEntries(await Promise.all(ARTIFACT_FILES.map(async (name) => {
    const bytes = await fs.readFile(path.join(dataDir, name))
    return [name, {
      base64url: bytes.toString("base64url"),
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    }]
  })))
}

async function buildHistoricalVersion(spec) {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ego-history-v${spec.schemaVersion}-`))
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `ego-state-v${spec.schemaVersion}-`))
  await fs.chmod(dataDir, 0o700)
  const NativeDate = globalThis.Date
  try {
    const archive = execFileSync("git", ["archive", spec.commit], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
    execFileSync("tar", ["-x", "-C", archiveRoot], { input: archive })
    const storeModule = await import(
      pathToFileURL(path.join(archiveRoot, "src", "store.mjs"))
    )
    const receiptModule = await import(
      pathToFileURL(path.join(archiveRoot, "src", "attachment-execution-receipt.mjs"))
    )
    const ackModule = spec.schemaVersion === 7
      ? await import(pathToFileURL(path.join(archiveRoot, "src", "attachment-consumer-ack.mjs")))
      : null
    globalThis.Date = fixedDate()
    const store = new storeModule.EventStore(dataDir, { maxEvents: spec.maxEvents })
    await store.initialize()
    const workflowId = `4559c675-14a9-4ec0-b5f9-0bb3ec3b73${spec.schemaVersion}`
    const operationKey = `exchange:a3k-history-v${spec.schemaVersion}:EGO_CHAT_A3K_HISTORY_V${spec.schemaVersion}_12345678`
    const prompt = `EGO_CHAT_A3K_HISTORY_V${spec.schemaVersion}_12345678\nprepare`
    const workflow = {
      bindingKey: `a3k-history-v${spec.schemaVersion}`,
      createdAt: FIXED_NOW,
      id: workflowId,
      inputDigest: sha256(Buffer.from(prompt, "utf8")),
      kind: "ego_exchange",
      operationKey,
      phase: "browser_owned",
      private: {
        request: {
          prompt,
          receiptCapture: {
            consumer_signer_authorization_sha256: "8".repeat(64),
            external_binding_sha256: `${spec.schemaVersion}`.repeat(64),
            profile: "a3k-manual-canary-v1",
            receipt_capture_requested: true,
            schema: "ego-chat-receipt-enabled-exchange-request/v1",
          },
        },
      },
      reconciliation: {
        beforeHead: {
          contentDigest: "1".repeat(64),
          fingerprint: "2".repeat(64),
          fingerprintVersion: "tail-v1",
          messageId: "assistant-before",
          role: "assistant",
        },
        bindingRevision: 1,
        turnMarker: `EGO_CHAT_A3K_HISTORY_V${spec.schemaVersion}_12345678`,
      },
      status: "running",
      updatedAt: FIXED_NOW,
    }
    const admission = receiptModule.buildAttachmentCaptureIntent({
      authorizationDigest: "8".repeat(64),
      createdAt: FIXED_NOW,
      externalBindingDigest: `${spec.schemaVersion}`.repeat(64),
      operationKey,
      profile: "a3k-manual-canary-v1",
      ...(spec.schemaVersion >= 6
        ? {
            runtimeIdentity: {
              executable_sha256: "3".repeat(64),
              implementation_git_sha: "4".repeat(40),
              package_inventory_sha256: "5".repeat(64),
            },
            signerKeyId: `ed25519-spki-sha256:${"7".repeat(64)}`,
          }
        : {}),
      signerEnrollmentDigest: "6".repeat(64),
      workflowId,
    })
    await store.persistStarted("workflow.started", workflow, {
      intent: admission.intent,
      intentDigest: admission.digest,
    })

    if (spec.schemaVersion === 5) {
      const progressed = { ...workflow, phase: "send_confirmed", updatedAt: FIXED_NOW }
      await store.persist("workflow.progressed", progressed, workflow)
      await store.persistBinding("binding.created", {
        canonicalUrl: null,
        key: `history-tail-v${spec.schemaVersion}`,
        state: "unbound",
      })
    } else {
      const confirmed = await store.persistConfirmedAttachmentSend(
        "ego.send_confirmed",
        workflow,
        {
          phase: "awaiting_attachment_capture",
          private: workflow.private,
          reconciliation: workflow.reconciliation,
          status: "running",
        },
        {
          canonicalUrl: `https://chatgpt.com/c/history-v${spec.schemaVersion}`,
          promptMessageId: "prompt-confirmed",
          sentAt: FIXED_NOW,
        },
      )
      await store.beginAttachmentCapture(confirmed, FIXED_NOW)
      const firstCapture = store.getAttachmentCapture(workflowId)
      const identity = store.getConfirmedSendIdentity(workflowId)
      const identityDigest = receiptModule.sha256Hex(
        receiptModule.canonicalJsonBytes(identity),
      )
      let capture = await store.recordAttachmentCaptureAttempt({
        capture: firstCapture,
        elapsedMonotonicMs: 25,
        observation: attachmentGraphObservation({
          canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
          captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
          observedAt: "2026-09-04T05:00:01.000Z",
          sequence: 1,
          sourceConfirmedSendIdentitySha256: identityDigest,
        }),
      })
      capture = await store.recordAttachmentCaptureAttempt({
        capture,
        elapsedMonotonicMs: 25,
        observation: attachmentGraphObservation({
          canonicalConversationLocatorSha256: identity.canonical_conversation_url_sha256,
          captureOperationKeySha256: firstCapture.capture_operation_key_sha256,
          observedAt: "2026-09-04T05:00:02.000Z",
          sequence: 2,
          sourceConfirmedSendIdentitySha256: identityDigest,
        }),
      })
      const disposition = receiptModule.buildAttachmentExecutionDisposition({
        captureOperation: capture,
        confirmedSendIdentity: identity,
        confirmedSendIdentityDigest: identityDigest,
        observations: capture.candidate_observations,
        terminalAt: "2026-09-04T05:00:03.000Z",
      })
      const dispositionEnvelope = signedAttachmentEnvelope(receiptModule, disposition)
      await store.persistAttachmentDisposition({ capture, envelope: dispositionEnvelope })
      if (spec.schemaVersion === 7) {
        const evidence = {
          confirmed_send_identity: identity,
          disposition_envelope: dispositionEnvelope,
          intent: admission.intent,
        }
        const acknowledgement = consumerAcknowledgement(
          receiptModule,
          ackModule,
          evidence,
        )
        await store.releaseAttachmentEvidence({
          acknowledgement,
          envelope: signedConsumerAcknowledgement(receiptModule, acknowledgement),
          workflowId,
        })
      }
    }

    const sourceFiles = [
      "src/store.mjs",
      "src/attachment-execution-receipt.mjs",
      ...(spec.schemaVersion === 7 ? ["src/attachment-consumer-ack.mjs"] : []),
    ].map((relativePath) => {
      const bytes = execFileSync("git", ["show", `${spec.commit}:${relativePath}`], {
        cwd: REPOSITORY_ROOT,
      })
      return { path: relativePath, sha256: sha256(bytes) }
    })
    return {
      artifacts: await snapshotArtifacts(dataDir),
      expected_external_binding_sha256: `${spec.schemaVersion}`.repeat(64),
      expected_source_workflow_id: workflowId,
      producer_commit: spec.commit,
      producer_source_files: sourceFiles,
      schema_version: spec.schemaVersion,
    }
  } finally {
    globalThis.Date = NativeDate
    await fs.rm(archiveRoot, { force: true, recursive: true })
    await fs.rm(dataDir, { force: true, recursive: true })
  }
}

export async function buildA3kLegacyAttachmentProvenance() {
  const builderBytes = await fs.readFile(fileURLToPath(import.meta.url))
  const versions = []
  for (const spec of VERSIONS) {
    versions.push(await buildHistoricalVersion(spec))
  }
  return {
    builder_source_sha256: sha256(builderBytes),
    schema: "ego-chat-a3k-legacy-attachment-provenance/v2",
    versions,
  }
}

export async function serializeA3kLegacyAttachmentProvenance() {
  return canonicalJsonBytes(await buildA3kLegacyAttachmentProvenance())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDirectories = process.argv.slice(2)
  if (outputDirectories.length === 0) {
    throw new Error("at least one output directory is required")
  }
  const bytes = await serializeA3kLegacyAttachmentProvenance()
  for (const directory of outputDirectories) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, FIXTURE_NAME), bytes, { mode: 0o600 })
  }
}
