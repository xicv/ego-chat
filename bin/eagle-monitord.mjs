#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises"

import { EagleMonitorBrokerAdapter } from "../src/eagle-monitor-broker.mjs"
import { loadEagleMonitorConfig } from "../src/eagle-monitor-config.mjs"
import { EagleMonitorEngine } from "../src/eagle-monitor-engine.mjs"
import { acquireMonitorLease } from "../src/eagle-monitor-lease.mjs"
import { EgoChatError } from "../src/errors.mjs"
import {
  createLocalNotifier,
  createMonitorClock,
  createPowerController,
  createStorageObserver,
} from "../src/eagle-monitor-runtime.mjs"
import { EagleMonitorStore } from "../src/eagle-monitor-store.mjs"

function parseArgs(args) {
  const expected = new Set([
    "--broker-data-dir",
    "--broker-socket",
    "--ego-browser",
    "--monitor-data-dir",
  ])
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!expected.has(key) || !value || values.has(key)) throw new Error("invalid_daemon_arguments")
    values.set(key, value)
  }
  if (values.size !== expected.size) throw new Error("invalid_daemon_arguments")
  return values
}

const args = parseArgs(process.argv.slice(2))
const config = loadEagleMonitorConfig({
  brokerConfig: {
    dataDir: args.get("--broker-data-dir"),
    egoBrowserCommand: args.get("--ego-browser"),
    socketPath: args.get("--broker-socket"),
  },
  dataDir: args.get("--monitor-data-dir"),
})
const store = new EagleMonitorStore(config)
await store.initialize()
const lease = await acquireMonitorLease(config)
const power = createPowerController(config)
const abort = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => abort.abort())
}
const dispatchFence = {
  identity: lease.identity,
  assertCurrent: async () => {
    if (abort.signal.aborted) {
      throw new EgoChatError("monitor_stopping", "Eagle Monitor is stopping before dispatch.")
    }
    const current = await lease.assertCurrent()
    if (abort.signal.aborted) {
      throw new EgoChatError("monitor_stopping", "Eagle Monitor is stopping before dispatch.")
    }
    return current
  },
}
const engine = new EagleMonitorEngine({
  broker: new EagleMonitorBrokerAdapter(config.brokerConfig),
  clock: createMonitorClock(),
  config,
  lease: dispatchFence,
  notifier: createLocalNotifier(config),
  power,
  storage: createStorageObserver(config),
  store,
})

try {
  while (!abort.signal.aborted) {
    const result = await engine.tick()
    if (!result.active) break
    await delay(result.backoffMs, undefined, { signal: abort.signal }).catch((error) => {
      if (error.name !== "AbortError") throw error
    })
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error.code ?? "monitor_daemon_failed",
    message: "Eagle Monitor stopped safely; inspect status and incidents.",
  })}\n`)
  process.exitCode = 1
} finally {
  power.close()
  await power.setIdleSleepAssertion(false)
  await lease.release().catch(() => {})
}
