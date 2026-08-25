import { constants as fsConstants } from "node:fs"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { RUNTIME_IDENTITY } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"
import { requestBroker, requestBrokerUpgrade } from "./ipc-client.mjs"

const LEGACY_QUIESCENCE_MS = 100
const MAX_LEASE_BYTES = 64 * 1024
const MAX_UNIX_SOCKET_BYTES = 104
const STOP_TIMEOUT_MS = 10_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runtimeMatches(candidate) {
  return JSON.stringify(candidate) === JSON.stringify(RUNTIME_IDENTITY)
}

function isConnectionFailure(error) {
  return ["ECONNREFUSED", "ENOENT"].includes(error?.code)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function assertStatus(value) {
  const broker = value?.broker
  if (
    !broker
    || typeof broker.brokerId !== "string"
    || !Number.isSafeInteger(broker.epoch)
    || !Number.isSafeInteger(broker.pid)
    || broker.pid < 1
    || typeof broker.runtimeIdentity !== "object"
    || broker.runtimeIdentity === null
    || typeof broker.socketPath !== "string"
    || !Array.isArray(value.activeBindings)
    || !Array.isArray(value.runningWorkflows)
    || typeof value.driverMailbox !== "object"
    || value.driverMailbox === null
    || !Number.isSafeInteger(value.driverMailbox.files)
    || value.driverMailbox.files < 0
    || !Number.isSafeInteger(value.driverMailbox.reservations)
    || value.driverMailbox.reservations < 0
  ) {
    throw new EgoChatError(
      "invalid_broker_status",
      "The authoritative broker returned an invalid runtime-handoff status.",
    )
  }
  return value
}

function assertIdle(status) {
  if (
    status.activeBindings.length > 0
    || status.runningWorkflows.length > 0
    || status.driverMailbox.files > 0
    || status.driverMailbox.reservations > 0
  ) {
    throw new EgoChatError(
      "upgrade_blocked_active_work",
      "The authoritative broker still owns active work; leave it running and retry setup after every workflow stops.",
      {
        activeBindingCount: status.activeBindings.length,
        mailboxFileCount: status.driverMailbox.files,
        mailboxReservationCount: status.driverMailbox.reservations,
        runningWorkflowCount: status.runningWorkflows.length,
      },
    )
  }
}

async function readLease(dataDir) {
  const leasePath = path.join(dataDir, "broker.lock")
  const handle = await fs.open(leasePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile()
      || stat.size > MAX_LEASE_BYTES
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0
    ) {
      throw new EgoChatError(
        "unsafe_broker_lease",
        "The authoritative broker lease is not a private bounded regular file.",
      )
    }
    try {
      return JSON.parse(await handle.readFile("utf8"))
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new EgoChatError("corrupt_broker_lease", "The authoritative broker lease contains invalid JSON.")
      }
      throw error
    }
  } finally {
    await handle.close()
  }
}

function assertSameIdentity(status, lease) {
  const broker = status.broker
  if (
    lease?.brokerId !== broker.brokerId
    || lease?.epoch !== broker.epoch
    || lease?.pid !== broker.pid
    || lease?.socketPath !== broker.socketPath
    || JSON.stringify(lease?.runtimeIdentity) !== JSON.stringify(broker.runtimeIdentity)
  ) {
    throw new EgoChatError(
      "broker_handoff_identity_changed",
      "The authoritative broker identity changed during runtime handoff.",
    )
  }
  if (
    !Array.isArray(lease.browserPids)
    || lease.browserPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
    || !Array.isArray(lease.browserProcessGroups)
    || lease.browserProcessGroups.some((group) => !Number.isSafeInteger(group) || group < 1)
  ) {
    throw new EgoChatError(
      "unsafe_broker_lease",
      "The authoritative broker lease has no trustworthy browser-child ledger.",
    )
  }
  if (
    lease.browserPids.length > 0
    || lease.browserProcessGroups.length > 0
  ) {
    throw new EgoChatError(
      "upgrade_blocked_browser_child",
      "The authoritative broker still owns a click-capable browser child; retry setup after it exits.",
    )
  }
}

function sameBroker(left, right) {
  return (
    left.broker.brokerId === right.broker.brokerId
    && left.broker.epoch === right.broker.epoch
    && left.broker.pid === right.broker.pid
    && left.broker.socketPath === right.broker.socketPath
    && JSON.stringify(left.broker.runtimeIdentity) === JSON.stringify(right.broker.runtimeIdentity)
  )
}

