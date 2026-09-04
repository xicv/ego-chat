import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
  ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT,
  AttachmentReceiptAuthority,
  RECEIPT_RELEVANT_RUNTIME_PATHS,
  writeReceiptBuildManifest,
} from "../src/attachment-receipt-authority.mjs"
import { ATTACHMENT_CONSUMER_ACKNOWLEDGEMENT_DOES_NOT_GRANT } from "../src/attachment-consumer-ack.mjs"
import {
  buildAmbiguousSendDisposition,
  canonicalJsonBytes,
  sha256Hex,
} from "../src/attachment-execution-receipt.mjs"

const NOW = "2026-09-04T05:00:00.000Z"

async function writePrivate(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { mode: 0o700, recursive: true })
  await fs.writeFile(filePath, bytes, { mode: 0o600 })
}

async function createRuntimeFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ego-receipt-runtime-")))
  t.after(() => fs.rm(root, { force: false, recursive: true }))
  await fs.chmod(root, 0o700)
  const files = RECEIPT_RELEVANT_RUNTIME_PATHS.map((relativePath) => [
    relativePath,
    Buffer.from(`fixture:${relativePath}\n`, "utf8"),
  ])
  for (const [relativePath, bytes] of files) {
    await writePrivate(path.join(root, relativePath), bytes)
  }
  const executablePath = path.join(root, "ego-chat")
  const executableBytes = Buffer.from("fixture ego-chat executable", "utf8")
  await writePrivate(executablePath, executableBytes)
  const packageInventory = files.map(([relativePath, bytes]) => ({
    mode: 0o600,
    path: relativePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  }))
  const manifest = {
    executable_mode: 0o600,
    executable_path: executablePath,
    executable_sha256: sha256Hex(executableBytes),
    implementation_git_sha: "1".repeat(40),
    package_inventory: packageInventory,
    package_inventory_sha256: sha256Hex(canonicalJsonBytes(packageInventory)),
    runtime_root: root,
    runtime_root_mode: 0o700,
    schema: "ego-chat-receipt-build-manifest/v2",
  }
  await writePrivate(
    path.join(root, "receipt-build-manifest.json"),
    canonicalJsonBytes(manifest),
  )
  return { executablePath, manifest, root }
}

