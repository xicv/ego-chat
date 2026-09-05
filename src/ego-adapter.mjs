import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import path from "node:path"

import {
  EGO_DRIVER_RESULT_PREFIX,
  egoDriverSourceForInput,
} from "./ego-driver-source.mjs"
import { EgoChatError } from "./errors.mjs"
import {
  BROWSER_CONTRACT_REVISION,
  DEFAULT_BROWSER_CAPTURE_SLICE_MS,
  MAX_DRIVER_INPUT_BYTES,
  MAX_IPC_LINE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_RESULT_BYTES,
} from "./constants.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

const DRIVER_INPUT_UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const DRIVER_INPUT_PATTERN = new RegExp(`^input-([1-9][0-9]{0,9})-(${DRIVER_INPUT_UUID})\\.json$`)
const LEGACY_DRIVER_INPUT_PATTERN = new RegExp(`^input-(${DRIVER_INPUT_UUID})\\.json$`)
const DEFAULT_DRIVER_MAILBOX_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_DRIVER_MAILBOX_MAX_FILES = 16
const DEFAULT_DRIVER_MAILBOX_RETENTION_MS = 5 * 60 * 1_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processOrGroupIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function terminateProcessGroup(pid, child = undefined, signal = "SIGTERM") {
  try {
    if (process.platform === "win32") {
      child?.kill(signal)
    } else {
      process.kill(-pid, signal)
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error
    }
  }
}

async function waitForProcessGroups(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let live = [...new Set(pids)].filter(processOrGroupIsAlive)
  while (live.length > 0 && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
    live = live.filter(processOrGroupIsAlive)
  }
  return live
}

function decodeDriverResult(stdout) {
  const lines = stdout.split("\n")
  const resultLines = lines.filter((line) => line.includes(EGO_DRIVER_RESULT_PREFIX))
  if (resultLines.length !== 1) {
    throw new EgoChatError("invalid_driver_output", "The Ego Browser driver did not return exactly one result envelope.", {
      outputBytes: Buffer.byteLength(stdout, "utf8"),
      outputDigest: digest(stdout),
      resultEnvelopeCount: resultLines.length,
    })
  }

  let decoded
  try {
    const prefixIndex = resultLines[0].indexOf(EGO_DRIVER_RESULT_PREFIX)
    const encoded = resultLines[0].slice(prefixIndex + EGO_DRIVER_RESULT_PREFIX.length).trim()
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch (_error) {
    throw new EgoChatError("invalid_driver_output", "The Ego Browser driver returned an invalid result envelope.")
  }

  if (decoded?.ok === true && decoded.result && typeof decoded.result === "object") {
    return decoded.result
  }
  if (decoded?.humanRequired === true) {
    throw new EgoChatError("human_required", decoded.message ?? "Human browser intervention is required.", {
      evidence: decoded.evidence ?? {},
      reason: decoded.reason ?? "browser_intervention_required",
    })
  }
  const driverError = decoded?.error
  const details = {
    ...(typeof driverError?.compositionMethod === "string"
      && /^[a-z][a-z0-9_]{0,63}$/.test(driverError.compositionMethod)
      ? { compositionMethod: driverError.compositionMethod }
      : {}),
    ...(typeof driverError?.diagnosticDigest === "string"
      ? { diagnosticDigest: driverError.diagnosticDigest }
      : {}),
    ...(typeof driverError?.draftCleared === "boolean"
      ? { draftCleared: driverError.draftCleared }
      : {}),
    ...(driverError?.modelPolicy && typeof driverError.modelPolicy === "object"
      ? { evidence: { modelPolicy: driverError.modelPolicy } }
      : {}),
    ...(typeof driverError?.stage === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(driverError.stage)
      ? { driverStage: driverError.stage }
      : {}),
    ...(Number.isSafeInteger(driverError?.promptBytes)
      && driverError.promptBytes >= 1
      && driverError.promptBytes <= MAX_PROMPT_BYTES
      ? { promptBytes: driverError.promptBytes }
      : {}),
    ...(Number.isSafeInteger(driverError?.promptCharacters)
      && driverError.promptCharacters >= 1
      && driverError.promptCharacters <= MAX_PROMPT_BYTES
      ? { promptCharacters: driverError.promptCharacters }
      : {}),
  }
  throw new EgoChatError(
    driverError?.code ?? "ego_driver_failed",
    driverError?.message ?? "The Ego Browser driver failed.",
    Object.keys(details).length > 0 ? details : undefined,
  )
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writePrivateText(filePath, value) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(filePath))
}

