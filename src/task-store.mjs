import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { EgoChatError } from "./errors.mjs"
import {
  cloneTaskValue,
  createEmptyTaskState,
  reduceTaskCommand,
  validateTaskState,
} from "./task-domain.mjs"

function clone(value) {
  return structuredClone(value)
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700, recursive: true })
  const stat = await fs.stat(directory)
  if (!stat.isDirectory()) {
    throw new EgoChatError("unsafe_data_dir", "The durable task data path is not a directory.")
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError("unsafe_data_dir", "The durable task data directory is owned by another user.")
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new EgoChatError(
      "unsafe_data_dir",
      "The durable task data directory must not be accessible to another user or group.",
    )
  }
}

async function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporaryPath, filePath)
  const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

export class DurableTaskStore {
  #dataDir
  #filePath
  #state = createEmptyTaskState()
  #tail = Promise.resolve()

  constructor(dataDir, { fileName = "task-spine-state.json" } = {}) {
    if (typeof fileName !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(fileName)) {
      throw new TypeError("fileName must be a simple bounded file name")
    }
    this.#dataDir = dataDir
    this.#filePath = path.join(dataDir, fileName)
  }

  get dataDir() {
    return this.#dataDir
  }

  getMetrics() {
    return {
      activityCount: Object.keys(this.#state.activities).length,
      approvalCount: Object.keys(this.#state.approvals).length,
      artifactCount: Object.keys(this.#state.artifacts).length,
      conversationCount: Object.keys(this.#state.conversations).length,
      effectCount: Object.keys(this.#state.effects).length,
      eventCount: this.#state.events.length,
      leaseCount: Object.keys(this.#state.leases).length,
      revision: this.#state.revision,
      runnerCount: Object.keys(this.#state.runners).length,
      taskCount: Object.keys(this.#state.tasks).length,
    }
  }

  async initialize() {
    await ensurePrivateDirectory(this.#dataDir)
    this.#state = await this.#readState()
    return this.getMetrics()
  }

  async snapshot({ refresh = true } = {}) {
    await this.#tail
    if (refresh) this.#state = await this.#readState()
    return clone(this.#state)
  }

  async transact(command) {
    const capturedCommand = cloneTaskValue(command)
    const operation = this.#tail.then(async () => {
      const current = await this.#readState()
      const transition = reduceTaskCommand(current, capturedCommand)
      if (transition.next !== current) await writeAtomicJson(this.#filePath, transition.next)
      this.#state = clone(transition.next)
      return {
        events: clone(transition.emitted),
        state: clone(transition.next),
      }
    })
    this.#tail = operation.catch(() => {})
    return operation
  }

  async #readState() {
    try {
      const value = JSON.parse(await fs.readFile(this.#filePath, "utf8"))
      validateTaskState(value)
      return value
    } catch (error) {
      if (error.code === "ENOENT") return createEmptyTaskState()
      if (error instanceof SyntaxError) {
        throw new EgoChatError("corrupt_task_state", "The durable task state contains invalid JSON.")
      }
      throw error
    }
  }
}