test("receipt signer enrollment is create-once and qualification verifies human authority before Send", async (t) => {
  const runtime = await createRuntimeFixture(t)
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ego-receipt-data-")))
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  await fs.chmod(dataDir, 0o700)
  const authorityRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "a3k-receipt-authority-")),
  )
  t.after(() => fs.rm(authorityRoot, { force: false, recursive: true }))
  await fs.chmod(authorityRoot, 0o700)
  const authorizationPath = path.join(authorityRoot, "signer-authorization-v1.json")
  const signaturePath = `${authorizationPath}.sig`
  const publicKeyPath = path.join(authorityRoot, "human-approval-public-key.pem")
  const humanKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  await writePrivate(publicKeyPath, humanKeyPair.publicKey.export({ format: "pem", type: "spki" }))
  const authority = new AttachmentReceiptAuthority({
    authorizationPath,
    dataDir,
    executablePath: runtime.executablePath,
    humanApprovalPublicKeyPath: publicKeyPath,
    now: () => new Date(NOW),
    runtimeRoot: runtime.root,
    signaturePath,
  })

  const firstEnrollment = await authority.enroll({ createdAt: "2026-09-04T04:00:00.000Z" })
  const secondEnrollment = await authority.enroll({ createdAt: "2099-01-01T00:00:00.000Z" })
  assert.deepEqual(secondEnrollment, firstEnrollment)
  assert.match(firstEnrollment.signer_key_id, /^ed25519-spki-sha256:[a-f0-9]{64}$/)
  assert.deepEqual(firstEnrollment.allowed_evidence_types, ALLOWED_ATTACHMENT_EVIDENCE_TYPES)
  assert.equal(firstEnrollment.executable_sha256, runtime.manifest.executable_sha256)
  assert.equal(firstEnrollment.package_inventory_sha256, runtime.manifest.package_inventory_sha256)
  const authorization = {
    allowed_evidence_types: ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
    authority_domain: "attachment-transport-signer-only",
    authority_key_id: "a3k-human-approval-root-v1",
    does_not_grant: ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT,
    executable_path: runtime.executablePath,
    executable_sha256: firstEnrollment.executable_sha256,
    implementation_git_sha: firstEnrollment.implementation_git_sha,
    package_inventory_sha256: firstEnrollment.package_inventory_sha256,
    policy_revision: 1,
    receipt_build_manifest_sha256: firstEnrollment.receipt_build_manifest_sha256,
    revocation_epoch: 0,
    rotation_epoch: 1,
    schema: "a3k-attachment-transport-signer-authorization/v1",
    signer_key_id: firstEnrollment.signer_key_id,
    spki_der_sha256: firstEnrollment.spki_der_sha256,
    valid_from: "2026-09-04T00:00:00.000Z",
    valid_until: "2026-09-05T00:00:00.000Z",
  }
  const authorizationBytes = canonicalJsonBytes(authorization)
  await writePrivate(authorizationPath, authorizationBytes)
  await writePrivate(signaturePath, sign("RSA-SHA256", authorizationBytes, humanKeyPair.privateKey))

  const qualification = await authority.qualify({
    consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
  })
  assert.equal(
    qualification.consumerSignerAuthorizationDigest,
    sha256Hex(authorizationBytes),
  )
  assert.equal(
    qualification.signerEnrollmentDigest,
    sha256Hex(canonicalJsonBytes(firstEnrollment)),
  )
  assert.equal(qualification.signerKeyId, firstEnrollment.signer_key_id)
  assert.deepEqual(qualification.runtimeIdentity, {
    executable_sha256: runtime.manifest.executable_sha256,
    implementation_git_sha: runtime.manifest.implementation_git_sha,
    package_inventory_sha256: runtime.manifest.package_inventory_sha256,
  })
  assert.equal(
    qualification.authoritySnapshotDigest,
    sha256Hex(canonicalJsonBytes(qualification.authoritySnapshot)),
  )
  assert.equal(
    qualification.authoritySnapshot.consumer_signer_authorization_sha256,
    sha256Hex(authorizationBytes),
  )

  const disposition = {
    authority_domain: "attachment-observation-only",
    capture_evidence_projection_sha256: "e".repeat(64),
    capture_operation_key_sha256: "a".repeat(64),
    capture_runtime_identity_sha256: sha256Hex(canonicalJsonBytes(qualification.runtimeIdentity)),
    consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    direct_response_branch_count: 1,
    external_binding_sha256: "b".repeat(64),
    final_stable_observation_at: "2026-09-04T04:59:59.000Z",
    first_stable_observation_at: "2026-09-04T04:59:58.000Z",
    generated_image_artifact_count: 1,
    media_type: "application/vnd.ego-chat.attachment-execution-disposition.v1+jcs",
    non_image_artifact_count: 0,
    normal_download_control_count: 0,
    normal_save_control_count: 0,
    outcome: "UNKNOWN",
    qualified_runtime_identity: {
      ...qualification.runtimeIdentity,
      runtime_identity_sha256: sha256Hex(canonicalJsonBytes(qualification.runtimeIdentity)),
    },
    reason: "UNSUPPORTED_SAVE_ASSOCIATION",
    receipt: null,
    save_association_id: null,
    schema: "ego-chat-attachment-execution-disposition/v1",
    signature_input_domain: "EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1",
    signer_enrollment_sha256: qualification.signerEnrollmentDigest,
    signer_key_id: qualification.signerKeyId,
    source_confirmed_send_identity_sha256: "c".repeat(64),
    stable_observation_count: 2,
    stable_observation_sha256: "d".repeat(64),
    terminal_at: NOW,
    total_artifact_count: 1,
    unclassified_artifact_count: 0,
  }
  const envelope = await authority.signAttachmentDisposition({
    authoritySnapshot: qualification.authoritySnapshot,
    authoritySnapshotDigest: qualification.authoritySnapshotDigest,
    consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
    disposition,
  })
  const payloadBytes = Buffer.from(envelope.payload_base64url, "base64url")
  assert.ok(payloadBytes.equals(canonicalJsonBytes(disposition)))
  assert.equal(envelope.payload_sha256, sha256Hex(payloadBytes))
  assert.equal(envelope.signer_key_id, firstEnrollment.signer_key_id)
  assert.equal(envelope.authority_domain, "attachment-observation-only")
  assert.equal(envelope.signature_input_domain, "EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1")
  assert.equal(envelope.media_type, disposition.media_type)
  assert.equal(
    verify(
      null,
      Buffer.concat([
        Buffer.from("EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1\0", "ascii"),
        payloadBytes,
      ]),
      createPublicKey({
        format: "der",
        key: Buffer.from(firstEnrollment.spki_der_base64url, "base64url"),
        type: "spki",
      }),
      Buffer.from(envelope.signature_base64url, "base64url"),
    ),
    true,
  )
  const acknowledgement = {
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
  }
  const acknowledgementBytes = canonicalJsonBytes(acknowledgement)
  const acknowledgementEnvelope = {
    authority_domain: acknowledgement.authority_domain,
    media_type: acknowledgement.media_type,
    payload_base64url: acknowledgementBytes.toString("base64url"),
    payload_sha256: sha256Hex(acknowledgementBytes),
    schema: "a3k-signed-attachment-disposition-consumer-acknowledgement-envelope/v1",
    signature_base64url: sign(
      "RSA-SHA256",
      Buffer.concat([
        Buffer.from("A3K_ATTACHMENT_DISPOSITION_CONSUMER_ACKNOWLEDGEMENT_V1\0", "ascii"),
        acknowledgementBytes,
      ]),
      humanKeyPair.privateKey,
    ).toString("base64url"),
    signature_input_domain: acknowledgement.signature_input_domain,
    signer_key_id: acknowledgement.authority_key_id,
  }
  assert.deepEqual(
    await authority.verifyConsumerAcknowledgement(acknowledgementEnvelope),
    acknowledgement,
  )
  await assert.rejects(
    authority.signAttachmentDisposition({
      authoritySnapshot: qualification.authoritySnapshot,
      authoritySnapshotDigest: qualification.authoritySnapshotDigest,
      consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
      disposition: {
        ...disposition,
        signer_key_id: `ed25519-spki-sha256:${"0".repeat(64)}`,
      },
    }),
    (error) => error.code === "attachment_disposition_authority_mismatch",
  )

  const runtimeFile = path.join(runtime.root, RECEIPT_RELEVANT_RUNTIME_PATHS[0])
  const originalRuntimeBytes = await fs.readFile(runtimeFile)
  await fs.writeFile(runtimeFile, Buffer.concat([originalRuntimeBytes, Buffer.from("drift")]))
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "receipt_runtime_identity_mismatch",
  )
  await fs.writeFile(runtimeFile, originalRuntimeBytes)
  await fs.chmod(runtimeFile, 0o644)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "invalid_receipt_build_manifest",
  )
  await fs.chmod(runtimeFile, 0o600)
  const runtimeLinkTarget = `${runtimeFile}.target`
  await fs.rename(runtimeFile, runtimeLinkTarget)
  await fs.symlink(runtimeLinkTarget, runtimeFile)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "invalid_receipt_build_manifest",
  )
  await fs.unlink(runtimeFile)
  await fs.rename(runtimeLinkTarget, runtimeFile)
  const publicKeyHardlink = `${publicKeyPath}.hardlink`
  await fs.link(publicKeyPath, publicKeyHardlink)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "attachment_receipt_authorization_unavailable",
  )
  await fs.unlink(publicKeyHardlink)
  const privateKeyPath = path.join(
    dataDir,
    "attachment-receipt-signer",
    "private-key.pk8",
  )
  const privateKeyHardlink = `${privateKeyPath}.hardlink`
  await fs.link(privateKeyPath, privateKeyHardlink)
  await assert.rejects(
    authority.signAttachmentDisposition({
      authoritySnapshot: qualification.authoritySnapshot,
      authoritySnapshotDigest: qualification.authoritySnapshotDigest,
      consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
      disposition,
    }),
    (error) => error.code === "unsafe_attachment_signer_key",
  )
  await fs.unlink(privateKeyHardlink)
  const signerRoot = path.dirname(privateKeyPath)
  await fs.chmod(signerRoot, 0o755)
  await assert.rejects(
    authority.signAttachmentDisposition({
      authoritySnapshot: qualification.authoritySnapshot,
      authoritySnapshotDigest: qualification.authoritySnapshotDigest,
      consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
      disposition,
    }),
    (error) => error.code === "unsafe_attachment_signer_root",
  )
  await fs.chmod(signerRoot, 0o700)
  const originalAuthorization = await fs.readFile(authorizationPath)
  await fs.unlink(authorizationPath)
  execFileSync("/usr/bin/mkfifo", [authorizationPath])
  await fs.chmod(authorizationPath, 0o600)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "attachment_receipt_authorization_unavailable",
  )
  await fs.unlink(authorizationPath)
  await writePrivate(authorizationPath, originalAuthorization)
  await fs.writeFile(signaturePath, Buffer.alloc(1025))
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "attachment_receipt_authorization_unavailable",
  )
  await fs.writeFile(signaturePath, sign(
    "RSA-SHA256",
    authorizationBytes,
    humanKeyPair.privateKey,
  ))
  const relocatedAuthorityRoot = `${authorityRoot}.pinned`
  await fs.rename(authorityRoot, relocatedAuthorityRoot)
  await fs.symlink(relocatedAuthorityRoot, authorityRoot)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "attachment_receipt_authorization_unavailable",
  )
  await fs.unlink(authorityRoot)
  await fs.rename(relocatedAuthorityRoot, authorityRoot)
  const pinnedDuringReadRoot = `${authorityRoot}.during-read`
  let replacedDuringRead = false
  const racingAuthority = new AttachmentReceiptAuthority({
    authorityFaultInjector: async (phase) => {
      if (phase !== "authorization_evidence_read" || replacedDuringRead) return
      await fs.rename(authorityRoot, pinnedDuringReadRoot)
      await fs.mkdir(authorityRoot, { mode: 0o700 })
      replacedDuringRead = true
    },
    authorizationPath,
    dataDir,
    executablePath: runtime.executablePath,
    humanApprovalPublicKeyPath: publicKeyPath,
    now: () => new Date(NOW),
    runtimeRoot: runtime.root,
    signaturePath,
  })
  await assert.rejects(
    racingAuthority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "attachment_receipt_authorization_unavailable",
  )
  assert.equal(replacedDuringRead, true)
  await fs.rmdir(authorityRoot)
  await fs.rename(pinnedDuringReadRoot, authorityRoot)
  const originalAuthorizationPath = `${authorizationPath}.during-read`
  let replacedAuthorizationFile = false
  const fileRacingAuthority = new AttachmentReceiptAuthority({
    authorityFaultInjector: async (phase) => {
      if (phase !== "authorization_file_bytes_read" || replacedAuthorizationFile) return
      await fs.rename(authorizationPath, originalAuthorizationPath)
      await writePrivate(authorizationPath, authorizationBytes)
      replacedAuthorizationFile = true
    },
    authorizationPath,
    dataDir,
    executablePath: runtime.executablePath,
    humanApprovalPublicKeyPath: publicKeyPath,
    now: () => new Date(NOW),
    runtimeRoot: runtime.root,
    signaturePath,
  })
  try {
    await assert.rejects(
      fileRacingAuthority.qualify({
        consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
      }),
      (error) => error.code === "attachment_receipt_authorization_unavailable",
    )
    assert.equal(replacedAuthorizationFile, true)
  } finally {
    if (replacedAuthorizationFile) {
      await fs.unlink(authorizationPath)
      await fs.rename(originalAuthorizationPath, authorizationPath)
    }
  }
  const originalSignature = await fs.readFile(signaturePath)
  const invalidSignature = Buffer.from(originalSignature)
  invalidSignature[0] ^= 0x01
  await fs.writeFile(signaturePath, invalidSignature)
  await assert.rejects(
    authority.qualify({
      consumer_signer_authorization_sha256: sha256Hex(authorizationBytes),
    }),
    (error) => error.code === "invalid_attachment_receipt_authorization",
  )
  const admittedIntent = {
    consumer_signer_authorization_sha256: qualification.consumerSignerAuthorizationDigest,
    created_at: NOW,
    external_binding_sha256: "b".repeat(64),
    live_reservation_bytes: 1024 * 1024,
    permanent_reservation_bytes: 32 * 1024,
    profile: "a3k-manual-canary-v1",
    qualified_runtime_identity: {
      ...qualification.runtimeIdentity,
      runtime_identity_sha256: sha256Hex(canonicalJsonBytes(qualification.runtimeIdentity)),
    },
    schema: "ego-chat-attachment-capture-intent/v1",
    send_resolution_deadline_at: "2026-09-04T05:10:00.000Z",
    signer_enrollment_sha256: qualification.signerEnrollmentDigest,
    signer_key_id: qualification.signerKeyId,
    source_operation_key_sha256: "e".repeat(64),
    source_workflow_id: "workflow-admitted-before-rotation",
    state: "RESERVED",
  }
  const ambiguousDisposition = buildAmbiguousSendDisposition({
    brokerEpoch: 7,
    browserFencingGeneration: 11,
    firstObservationAt: "2026-09-04T05:00:01.000Z",
    intent: admittedIntent,
    lastObservationAt: "2026-09-04T05:00:02.000Z",
    preDispatchTurnMarker: "EGO_CHAT_A3K_ADMITTED_AUTHORITY_12345678",
    terminalAt: "2026-09-04T05:10:00.000Z",
  })
  const admittedEnvelope = await authority.signAttachmentDisposition({
    authoritySnapshot: qualification.authoritySnapshot,
    authoritySnapshotDigest: qualification.authoritySnapshotDigest,
    consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
    disposition: ambiguousDisposition,
  })
  assert.equal(admittedEnvelope.payload_sha256, sha256Hex(canonicalJsonBytes(ambiguousDisposition)))
  const relocatedSignerRoot = `${signerRoot}.during-sign`
  let replacedSignerRoot = false
  const signerRacingAuthority = new AttachmentReceiptAuthority({
    authorityFaultInjector: async (phase) => {
      if (phase !== "signer_private_key_read" || replacedSignerRoot) return
      await fs.rename(signerRoot, relocatedSignerRoot)
      await fs.mkdir(signerRoot, { mode: 0o700 })
      replacedSignerRoot = true
    },
    authorizationPath,
    dataDir,
    executablePath: runtime.executablePath,
    humanApprovalPublicKeyPath: publicKeyPath,
    now: () => new Date(NOW),
    runtimeRoot: runtime.root,
    signaturePath,
  })
  try {
    await assert.rejects(
      signerRacingAuthority.signAttachmentDisposition({
        authoritySnapshot: qualification.authoritySnapshot,
        authoritySnapshotDigest: qualification.authoritySnapshotDigest,
        consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
        disposition: ambiguousDisposition,
      }),
      (error) => error.code === "unsafe_attachment_signer_root",
    )
    assert.equal(replacedSignerRoot, true)
  } finally {
    if (replacedSignerRoot) {
      await fs.rmdir(signerRoot)
      await fs.rename(relocatedSignerRoot, signerRoot)
    }
  }
  await assert.rejects(
    authority.signAttachmentDisposition({
      authoritySnapshot: {
        ...qualification.authoritySnapshot,
        admitted_at: "2026-09-04T05:00:00.001Z",
      },
      authoritySnapshotDigest: qualification.authoritySnapshotDigest,
      consumerSignerAuthorizationDigest: sha256Hex(authorizationBytes),
      disposition: ambiguousDisposition,
    }),
    (error) => error.code === "attachment_receipt_authority_snapshot_mismatch",
  )
})

