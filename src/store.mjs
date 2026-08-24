import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { EgoChatError } from "./errors.mjs"

const EMPTY_STATE = Object.freeze({
  bindings: {},
  modelPolicies: {},
  nextSeq: 1,
  schemaVersion: 3,
  workflows: {},
})

function clone(value) {
  return structuredClone(value)
}

async function assertPrivateDirectory(directory) {
  const stat = await fs.stat(directory)
  if (!stat.isDirectory()) {
    throw new EgoChatError("unsafe_data_dir", "The configured data path is not a directory.")
  }

  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError("unsafe_data_dir", "The configured data directory is owned by another user.")
  }

  if ((stat.mode & 0o077) !== 0) {
    throw new EgoChatError(
      "unsafe_data_dir",
      "The configured data directory is accessible to another user or group; set its mode to 0700.",
    )
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700, recursive: true })
  await assertPrivateDirectory(directory)
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

function applyEvent(state, event) {
  if (
    !event
    || event.schemaVersion !== 1
    || !Number.isSafeInteger(event.seq)
    || typeof event.type !== "string"
  ) {
    throw new EgoChatError("corrupt_event_log", "The event ledger contains an invalid record.")
  }

  if (event.seq !== state.nextSeq) {
    throw new EgoChatError("corrupt_event_log", "The event ledger sequence is not contiguous.")
  }

  if (event.workflow && typeof event.workflow.id === "string") {
    state.workflows[event.workflow.id] = event.workflow
  } else if (event.binding && typeof event.binding.key === "string") {
    state.bindings[event.binding.key] = event.binding
  } else if (event.modelPolicy && typeof event.modelPolicy.key === "string") {
    state.modelPolicies[event.modelPolicy.key] = event.modelPolicy
  } else {
    throw new EgoChatError("corrupt_event_log", "The event ledger contains an invalid record.")
  }
  state.nextSeq += 1
}

export class EventStore {
  #dataDir
  #eventsPath
  #state = clone(EMPTY_STATE)
  #statePath
  #tail = Promise.resolve()

  constructor(dataDir) {
    this.#dataDir = dataDir
    this.#eventsPath = path.join(dataDir, "events.jsonl")
    this.#statePath = path.join(dataDir, "state.json")
  }

  get dataDir() {
    return this.#dataDir
  }

  async initialize() {
    await ensurePrivateDirectory(this.#dataDir)
    this.#state = clone(EMPTY_STATE)

    let ledger
    try {
      ledger = await fs.readFile(this.#eventsPath, "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
      ledger = ""
    }

    const lines = ledger.split("\n")
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.length === 0) {
        continue
      }

      try {
        applyEvent(this.#state, JSON.parse(line))
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new EgoChatError("corrupt_event_log", `The event ledger has invalid JSON on line ${index + 1}.`)
        }
        throw error
      }
    }

    await writeAtomicJson(this.#statePath, this.#state)
  }

  listWorkflows() {
    return Object.values(this.#state.workflows).map(clone)
  }

  getWorkflow(workflowId) {
    const workflow = this.#state.workflows[workflowId]
    return workflow ? clone(workflow) : undefined
  }

  listBindings() {
    return Object.values(this.#state.bindings).map(clone)
  }

  getBinding(bindingKey) {
    const binding = this.#state.bindings[bindingKey]
    return binding ? clone(binding) : undefined
  }

  listModelPolicies() {
    return Object.values(this.#state.modelPolicies).map(clone)
  }

  getModelPolicy(policyKey) {
    const modelPolicy = this.#state.modelPolicies[policyKey]
    return modelPolicy ? clone(modelPolicy) : undefined
  }

  async persist(type, workflow, expectedWorkflow = undefined) {
    return this.#persistEntity(type, "workflow", workflow, expectedWorkflow)
  }

  async persistBinding(type, binding) {
    return this.#persistEntity(type, "binding", binding)
  }

  async persistModelPolicy(type, modelPolicy) {
    return this.#persistEntity(type, "modelPolicy", modelPolicy)
  }

  async #persistEntity(type, entityName, entity, expectedEntity = undefined) {
    const operation = this.#tail.then(async () => {
      if (entityName === "workflow" && expectedEntity !== undefined) {
        const current = this.#state.workflows[entity.id]
        if (!isDeepStrictEqual(current, expectedEntity)) {
          throw new EgoChatError(
            "workflow_transition_conflict",
            "The workflow changed before this state transition could be committed.",
          )
        }
      }
      const event = {
        at: new Date().toISOString(),
        [entityName]: clone(entity),
        schemaVersion: 1,
        seq: this.#state.nextSeq,
        type,
      }
      const handle = await fs.open(this.#eventsPath, "a", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }

      applyEvent(this.#state, event)
      await writeAtomicJson(this.#statePath, this.#state)
      return clone(entity)
    })

    this.#tail = operation.catch(() => {})
    return operation
  }
}
