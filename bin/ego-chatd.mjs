#!/usr/bin/env node

import { Broker } from "../src/broker.mjs"
import { AppServerClient } from "../src/app-server-client.mjs"
import { EventStore } from "../src/store.mjs"
import { EgoAdapter } from "../src/ego-adapter.mjs"
import { loadConfig } from "../src/config.mjs"
import { loadOrCreateBrokerToken } from "../src/auth-token.mjs"
import { startIpcServer } from "../src/ipc-server.mjs"
import { EgoChatError } from "../src/errors.mjs"

const config = loadConfig()
const store = new EventStore(config.dataDir)
const egoAdapter = new EgoAdapter({
  command: config.egoBrowserCommand,
  dataDir: config.dataDir,
})
const broker = new Broker({
  appServerFactory: () => new AppServerClient(),
  egoAdapter,
  store,
})

await broker.initialize()
const token = await loadOrCreateBrokerToken(config.dataDir)

const methods = new Map([
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
  ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ["workflow.cancel", (params) => broker.cancelWorkflow(params)],
  ["workflow.get", (params) => broker.getWorkflow(params)],
  ["workflow.start_probe", (params) => broker.startProbe(params)],
])

let ipc
try {
  ipc = await startIpcServer({
  dispatch: async (method, params, signal) => {
    const handler = methods.get(method)
    if (!handler) {
      throw new EgoChatError("method_not_found", "The requested broker method does not exist.")
    }
    return handler(params, signal)
  },
  socketPath: config.socketPath,
  token,
  })
} catch (error) {
  if (error instanceof EgoChatError && error.code === "already_running") {
    broker.close()
    process.exit(0)
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