function assertSafeSocket(stat) {
  if (
    !stat.isSocket()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0
  ) {
    throw new EgoChatError(
      "unsafe_broker_socket",
      "A broker socket selected for legacy upgrade fencing is not a private owned Unix socket.",
    )
  }
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function exactSocketConfig(config, socketPath) {
  return { ...config, legacySocketPaths: [], socketPath }
}

async function statusAt(config, socketPath) {
  return assertStatus(await requestBroker(
    exactSocketConfig(config, socketPath),
    "broker.status",
    {},
    { autostart: false, timeoutMs: 1_000 },
  ))
}

function quarantinePath(socketPath) {
  const candidate = path.join(
    path.dirname(socketPath),
    `.ego-chat-handoff-${randomUUID().replaceAll("-", "").slice(0, 16)}.sock`,
  )
  if (Buffer.byteLength(candidate, "utf8") >= MAX_UNIX_SOCKET_BYTES) {
    throw new EgoChatError(
      "unsafe_broker_socket",
      "The broker socket directory is too long for a private legacy upgrade fence.",
    )
  }
  return candidate
}

async function quarantineLegacySockets(config, expected) {
  const primaryPath = expected.broker.socketPath
  const candidates = [...new Set([
    primaryPath,
    config.socketPath,
    ...(config.legacySocketPaths ?? []),
  ])]
  const moved = []

  try {
    for (const socketPath of candidates) {
      const before = await lstatIfPresent(socketPath)
      if (!before) continue
      if (!before.isSocket()) {
        if (socketPath === primaryPath) assertSafeSocket(before)
        continue
      }
      if (socketPath === primaryPath) assertSafeSocket(before)

      let observed
      try {
        observed = await statusAt(config, socketPath)
      } catch (error) {
        if (
          socketPath !== primaryPath
          && ["ECONNREFUSED", "ENOENT", "unauthorized"].includes(error.code)
        ) {
          continue
        }
        throw error
      }
      if (!sameBroker(expected, observed)) {
        if (socketPath === primaryPath) {
          throw new EgoChatError(
            "broker_handoff_identity_changed",
            "The authoritative broker identity changed before its legacy socket could be fenced.",
          )
        }
        continue
      }
      assertSafeSocket(before)

      const current = await fs.lstat(socketPath)
      assertSafeSocket(current)
      if (current.dev !== before.dev || current.ino !== before.ino) {
        throw new EgoChatError(
          "broker_handoff_identity_changed",
          "A broker socket changed while the legacy upgrade fence was being installed.",
        )
      }
      const quarantinedPath = quarantinePath(socketPath)
      if (await lstatIfPresent(quarantinedPath)) {
        throw new EgoChatError(
          "unsafe_broker_socket",
          "A private legacy upgrade-fence path already exists.",
        )
      }
      await fs.rename(socketPath, quarantinedPath)
      const quarantined = await fs.lstat(quarantinedPath)
      assertSafeSocket(quarantined)
      if (quarantined.dev !== before.dev || quarantined.ino !== before.ino) {
        throw new EgoChatError(
          "broker_handoff_identity_changed",
          "The broker socket identity changed while entering the legacy upgrade fence.",
        )
      }
      moved.push({
        dev: before.dev,
        ino: before.ino,
        originalPath: socketPath,
        quarantinedPath,
      })
    }
  } catch (error) {
    await restoreLegacySockets(moved, error)
    throw error
  }

  const primary = moved.find((entry) => entry.originalPath === primaryPath)
  if (!primary) {
    await restoreLegacySockets(moved)
    throw new EgoChatError(
      "broker_handoff_identity_changed",
      "The authoritative broker socket disappeared before the legacy upgrade fence was complete.",
    )
  }
  return { moved, primary }
}

async function restoreLegacySockets(moved, originalError = undefined) {
  let restoreError
  for (const entry of [...moved].reverse()) {
    try {
      if (await lstatIfPresent(entry.originalPath)) {
        throw new EgoChatError(
          "broker_handoff_socket_restore_failed",
          "A published broker socket path was recreated before the legacy fence could be restored.",
        )
      }
      const quarantined = await fs.lstat(entry.quarantinedPath)
      assertSafeSocket(quarantined)
      if (quarantined.dev !== entry.dev || quarantined.ino !== entry.ino) {
        throw new EgoChatError(
          "broker_handoff_socket_restore_failed",
          "A quarantined broker socket changed before the legacy fence could be restored.",
        )
      }
      await fs.rename(entry.quarantinedPath, entry.originalPath)
    } catch (error) {
      restoreError ??= error
    }
  }
  if (restoreError) {
    throw new EgoChatError(
      "broker_handoff_socket_restore_failed",
      "The legacy broker socket fence could not be restored safely; restart every Ego Chat host before retrying.",
      {
        cause: originalError?.code ?? null,
        restoreCause: restoreError.code ?? "unknown",
      },
    )
  }
}

async function removeQuarantinedSockets(moved) {
  for (const entry of moved) {
    const stat = await lstatIfPresent(entry.quarantinedPath)
    if (!stat) continue
    assertSafeSocket(stat)
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new EgoChatError(
        "unsafe_broker_socket",
        "A legacy upgrade-fence socket changed before cleanup.",
      )
    }
    await fs.unlink(entry.quarantinedPath)
  }
}

