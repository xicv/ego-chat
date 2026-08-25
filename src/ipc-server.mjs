import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { randomUUID, timingSafeEqual } from "node:crypto"

import {
  IPC_VERSION,
  MAX_IPC_LINE_BYTES,
  READ_ONLY_IPC_METHODS,
  RUNTIME_IDENTITY,
} from "./constants.mjs"
import { EgoChatError, asPublicError } from "./errors.mjs"

function tokensMatch(actual, expected) {
  const actualBuffer = Buffer.from(typeof actual === "string" ? actual : "", "utf8")
  const expectedBuffer = Buffer.from(expected, "utf8")
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function validateRequest(message, expectedToken) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new EgoChatError("invalid_request", "The IPC request must be an object.")
  }
  if (message.version !== IPC_VERSION) {
    throw new EgoChatError("unsupported_ipc_version", "The IPC protocol version is not supported.")
  }
  if (typeof message.id !== "string" || message.id.length > 100) {
    throw new EgoChatError("invalid_request", "The IPC request ID is invalid.")
  }
  if (typeof message.method !== "string" || message.method.length > 100) {
    throw new EgoChatError("invalid_request", "The IPC method is invalid.")
  }
  if (!tokensMatch(message.token, expectedToken)) {
    throw new EgoChatError("unauthorized", "The IPC request was not authenticated.")
  }
  if (
    !READ_ONLY_IPC_METHODS.has(message.method)
    && JSON.stringify(message.runtime) !== JSON.stringify(RUNTIME_IDENTITY)
  ) {
    throw new EgoChatError(
      "restart_required",
      "This MCP facade does not match the authoritative Ego Chat runtime. Restart the host app before mutating durable state.",
      { brokerRuntime: RUNTIME_IDENTITY, clientRuntime: message.runtime ?? null },
    )
  }
  return message
}

export async function probeExistingBroker(socketPath, token) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    let buffer = ""
    let settled = false
    const finish = (value) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 500)
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: randomUUID(), method: "ping", params: {}, token, version: IPC_VERSION })}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex))
        finish(response.ok === true)
      } catch (_error) {
        finish(false)
      }
    })
    socket.on("error", () => finish(false))
    socket.on("end", () => finish(false))
  })
}

async function removeSocket(socketPath, token = undefined) {
  let stat
  try {
    stat = await fs.lstat(socketPath)
  } catch (error) {
    if (error.code === "ENOENT") {
      return
    }
    throw error
  }

  if (!stat.isSocket()) {
    throw new EgoChatError("unsafe_socket_path", "The configured broker socket path exists and is not a Unix socket.")
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new EgoChatError("unsafe_socket_path", "The configured broker socket is owned by another user.")
  }
  if (token && await probeExistingBroker(socketPath, token)) {
    throw new EgoChatError("already_running", "An authenticated Ego Chat broker is already listening on this socket.")
  }
  await fs.unlink(socketPath)
}

export async function startIpcServer({ allowStickyDirectory = false, dispatch, socketPath, token }) {
  const socketDirectory = path.dirname(socketPath)
  await fs.mkdir(socketDirectory, { mode: 0o700, recursive: true })
  const directoryStat = await fs.stat(socketDirectory)
  const privateDirectory = directoryStat.isDirectory()
    && (typeof process.getuid !== "function" || directoryStat.uid === process.getuid())
    && (directoryStat.mode & 0o077) === 0
  const protectedStickyDirectory = allowStickyDirectory
    && directoryStat.isDirectory()
    && (directoryStat.mode & 0o1000) !== 0
    && (directoryStat.mode & 0o002) !== 0
    && (directoryStat.uid === 0 || typeof process.getuid !== "function" || directoryStat.uid === process.getuid())
  if (!privateDirectory && !protectedStickyDirectory) {
    throw new EgoChatError("unsafe_socket_directory", "The broker runtime directory is not private to the current user.")
  }
  await removeSocket(socketPath, token)

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8")
    let buffer = ""
    let handled = false
    const controller = new AbortController()

    socket.on("close", () => controller.abort())
    socket.on("data", async (chunk) => {
      if (handled) {
        return
      }
      buffer += chunk
      if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_LINE_BYTES) {
        handled = true
        socket.end(`${JSON.stringify({ id: null, ok: false, error: asPublicError(new EgoChatError("request_too_large", "The IPC request is too large.")) })}\n`)
        return
      }

      const newlineIndex = buffer.indexOf("\n")
      if (newlineIndex === -1) {
        return
      }
      handled = true
      const line = buffer.slice(0, newlineIndex)
      let id = null

      try {
        const request = validateRequest(JSON.parse(line), token)
        id = request.id
        const result = await dispatch(request.method, request.params ?? {}, controller.signal)
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify({ id, ok: true, result })}\n`)
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          error = new EgoChatError("invalid_json", "The IPC request is not valid JSON.")
        }
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify({ error: asPublicError(error), id, ok: false })}\n`)
        }
      }
    })
  })

  const previousUmask = process.umask(0o077)
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(socketPath)
    })
  } finally {
    process.umask(previousUmask)
  }
  await fs.chmod(socketPath, 0o600)

  return {
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      await removeSocket(socketPath)
    },
    server,
  }
}

export async function startIpcServers({ dispatch, socketPaths, stickySocketPaths = [], token }) {
  const uniqueSocketPaths = [...new Set(socketPaths)]
  const sticky = new Set(stickySocketPaths)
  const servers = []
  try {
    for (const socketPath of uniqueSocketPaths) {
      try {
        servers.push(await startIpcServer({
          allowStickyDirectory: sticky.has(socketPath),
          dispatch,
          socketPath,
          token,
        }))
      } catch (error) {
        if (error instanceof EgoChatError) {
          throw new EgoChatError(error.code, error.message, {
            ...(error.details ?? {}),
            socketPath,
          })
        }
        throw error
      }
    }
  } catch (error) {
    for (const server of [...servers].reverse()) {
      await server.close().catch(() => {})
    }
    throw error
  }

  return {
    close: async () => {
      let firstError
      for (const server of [...servers].reverse()) {
        try {
          await server.close()
        } catch (error) {
          firstError ??= error
        }
      }
      if (firstError) {
        throw firstError
      }
    },
    servers: servers.map((entry) => entry.server),
  }
}
