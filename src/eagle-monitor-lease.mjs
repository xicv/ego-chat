import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

import { EAGLE_MONITOR_SCHEMA_VERSION } from "./eagle-monitor-constants.mjs"
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removeFileIfPresent,
  writeAtomicJson,
} from "./eagle-monitor-fs.mjs"
import { EgoChatError } from "./errors.mjs"

function defaultProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

async function readEpoch(config) {
  const value = await readPrivateJson(config.paths.epoch, {
    allowMissing: true,
    corruptionCode: "corrupt_monitor_epoch",
    maximumBytes: 16 * 1024,
  })
  if (value === null) return 0
  if (
    value.schemaVersion !== EAGLE_MONITOR_SCHEMA_VERSION
    || !Number.isSafeInteger(value.epoch)
    || value.epoch < 0
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))
    || Object.keys(value).some((key) => !["epoch", "schemaVersion", "updatedAt"].includes(key))
  ) {
    throw new EgoChatError("corrupt_monitor_epoch", "The durable Eagle Monitor epoch is invalid.")
  }
  return value.epoch
}

async function nextEpoch(config) {
  const priorEpoch = await readEpoch(config)
  const epoch = priorEpoch + 1
  await writeAtomicJson(config.paths.epoch, {
    epoch,
    schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  })
  return epoch
}

async function readOwner(config) {
  const owner = await readPrivateJson(config.paths.lock, {
    allowMissing: true,
    corruptionCode: "corrupt_monitor_lease",
    maximumBytes: 16 * 1024,
  })
  if (owner === null) return null
  if (
    owner.schemaVersion !== EAGLE_MONITOR_SCHEMA_VERSION
    || typeof owner.ownerId !== "string"
    || owner.ownerId.length < 1
    || owner.ownerId.length > 100
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || !Number.isSafeInteger(owner.epoch)
    || owner.epoch < 0
    || !["active", "claiming"].includes(owner.state)
    || typeof owner.acquiredAt !== "string"
    || !Number.isFinite(Date.parse(owner.acquiredAt))
    || Object.keys(owner).some((key) => ![
      "acquiredAt",
      "epoch",
      "ownerId",
      "pid",
      "schemaVersion",
      "state",
    ].includes(key))
  ) {
    throw new EgoChatError(
      "corrupt_monitor_lease",
      "The durable Eagle Monitor lease is invalid; recovery remains paused.",
    )
  }
  return owner
}

export async function inspectMonitorLease(config, { processIsAlive = defaultProcessIsAlive } = {}) {
  const durableEpoch = await readEpoch(config)
  const owner = await readOwner(config)
  if (!owner) return { active: false, epoch: null }
  if (
    (owner.state === "claiming" && owner.epoch !== 0)
    || (owner.state === "active" && (owner.epoch < 1 || owner.epoch !== durableEpoch))
  ) {
    throw new EgoChatError(
      "corrupt_monitor_lease",
      "The durable Eagle Monitor lease does not match its monotonic epoch.",
    )
  }
  return {
    active: processIsAlive(owner.pid),
    epoch: Number.isSafeInteger(owner.epoch) ? owner.epoch : null,
  }
}

export async function acquireMonitorLease(config, {
  now = () => new Date().toISOString(),
  ownerId = randomUUID(),
  pid = process.pid,
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  await ensurePrivateDirectory(config.dataDir)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle
    try {
      handle = await fs.open(config.paths.lock, "wx", 0o600)
      await handle.writeFile(`${JSON.stringify({
        acquiredAt: now(),
        epoch: 0,
        ownerId,
        pid,
        schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
        state: "claiming",
      })}\n`, "utf8")
      await handle.sync()
      await handle.close()
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error.code !== "EEXIST") throw error
      const existing = await readOwner(config)
      if (!existing) continue
      if (processIsAlive(existing.pid)) {
        throw new EgoChatError(
          "monitor_already_running",
          "Another live Eagle Monitor owns the recovery lease; this process may observe only.",
          { epoch: existing.epoch ?? null },
        )
      }
      const stalePath = `${config.paths.lock}.stale.${randomUUID()}`
      try {
        await fs.rename(config.paths.lock, stalePath)
        await removeFileIfPresent(stalePath)
      } catch (retireError) {
        if (retireError.code !== "ENOENT") throw retireError
      }
      continue
    }

    try {
      const epoch = await nextEpoch(config)
      const identity = {
        acquiredAt: now(),
        epoch,
        ownerId,
        pid,
        schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
        state: "active",
      }
      await writeAtomicJson(config.paths.lock, identity)

      const assertCurrent = async () => {
        const current = await readOwner(config)
        if (
          !current
          || current.ownerId !== ownerId
          || current.epoch !== epoch
          || current.pid !== pid
          || current.state !== "active"
        ) {
          throw new EgoChatError(
            "monitor_lease_lost",
            "The Eagle Monitor fencing lease changed before a recovery action.",
          )
        }
        return structuredClone(current)
      }

      return {
        assertCurrent,
        identity,
        release: async () => {
          await assertCurrent()
          await removeFileIfPresent(config.paths.lock)
        },
      }
    } catch (error) {
      const current = await readOwner(config).catch(() => null)
      if (current?.ownerId === ownerId) await fs.unlink(config.paths.lock).catch(() => {})
      throw error
    }
  }

  throw new EgoChatError("monitor_lease_contended", "The Eagle Monitor lease is contended.")
}
