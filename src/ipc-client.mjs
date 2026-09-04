import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

import {
  IPC_VERSION,
  MAX_IPC_LINE_BYTES,
  READ_ONLY_IPC_METHODS,
  RUNTIME_IDENTITY,
} from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"
import { readBrokerToken } from "./auth-token.mjs"

const DAEMON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/ego-chatd.mjs")

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestOnce(
  config,
  method,
  params,
  timeoutMs,
  signal = undefined,
  runtime = RUNTIME_IDENTITY,
) {
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
        runtime,
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

export async function requestBrokerUpgrade(config, broker, targetRuntime = RUNTIME_IDENTITY) {
  return requestOnce(
    config,
    "broker.prepare_upgrade",
    { expectedBroker: broker, targetRuntime },
    5_000,
    undefined,
    broker.runtimeIdentity,
  )
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

function runtimeMatches(candidate) {
  return JSON.stringify(candidate) === JSON.stringify(RUNTIME_IDENTITY)
}

async function assertCompatibleMutationTarget(config) {
  const ping = await requestOnce(config, "ping", {}, 500)
  if (!runtimeMatches(ping.runtimeIdentity)) {
    throw new EgoChatError(
      "restart_required",
      "The configured socket belongs to a legacy or incompatible Ego Chat broker. Restart the host app before mutating durable state.",
      {
        brokerRuntime: ping.runtimeIdentity ?? null,
        clientRuntime: RUNTIME_IDENTITY,
        pid: ping.pid ?? null,
        socketPath: config.socketPath,
      },
    )
  }
}

export async function requestBroker(config, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000
  try {
    if (
      !READ_ONLY_IPC_METHODS.has(method)
      && (config.legacySocketPaths ?? []).includes(config.socketPath)
    ) {
      await assertCompatibleMutationTarget(config)
    }
    return await requestOnce(config, method, params, timeoutMs, options.signal)
  } catch (error) {
    if (options.autostart === false || (!isConnectionFailure(error) && error.code !== "ENOENT")) {
      throw error
    }
  }

  for (const legacySocketPath of options.legacyFallback === false
    ? []
    : (config.legacySocketPaths ?? [])) {
    try {
      const legacy = { ...config, socketPath: legacySocketPath }
      const ping = await requestOnce(legacy, "ping", {}, 500)
      if (!ping.runtimeIdentity) {
        if (!READ_ONLY_IPC_METHODS.has(method)) {
          throw new EgoChatError(
            "restart_required",
            "A legacy Ego Chat broker is still active. Restart Codex and ZCode before starting another durable operation.",
            { pid: ping.pid, socketPath: legacySocketPath },
          )
        }
        return requestOnce(legacy, method, params, timeoutMs, options.signal)
      }
    } catch (error) {
      if (error instanceof EgoChatError && error.code === "restart_required") {
        throw error
      }
      if (!isConnectionFailure(error) && error.code !== "ENOENT" && error.code !== "ipc_timeout") {
        throw error
      }
    }
  }

  await options.beforeAutostart?.()
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
