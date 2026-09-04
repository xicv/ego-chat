import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { EAGLE_MONITOR_LABEL, EAGLE_MONITOR_POLICY } from "./eagle-monitor-constants.mjs"
import { EgoChatError } from "./errors.mjs"
import { loadConfig } from "./config.mjs"

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DAEMON_PATH = path.resolve(SOURCE_DIRECTORY, "../bin/eagle-monitord.mjs")

function canonicalPath(candidate) {
  const resolved = path.resolve(candidate)
  try {
    return fs.realpathSync.native(resolved)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const missing = []
  let current = resolved
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    missing.unshift(path.basename(current))
    try {
      return path.join(fs.realpathSync.native(parent), ...missing)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      current = parent
    }
  }
}

function assertInside(candidate, parent, label) {
  if (candidate !== parent && !candidate.startsWith(`${parent}${path.sep}`)) {
    throw new EgoChatError("invalid_monitor_path", `${label} must remain inside the Ego Chat data directory.`)
  }
}

function absoluteExecutable(candidate, label) {
  if (typeof candidate !== "string" || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw new EgoChatError("invalid_monitor_path", `${label} must be an absolute path.`)
  }
  return canonicalPath(candidate)
}

function resolveExecutable(candidate, label, { allowMissing = false } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    throw new EgoChatError("monitor_dependency_unavailable", `${label} is unavailable.`)
  }
  const candidates = path.isAbsolute(candidate)
    ? [candidate]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((directory) => path.isAbsolute(directory))
        .map((directory) => path.join(directory, candidate))
  for (const executable of candidates) {
    try {
      const resolved = fs.realpathSync.native(executable)
      const stat = fs.statSync(resolved)
      fs.accessSync(resolved, fs.constants.X_OK)
      if (stat.isFile()) return resolved
    } catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes(error.code)) throw error
    }
  }
  if (allowMissing) return path.isAbsolute(candidate) ? canonicalPath(candidate) : candidate
  throw new EgoChatError("monitor_dependency_unavailable", `${label} is unavailable.`)
}

export function safeDigest(value) {
  if (value === null || value === undefined) return null
  return createHash("sha256").update(String(value), "utf8").digest("hex")
}

export function loadEagleMonitorConfig(overrides = {}) {
  const loadedBrokerConfig = loadConfig(overrides.brokerConfig ?? {})
  const brokerConfig = {
    ...loadedBrokerConfig,
    egoBrowserCommand: resolveExecutable(
      loadedBrokerConfig.egoBrowserCommand,
      "The Ego Browser executable",
      { allowMissing: overrides.requireEgoBrowser === false },
    ),
  }
  const requestedDataDir = overrides.dataDir
    ?? process.env.EAGLE_MONITOR_DATA_DIR
    ?? path.join(brokerConfig.dataDir, "eagle-monitor")
  const dataDir = canonicalPath(requestedDataDir)
  assertInside(dataDir, brokerConfig.dataDir, "The monitor data path")
  const launchAgentsDir = canonicalPath(
    overrides.launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents"),
  )
  const executablePath = absoluteExecutable(
    overrides.executablePath ?? process.execPath,
    "The Node executable",
  )
  const daemonPath = absoluteExecutable(
    overrides.daemonPath ?? DEFAULT_DAEMON_PATH,
    "The Eagle Monitor daemon",
  )
  const uid = overrides.uid ?? (typeof process.getuid === "function" ? process.getuid() : null)
  if (!Number.isSafeInteger(uid) || uid < 1) {
    throw new EgoChatError(
      uid === 0 ? "privileged_monitor_forbidden" : "unsupported_platform",
      "Eagle Monitor requires a non-root numeric per-user UID.",
    )
  }

  return {
    brokerConfig,
    commands: {
      caffeinate: overrides.commands?.caffeinate ?? "/usr/bin/caffeinate",
      launchctl: overrides.commands?.launchctl ?? "/bin/launchctl",
      osascript: overrides.commands?.osascript ?? "/usr/bin/osascript",
      pmset: overrides.commands?.pmset ?? "/usr/bin/pmset",
    },
    daemonPath,
    dataDir,
    executablePath,
    incidentLimit: overrides.incidentLimit ?? 200,
    label: EAGLE_MONITOR_LABEL,
    paths: {
      epoch: path.join(dataDir, "monitor-epoch.json"),
      lock: path.join(dataDir, "monitor.lock"),
      session: path.join(dataDir, "session.json"),
      state: path.join(dataDir, "state.json"),
      launchAgent: path.join(launchAgentsDir, `${EAGLE_MONITOR_LABEL}.plist`),
    },
    platform: overrides.platform ?? process.platform,
    policy: EAGLE_MONITOR_POLICY,
    pollIntervalMs: overrides.pollIntervalMs ?? 5_000,
    serviceTarget: `gui/${uid}/${EAGLE_MONITOR_LABEL}`,
    uid,
  }
}
