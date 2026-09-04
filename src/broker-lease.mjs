import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function processGroupIsAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    return false
  }
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomic(filePath, value) {
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
  await syncDirectory(directory)
}

async function readOwner(ownerPath) {
  try {
    return JSON.parse(await fs.readFile(ownerPath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    if (error instanceof SyntaxError) {
      throw new EgoChatError(
        "corrupt_broker_lease",
        "The authoritative broker lease contains invalid JSON.",
      )
    }
    throw error
  }
}

async function inspectClaim(lockPath) {
  let stat
  try {
    stat = await fs.lstat(lockPath)
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  }
  const legacyDirectory = stat.isDirectory()
  if (!legacyDirectory && !stat.isFile()) {
    throw new EgoChatError(
      "corrupt_broker_lease",
      "The authoritative broker lease is neither a file nor a legacy claim directory.",
    )
  }
  const ownerPath = legacyDirectory ? path.join(lockPath, "owner.json") : lockPath
  const owner = await readOwner(ownerPath)
  if (!owner || typeof owner.brokerId !== "string") {
    throw new EgoChatError(
      "corrupt_broker_lease",
      "The authoritative broker claim has no complete owner record; manual reconciliation is required.",
    )
  }
  return { legacyDirectory, owner, ownerPath }
}

function liveOwnerProcesses(owner) {
  const candidates = [
    owner.pid,
    ...(Array.isArray(owner.browserPids) ? owner.browserPids : []),
  ]
  const processGroups = Array.isArray(owner.browserProcessGroups)
    ? owner.browserProcessGroups
    : []
  return {
    pids: [...new Set(candidates)].filter(processIsAlive),
    processGroups: [...new Set(processGroups)].filter(processGroupIsAlive),
  }
}

export async function inspectBrokerLease(dataDir) {
  const lockPath = path.join(dataDir, "broker.lock")
  const existing = await inspectClaim(lockPath)
  if (!existing) {
    return {
      browserProcessGroups: [],
      browserPids: [],
      conclusivelyDead: true,
      epoch: null,
      ownerPresent: false,
      runtimeIdentity: null,
      state: "absent",
    }
  }
  if (
    !Number.isSafeInteger(existing.owner.pid)
    || existing.owner.pid < 1
    || !Number.isSafeInteger(existing.owner.epoch)
    || existing.owner.epoch < 0
    || !["active", "claiming"].includes(existing.owner.state)
    || !existing.owner.runtimeIdentity
    || typeof existing.owner.runtimeIdentity !== "object"
  ) {
    throw new EgoChatError(
      "corrupt_broker_lease",
      "The authoritative broker claim is incomplete; Eagle Monitor will not infer broker death.",
    )
  }
  const live = liveOwnerProcesses(existing.owner)
  const alive = live.pids.length > 0 || live.processGroups.length > 0
  return {
    browserProcessGroups: Array.isArray(existing.owner.browserProcessGroups)
      ? [...existing.owner.browserProcessGroups]
      : [],
    browserPids: Array.isArray(existing.owner.browserPids)
      ? [...existing.owner.browserPids]
      : [],
    conclusivelyDead: !alive,
    epoch: Number.isSafeInteger(existing.owner.epoch) ? existing.owner.epoch : null,
    ownerPresent: true,
    runtimeIdentity: existing.owner.runtimeIdentity ?? null,
    state: alive ? "alive" : "stale",
  }
}

async function retireStaleClaim(lockPath) {
  const stalePath = `${lockPath}.stale.${randomUUID()}`
  try {
    await fs.rename(lockPath, stalePath)
  } catch (error) {
    if (error.code === "ENOENT") {
      return false
    }
    throw error
  }
  const staleStat = await fs.lstat(stalePath)
  if (staleStat.isDirectory()) {
    await fs.rm(stalePath, { force: false, recursive: true })
  } else {
    await fs.unlink(stalePath)
  }
  await syncDirectory(path.dirname(lockPath))
  return true
}

async function nextEpoch(dataDir) {
  const epochPath = path.join(dataDir, "broker-epoch.json")
  let previous = 0
  try {
    const parsed = JSON.parse(await fs.readFile(epochPath, "utf8"))
    if (Number.isSafeInteger(parsed.epoch) && parsed.epoch >= 0) {
      previous = parsed.epoch
    } else {
      throw new EgoChatError("corrupt_broker_epoch", "The durable broker epoch is invalid.")
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
  const epoch = previous + 1
  await writeAtomic(epochPath, { epoch, updatedAt: new Date().toISOString() })
  return epoch
}

export async function acquireBrokerLease({
  afterClaim = undefined,
  dataDir,
  runtimeIdentity,
  socketPath,
}) {
  await fs.mkdir(dataDir, { mode: 0o700, recursive: true })
  const lockPath = path.join(dataDir, "broker.lock")

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await inspectClaim(lockPath)
    if (existing) {
      const live = liveOwnerProcesses(existing.owner)
      if (live.pids.length > 0 || live.processGroups.length > 0) {
        throw new EgoChatError(
          "broker_already_running",
          "An authoritative Ego Chat broker generation or its click-capable browser child still owns this data directory.",
          {
            brokerId: existing.owner.brokerId,
            browserProcessGroups: Array.isArray(existing.owner.browserProcessGroups)
              ? existing.owner.browserProcessGroups
              : [],
            browserPids: Array.isArray(existing.owner.browserPids)
              ? existing.owner.browserPids
              : [],
            epoch: existing.owner.epoch,
            livePids: live.pids,
            liveProcessGroups: live.processGroups,
            pid: existing.owner.pid,
            socketPath: existing.owner.socketPath,
          },
        )
      }
      if (!await retireStaleClaim(lockPath)) {
        continue
      }
    }

    const brokerId = randomUUID()
    const claimPath = path.join(dataDir, `.broker-claim-${randomUUID()}.json`)
    const claimingIdentity = {
      acquiredAt: new Date().toISOString(),
      brokerId,
      browserProcessGroups: [],
      browserPids: [],
      epoch: 0,
      pid: process.pid,
      runtimeIdentity,
      socketPath,
      state: "claiming",
    }
    await writeAtomic(claimPath, claimingIdentity)
    try {
      await fs.link(claimPath, lockPath)
      await syncDirectory(dataDir)
    } catch (error) {
      await fs.unlink(claimPath).catch(() => {})
      if (error.code === "EEXIST") {
        continue
      }
      throw error
    }
    await fs.unlink(claimPath)

    let identity
    try {
      await afterClaim?.(structuredClone(claimingIdentity))
      const epoch = await nextEpoch(dataDir)
      identity = {
        ...claimingIdentity,
        epoch,
        state: "active",
      }
      await writeAtomic(lockPath, identity)
    } catch (error) {
      const owner = await readOwner(lockPath).catch(() => null)
      if (owner?.brokerId === brokerId) {
        await fs.unlink(lockPath).catch(() => {})
      }
      throw error
    }

    const browserPids = new Set()
    const browserProcessGroups = new Set()
    let ownerTail = Promise.resolve()
    const updateBrowserPids = (mutation) => {
      const operation = ownerTail.then(async () => {
        const owner = await readOwner(lockPath)
        if (
          !owner
          || owner.brokerId !== brokerId
          || owner.epoch !== identity.epoch
          || owner.pid !== process.pid
        ) {
          throw new EgoChatError(
            "broker_lease_lost",
            "The broker lease changed while updating its click-capable browser children.",
          )
        }
        mutation(browserPids)
        await writeAtomic(lockPath, {
          ...identity,
          browserProcessGroups: [...browserProcessGroups].sort((left, right) => left - right),
          browserPids: [...browserPids].sort((left, right) => left - right),
        })
      })
      ownerTail = operation.catch(() => {})
      return operation
    }

    return {
      identity,
      inspect: async () => {
        await ownerTail
        const owner = await readOwner(lockPath)
        if (
          !owner
          || owner.brokerId !== brokerId
          || owner.epoch !== identity.epoch
          || owner.pid !== process.pid
        ) {
          throw new EgoChatError(
            "broker_lease_lost",
            "The broker lease changed before its child ledger could be inspected.",
          )
        }
        return structuredClone(owner)
      },
      lockPath,
      ownerPath: lockPath,
      registerChild: async (pid, { processGroup = false } = {}) => {
        if (!Number.isSafeInteger(pid) || pid < 1) {
          throw new EgoChatError("invalid_browser_pid", "The Ego Browser child PID is invalid.")
        }
        if (processGroup && process.platform === "win32") {
          throw new EgoChatError(
            "invalid_browser_process_group",
            "Browser process-group fencing is unavailable on this platform.",
          )
        }
        await updateBrowserPids((pids) => {
          pids.add(pid)
          if (processGroup) {
            browserProcessGroups.add(pid)
          }
        })
      },
      release: async () => {
        let owner
        let liveBrowserPids = []
        let liveBrowserProcessGroups = []
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await ownerTail
          owner = await readOwner(lockPath)
          if (!owner || owner.brokerId !== brokerId || owner.epoch !== identity.epoch) {
            throw new EgoChatError(
              "broker_lease_lost",
              "The broker lease changed before this process could release it.",
            )
          }
          liveBrowserPids = (owner.browserPids ?? []).filter(processIsAlive)
          liveBrowserProcessGroups = (owner.browserProcessGroups ?? []).filter(processGroupIsAlive)
          if (liveBrowserPids.length === 0 && liveBrowserProcessGroups.length === 0) {
            break
          }
          await wait(50)
        }
        if (liveBrowserPids.length > 0 || liveBrowserProcessGroups.length > 0) {
          throw new EgoChatError(
            "broker_children_active",
            "Click-capable Ego Browser children are still running; the broker lease cannot be released.",
            {
              browserPids: liveBrowserPids,
              browserProcessGroups: liveBrowserProcessGroups,
            },
          )
        }
        await fs.unlink(lockPath)
        await syncDirectory(dataDir)
      },
      unregisterChild: async (pid) => {
        await updateBrowserPids((pids) => {
          pids.delete(pid)
          browserProcessGroups.delete(pid)
        })
      },
    }
  }

  throw new EgoChatError("broker_lease_contended", "The broker lease could not be acquired safely.")
}
