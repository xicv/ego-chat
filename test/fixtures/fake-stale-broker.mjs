import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

const dataDir = process.env.EGO_CHAT_DATA_DIR
const socketPath = process.env.EGO_CHAT_SOCKET_PATH
const aliasPath = process.env.EGO_CHAT_FAKE_STALE_ALIAS_PATH
const mode = process.env.EGO_CHAT_FAKE_STALE_MODE ?? "idle"
const token = (await fs.readFile(path.join(dataDir, "broker-token"), "utf8")).trim()
const runtimeIdentity = mode === "same-version-atomic-idle" ? {
  appVersion: "0.2.19",
  browserContractRevision: 14,
  ipcVersion: 1,
  mcpSchemaRevision: 10,
  runtimeGeneration: "2026-09-05.2",
  storeSchemaRevision: 7,
  taskStoreSchemaRevision: 1,
  contractDigest: "9a35f79a3fef024e2e99a9652e626fe0740c7aed392e5e296f1270ed95c16d28",
} : {
  appVersion: "0.2.0",
  browserContractRevision: 6,
  contractDigest: "stale-runtime-contract",
  ipcVersion: 1,
  mcpSchemaRevision: 3,
  runtimeGeneration: "test-stale-runtime",
  storeSchemaRevision: 4,
}
const identity = {
  acquiredAt: new Date().toISOString(),
  brokerId: "fake-stale-broker",
  ...(mode === "browser-ledger-unknown"
    ? {}
    : {
        browserProcessGroups: [],
        browserPids: mode === "browser" ? [process.pid] : [],
      }),
  epoch: 7,
  pid: process.pid,
  runtimeIdentity,
  socketPath,
  state: "active",
}
let statusReads = 0
let raceActive = false

await fs.writeFile(path.join(dataDir, "broker.lock"), `${JSON.stringify(identity)}\n`, { mode: 0o600 })

const server = net.createServer((socket) => {
  socket.setEncoding("utf8")
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    const newlineIndex = buffer.indexOf("\n")
    if (newlineIndex === -1) {
      return
    }
    const request = JSON.parse(buffer.slice(0, newlineIndex))
    if (request.token !== token) {
      socket.end(`${JSON.stringify({ id: request.id, ok: false, error: { code: "unauthorized" } })}\n`)
      return
    }
    if (request.method === "broker.prepare_upgrade" && ["atomic-idle", "same-version-atomic-idle"].includes(mode)) {
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          broker: identity,
          status: "accepted",
          targetRuntime: request.params.targetRuntime,
        },
      })}\n`)
      globalThis.setImmediate(() => stop(0))
      return
    }
    if (!["broker.status", "ping"].includes(request.method)) {
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "method_not_found", message: "The requested broker method does not exist." },
      })}\n`)
      return
    }
    statusReads += request.method === "broker.status" ? 1 : 0
    const responseIdentity = mode === "identity-race" && statusReads > 1
      ? { ...identity, brokerId: "replacement-stale-broker" }
      : identity
    const runningWorkflows = mode === "active" || raceActive
      ? [{ id: "active-test-workflow", kind: "ego_exchange" }]
      : []
    const result = request.method === "ping"
      ? { ...responseIdentity, ok: true }
      : {
          activeBindings: [],
          broker: responseIdentity,
          ...(mode === "mailbox-unknown"
            ? {}
            : { driverMailbox: { files: 0, reservations: 0 } }),
          runningWorkflows,
        }
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
    if (mode === "legacy-admission-race" && statusReads === 2) {
      raceActive = true
    }
  })
})

await server.listen(socketPath)
await fs.chmod(socketPath, 0o600)
if (aliasPath) {
  await fs.link(socketPath, aliasPath)
}
process.stdout.write("ready\n")

let stopping = false
async function stop(exitCode = 0) {
  if (stopping) {
    return
  }
  stopping = true
  await new Promise((resolve) => server.close(resolve))
  await fs.unlink(socketPath).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error
    }
  })
  if (aliasPath) {
    await fs.unlink(aliasPath).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  await fs.unlink(path.join(dataDir, "broker.lock"))
  process.exit(exitCode)
}

process.on("SIGTERM", () => {
  stop(mode === "atomic-idle" ? 42 : 0).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exit(1)
  })
})
