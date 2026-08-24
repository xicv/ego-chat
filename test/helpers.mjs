import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { requestBroker } from "../src/ipc-client.mjs"

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const MCP_PATH = path.resolve(TEST_DIRECTORY, "../bin/ego-chat-mcp.mjs")

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function createTestConfig() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-test-data-"))
  await fs.chmod(dataDir, 0o700)
  const socketPath = path.join(
    os.tmpdir(),
    `egc-t-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
  )
  return {
    config: {
      dataDir,
      egoBrowserCommand: "ego-browser",
      socketPath,
    },
    env: {
      ...process.env,
      EGO_CHAT_DATA_DIR: dataDir,
      EGO_CHAT_EGO_BROWSER: "ego-browser",
      EGO_CHAT_SOCKET_PATH: socketPath,
    },
  }
}

export async function stopTestDaemon(config) {
  try {
    const ping = await requestBroker(config, "ping", {}, { autostart: false, timeoutMs: 1_000 })
    process.kill(ping.pid, "SIGTERM")
  } catch (error) {
    if (!["ECONNREFUSED", "ENOENT", "ESRCH"].includes(error.code)) {
      throw error
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.lstat(config.socketPath)
      await delay(50)
    } catch (error) {
      if (error.code === "ENOENT") {
        return
      }
      throw error
    }
  }
  throw new Error("Test broker did not stop")
}

export async function removeTestConfig(config) {
  await fs.rm(config.dataDir, { force: false, recursive: true })
}
