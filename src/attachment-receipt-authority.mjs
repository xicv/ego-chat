import { Buffer } from "node:buffer"
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import {
  canonicalJsonBytes,
  sha256Hex,
} from "./attachment-execution-receipt.mjs"
import { EgoChatError } from "./errors.mjs"

const AUTHORIZATION_KEYS = [
  "allowed_evidence_types",
  "authority_domain",
  "authority_key_id",
  "does_not_grant",
  "executable_path",
  "executable_sha256",
  "implementation_git_sha",
  "package_inventory_sha256",
  "policy_revision",
  "receipt_build_manifest_sha256",
  "revocation_epoch",
  "rotation_epoch",
  "schema",
  "signer_key_id",
  "spki_der_sha256",
  "valid_from",
  "valid_until",
]

const ENROLLMENT_KEYS = [
  "allowed_evidence_types",
  "created_at",
  "executable_sha256",
  "implementation_git_sha",
  "package_inventory_sha256",
  "receipt_build_manifest_sha256",
  "runtime_identity_sha256",
  "schema",
  "signer_key_id",
  "spki_der_base64url",
  "spki_der_sha256",
]

const MANIFEST_KEYS = [
  "executable_path",
  "executable_sha256",
  "implementation_git_sha",
  "package_inventory",
  "package_inventory_sha256",
  "runtime_root",
  "schema",
]

const PACKAGE_ENTRY_KEYS = ["path", "sha256", "size_bytes"]
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/
const KEY_ID_PATTERN = /^ed25519-spki-sha256:[a-f0-9]{64}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_AUTHORIZATION_BYTES = 256 * 1024
const MAX_SIGNATURE_BYTES = 1024

export const ALLOWED_ATTACHMENT_EVIDENCE_TYPES = Object.freeze([
  Object.freeze({
    authority_domain: "attachment-observation-only",
    media_type: "application/vnd.ego-chat.attachment-execution-disposition.v1+jcs",
    schema: "ego-chat-attachment-execution-disposition/v1",
    signature_input_domain: "EGO_CHAT_ATTACHMENT_EXECUTION_DISPOSITION_V1",
  }),
  Object.freeze({
    authority_domain: "send-ambiguity-observation-only",
    media_type: "application/vnd.ego-chat.ambiguous-send-disposition.v1+jcs",
    schema: "ego-chat-ambiguous-send-disposition/v1",
    signature_input_domain: "EGO_CHAT_AMBIGUOUS_SEND_DISPOSITION_V1",
  }),
  Object.freeze({
    authority_domain: "send-absence-observation-only",
    media_type: "application/vnd.ego-chat.confirmed-send-absence.v1+jcs",
    schema: "ego-chat-confirmed-send-absence/v1",
    signature_input_domain: "EGO_CHAT_CONFIRMED_SEND_ABSENCE_V1",
  }),
])

export const ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT = Object.freeze([
  "image-generation",
  "image-editing",
  "source-approval",
  "runtime-approval",
  "repository-write",
  "scheduler-activation",
  "production-queue-activation",
])

export const RECEIPT_RELEVANT_RUNTIME_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "bin/ego-chat-mcp.mjs",
  "bin/ego-chat.mjs",
  "bin/ego-chatd.mjs",
  "src/app-server-client.mjs",
  "src/attachment-execution-receipt.mjs",
  "src/attachment-receipt-authority.mjs",
  "src/auth-token.mjs",
  "src/broker-lease.mjs",
  "src/broker.mjs",
  "src/config.mjs",
  "src/constants.mjs",
  "src/convergence.mjs",
  "src/ego-adapter.mjs",
  "src/ego-driver-source.mjs",
  "src/errors.mjs",
  "src/ipc-client.mjs",
  "src/ipc-server.mjs",
  "src/mcp-server.mjs",
  "src/runtime-handoff.mjs",
  "src/store.mjs",
  "src/task-domain.mjs",
  "src/task-fakes.mjs",
  "src/task-spine.mjs",
  "src/task-store.mjs",
  "src/upgrade-dispatch.mjs",
  "src/validation.mjs",
  "src/workflow-supervision.mjs",
])