async function waitForBrokerStop(dataDir, status, moved = []) {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processIsAlive(status.broker.pid)) {
      try {
        await fs.lstat(path.join(dataDir, "broker.lock"))
      } catch (error) {
        if (error.code === "ENOENT") {
          await removeQuarantinedSockets(moved)
          return { previousRuntime: status.broker.runtimeIdentity, status: "stopped" }
        }
        throw error
      }
    }
    await delay(50)
  }

  throw new EgoChatError(
    "broker_handoff_timeout",
    "The stale broker did not release its authoritative lease before the handoff deadline.",
  )
}

async function legacyHandoff(config, first) {
  const { moved, primary } = await quarantineLegacySockets(config, first)
  let signalled = false
  try {
    await delay(LEGACY_QUIESCENCE_MS)
    const second = await statusAt(config, primary.quarantinedPath)
    assertIdle(second)
    if (!sameBroker(first, second)) {
      throw new EgoChatError(
        "broker_handoff_identity_changed",
        "The authoritative broker identity changed inside the legacy upgrade fence.",
      )
    }
    assertSameIdentity(second, await readLease(config.dataDir))

    await delay(LEGACY_QUIESCENCE_MS)
    const third = await statusAt(config, primary.quarantinedPath)
    assertIdle(third)
    if (!sameBroker(second, third)) {
      throw new EgoChatError(
        "broker_handoff_identity_changed",
        "The authoritative broker identity changed during the final legacy upgrade proof.",
      )
    }
    assertSameIdentity(third, await readLease(config.dataDir))
    if (!processIsAlive(third.broker.pid)) {
      throw new EgoChatError(
        "broker_handoff_identity_changed",
        "The authoritative broker exited during the final legacy upgrade proof.",
      )
    }

    process.kill(third.broker.pid, "SIGTERM")
    signalled = true
    return waitForBrokerStop(config.dataDir, third, moved)
  } catch (error) {
    if (!signalled) await restoreLegacySockets(moved, error)
    throw error
  }
}

export async function inspectBrokerRuntime(config) {
  let status
  try {
    status = assertStatus(await requestBroker(
      config,
      "broker.status",
      {},
      { autostart: false, timeoutMs: 1_000 },
    ))
  } catch (error) {
    if (isConnectionFailure(error)) {
      return { status: "not_running" }
    }
    throw error
  }
  return runtimeMatches(status.broker.runtimeIdentity)
    ? { runtime: RUNTIME_IDENTITY, status: "current" }
    : { runtime: status.broker.runtimeIdentity, status: "stale" }
}

export async function handoffBrokerRuntime(config) {
  let first
  try {
    first = assertStatus(await requestBroker(
      config,
      "broker.status",
      {},
      { autostart: false, timeoutMs: 1_000 },
    ))
  } catch (error) {
    if (isConnectionFailure(error)) {
      return { status: "not_running" }
    }
    throw error
  }

  if (runtimeMatches(first.broker.runtimeIdentity)) {
    return { runtime: RUNTIME_IDENTITY, status: "current" }
  }

  assertIdle(first)
  const firstLease = await readLease(config.dataDir)
  assertSameIdentity(first, firstLease)
  if (!processIsAlive(first.broker.pid)) {
    throw new EgoChatError(
      "broker_handoff_identity_changed",
      "The authoritative broker exited during runtime handoff.",
    )
  }

  try {
    const prepared = await requestBrokerUpgrade(
      exactSocketConfig(config, first.broker.socketPath),
      first.broker,
    )
    if (
      prepared?.status !== "accepted"
      || !sameBroker(first, { broker: prepared.broker })
      || JSON.stringify(prepared.targetRuntime) !== JSON.stringify(RUNTIME_IDENTITY)
    ) {
      throw new EgoChatError(
        "invalid_broker_upgrade_response",
        "The authoritative broker returned an invalid atomic upgrade-drain response.",
      )
    }
    return waitForBrokerStop(config.dataDir, first)
  } catch (error) {
    if (error.code !== "method_not_found") throw error
  }

  return legacyHandoff(config, first)
}
