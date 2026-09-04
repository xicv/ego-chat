import { Buffer } from "node:buffer"
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import {
  assertValidTerminalEvidenceDisposition,
  canonicalJsonBytes,
  sha256Hex,
} from "./attachment-execution-receipt.mjs"
import { verifyAttachmentConsumerAcknowledgementEnvelope } from "./attachment-consumer-ack.mjs"
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
  "executable_mode",
  "executable_path",
  "executable_sha256",
  "implementation_git_sha",
  "package_inventory",
  "package_inventory_sha256",
  "runtime_root",
  "runtime_root_mode",
  "schema",
]

const PACKAGE_ENTRY_KEYS = ["mode", "path", "sha256", "size_bytes"]
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/
const KEY_ID_PATTERN = /^ed25519-spki-sha256:[a-f0-9]{64}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_AUTHORIZATION_BYTES = 256 * 1024
const MAX_SIGNATURE_BYTES = 1024
const MAX_DISPOSITION_BYTES = 256 * 1024
const AUTHORITY_SNAPSHOT_KEYS = [
  "admitted_at",
  "authorization_base64url",
  "authorization_signature_base64url",
  "consumer_signer_authorization_sha256",
  "enrollment_base64url",
  "human_approval_public_key_base64url",
  "qualified_runtime_identity",
  "receipt_build_manifest_base64url",
  "receipt_build_manifest_sha256",
  "schema",
  "signer_enrollment_sha256",
  "signer_key_id",
]

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
  "src/attachment-consumer-ack.mjs",
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

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFileStat(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function validateRegularFileStat(stat, filePath, maximumBytes, code, requiredMode) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(code, `Receipt authority path is not a regular file: ${filePath}`)
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(code, `Receipt authority file has the wrong owner: ${filePath}`)
  }
  if (stat.nlink !== 1) {
    fail(code, `Receipt authority file is not single-link: ${filePath}`)
  }
  if (requiredMode !== undefined && (stat.mode & 0o7777) !== requiredMode) {
    fail(code, `Receipt authority file has the wrong mode: ${filePath}`)
  }
  if (stat.size > maximumBytes) {
    fail(code, `Receipt authority file is too large: ${filePath}`)
  }
}

async function readBoundedRegularFileEvidence(
  filePath,
  maximumBytes,
  code,
  { afterRead = undefined, requiredMode = undefined } = {},
) {
  let pathBefore
  try {
    pathBefore = await fs.lstat(filePath)
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(code, `Required receipt authority file is missing: ${filePath}`)
    }
    throw error
  }
  validateRegularFileStat(pathBefore, filePath, maximumBytes, code, requiredMode)
  let handle
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    )
  } catch (_error) {
    fail(code, `Receipt authority file could not be opened safely: ${filePath}`)
  }
  try {
    const descriptorBefore = await handle.stat()
    validateRegularFileStat(
      descriptorBefore,
      filePath,
      maximumBytes,
      code,
      requiredMode,
    )
    if (!sameFileIdentity(pathBefore, descriptorBefore)) {
      fail(code, `Receipt authority file identity changed before open: ${filePath}`)
    }
    const bytes = Buffer.alloc(descriptorBefore.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const overflowProbe = Buffer.alloc(1)
    const { bytesRead: overflowBytesRead } = await handle.read(
      overflowProbe,
      0,
      1,
      offset,
    )
    await afterRead?.()
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
    ])
    validateRegularFileStat(
      descriptorAfter,
      filePath,
      maximumBytes,
      code,
      requiredMode,
    )
    validateRegularFileStat(pathAfter, filePath, maximumBytes, code, requiredMode)
    if (
      !sameStableFileStat(descriptorBefore, descriptorAfter)
      || !sameFileIdentity(descriptorAfter, pathAfter)
      || offset !== descriptorBefore.size
      || overflowBytesRead !== 0
    ) {
      fail(code, `Receipt authority file changed during read: ${filePath}`)
    }
    return { bytes, stat: descriptorAfter }
  } finally {
    await handle.close()
  }
}

async function readBoundedRegularFile(filePath, maximumBytes, code, options = undefined) {
  return (await readBoundedRegularFileEvidence(
    filePath,
    maximumBytes,
    code,
    options,
  )).bytes
}