function fail(code, message) {
  throw new EgoChatError(code, message)
}

function hasExactKeys(value, keys) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
}

function parseTimestamp(value, field) {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    fail("invalid_attachment_receipt_authority", `${field} must be an exact UTC timestamp.`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("invalid_attachment_receipt_authority", `${field} is not a valid UTC timestamp.`)
  }
  return timestamp
}

async function readBoundedRegularFile(filePath, maximumBytes, code) {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(code, `Required receipt authority file is missing: ${filePath}`)
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(code, `Receipt authority path is not a regular file: ${filePath}`)
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(code, `Receipt authority file has the wrong owner: ${filePath}`)
  }
  if (stat.size > maximumBytes) {
    fail(code, `Receipt authority file is too large: ${filePath}`)
  }
  return fs.readFile(filePath)
}

async function readCanonicalJson(filePath, maximumBytes, code) {
  const bytes = await readBoundedRegularFile(filePath, maximumBytes, code)
  let value
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    fail(code, `Receipt authority JSON is invalid: ${filePath}`)
  }
  let canonical
  try {
    canonical = canonicalJsonBytes(value)
  } catch {
    fail(code, `Receipt authority JSON is outside the canonical I-JSON domain: ${filePath}`)
  }
  if (!bytes.equals(canonical)) {
    fail(code, `Receipt authority JSON is not canonical: ${filePath}`)
  }
  return { bytes, value }
}

async function assertPrivateDirectory(directory) {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("unsafe_attachment_signer_root", "The attachment signer root is not a directory.")
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail("unsafe_attachment_signer_root", "The attachment signer root has the wrong owner.")
  }
  if ((stat.mode & 0o077) !== 0) {
    fail("unsafe_attachment_signer_root", "The attachment signer root must have mode 0700.")
  }
}

async function assertPrivateFile(filePath, code) {
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(code, `Private signer path is not a regular file: ${filePath}`)
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(code, `Private signer file has the wrong owner: ${filePath}`)
  }
  if ((stat.mode & 0o077) !== 0) {
    fail(code, `Private signer file must have mode 0600: ${filePath}`)
  }
}

async function assertSymlinkFreeWithin(root, target, code) {
  const relative = path.relative(root, target)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(code, `Receipt runtime path escapes its fixed root: ${target}`)
  }
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) {
      fail(code, `Receipt runtime path contains a symbolic link: ${current}`)
    }
  }
}

function runtimeIdentity(manifest) {
  return {
    executable_sha256: manifest.executable_sha256,
    implementation_git_sha: manifest.implementation_git_sha,
    package_inventory_sha256: manifest.package_inventory_sha256,
  }
}

export class AttachmentReceiptAuthority {
  #authorizationPath
  #dataDir
  #enrollmentPath
  #executablePath
  #humanApprovalPublicKeyPath
  #manifestPath
  #now
  #privateKeyPath
  #runtimeRoot
  #signaturePath
  #signerRoot

  constructor({
    authorizationPath,
    dataDir,
    executablePath,
    humanApprovalPublicKeyPath,
    now = () => new Date(),
    runtimeRoot,
    signaturePath,
  }) {
    this.#authorizationPath = authorizationPath
    this.#dataDir = dataDir
    this.#executablePath = executablePath
    this.#humanApprovalPublicKeyPath = humanApprovalPublicKeyPath
    this.#manifestPath = path.join(runtimeRoot, "receipt-build-manifest.json")
    this.#now = now
    this.#runtimeRoot = runtimeRoot
    this.#signaturePath = signaturePath
    this.#signerRoot = path.join(dataDir, "attachment-receipt-signer")
    this.#privateKeyPath = path.join(this.#signerRoot, "private-key.pk8")
    this.#enrollmentPath = path.join(this.#signerRoot, "enrollment.json")
  }

