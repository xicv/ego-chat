import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

import { IPC_VERSION, MAX_IPC_LINE_BYTES } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"
import { readBrokerToken } from "./auth-token.mjs"

const DAEMON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/ego-chatd.mjs")

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestOnce(config, method, params, timeoutMs, signal = undefined) {
  const token = await readBrokerToken(config.dataDir)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socketPath)
    let buffer = ""
    let settled = false

    const finish = (callback, value) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      socket.destroy()
      callback(value)
    }
    const onAbort = () => {
      finish(reject, new EgoChatError("client_disconnected", "The local caller stopped waiting; the broker-owned workflow continues."))
    }
    const timer = setTimeout(() => {
      finish(reject, new EgoChatError("ipc_timeout", "The broker did not respond before the local IPC deadline."))
    }, timeoutMs)

    socket.setEncoding("utf8")
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: randomUUID(),
        method,
        params,
        token,
        version: IPC_VERSION,
      })}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_LINE_BYTES) {
        finish(reject, new EgoChatError("response_too_large", "The broker response exceeded the IPC size limit."))
        return
      }
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }

      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex))
        if (response.ok === true) {
          finish(resolve, response.result)
        } else {
          finish(reject, new EgoChatError(
            response.error?.code ?? "broker_error",
            response.error?.message ?? "The broker rejected the request.",
            response.error?.details,
          ))
        }
      } catch (_error) {
        finish(reject, new EgoChatError("invalid_response", "The broker returned invalid JSON."))
      }
    })
    socket.on("error", (error) => finish(reject, error))
    socket.on("end", () => {
      if (!settled) {
        finish(reject, new EgoChatError("incomplete_response", "The broker closed the IPC connection without a response."))
      }
    })
  })
}

function startDaemon(config) {
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    env: {
      ...process.env,
      EGO_CHAT_DATA_DIR: config.dataDir,
      EGO_CHAT_EGO_BROWSER: config.egoBrowserCommand,
      EGO_CHAT_SOCKET_PATH: config.socketPath,
    },
    stdio: "ignore",
  })
  child.unref()
}

function isConnectionFailure(error) {
  return ["ECONNREFUSED", "ENOENT"].includes(error?.code)
}

export async function requestBroker(config, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    return await requestOnce(config, method, params, timeoutMs, options.signal)
  } catch (error) {
    if (options.autostart === false || (!isConnectionFailure(error) && error.code !== "ENOENT")) {
      throw error
    }
  }

  startDaemon(config)
  let lastError
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100)
    try {
      return await requestOnce(config, method, params, timeoutMs, options.signal)
    } catch (error) {
      lastError = error
      if (!isConnectionFailure(error) && error.code !== "ENOENT") {
        throw error
      }
    }
  }

  throw new EgoChatError("daemon_start_failed", "The local broker did not become ready.", {
    cause: lastError?.code ?? "unknown",
  })
}