export class EgoAdapter {
  #activeChildren = new Map()
  #activeInputPaths = new Map()
  #brokerLease
  #browserLaneActive = 0
  #browserLaneQueued = 0
  #browserTail = Promise.resolve()
  #captureSliceMs
  #command
  #draining = false
  #mailboxDirectory
  #mailboxInputMaxBytes
  #mailboxMaxBytes
  #mailboxMaxFiles
  #mailboxMetrics = { bytes: 0, files: 0, removedStaleFiles: 0 }
  #mailboxReservations = new Map()
  #mailboxRetentionMs
  #mailboxTail = Promise.resolve()
  #registeredProcessGroups = new Set()

  constructor({
    brokerLease = undefined,
    captureSliceMs = DEFAULT_BROWSER_CAPTURE_SLICE_MS,
    command,
    mailboxDirectory = undefined,
    mailboxInputMaxBytes = MAX_DRIVER_INPUT_BYTES,
    mailboxMaxBytes = DEFAULT_DRIVER_MAILBOX_MAX_BYTES,
    mailboxMaxFiles = DEFAULT_DRIVER_MAILBOX_MAX_FILES,
    mailboxRetentionMs = DEFAULT_DRIVER_MAILBOX_RETENTION_MS,
  }) {
    if (!Number.isSafeInteger(captureSliceMs) || captureSliceMs < 1) {
      throw new TypeError("captureSliceMs must be a positive safe integer")
    }
    this.#brokerLease = brokerLease
    this.#captureSliceMs = captureSliceMs
    this.#command = command
    const uid = typeof process.getuid === "function" ? process.getuid() : "user"
    this.#mailboxDirectory = mailboxDirectory ?? `/tmp/egc-driver-${uid}`
    this.#mailboxInputMaxBytes = mailboxInputMaxBytes
    this.#mailboxMaxBytes = mailboxMaxBytes
    this.#mailboxMaxFiles = mailboxMaxFiles
    this.#mailboxRetentionMs = mailboxRetentionMs
  }