function validateDirectoryStat(stat, directory, code, requiredMode = undefined) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(code, `Receipt authority path is not a directory: ${directory}`)
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(code, `Receipt authority directory has the wrong owner: ${directory}`)
  }
  if (requiredMode !== undefined && (stat.mode & 0o7777) !== requiredMode) {
    fail(code, `Receipt authority directory has the wrong mode: ${directory}`)
  }
}

async function openPinnedDirectory(directory, code, requiredMode = undefined) {
  const named = await fs.lstat(directory)
  validateDirectoryStat(named, directory, code, requiredMode)
  let handle
  try {
    handle = await fs.open(
      directory,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_DIRECTORY ?? 0),
    )
    const opened = await handle.stat()
    validateDirectoryStat(opened, directory, code, requiredMode)
    if (!sameFileIdentity(named, opened)) {
      fail(code, `Receipt authority directory changed while it was pinned: ${directory}`)
    }
    return { directory, handle, identity: opened }
  } catch (error) {
    await handle?.close()
    throw error
  }
}

async function assertPinnedDirectory(pinned, code, requiredMode = undefined) {
  const [opened, named] = await Promise.all([
    pinned.handle.stat(),
    fs.lstat(pinned.directory),
  ])
  validateDirectoryStat(opened, pinned.directory, code, requiredMode)
  validateDirectoryStat(named, pinned.directory, code, requiredMode)
  if (
    !sameFileIdentity(pinned.identity, opened)
    || !sameFileIdentity(opened, named)
  ) {
    fail(code, `Receipt authority directory pathname changed: ${pinned.directory}`)
  }
}

async function readCanonicalJson(filePath, maximumBytes, code, options = undefined) {
  const bytes = await readBoundedRegularFile(filePath, maximumBytes, code, options)
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
  if (stat.nlink !== 1) {
    fail(code, `Private signer file is not single-link: ${filePath}`)
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail(code, `Private signer file must have mode 0600: ${filePath}`)
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writePrivateNew(filePath, bytes) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
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

export async function writeReceiptBuildManifest({
  executablePath,
  implementationGitSha,
  runtimeRoot,
}) {
  const [canonicalRoot, canonicalExecutable] = await Promise.all([
    fs.realpath(runtimeRoot),
    fs.realpath(executablePath),
  ])
  if (
    canonicalRoot !== runtimeRoot
    || canonicalExecutable !== executablePath
    || !GIT_SHA_PATTERN.test(implementationGitSha)
  ) {
    fail(
      "invalid_receipt_build_manifest_input",
      "Receipt build manifest inputs must be canonical fixed paths and an exact Git SHA.",
    )
  }
  const runtimeRootStat = await fs.lstat(canonicalRoot)
  validateDirectoryStat(
    runtimeRootStat,
    canonicalRoot,
    "invalid_receipt_build_manifest_input",
  )
  if ((runtimeRootStat.mode & 0o7000) !== 0) {
    fail(
      "invalid_receipt_build_manifest_input",
      "Receipt runtime root must not have special mode bits.",
    )
  }
  const packageInventory = []
  for (const relativePath of RECEIPT_RELEVANT_RUNTIME_PATHS) {
    const filePath = path.join(canonicalRoot, relativePath)
    await assertSymlinkFreeWithin(
      canonicalRoot,
      filePath,
      "invalid_receipt_build_manifest_input",
    )
    const evidence = await readBoundedRegularFileEvidence(
      filePath,
      MAX_MANIFEST_BYTES,
      "invalid_receipt_build_manifest_input",
    )
    if ((evidence.stat.mode & 0o7000) !== 0) {
      fail(
        "invalid_receipt_build_manifest_input",
        `Receipt runtime file has special mode bits: ${relativePath}`,
      )
    }
    packageInventory.push({
      mode: evidence.stat.mode & 0o777,
      path: relativePath,
      sha256: sha256Hex(evidence.bytes),
      size_bytes: evidence.bytes.length,
    })
  }
  const executableEvidence = await readBoundedRegularFileEvidence(
    canonicalExecutable,
    MAX_MANIFEST_BYTES * 16,
    "invalid_receipt_build_manifest_input",
  )
  if ((executableEvidence.stat.mode & 0o7000) !== 0) {
    fail(
      "invalid_receipt_build_manifest_input",
      "Receipt executable must not have special mode bits.",
    )
  }
  const manifest = {
    executable_mode: executableEvidence.stat.mode & 0o777,
    executable_path: canonicalExecutable,
    executable_sha256: sha256Hex(executableEvidence.bytes),
    implementation_git_sha: implementationGitSha,
    package_inventory: packageInventory,
    package_inventory_sha256: sha256Hex(canonicalJsonBytes(packageInventory)),
    runtime_root: canonicalRoot,
    runtime_root_mode: runtimeRootStat.mode & 0o777,
    schema: "ego-chat-receipt-build-manifest/v2",
  }
  const targetPath = path.join(canonicalRoot, "receipt-build-manifest.json")
  const temporaryPath = path.join(canonicalRoot, `.receipt-build-manifest-${randomUUID()}`)
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(canonicalJsonBytes(manifest))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporaryPath, targetPath)
    await syncDirectory(canonicalRoot)
  } catch (error) {
    try {
      await fs.unlink(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError
    }
    throw error
  }
  return manifest
}

export function createInstalledAttachmentReceiptAuthority({
  dataDir,
  homeDirectory = os.homedir(),
  now = () => new Date(),
  runtimeRoot,
}) {
  const authorityRoot = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Across3Kingdoms",
    "asset-decisions",
  )
  const authorizationPath = path.join(
    authorityRoot,
    "attachment-transport-signer",
    "authorization-v1.json",
  )
  return new AttachmentReceiptAuthority({
    authorizationPath,
    dataDir,
    humanApprovalPublicKeyPath: path.join(
      authorityRoot,
      "human-approval-public-key.pem",
    ),
    now,
    runtimeRoot,
    signaturePath: `${authorizationPath}.sig`,
  })
}

