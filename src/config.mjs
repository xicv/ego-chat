import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { createHash } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ego Chat")
  }

  return path.join(os.homedir(), ".local", "share", "ego-chat")
}

function canonicalDataDir(candidate) {
  const resolved = path.resolve(candidate)
  try {
    return fs.realpathSync.native(resolved)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  const missing = []
  let current = resolved
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) {
      return resolved
    }
    missing.unshift(path.basename(current))
    try {
      return path.join(fs.realpathSync.native(parent), ...missing)
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
      current = parent
    }
  }
}

function stableRuntimeRoot() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  return path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", `ego-chat-${uid}`)
}

function brokerKey(dataDir) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  return createHash("sha256").update(`${uid}\0${dataDir}`, "utf8").digest("hex")
}

function defaultSocketPath(dataDir) {
  return path.join(stableRuntimeRoot(), brokerKey(dataDir).slice(0, 20), "broker.sock")
}

function legacySocketPaths() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  return [...new Set([
    path.join(os.tmpdir(), `egc-${uid}.sock`),
    path.join("/tmp", `egc-${uid}.sock`),
    path.join("/private/tmp", `egc-${uid}.sock`),
  ].map((candidate) => {
    const resolved = path.resolve(candidate)
    try {
      return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved))
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
      return resolved
    }
  }))]
}

function validateSocketPath(candidate, defaultPath) {
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    throw new EgoChatError("invalid_socket_path", "The broker socket path is invalid.")
  }
  const resolved = path.resolve(candidate)
  const isStableDefault = resolved === defaultPath
  const isTestOrLegacyOverride = (
    path.dirname(resolved) === path.resolve(os.tmpdir())
    && /^egc-[A-Za-z0-9._-]+\.sock$/.test(path.basename(resolved))
  )
  if (!isStableDefault && !isTestOrLegacyOverride) {
    throw new EgoChatError(
      "invalid_socket_path",
      "The broker socket must use Ego Chat's canonical runtime path or an egc-*.sock compatibility override directly inside the current temporary directory.",
    )
  }
  if (Buffer.byteLength(resolved, "utf8") >= 104) {
    throw new EgoChatError("invalid_socket_path", "The broker socket path is too long for a macOS Unix socket.")
  }
  return resolved
}

function validateCommand(candidate) {
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.includes("\0")) {
    throw new EgoChatError("invalid_ego_command", "The Ego Browser command is invalid.")
  }
  return candidate
}

export function loadConfig(overrides = {}) {
  const dataDir = canonicalDataDir(overrides.dataDir ?? process.env.EGO_CHAT_DATA_DIR ?? defaultDataDir())
  const canonicalSocketPath = defaultSocketPath(dataDir)
  const socketPath = validateSocketPath(
    overrides.socketPath ?? process.env.EGO_CHAT_SOCKET_PATH ?? canonicalSocketPath,
    canonicalSocketPath,
  )
  return {
    brokerKey: brokerKey(dataDir),
    dataDir,
    egoBrowserCommand: validateCommand(
      overrides.egoBrowserCommand ?? process.env.EGO_CHAT_EGO_BROWSER ?? "ego-browser",
    ),
    legacySocketPaths: legacySocketPaths().filter((candidate) => candidate !== canonicalSocketPath),
    reserveLegacySockets: socketPath === canonicalSocketPath,
    socketPath,
  }
}
