import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertOwnedByCurrentUser(stat, label) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError(
      "unsafe_monitor_storage",
      `${label} is not owned by the current user.`,
    )
  }
}

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700, recursive: true })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new EgoChatError(
      "unsafe_monitor_storage",
      "The Eagle Monitor data path must be a real directory.",
    )
  }
  assertOwnedByCurrentUser(stat, "The Eagle Monitor data directory")
  if ((stat.mode & 0o077) !== 0) {
    throw new EgoChatError(
      "unsafe_monitor_storage",
      "The Eagle Monitor data directory must not grant group or other access.",
    )
  }
}

export async function readPrivateJson(filePath, {
  allowMissing = false,
  corruptionCode = "corrupt_monitor_state",
  maximumBytes = 1024 * 1024,
} = {}) {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new EgoChatError(corruptionCode, "A private Eagle Monitor file has an unsafe type.")
  }
  assertOwnedByCurrentUser(stat, "A private Eagle Monitor file")
  if ((stat.mode & 0o077) !== 0 || stat.size > maximumBytes) {
    throw new EgoChatError(
      corruptionCode,
      "A private Eagle Monitor file has unsafe permissions or size.",
    )
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new EgoChatError(corruptionCode, "A private Eagle Monitor file contains invalid JSON.")
    }
    throw error
  }
}

export async function writeAtomicText(filePath, text, mode = 0o600) {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { mode: 0o700, recursive: true })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      mode,
    )
    await handle.writeFile(text, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporaryPath, filePath)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export async function writeAtomicJson(filePath, value) {
  await writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath)
    await syncDirectory(path.dirname(filePath))
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}
