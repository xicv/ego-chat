import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { EgoChatError } from "./errors.mjs"

const TOKEN_PATTERN = /^[a-f0-9]{64}$/

async function validateTokenFile(filePath) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new EgoChatError("unsafe_token_file", "The broker token path is not a regular file.")
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError("unsafe_token_file", "The broker token file is owned by another user.")
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new EgoChatError("unsafe_token_file", "The broker token file must have mode 0600.")
  }
}

export async function readBrokerToken(dataDir) {
  const filePath = path.join(dataDir, "broker-token")
  await validateTokenFile(filePath)
  const token = (await fs.readFile(filePath, "utf8")).trim()
  if (!TOKEN_PATTERN.test(token)) {
    throw new EgoChatError("invalid_token_file", "The broker token file has an invalid value.")
  }
  return token
}

export async function loadOrCreateBrokerToken(dataDir) {
  try {
    return await readBrokerToken(dataDir)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  const filePath = path.join(dataDir, "broker-token")
  const token = randomBytes(32).toString("hex")
  try {
    const handle = await fs.open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    )
    try {
      await handle.writeFile(`${token}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return token
  } catch (error) {
    if (error.code === "EEXIST") {
      return readBrokerToken(dataDir)
    }
    throw error
  }
}
