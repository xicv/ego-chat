import os from "node:os"
import path from "node:path"

import { EgoChatError } from "./errors.mjs"

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ego Chat")
  }

  return path.join(os.homedir(), ".local", "share", "ego-chat")
}

function defaultSocketPath() {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  return path.join(os.tmpdir(), `egc-${uid}.sock`)
}

function validateSocketPath(candidate) {
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    throw new EgoChatError("invalid_socket_path", "The broker socket path is invalid.")
  }
  const resolved = path.resolve(candidate)
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !/^egc-[A-Za-z0-9._-]+\.sock$/.test(path.basename(resolved))
  ) {
    throw new EgoChatError(
      "invalid_socket_path",
      "The broker socket must use an egc-*.sock name directly inside the private system temporary directory.",
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
  return {
    dataDir: path.resolve(overrides.dataDir ?? process.env.EGO_CHAT_DATA_DIR ?? defaultDataDir()),
    egoBrowserCommand: validateCommand(
      overrides.egoBrowserCommand ?? process.env.EGO_CHAT_EGO_BROWSER ?? "ego-browser",
    ),
    socketPath: validateSocketPath(
      overrides.socketPath ?? process.env.EGO_CHAT_SOCKET_PATH ?? defaultSocketPath(),
    ),
  }
}
