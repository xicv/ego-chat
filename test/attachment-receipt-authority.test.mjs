import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
  ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT,
  AttachmentReceiptAuthority,
  RECEIPT_RELEVANT_RUNTIME_PATHS,
} from "../src/attachment-receipt-authority.mjs"
import {
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
    path: relativePath,
    sha256: sha256Hex(bytes),
    size_bytes: bytes.length,
  }))
  const manifest = {
    executable_path: executablePath,
    executable_sha256: sha256Hex(executableBytes),
    implementation_git_sha: "1".repeat(40),
    package_inventory: packageInventory,
    package_inventory_sha256: sha256Hex(canonicalJsonBytes(packageInventory)),
    runtime_root: root,
    schema: "ego-chat-receipt-build-manifest/v1",
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