test("receipt canonical JSON rejects sparse arrays, lone surrogates, and non-JSON objects", () => {
  const sparse = []
  sparse.length = 1
  assert.throws(() => canonicalJsonBytes(sparse), (error) => error.code === "invalid_canonical_json")
  assert.throws(
    () => canonicalJsonBytes({ value: "\ud800" }),
    (error) => error.code === "invalid_canonical_json",
  )
  assert.throws(
    () => canonicalJsonBytes({ "\udfff": "value" }),
    (error) => error.code === "invalid_canonical_json",
  )
  assert.throws(
    () => canonicalJsonBytes(new Date("2026-09-04T00:00:00.000Z")),
    (error) => error.code === "invalid_canonical_json",
  )
})

test("receipt build manifest records the exact managed runtime and fixed executable bytes", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ego-receipt-install-")))
  t.after(() => fs.rm(root, { force: false, recursive: true }))
  await fs.chmod(root, 0o700)
  for (const relativePath of RECEIPT_RELEVANT_RUNTIME_PATHS) {
    await writePrivate(path.join(root, relativePath), Buffer.from(`installed:${relativePath}\n`))
  }
  const executablePath = path.join(root, "ego-chat")
  const executableBytes = Buffer.from("installed executable")
  await writePrivate(executablePath, executableBytes)

  const result = await writeReceiptBuildManifest({
    executablePath,
    implementationGitSha: "a".repeat(40),
    runtimeRoot: root,
  })
  const persisted = await fs.readFile(path.join(root, "receipt-build-manifest.json"))
  assert.deepEqual(persisted, canonicalJsonBytes(result))
  assert.equal(result.executable_path, executablePath)
  assert.equal(result.executable_sha256, sha256Hex(executableBytes))
  assert.deepEqual(
    result.package_inventory.map((entry) => entry.path),
    RECEIPT_RELEVANT_RUNTIME_PATHS,
  )
  assert.equal(
    result.package_inventory_sha256,
    sha256Hex(canonicalJsonBytes(result.package_inventory)),
  )
})