  async #loadRuntimeManifest() {
    const canonicalRoot = await fs.realpath(this.#runtimeRoot)
    if (canonicalRoot !== this.#runtimeRoot) {
      fail("invalid_receipt_build_manifest", "The receipt runtime root is not canonical.")
    }
    const { bytes, value: manifest } = await readCanonicalJson(
      this.#manifestPath,
      MAX_MANIFEST_BYTES,
      "invalid_receipt_build_manifest",
    )
    if (
      !hasExactKeys(manifest, MANIFEST_KEYS)
      || manifest.schema !== "ego-chat-receipt-build-manifest/v1"
      || manifest.runtime_root !== this.#runtimeRoot
      || manifest.executable_path !== this.#executablePath
      || !SHA256_PATTERN.test(manifest.executable_sha256)
      || !GIT_SHA_PATTERN.test(manifest.implementation_git_sha)
      || !SHA256_PATTERN.test(manifest.package_inventory_sha256)
      || !Array.isArray(manifest.package_inventory)
      || manifest.package_inventory.length !== RECEIPT_RELEVANT_RUNTIME_PATHS.length
    ) {
      fail("invalid_receipt_build_manifest", "The receipt build manifest has an invalid shape.")
    }
    const expectedPaths = [...RECEIPT_RELEVANT_RUNTIME_PATHS]
    const observedPaths = manifest.package_inventory.map((entry) => entry?.path)
    if (!isDeepStrictEqual(observedPaths, expectedPaths)) {
      fail("invalid_receipt_build_manifest", "The receipt build manifest file inventory drifted.")
    }
    for (const entry of manifest.package_inventory) {
      if (
        !hasExactKeys(entry, PACKAGE_ENTRY_KEYS)
        || typeof entry.path !== "string"
        || !SHA256_PATTERN.test(entry.sha256)
        || !Number.isSafeInteger(entry.size_bytes)
        || entry.size_bytes < 0
      ) {
        fail("invalid_receipt_build_manifest", "The receipt build manifest entry is invalid.")
      }
      const filePath = path.join(this.#runtimeRoot, entry.path)
      await assertSymlinkFreeWithin(
        this.#runtimeRoot,
        filePath,
        "invalid_receipt_build_manifest",
      )
      const fileBytes = await readBoundedRegularFile(
        filePath,
        MAX_MANIFEST_BYTES,
        "invalid_receipt_build_manifest",
      )
      if (fileBytes.length !== entry.size_bytes || sha256Hex(fileBytes) !== entry.sha256) {
        fail("receipt_runtime_identity_mismatch", `Receipt runtime file drifted: ${entry.path}`)
      }
    }
    if (
      sha256Hex(canonicalJsonBytes(manifest.package_inventory))
        !== manifest.package_inventory_sha256
    ) {
      fail("invalid_receipt_build_manifest", "The package inventory digest does not match.")
    }
    const executableBytes = await readBoundedRegularFile(
      this.#executablePath,
      MAX_MANIFEST_BYTES * 16,
      "invalid_receipt_build_manifest",
    )
    if (sha256Hex(executableBytes) !== manifest.executable_sha256) {
      fail("receipt_runtime_identity_mismatch", "The fixed Ego Chat executable drifted.")
    }
    return { digest: sha256Hex(bytes), manifest }
  }

  async #loadEnrollment(runtime) {
    await assertPrivateDirectory(this.#signerRoot)
    await assertPrivateFile(this.#privateKeyPath, "unsafe_attachment_signer_key")
    await assertPrivateFile(this.#enrollmentPath, "unsafe_attachment_signer_enrollment")
    const { bytes, value: enrollment } = await readCanonicalJson(
      this.#enrollmentPath,
      MAX_AUTHORIZATION_BYTES,
      "invalid_attachment_signer_enrollment",
    )
    if (
      !hasExactKeys(enrollment, ENROLLMENT_KEYS)
      || enrollment.schema !== "ego-chat-attachment-signer-enrollment/v1"
      || !KEY_ID_PATTERN.test(enrollment.signer_key_id)
      || !BASE64URL_PATTERN.test(enrollment.spki_der_base64url)
      || !SHA256_PATTERN.test(enrollment.spki_der_sha256)
      || enrollment.signer_key_id !== `ed25519-spki-sha256:${enrollment.spki_der_sha256}`
      || !isDeepStrictEqual(enrollment.allowed_evidence_types, ALLOWED_ATTACHMENT_EVIDENCE_TYPES)
      || enrollment.implementation_git_sha !== runtime.manifest.implementation_git_sha
      || enrollment.executable_sha256 !== runtime.manifest.executable_sha256
      || enrollment.package_inventory_sha256 !== runtime.manifest.package_inventory_sha256
      || enrollment.receipt_build_manifest_sha256 !== runtime.digest
      || enrollment.runtime_identity_sha256
        !== sha256Hex(canonicalJsonBytes(runtimeIdentity(runtime.manifest)))
    ) {
      fail("invalid_attachment_signer_enrollment", "The attachment signer enrollment drifted.")
    }
    parseTimestamp(enrollment.created_at, "created_at")
    const spkiDer = Buffer.from(enrollment.spki_der_base64url, "base64url")
    if (
      spkiDer.toString("base64url") !== enrollment.spki_der_base64url
      || sha256Hex(spkiDer) !== enrollment.spki_der_sha256
    ) {
      fail("invalid_attachment_signer_enrollment", "The enrolled SPKI identity is invalid.")
    }
    const privateKeyDer = await fs.readFile(this.#privateKeyPath)
    let derivedSpki
    try {
      derivedSpki = createPublicKey(createPrivateKey({
        format: "der",
        key: privateKeyDer,
        type: "pkcs8",
      })).export({ format: "der", type: "spki" })
    } catch {
      fail("invalid_attachment_signer_enrollment", "The attachment signer key is invalid.")
    }
    if (!Buffer.from(derivedSpki).equals(spkiDer)) {
      fail("invalid_attachment_signer_enrollment", "The signer key does not match enrollment.")
    }
    return { bytes, enrollment }
  }

  async enroll({ createdAt = this.#now().toISOString() } = {}) {
    const runtime = await this.#loadRuntimeManifest()
    try {
      return (await this.#loadEnrollment(runtime)).enrollment
    } catch (error) {
      if (error.code !== "ENOENT" && ![
        "unsafe_attachment_signer_root",
      ].includes(error.code)) {
        throw error
      }
      try {
        await fs.lstat(this.#signerRoot)
        throw error
      } catch (statError) {
        if (statError.code !== "ENOENT") throw error
      }
    }
    await assertPrivateDirectory(this.#dataDir)
    parseTimestamp(createdAt, "created_at")
    const keyPair = generateKeyPairSync("ed25519")
    const privateKeyDer = keyPair.privateKey.export({ format: "der", type: "pkcs8" })
    const spkiDer = keyPair.publicKey.export({ format: "der", type: "spki" })
    const spkiDigest = sha256Hex(spkiDer)
    const identity = runtimeIdentity(runtime.manifest)
    const enrollment = {
      allowed_evidence_types: ALLOWED_ATTACHMENT_EVIDENCE_TYPES,
      created_at: createdAt,
      executable_sha256: identity.executable_sha256,
      implementation_git_sha: identity.implementation_git_sha,
      package_inventory_sha256: identity.package_inventory_sha256,
      receipt_build_manifest_sha256: runtime.digest,
      runtime_identity_sha256: sha256Hex(canonicalJsonBytes(identity)),
      schema: "ego-chat-attachment-signer-enrollment/v1",
      signer_key_id: `ed25519-spki-sha256:${spkiDigest}`,
      spki_der_base64url: spkiDer.toString("base64url"),
      spki_der_sha256: spkiDigest,
    }
    const temporaryRoot = await fs.mkdtemp(path.join(this.#dataDir, ".attachment-receipt-signer-"))
    await fs.chmod(temporaryRoot, 0o700)
    try {
      await Promise.all([
        fs.writeFile(path.join(temporaryRoot, "private-key.pk8"), privateKeyDer, {
          flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          mode: 0o600,
        }),
        fs.writeFile(path.join(temporaryRoot, "enrollment.json"), canonicalJsonBytes(enrollment), {
          flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          mode: 0o600,
        }),
      ])
      try {
        await fs.rename(temporaryRoot, this.#signerRoot)
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error
      }
    } finally {
      try {
        await fs.rm(temporaryRoot, { recursive: true })
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
    return (await this.#loadEnrollment(runtime)).enrollment
  }

  async qualify(request) {
    const runtime = await this.#loadRuntimeManifest()
    const { bytes: enrollmentBytes, enrollment } = await this.#loadEnrollment(runtime)
    const { bytes: authorizationBytes, value: authorization } = await readCanonicalJson(
      this.#authorizationPath,
      MAX_AUTHORIZATION_BYTES,
      "attachment_receipt_authorization_unavailable",
    )
    const authorizationDigest = sha256Hex(authorizationBytes)
    if (request?.consumer_signer_authorization_sha256 !== authorizationDigest) {
      fail(
        "attachment_receipt_authorization_mismatch",
        "The requested consumer signer authorization digest does not match the fixed document.",
      )
    }
    if (
      !hasExactKeys(authorization, AUTHORIZATION_KEYS)
      || authorization.schema !== "a3k-attachment-transport-signer-authorization/v1"
      || authorization.authority_key_id !== "a3k-human-approval-root-v1"
      || authorization.authority_domain !== "attachment-transport-signer-only"
      || authorization.policy_revision !== 1
      || authorization.revocation_epoch !== 0
      || authorization.rotation_epoch !== 1
      || !isDeepStrictEqual(authorization.allowed_evidence_types, ALLOWED_ATTACHMENT_EVIDENCE_TYPES)
      || !isDeepStrictEqual(authorization.does_not_grant, ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT)
      || authorization.signer_key_id !== enrollment.signer_key_id
      || authorization.spki_der_sha256 !== enrollment.spki_der_sha256
      || authorization.executable_path !== this.#executablePath
      || authorization.executable_sha256 !== runtime.manifest.executable_sha256
      || authorization.implementation_git_sha !== runtime.manifest.implementation_git_sha
      || authorization.package_inventory_sha256 !== runtime.manifest.package_inventory_sha256
      || authorization.receipt_build_manifest_sha256 !== runtime.digest
    ) {
      fail("invalid_attachment_receipt_authorization", "The signer authorization drifted.")
    }
    const validFrom = parseTimestamp(authorization.valid_from, "valid_from")
    const validUntil = parseTimestamp(authorization.valid_until, "valid_until")
    const now = this.#now().getTime()
    if (validFrom > now || now > validUntil || validFrom >= validUntil) {
      fail("attachment_receipt_authorization_inactive", "The signer authorization is not active.")
    }
    const [signature, publicKey] = await Promise.all([
      readBoundedRegularFile(
        this.#signaturePath,
        MAX_SIGNATURE_BYTES,
        "attachment_receipt_authorization_unavailable",
      ),
      readBoundedRegularFile(
        this.#humanApprovalPublicKeyPath,
        MAX_AUTHORIZATION_BYTES,
        "attachment_receipt_authorization_unavailable",
      ),
    ])
    let validSignature = false
    try {
      validSignature = verify("RSA-SHA256", authorizationBytes, publicKey, signature)
    } catch {
      validSignature = false
    }
    if (!validSignature) {
      fail("invalid_attachment_receipt_authorization", "The human authorization signature is invalid.")
    }
    return {
      consumerSignerAuthorizationDigest: authorizationDigest,
      runtimeIdentity: runtimeIdentity(runtime.manifest),
      signerEnrollmentDigest: sha256Hex(enrollmentBytes),
      signerKeyId: enrollment.signer_key_id,
    }
  }
}
