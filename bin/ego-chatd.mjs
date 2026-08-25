#!/usr/bin/env node

import { Broker } from "../src/broker.mjs"
import { AppServerClient } from "../src/app-server-client.mjs"
import { EventStore } from "../src/store.mjs"
import { EgoAdapter } from "../src/ego-adapter.mjs"
import { loadConfig } from "../src/config.mjs"
import { loadOrCreateBrokerToken } from "../src/auth-token.mjs"
import { probeExistingBroker, startIpcServers } from "../src/ipc-server.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { acquireBrokerLease } from "../src/broker-lease.mjs"
import { RUNTIME_IDENTITY } from "../src/constants.mjs"
import { createUpgradeAwareDispatch } from "../src/upgrade-dispatch.mjs"

const config = loadConfig()
const lease = await acquireBrokerLease({
  dataDir: config.dataDir,
  runtimeIdentity: RUNTIME_IDENTITY,
  socketPath: config.socketPath,
})
const token = await loadOrCreateBrokerToken(config.dataDir)
for (const legacySocketPath of config.legacySocketPaths) {
  if (await probeExistingBroker(legacySocketPath, token)) {
    await lease.release()
    throw new EgoChatError(
      "legacy_broker_active",
      "A legacy Ego Chat broker still owns this data directory. Restart Codex and ZCode before starting the canonical broker generation.",
      { socketPath: legacySocketPath },
    )
  }
}
const store = new EventStore(config.dataDir)
const brokerLease = {
  brokerId: lease.identity.brokerId,
  epoch: lease.identity.epoch,
  ownerPath: lease.ownerPath,
  pid: lease.identity.pid,
  registerChild: lease.registerChild,
  unregisterChild: lease.unregisterChild,
}
const egoAdapter = new EgoAdapter({
  brokerLease,
  command: config.egoBrowserCommand,
  dataDir: config.dataDir,
})
const broker = new Broker({
  appServerFactory: () => new AppServerClient(),
  brokerIdentity: lease.identity,
  brokerLease,
  egoAdapter,
  store,
})

try {
  await egoAdapter.initialize()
  await broker.initialize()
} catch (error) {
  broker.close()
  await egoAdapter.drain()
  await lease.release()
  throw error
}

const methods = new Map([
  ["broker.status", () => broker.getStatus()],
  ["conversation.start_adoption", (params) => broker.startConversationAdoption(params)],
  ["conversation.bind", (params) => broker.bindConversation(params)],
  ["conversation.get", (params) => broker.getConversationBinding(params)],
  ["conversation.reconcile", (params) => broker.reconcileConversation(params)],
  ["conversation.verify", (params) => broker.verifyConversation(params)],
  ["convergence.start", (params) => broker.startConvergence(params)],
  ["ego.preflight", (params) => broker.egoPreflight(params)],
  ["model_policy.ensure", (params) => broker.ensureModelPolicy(params)],
  ["model_policy.get", () => broker.getModelPolicy()],
  ["ego.start_exchange", (params) => broker.startEgoExchange(params)],
  ["ping", () => broker.ping()],
  ["result.read", (params) => broker.readResult(params)],
  ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ["workflow.abandon", (params) => broker.abandonWorkflow(params)],
  ["workflow.cancel", (params) => broker.cancelWorkflow(params)],
  ["workflow.get", (params) => broker.getWorkflow(params)],
  ["workflow.start_probe", (params) => broker.startProbe(params)],
])

let ipc
let resolveIpcReady
const ipcReady = new Promise((resolve) => {
  resolveIpcReady = resolve
})
let upgradeShutdownScheduled = false
const dispatch = createUpgradeAwareDispatch({
  dispatch: async (method, params, signal) => {
    const handler = methods.get(method)
    if (!handler) {
      throw new EgoChatError("method_not_found", "The requested broker method does not exist.")
    }
    return handler(params, signal)
  },
  getStatus: () => broker.getStatus(),
  onUpgradeAccepted: async () => {
    await ipcReady
    const owner = await lease.inspect()
    if (
      !Array.isArray(owner.browserPids)
      || !Array.isArray(owner.browserProcessGroups)
    ) {
      throw new EgoChatError(
        "unsafe_broker_lease",
        "The authoritative broker lease has no trustworthy browser-child ledger.",
      )
    }
    if (owner.browserPids.length > 0 || owner.browserProcessGroups.length > 0) {
      throw new EgoChatError(
        "upgrade_blocked_browser_child",
        "The authoritative broker still owns a click-capable browser child; retry setup after it exits.",
      )
    }
    if (upgradeShutdownScheduled) return
    upgradeShutdownScheduled = true
    globalThis.setImmediate(() => {
      shutdown()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error("Failed to stop broker after upgrade drain:", error)
          process.exit(1)
        })
    })
  },
  runtimeIdentity: RUNTIME_IDENTITY,
})
try {
  const compatibilitySocketPaths = config.reserveLegacySockets ? config.legacySocketPaths : []
  ipc = await startIpcServers({
    dispatch,
    socketPaths: [...compatibilitySocketPaths, config.socketPath],
    stickySocketPaths: compatibilitySocketPaths,
    token,
  })
  resolveIpcReady()
} catch (error) {
  broker.close()
  await egoAdapter.drain()
  await lease.release()
  if (
    error instanceof EgoChatError
    && error.code === "already_running"
    && error.details?.socketPath === config.socketPath
  ) {
    process.exit(0)
  }
  if (error instanceof EgoChatError && error.code === "already_running") {
    throw new EgoChatError(
      "legacy_broker_active",
      "A legacy Ego Chat broker claimed a compatibility socket while the canonical broker was starting. Restart Codex and ZCode before retrying.",
      { socketPath: error.details?.socketPath },
    )
  }
  throw error
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  broker.close()
  await ipc.close()
  await egoAdapter.drain()
  await lease.release()
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("Failed to stop broker:", error)
        process.exit(1)
      })
  })
}