export class AttachmentReceiptAuthority {
  #authorityFaultInjector
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
    authorityFaultInjector = undefined,
    authorizationPath,
    dataDir,
    executablePath,
    humanApprovalPublicKeyPath,
    now = () => new Date(),
    runtimeRoot,
    signaturePath,
  }) {
    this.#authorityFaultInjector = authorityFaultInjector
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
    const runtimeRootPin = await openPinnedDirectory(
      this.#runtimeRoot,
      "invalid_receipt_build_manifest",
    )
    let executableParentPin
    try {
      const canonicalRoot = await fs.realpath(this.#runtimeRoot)
      if (canonicalRoot !== this.#runtimeRoot) {
        fail("invalid_receipt_build_manifest", "The receipt runtime root is not canonical.")
      }
      const { bytes, value: manifest } = await readCanonicalJson(
        this.#manifestPath,
        MAX_MANIFEST_BYTES,
        "invalid_receipt_build_manifest",
        { requiredMode: 0o600 },
      )
      if (
      !hasExactKeys(manifest, MANIFEST_KEYS)
      || manifest.schema !== "ego-chat-receipt-build-manifest/v2"
      || manifest.runtime_root !== this.#runtimeRoot
      || !Number.isSafeInteger(manifest.runtime_root_mode)
      || manifest.runtime_root_mode < 0
      || manifest.runtime_root_mode > 0o777
      || !Number.isSafeInteger(manifest.executable_mode)
      || manifest.executable_mode < 0
      || manifest.executable_mode > 0o777
      || (this.#executablePath !== undefined && manifest.executable_path !== this.#executablePath)
      || !path.isAbsolute(manifest.executable_path)
      || !SHA256_PATTERN.test(manifest.executable_sha256)
      || !GIT_SHA_PATTERN.test(manifest.implementation_git_sha)
      || !SHA256_PATTERN.test(manifest.package_inventory_sha256)
      || !Array.isArray(manifest.package_inventory)
      || manifest.package_inventory.length !== RECEIPT_RELEVANT_RUNTIME_PATHS.length
      ) {
        fail("invalid_receipt_build_manifest", "The receipt build manifest has an invalid shape.")
      }
      await assertPinnedDirectory(
        runtimeRootPin,
        "invalid_receipt_build_manifest",
        manifest.runtime_root_mode,
      )
      this.#executablePath ??= manifest.executable_path
      if (await fs.realpath(this.#executablePath) !== this.#executablePath) {
        fail("invalid_receipt_build_manifest", "The fixed Ego Chat executable path is not canonical.")
      }
      executableParentPin = await openPinnedDirectory(
        path.dirname(this.#executablePath),
        "invalid_receipt_build_manifest",
      )
      const expectedPaths = [...RECEIPT_RELEVANT_RUNTIME_PATHS]
      const observedPaths = manifest.package_inventory.map((entry) => entry?.path)
      if (!isDeepStrictEqual(observedPaths, expectedPaths)) {
        fail("invalid_receipt_build_manifest", "The receipt build manifest file inventory drifted.")
      }
      for (const entry of manifest.package_inventory) {
        if (
        !hasExactKeys(entry, PACKAGE_ENTRY_KEYS)
        || !Number.isSafeInteger(entry.mode)
        || entry.mode < 0
        || entry.mode > 0o777
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
          { requiredMode: entry.mode },
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
        { requiredMode: manifest.executable_mode },
      )
      if (sha256Hex(executableBytes) !== manifest.executable_sha256) {
        fail("receipt_runtime_identity_mismatch", "The fixed Ego Chat executable drifted.")
      }
      await assertPinnedDirectory(
        runtimeRootPin,
        "invalid_receipt_build_manifest",
        manifest.runtime_root_mode,
      )
      await assertPinnedDirectory(
        executableParentPin,
        "invalid_receipt_build_manifest",
      )
      return { bytes, digest: sha256Hex(bytes), manifest }
    } finally {
      await executableParentPin?.handle.close()
      await runtimeRootPin.handle.close()
    }
  }

  async #loadEnrollment(runtime) {
    const signerRootPin = await openPinnedDirectory(
      this.#signerRoot,
      "unsafe_attachment_signer_root",
      0o700,
    )
    try {
      await assertPrivateFile(this.#privateKeyPath, "unsafe_attachment_signer_key")
      await assertPrivateFile(this.#enrollmentPath, "unsafe_attachment_signer_enrollment")
      const { bytes, value: enrollment } = await readCanonicalJson(
        this.#enrollmentPath,
        MAX_AUTHORIZATION_BYTES,
        "invalid_attachment_signer_enrollment",
        { requiredMode: 0o600 },
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
      const privateKeyDer = await readBoundedRegularFile(
        this.#privateKeyPath,
        MAX_AUTHORIZATION_BYTES,
        "unsafe_attachment_signer_key",
        { requiredMode: 0o600 },
      )
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
      await assertPinnedDirectory(
        signerRootPin,
        "unsafe_attachment_signer_root",
        0o700,
      )
      return { bytes, enrollment }
    } finally {
      await signerRootPin.handle.close()
    }
  }

  async enroll({ createdAt = this.#now().toISOString() } = {}) {
    await fs.mkdir(this.#dataDir, { mode: 0o700, recursive: true })
    await assertPrivateDirectory(this.#dataDir)
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
        writePrivateNew(path.join(temporaryRoot, "private-key.pk8"), privateKeyDer),
        writePrivateNew(
          path.join(temporaryRoot, "enrollment.json"),
          canonicalJsonBytes(enrollment),
        ),
      ])
      await syncDirectory(temporaryRoot)
      try {
        await fs.rename(temporaryRoot, this.#signerRoot)
        await syncDirectory(this.#dataDir)
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

  async #loadAuthorizationEvidence() {
    const directories = [...new Set([
      path.dirname(this.#authorizationPath),
      path.dirname(this.#signaturePath),
      path.dirname(this.#humanApprovalPublicKeyPath),
    ])]
    const pins = []
    try {
      for (const directory of directories) {
        pins.push(await openPinnedDirectory(
          directory,
          "attachment_receipt_authorization_unavailable",
          0o700,
        ))
      }
      const [authorizationRecord, signature, publicKey] = await Promise.all([
        readCanonicalJson(
          this.#authorizationPath,
          MAX_AUTHORIZATION_BYTES,
          "attachment_receipt_authorization_unavailable",
          {
            afterRead: () => this.#authorityFaultInjector?.(
              "authorization_file_bytes_read",
            ),
            requiredMode: 0o600,
          },
        ),
        readBoundedRegularFile(
          this.#signaturePath,
          MAX_SIGNATURE_BYTES,
          "attachment_receipt_authorization_unavailable",
          { requiredMode: 0o600 },
        ),
        readBoundedRegularFile(
          this.#humanApprovalPublicKeyPath,
          MAX_AUTHORIZATION_BYTES,
          "attachment_receipt_authorization_unavailable",
          { requiredMode: 0o600 },
        ),
      ])
      await this.#authorityFaultInjector?.("authorization_evidence_read")
      for (const pin of pins) {
        await assertPinnedDirectory(
          pin,
          "attachment_receipt_authorization_unavailable",
          0o700,
        )
      }
      return { authorizationRecord, publicKey, signature }
    } finally {
      await Promise.all(pins.map((pin) => pin.handle.close()))
    }
  }

  async qualify(request) {
    const runtime = await this.#loadRuntimeManifest()
    const { bytes: enrollmentBytes, enrollment } = await this.#loadEnrollment(runtime)
    const {
      authorizationRecord: { bytes: authorizationBytes, value: authorization },
      publicKey,
      signature,
    } = await this.#loadAuthorizationEvidence()
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
    let validSignature = false
    try {
      validSignature = verify("RSA-SHA256", authorizationBytes, publicKey, signature)
    } catch {
      validSignature = false
    }
    if (!validSignature) {
      fail("invalid_attachment_receipt_authorization", "The human authorization signature is invalid.")
    }
    const admittedAt = this.#now().toISOString()
    const authoritySnapshot = {
      admitted_at: admittedAt,
      authorization_base64url: authorizationBytes.toString("base64url"),
      authorization_signature_base64url: signature.toString("base64url"),
      consumer_signer_authorization_sha256: authorizationDigest,
      enrollment_base64url: enrollmentBytes.toString("base64url"),
      human_approval_public_key_base64url: publicKey.toString("base64url"),
      qualified_runtime_identity: runtimeIdentity(runtime.manifest),
      receipt_build_manifest_base64url: runtime.bytes.toString("base64url"),
      receipt_build_manifest_sha256: runtime.digest,
      schema: "ego-chat-attachment-receipt-authorization-snapshot/v1",
      signer_enrollment_sha256: sha256Hex(enrollmentBytes),
      signer_key_id: enrollment.signer_key_id,
    }
    return {
      authoritySnapshot,
      authoritySnapshotDigest: sha256Hex(canonicalJsonBytes(authoritySnapshot)),
      consumerSignerAuthorizationDigest: authorizationDigest,
      runtimeIdentity: runtimeIdentity(runtime.manifest),
      signerEnrollmentDigest: sha256Hex(enrollmentBytes),
      signerKeyId: enrollment.signer_key_id,
    }
  }

  #validateAuthoritySnapshot(snapshot, expectedDigest) {
    if (
      !hasExactKeys(snapshot, AUTHORITY_SNAPSHOT_KEYS)
      || snapshot.schema !== "ego-chat-attachment-receipt-authorization-snapshot/v1"
      || !SHA256_PATTERN.test(expectedDigest)
      || sha256Hex(canonicalJsonBytes(snapshot)) !== expectedDigest
      || ![
        snapshot.authorization_base64url,
        snapshot.authorization_signature_base64url,
        snapshot.enrollment_base64url,
        snapshot.human_approval_public_key_base64url,
        snapshot.receipt_build_manifest_base64url,
      ].every((value) => typeof value === "string" && BASE64URL_PATTERN.test(value))
    ) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The admitted receipt authority snapshot is invalid or changed.",
      )
    }
    const authorizationBytes = Buffer.from(snapshot.authorization_base64url, "base64url")
    const signature = Buffer.from(snapshot.authorization_signature_base64url, "base64url")
    const enrollmentBytes = Buffer.from(snapshot.enrollment_base64url, "base64url")
    const publicKey = Buffer.from(snapshot.human_approval_public_key_base64url, "base64url")
    const manifestBytes = Buffer.from(snapshot.receipt_build_manifest_base64url, "base64url")
    if (
      authorizationBytes.toString("base64url") !== snapshot.authorization_base64url
      || signature.toString("base64url") !== snapshot.authorization_signature_base64url
      || enrollmentBytes.toString("base64url") !== snapshot.enrollment_base64url
      || publicKey.toString("base64url") !== snapshot.human_approval_public_key_base64url
      || manifestBytes.toString("base64url") !== snapshot.receipt_build_manifest_base64url
      || authorizationBytes.length > MAX_AUTHORIZATION_BYTES
      || signature.length > MAX_SIGNATURE_BYTES
      || enrollmentBytes.length > MAX_AUTHORIZATION_BYTES
      || publicKey.length > MAX_AUTHORIZATION_BYTES
      || manifestBytes.length > MAX_MANIFEST_BYTES
    ) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The admitted receipt authority snapshot encoding is invalid.",
      )
    }
    let authorization
    let enrollment
    let manifest
    try {
      authorization = JSON.parse(authorizationBytes.toString("utf8"))
      enrollment = JSON.parse(enrollmentBytes.toString("utf8"))
      manifest = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The admitted receipt authority snapshot is not JSON.",
      )
    }
    if (
      !authorizationBytes.equals(canonicalJsonBytes(authorization))
      || !enrollmentBytes.equals(canonicalJsonBytes(enrollment))
      || !manifestBytes.equals(canonicalJsonBytes(manifest))
      || sha256Hex(authorizationBytes)
        !== snapshot.consumer_signer_authorization_sha256
      || sha256Hex(enrollmentBytes) !== snapshot.signer_enrollment_sha256
      || sha256Hex(manifestBytes) !== snapshot.receipt_build_manifest_sha256
      || snapshot.signer_key_id !== enrollment.signer_key_id
      || authorization.signer_key_id !== snapshot.signer_key_id
      || authorization.spki_der_sha256 !== enrollment.spki_der_sha256
      || authorization.receipt_build_manifest_sha256
        !== snapshot.receipt_build_manifest_sha256
      || enrollment.receipt_build_manifest_sha256
        !== snapshot.receipt_build_manifest_sha256
      || !isDeepStrictEqual(snapshot.qualified_runtime_identity, runtimeIdentity(manifest))
      || authorization.executable_sha256 !== manifest.executable_sha256
      || authorization.implementation_git_sha !== manifest.implementation_git_sha
      || authorization.package_inventory_sha256 !== manifest.package_inventory_sha256
      || enrollment.executable_sha256 !== manifest.executable_sha256
      || enrollment.implementation_git_sha !== manifest.implementation_git_sha
      || enrollment.package_inventory_sha256 !== manifest.package_inventory_sha256
      || !isDeepStrictEqual(authorization.allowed_evidence_types, ALLOWED_ATTACHMENT_EVIDENCE_TYPES)
      || !isDeepStrictEqual(enrollment.allowed_evidence_types, ALLOWED_ATTACHMENT_EVIDENCE_TYPES)
      || !isDeepStrictEqual(authorization.does_not_grant, ATTACHMENT_AUTHORIZATION_DOES_NOT_GRANT)
    ) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The admitted receipt authority snapshot lineage is invalid.",
      )
    }
    const admittedAt = parseTimestamp(snapshot.admitted_at, "admitted_at")
    const validFrom = parseTimestamp(authorization.valid_from, "valid_from")
    const validUntil = parseTimestamp(authorization.valid_until, "valid_until")
    let validSignature = false
    try {
      validSignature = verify("RSA-SHA256", authorizationBytes, publicKey, signature)
    } catch {
      validSignature = false
    }
    if (!validSignature || admittedAt < validFrom || admittedAt > validUntil) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The admitted receipt authority snapshot was not valid at admission.",
      )
    }
    return { authorization, enrollment, manifest }
  }

  async signAttachmentDisposition({
    authoritySnapshot,
    authoritySnapshotDigest,
    consumerSignerAuthorizationDigest,
    disposition,
  }) {
    const snapshot = this.#validateAuthoritySnapshot(
      authoritySnapshot,
      authoritySnapshotDigest,
    )
    if (
      consumerSignerAuthorizationDigest
        !== authoritySnapshot.consumer_signer_authorization_sha256
    ) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The terminal signer request does not match its admitted authority snapshot.",
      )
    }
    const runtime = await this.#loadRuntimeManifest()
    const { bytes: enrollmentBytes, enrollment } = await this.#loadEnrollment(runtime)
    if (
      runtime.digest !== authoritySnapshot.receipt_build_manifest_sha256
      || sha256Hex(enrollmentBytes) !== authoritySnapshot.signer_enrollment_sha256
      || enrollment.signer_key_id !== authoritySnapshot.signer_key_id
      || !isDeepStrictEqual(runtime.manifest, snapshot.manifest)
      || !isDeepStrictEqual(enrollment, snapshot.enrollment)
    ) {
      fail(
        "attachment_receipt_authority_snapshot_mismatch",
        "The current enrolled signer identity does not match the admitted authority snapshot.",
      )
    }
    try {
      assertValidTerminalEvidenceDisposition(disposition)
    } catch (error) {
      if (error instanceof EgoChatError) throw error
      fail(
        "invalid_attachment_disposition",
        "The attachment execution disposition is invalid.",
      )
    }
    const qualifiedRuntimeIdentity = {
      ...authoritySnapshot.qualified_runtime_identity,
      runtime_identity_sha256: sha256Hex(
        canonicalJsonBytes(authoritySnapshot.qualified_runtime_identity),
      ),
    }
    if (
      disposition.consumer_signer_authorization_sha256
        !== authoritySnapshot.consumer_signer_authorization_sha256
      || disposition.signer_enrollment_sha256
        !== authoritySnapshot.signer_enrollment_sha256
      || disposition.signer_key_id !== authoritySnapshot.signer_key_id
      || !isDeepStrictEqual(disposition.qualified_runtime_identity, qualifiedRuntimeIdentity)
      || (disposition.schema === "ego-chat-attachment-execution-disposition/v1"
        && disposition.capture_runtime_identity_sha256
          !== qualifiedRuntimeIdentity.runtime_identity_sha256)
    ) {
      fail(
        "attachment_disposition_authority_mismatch",
        "The disposition does not match the currently qualified receipt authority.",
      )
    }
    const payloadBytes = canonicalJsonBytes(disposition)
    if (payloadBytes.length > MAX_DISPOSITION_BYTES) {
      fail("attachment_disposition_too_large", "The disposition exceeds its size bound.")
    }
    const signerRootPin = await openPinnedDirectory(
      this.#signerRoot,
      "unsafe_attachment_signer_root",
      0o700,
    )
    let privateKeyBytes
    try {
      privateKeyBytes = await readBoundedRegularFile(
        this.#privateKeyPath,
        MAX_AUTHORIZATION_BYTES,
        "unsafe_attachment_signer_key",
        { requiredMode: 0o600 },
      )
      await this.#authorityFaultInjector?.("signer_private_key_read")
      await assertPinnedDirectory(
        signerRootPin,
        "unsafe_attachment_signer_root",
        0o700,
      )
    } finally {
      await signerRootPin.handle.close()
    }
    let privateKey
    try {
      privateKey = createPrivateKey({
        format: "der",
        key: privateKeyBytes,
        type: "pkcs8",
      })
    } catch {
      fail("invalid_attachment_signer_enrollment", "The attachment signer key is invalid.")
    }
    const signatureInput = Buffer.concat([
      Buffer.from(`${disposition.signature_input_domain}\0`, "ascii"),
      payloadBytes,
    ])
    const signature = sign(null, signatureInput, privateKey)
    if (signature.length !== 64) {
      fail("invalid_attachment_signature", "The Ed25519 signature has an invalid length.")
    }
    return {
      authority_domain: disposition.authority_domain,
      media_type: disposition.media_type,
      payload_base64url: payloadBytes.toString("base64url"),
      payload_sha256: sha256Hex(payloadBytes),
      schema: "ego-chat-signed-attachment-evidence-envelope/v1",
      signature_base64url: signature.toString("base64url"),
      signature_input_domain: disposition.signature_input_domain,
      signer_key_id: disposition.signer_key_id,
    }
  }

  async verifyConsumerAcknowledgement(envelope) {
    const publicKey = await readBoundedRegularFile(
      this.#humanApprovalPublicKeyPath,
      MAX_AUTHORIZATION_BYTES,
      "attachment_consumer_acknowledgement_authority_unavailable",
      { requiredMode: 0o600 },
    )
    return verifyAttachmentConsumerAcknowledgementEnvelope(envelope, publicKey)
  }
}