  async initialize() {
    return this.#withMailboxLock(async () => {
      const metrics = await this.#scanMailbox()
      this.#assertMailboxCapacity(metrics)
      return this.getMailboxMetrics()
    })
  }

  getMailboxMetrics() {
    return {
      activeBrowserOperations: this.#browserLaneActive,
      byteLimit: this.#mailboxMaxBytes,
      bytes: this.#mailboxMetrics.bytes,
      fileLimit: this.#mailboxMaxFiles,
      files: this.#mailboxMetrics.files,
      inputByteLimit: this.#mailboxInputMaxBytes,
      reservedBytes: [...this.#mailboxReservations.values()]
        .reduce((total, size) => total + size, 0),
      reservations: this.#mailboxReservations.size,
      retentionMs: this.#mailboxRetentionMs,
      queuedBrowserOperations: this.#browserLaneQueued,
    }
  }

  async refreshMailboxMetrics() {
    return this.#withMailboxLock(async () => {
      await this.#scanMailbox()
      return this.getMailboxMetrics()
    })
  }

  async drain(timeoutMs = 5_000) {
    this.#draining = true
    const children = [...this.#activeChildren.values()]
    const childByPid = new Map(children.map((entry) => [entry.pid, entry.child]))
    for (const { child, pid } of children) {
      if (!processOrGroupIsAlive(pid)) {
        continue
      }
      terminateProcessGroup(pid, child)
    }
    for (const pid of this.#registeredProcessGroups) {
      if (!this.#activeChildren.has(pid) && processOrGroupIsAlive(pid)) {
        terminateProcessGroup(pid)
      }
    }
    const processGroups = [
      ...children.map(({ pid }) => pid),
      ...this.#registeredProcessGroups,
    ]
    const gracefulTimeoutMs = Math.max(1, Math.floor(timeoutMs / 2))
    let liveProcessGroups = await waitForProcessGroups(processGroups, gracefulTimeoutMs)
    for (const pid of liveProcessGroups) {
      terminateProcessGroup(pid, childByPid.get(pid), "SIGKILL")
    }
    if (liveProcessGroups.length > 0) {
      liveProcessGroups = await waitForProcessGroups(
        liveProcessGroups,
        Math.max(1, timeoutMs - gracefulTimeoutMs),
      )
    }
    if (liveProcessGroups.length > 0) {
      throw new EgoChatError(
        "browser_children_active",
        "Ego Browser process groups did not exit during broker shutdown; authority remains fenced.",
        { browserProcessGroups: liveProcessGroups },
      )
    }
    const unregisterDeadline = Date.now() + timeoutMs
    while (this.#registeredProcessGroups.size > 0 && Date.now() < unregisterDeadline) {
      await delay(Math.min(50, Math.max(1, unregisterDeadline - Date.now())))
    }
    if (this.#registeredProcessGroups.size > 0) {
      throw new EgoChatError(
        "browser_children_active",
        "Exited Ego Browser process groups did not clear their durable lease registrations; authority remains fenced.",
        { browserProcessGroups: [...this.#registeredProcessGroups] },
      )
    }
  }

  async preflight(params, signal = undefined, beforeRun = undefined) {
    return this.#run(
      { brokerLease: this.#brokerLease, mode: "preflight", ...params },
      60_000,
      signal,
      undefined,
      beforeRun,
    )
  }

  async bind(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    const { mode: bindingMode, ...bindingInput } = params
    return this.#run(
      { brokerLease: this.#brokerLease, ...bindingInput, bindingMode, mode: "bind" },
      60_000,
      signal,
      onResult,
      beforeRun,
    )
  }

  async adopt(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run(
      { brokerLease: this.#brokerLease, ...params, mode: "adopt" },
      params.timeoutMs + 60_000,
      signal,
      onResult,
      beforeRun,
    )
  }

  async exchange(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "exchange", ...params }, params.timeoutMs + 60_000, signal, onResult, beforeRun)
  }

  async sendExchange(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({
      brokerLease: this.#brokerLease,
      exchangeStage: "send_only",
      mode: "exchange",
      ...params,
    }, 3 * 60_000, signal, onResult, beforeRun)
  }

  async captureExchange(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    const timeoutMs = Math.min(params.timeoutMs, this.#captureSliceMs)
    return this.#run({
      brokerLease: this.#brokerLease,
      ...params,
      captureContinuationAllowed: params.timeoutMs > timeoutMs,
      mode: "capture_exchange",
      timeoutMs,
    }, timeoutMs + 60_000, signal, onResult, beforeRun)
  }

  async captureAttachmentExecution(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({
      brokerLease: this.#brokerLease,
      ...params,
      mode: "capture_attachment_execution",
    }, 60_000, signal, onResult, beforeRun)
  }

  async ensureModelPolicy(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "model_policy", ...params }, 60_000, signal, onResult, beforeRun)
  }

  async reconcile(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "reconcile", ...params }, 60_000, signal, onResult, beforeRun)
  }

  async reconcileBound(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "reconcile_bound", ...params }, 60_000, signal, onResult, beforeRun)
  }

  async reanchor(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "reanchor", ...params }, 60_000, signal, onResult, beforeRun)
  }

  async verify(params, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#run({ brokerLease: this.#brokerLease, mode: "verify", ...params }, 60_000, signal, onResult, beforeRun)
  }

  async #withMailboxLock(operation) {
    const pending = this.#mailboxTail.then(operation)
    this.#mailboxTail = pending.catch(() => {})
    return pending
  }

  async #withBrowserLane(operation) {
    this.#browserLaneQueued += 1
    const pending = this.#browserTail.then(async () => {
      this.#browserLaneQueued -= 1
      this.#browserLaneActive = 1
      try {
        return await operation()
      } finally {
        this.#browserLaneActive = 0
      }
    })
    this.#browserTail = pending.catch(() => {})
    return pending
  }

  async #ensureMailboxDirectory() {
    await fs.mkdir(this.#mailboxDirectory, { mode: 0o700, recursive: true })
    const mailboxStat = await fs.lstat(this.#mailboxDirectory)
    if (
      !mailboxStat.isDirectory()
      || mailboxStat.isSymbolicLink()
      || (typeof process.getuid === "function" && mailboxStat.uid !== process.getuid())
      || (mailboxStat.mode & 0o777) !== 0o700
    ) {
      throw new EgoChatError("unsafe_driver_mailbox", "The fixed Ego driver mailbox is not a private owned directory.")
    }
  }

  async #durableBrowserProcessGroups() {
    if (typeof this.#brokerLease?.ownerPath !== "string") {
      return new Set()
    }
    let owner
    try {
      owner = JSON.parse(await fs.readFile(this.#brokerLease.ownerPath, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") {
        return new Set()
      }
      throw new EgoChatError(
        "unsafe_driver_mailbox",
        "The broker lease could not be read while protecting active driver inputs.",
      )
    }
    if (
      owner.brokerId !== this.#brokerLease.brokerId
      || owner.epoch !== this.#brokerLease.epoch
      || owner.pid !== this.#brokerLease.pid
    ) {
      return new Set()
    }
    return new Set(
      (Array.isArray(owner.browserProcessGroups) ? owner.browserProcessGroups : [])
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    )
  }

  async #scanMailbox() {
    await this.#ensureMailboxDirectory()
    const durableGroups = await this.#durableBrowserProcessGroups()
    const entries = await fs.readdir(this.#mailboxDirectory)
    const observedPids = new Set()
    let bytes = 0
    let files = 0
    let removedStaleFiles = 0
    for (const entry of entries) {
      const currentMatch = DRIVER_INPUT_PATTERN.exec(entry)
      const legacy = LEGACY_DRIVER_INPUT_PATTERN.test(entry)
      if (!currentMatch && !legacy) {
        throw new EgoChatError(
          "unsafe_driver_mailbox",
          "The fixed Ego driver mailbox contains an unrecognized entry.",
          { entryDigest: digest(entry) },
        )
      }
      const inputPath = path.join(this.#mailboxDirectory, entry)
      let stat
      try {
        stat = await fs.lstat(inputPath)
      } catch (error) {
        if (error.code === "ENOENT") {
          continue
        }
        throw error
      }
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.nlink !== 1
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (stat.mode & 0o777) !== 0o600
        || stat.size > this.#mailboxInputMaxBytes
      ) {
        throw new EgoChatError(
          "unsafe_driver_mailbox",
          "A fixed Ego driver input is not a private bounded regular file.",
          { entryDigest: digest(entry) },
        )
      }
      const childPid = currentMatch ? Number(currentMatch[1]) : null
      const active = this.#activeInputPaths.get(inputPath) === childPid
        || (
          childPid !== null
          && durableGroups.has(childPid)
          && processOrGroupIsAlive(childPid)
        )
      const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
      if (!active && ageMs >= this.#mailboxRetentionMs) {
        await fs.unlink(inputPath).catch((error) => {
          if (error.code !== "ENOENT") {
            throw error
          }
        })
        removedStaleFiles += 1
        continue
      }
      if (childPid !== null) {
        if (observedPids.has(childPid)) {
          throw new EgoChatError(
            "unsafe_driver_mailbox",
            "The fixed Ego driver mailbox contains ambiguous files for one child process.",
            { childPid },
          )
        }
        observedPids.add(childPid)
      }
      bytes += stat.size
      files += 1
    }
    if (removedStaleFiles > 0) {
      await syncDirectory(this.#mailboxDirectory)
    }
    this.#mailboxMetrics = { bytes, files, removedStaleFiles }
    return this.#mailboxMetrics
  }

  #assertMailboxCapacity(metrics, additionalFiles = 0, additionalBytes = 0) {
    const reservedBytes = [...this.#mailboxReservations.values()]
      .reduce((total, size) => total + size, 0)
    const requiredBytes = metrics.bytes + reservedBytes + additionalBytes
    const requiredFiles = metrics.files + this.#mailboxReservations.size + additionalFiles
    if (requiredBytes > this.#mailboxMaxBytes || requiredFiles > this.#mailboxMaxFiles) {
      throw new EgoChatError(
        "driver_mailbox_capacity_exhausted",
        "The bounded private Ego driver mailbox is full; no browser process was started.",
        {
          byteLimit: this.#mailboxMaxBytes,
          fileLimit: this.#mailboxMaxFiles,
          requiredBytes,
          requiredFiles,
        },
      )
    }
  }

  async #reserveMailboxInput(serializedInput) {
    const sizeBytes = Buffer.byteLength(serializedInput, "utf8")
    if (sizeBytes > this.#mailboxInputMaxBytes) {
      throw new EgoChatError(
        "driver_input_too_large",
        "The fixed Ego driver input exceeds its hard per-file byte limit.",
        { limitBytes: this.#mailboxInputMaxBytes, sizeBytes },
      )
    }
    return this.#withMailboxLock(async () => {
      const metrics = await this.#scanMailbox()
      this.#assertMailboxCapacity(metrics, 1, sizeBytes)
      const token = randomUUID()
      this.#mailboxReservations.set(token, sizeBytes)
      return token
    })
  }

  async #writeReservedMailboxInput(token, childPid, serializedInput) {
    return this.#withMailboxLock(async () => {
      if (!this.#mailboxReservations.has(token)) {
        throw new EgoChatError("driver_mailbox_reservation_lost", "The fixed driver mailbox reservation disappeared.")
      }
      const metrics = await this.#scanMailbox()
      this.#assertMailboxCapacity(metrics)
      const inputPath = path.join(
        this.#mailboxDirectory,
        `input-${childPid}-${randomUUID()}.json`,
      )
      this.#activeInputPaths.set(inputPath, childPid)
      try {
        await writePrivateText(inputPath, serializedInput)
      } catch (error) {
        this.#activeInputPaths.delete(inputPath)
        await fs.unlink(inputPath).catch(() => {})
        throw error
      }
      this.#mailboxReservations.delete(token)
      this.#mailboxMetrics.bytes += Buffer.byteLength(serializedInput, "utf8")
      this.#mailboxMetrics.files += 1
      return inputPath
    })
  }

  async #releaseMailboxReservation(token) {
    return this.#withMailboxLock(async () => {
      this.#mailboxReservations.delete(token)
    })
  }

  async #removeMailboxInput(inputPath) {
    if (!inputPath) {
      return
    }
    return this.#withMailboxLock(async () => {
      try {
        await fs.unlink(inputPath)
        await syncDirectory(this.#mailboxDirectory)
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error
        }
      } finally {
        this.#activeInputPaths.delete(inputPath)
      }
      await this.#scanMailbox()
    })
  }

  async #run(input, timeoutMs, signal = undefined, onResult = undefined, beforeRun = undefined) {
    return this.#withBrowserLane(async () => {
      const inputPatch = typeof beforeRun === "function" ? beforeRun() : undefined
      if (inputPatch && typeof inputPatch.then === "function") {
        throw new EgoChatError("invalid_browser_admission", "The in-lane browser admission callback must be synchronous.")
      }
      const effectiveInput = inputPatch === undefined
        ? input
        : { ...input, ...inputPatch }
      const result = await this.#runExclusive(effectiveInput, timeoutMs, signal)
      if (typeof onResult === "function") {
        const callbackResult = onResult(result)
        if (callbackResult && typeof callbackResult.then === "function") {
          throw new EgoChatError("invalid_browser_admission", "The in-lane browser result callback must be synchronous.")
        }
      }
      return result
    })
  }

  async #runExclusive(input, timeoutMs, signal = undefined) {
    if (this.#draining) {
      throw new EgoChatError(
        "ego_adapter_draining",
        "The Ego Browser adapter is draining and cannot start another operation.",
      )
    }
    const serializedInput = `${JSON.stringify({
      browserContractRevision: BROWSER_CONTRACT_REVISION,
      ...input,
    })}\n`
    const mailboxReservation = await this.#reserveMailboxInput(serializedInput)

    let inputPath
    let registeredChildPid
    let registration = Promise.resolve()
    let spawnedChild
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.#command, ["nodejs"], {
          detached: process.platform !== "win32",
          env: process.env,
          signal,
          stdio: ["pipe", "pipe", "pipe"],
        })
        if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
          child.kill("SIGTERM")
          reject(new EgoChatError("invalid_browser_pid", "The Ego Browser child did not expose a valid process identity."))
          return
        }
        spawnedChild = child
        const childRecord = { child, pid: child.pid }
        this.#activeChildren.set(child.pid, childRecord)
        child.once("close", () => {
          this.#activeChildren.delete(child.pid)
        })
        let stdout = ""
        let stderr = ""
        let overflow = false
        let settled = false

        const timer = setTimeout(() => {
          child.kill("SIGTERM")
          finish(reject, new EgoChatError("ego_driver_timeout", "The Ego Browser driver exceeded its local deadline."))
        }, timeoutMs)
        const finish = (callback, value) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          callback(value)
        }

        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdin.on("error", (error) => {
          finish(reject, new EgoChatError(
            "ego_browser_process_failed",
            "The Ego Browser process closed before receiving its complete fixed driver.",
            { diagnosticDigest: digest(error.code ?? "stdin_error") },
          ))
        })
        child.stdout.on("data", (chunk) => {
          stdout += chunk
          if (Buffer.byteLength(stdout, "utf8") > MAX_RESULT_BYTES) {
            overflow = true
            child.kill("SIGTERM")
          }
        })
        child.stderr.on("data", (chunk) => {
          stderr += chunk
          if (Buffer.byteLength(stderr, "utf8") > MAX_IPC_LINE_BYTES) {
            stderr = stderr.slice(-MAX_IPC_LINE_BYTES)
          }
        })
        child.on("error", (error) => finish(reject, error))
        child.on("close", (code, closeSignal) => {
          if (overflow) {
            finish(reject, new EgoChatError("driver_output_too_large", "The Ego Browser driver output exceeded the configured limit."))
          } else if (code === 0) {
            try {
              finish(resolve, decodeDriverResult(`${stdout}\n${stderr}`))
            } catch (error) {
              finish(reject, error)
            }
          } else {
            finish(reject, new EgoChatError("ego_browser_process_failed", "The Ego Browser process exited unsuccessfully.", {
              diagnosticDigest: digest(stderr),
              exitCode: code,
              signal: closeSignal,
            }))
          }
        })

        registration = (async () => {
          if (typeof this.#brokerLease?.registerChild === "function") {
            if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
              throw new EgoChatError("invalid_browser_pid", "The Ego Browser child did not expose a valid process identity.")
            }
            await this.#brokerLease.registerChild(child.pid, {
              processGroup: process.platform !== "win32",
            })
            registeredChildPid = child.pid
            this.#registeredProcessGroups.add(child.pid)
          }
          if (settled) {
            return
          }
          inputPath = await this.#writeReservedMailboxInput(
            mailboxReservation,
            child.pid,
            serializedInput,
          )
          if (!settled) {
            child.stdin.end(egoDriverSourceForInput(inputPath))
          }
        })()
        registration.catch((error) => {
          finish(reject, error)
        })
      })
      return result
    } finally {
      await registration.catch(() => {})
      await this.#releaseMailboxReservation(mailboxReservation)
      const spawnedChildPid = spawnedChild?.pid
      if (Number.isSafeInteger(spawnedChildPid) && spawnedChildPid > 0) {
        if (processOrGroupIsAlive(spawnedChildPid)) {
          terminateProcessGroup(spawnedChildPid, spawnedChild)
        }
        const liveProcessGroups = await waitForProcessGroups([spawnedChildPid], 2_000)
        if (liveProcessGroups.length > 0) {
          throw new EgoChatError(
            "browser_children_active",
            "An Ego Browser process group remained alive after its driver exited; authority remains fenced.",
            { browserProcessGroups: liveProcessGroups },
          )
        }
      }
      if (
        registeredChildPid !== undefined
        && typeof this.#brokerLease?.unregisterChild === "function"
      ) {
        await this.#brokerLease.unregisterChild(registeredChildPid)
        this.#registeredProcessGroups.delete(registeredChildPid)
      }
      await this.#removeMailboxInput(inputPath)
    }
  }
}

export { decodeDriverResult }
