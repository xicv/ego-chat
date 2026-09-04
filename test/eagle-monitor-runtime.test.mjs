import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { RUNTIME_IDENTITY } from "../src/constants.mjs"
import { loadEagleMonitorConfig, safeDigest } from "../src/eagle-monitor-config.mjs"
import { EagleMonitorEngine } from "../src/eagle-monitor-engine.mjs"
import { acquireMonitorLease } from "../src/eagle-monitor-lease.mjs"
import { MonitorAction, MonitorState } from "../src/eagle-monitor-policy.mjs"
import { createPowerController } from "../src/eagle-monitor-runtime.mjs"
import {
  EAGLE_SEMANTIC_POLICY,
  projectEagleSemanticCheckpoint,
} from "../src/eagle-monitor-semantic.mjs"
import { EagleMonitorStore } from "../src/eagle-monitor-store.mjs"

const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001"
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url))

function embeddedRuntimePaths(source) {
  const body = source.match(/const RUNTIME_FILES: &\[EmbeddedFile\] = &\[([\s\S]*?)\n\];/)?.[1]
  assert.ok(body, "Rust embedded runtime inventory is present")
  return [...body.matchAll(/path: "([^"]+)"/g)].map((match) => match[1])
}

function localModuleSpecifiers(source) {
  const imports = []
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g
  for (const match of source.matchAll(pattern)) imports.push(match[1])
  return imports
}

test("the embedded runtime inventory is import-complete and materialized entry modules load", async (t) => {
  const rustSource = await fs.readFile(path.join(REPOSITORY_ROOT, "rust/main.rs"), "utf8")
  const runtimePaths = embeddedRuntimePaths(rustSource)
  const inventory = new Set(runtimePaths)
  const missingImports = []

  for (const runtimePath of runtimePaths.filter((entry) => entry.endsWith(".mjs"))) {
    const source = await fs.readFile(path.join(REPOSITORY_ROOT, runtimePath), "utf8")
    for (const specifier of localModuleSpecifiers(source)) {
      const importedPath = path.posix.normalize(path.posix.join(
        path.posix.dirname(runtimePath),
        specifier,
      ))
      if (!inventory.has(importedPath)) missingImports.push(`${runtimePath} -> ${importedPath}`)
    }
  }

  assert.deepEqual(missingImports, [], "every relative runtime import must be embedded")
  assert.equal(inventory.has("src/eagle-monitor-semantic.mjs"), true)

  const materialized = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-embedded-runtime-"))
  t.after(() => fs.rm(materialized, { force: true, recursive: true }))
  for (const runtimePath of runtimePaths) {
    const destination = path.join(materialized, runtimePath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(path.join(REPOSITORY_ROOT, runtimePath), destination)
  }
  const zodDirectory = path.join(materialized, "node_modules/zod")
  await fs.mkdir(zodDirectory, { recursive: true })
  await fs.writeFile(path.join(zodDirectory, "package.json"), JSON.stringify({
    exports: { "./v4": "./v4.mjs" },
    name: "zod",
    type: "module",
  }))
  await fs.writeFile(
    path.join(zodDirectory, "v4.mjs"),
    "const fluent = new Proxy(() => fluent, { apply: () => fluent, get: () => fluent })\nexport const z = fluent\n",
  )

  const entries = ["src/broker.mjs", "src/eagle-monitor-engine.mjs"]
    .map((entry) => pathToFileURL(path.join(materialized, entry)).href)
  await Promise.all(entries.map((entry) => import(entry)))
  assert.equal((await fs.stat(path.join(materialized, "src/eagle-monitor-semantic.mjs"))).isFile(), true)
})

async function fixture(t, {
  mode = "safe",
  onAc = true,
  pollIntervalMs = 1_000,
  powerPolicy = "allow-sleep",
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-runtime-"))
  const brokerData = path.join(root, "broker")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const config = loadEagleMonitorConfig({
    brokerConfig: {
      dataDir: brokerData,
      egoBrowserCommand: process.execPath,
      socketPath: path.join(os.tmpdir(), `egc-eagle-runtime-${process.pid}.sock`),
    },
    dataDir: path.join(brokerData, "eagle-monitor"),
    launchAgentsDir: path.join(root, "LaunchAgents"),
    platform: "darwin",
    pollIntervalMs,
  })
  const store = new EagleMonitorStore(config)
  await store.configureSession({
    bindingKey: "ego-chat-main",
    launchAgentDigest: "a".repeat(64),
    mode,
    now: "2026-09-04T00:00:00.000Z",
    powerPolicy,
    workflowId: WORKFLOW_ID,
  })
  const lease = await acquireMonitorLease(config)
  t.after(() => lease.release().catch(() => {}))
  let dispatchRevoked = false
  const dispatchFence = {
    identity: lease.identity,
    assertCurrent: async () => {
      if (dispatchRevoked) {
        const error = new Error("injected daemon stop")
        error.code = "monitor_stopping"
        throw error
      }
      const current = await lease.assertCurrent()
      if (dispatchRevoked) {
        const error = new Error("injected daemon stop")
        error.code = "monitor_stopping"
        throw error
      }
      return current
    },
  }
  const time = {
    monotonic: 1_000,
    wall: Date.parse("2026-09-04T00:00:00.000Z"),
  }
  const actions = []
  let beforeDispatch = async () => {}
  let beforeObserve = async () => {}
  let observation = {
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      bindingKey: "ego-chat-main",
      phase: "codex_running",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  }
  const broker = {
    attachExactWorkflow: async (workflowId, fence) => {
      await beforeDispatch("attach")
      await fence.assertCurrent()
      actions.push(["attach", workflowId])
    },
    observeExact: async (workflowId) => {
      actions.push(["observe", workflowId])
      await beforeObserve()
      return structuredClone(observation)
    },
    reconcileExactWorkflow: async (bindingKey, workflowId, fence) => {
      await beforeDispatch("reconcile")
      await fence.assertCurrent()
      actions.push(["reconcile", bindingKey, workflowId])
      return {
        observationOnly: true,
        phase: observation.workflow?.phase ?? null,
        status: observation.workflow?.status,
        workflowId,
      }
    },
    startBroker: async (fence) => {
      await beforeDispatch("start")
      await fence.assertCurrent()
      actions.push(["start"])
    },
  }
  const power = {
    observe: async () => ({ onAc, sleepDetected: false, wakeDetected: false }),
    setIdleSleepAssertion: async (enabled, fence) => {
      await fence.assertCurrent()
      actions.push(["power", enabled])
    },
  }
  const createEngine = () => new EagleMonitorEngine({
    broker,
    clock: {
      monotonicMs: () => time.monotonic,
      wallMs: () => time.wall,
    },
    config,
    lease: dispatchFence,
    notifier: {
      notify: async (_classification, fence) => {
        await fence.assertCurrent()
        actions.push(["notify"])
      },
    },
    power,
    storage: { observe: async () => ({ spaceAvailable: true, writable: true }) },
    store,
  })
  const engine = createEngine()
  return {
    actions,
    config,
    createEngine,
    engine,
    lease: dispatchFence,
    revokeDispatch: () => { dispatchRevoked = true },
    setBeforeDispatch: (value) => { beforeDispatch = value },
    setObservation: (value) => {
      observation = {
        ...value,
        workflow: value.workflow
          ? { bindingKey: "ego-chat-main", kind: "ego_exchange", ...value.workflow }
          : value.workflow,
      }
    },
    setBeforeObserve: (value) => { beforeObserve = value },
    store,
    time,
  }
}

test("broker death needs repeated IPC-plus-lease proof before one fenced start", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  const first = await context.engine.tick()
  assert.equal(first.classification.state, MonitorState.STARTUP)
  assert.equal(context.actions.some(([action]) => action === "start"), false)

  context.time.wall += context.config.policy.deadConfirmationMs
  context.time.monotonic += context.config.policy.deadConfirmationMs
  const second = await context.engine.tick()
  assert.equal(second.state.lastAction.action, MonitorAction.START_BROKER)
  assert.equal(second.state.lastAction.monitorEpoch, context.lease.identity.epoch)
  assert.equal(context.actions.filter(([action]) => action === "start").length, 1)
  assert.equal(second.state.recoveryCount, 1)
})

test("shadow mode never reports its predicted recovery action as in flight", async (t) => {
  const context = await fixture(t, { mode: "shadow" })
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  await context.engine.tick()
  context.time.wall += context.config.policy.deadConfirmationMs
  context.time.monotonic += context.config.policy.deadConfirmationMs

  const result = await context.engine.tick()
  assert.equal(result.state.lastAction.action, MonitorAction.START_BROKER)
  assert.equal(result.state.lastAction.outcome, "predicted_shadow_only")
  assert.equal(result.state.semantic.dimensions.recovery, "idle")
  assert.equal(context.actions.some(([action]) => action === "start"), false)
})

test("a new exact workflow does not inherit stale workflow-scoped recovery state", async (t) => {
  const context = await fixture(t)
  await context.store.writeState({
    backoffAttempt: 3,
    backoffKey: "a".repeat(64),
    brokerStarts: [],
    deadSinceAt: context.time.wall - context.config.policy.deadConfirmationMs,
    incidents: [],
    lastIncidentKey: "startup:broker_conclusively_dead",
    recoveryCount: 9,
    schemaVersion: 1,
    state: MonitorState.STARTUP,
    updatedAt: new Date(context.time.wall).toISOString(),
    workflowDigest: safeDigest("00000000-0000-4000-8000-000000000099"),
  }, context.lease)
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })

  const result = await context.engine.tick()
  assert.equal(context.actions.some(([action]) => action === "start"), false)
  assert.equal(result.state.deadSinceAt, context.time.wall)
  assert.equal(result.state.recoveryCount, 0)
  assert.equal(result.state.workflowDigest, safeDigest(WORKFLOW_ID))
})

test("an existing PR #20 state resumes with optional semantic fields absent", async (t) => {
  const context = await fixture(t)
  await context.store.writeState({
    brokerStarts: [],
    incidents: [],
    lastIncidentKey: null,
    recoveryCount: 4,
    schemaVersion: 1,
    state: MonitorState.HEALTHY,
    updatedAt: new Date(context.time.wall).toISOString(),
    workflowDigest: safeDigest(WORKFLOW_ID),
  }, context.lease)

  const result = await context.engine.tick()
  assert.equal(result.state.recoveryCount, 4)
  assert.equal(result.state.semantic.schema, "EagleSemanticState.v1")
  assert.equal(result.state.semantic.workflowDigest, safeDigest(WORKFLOW_ID))
  assert.equal("semanticIncidentKeys" in result.state, false)
})

test("transport cancellation is not mislabeled as a genuine human boundary", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      humanRequired: { code: "cancelled_during_convergence" },
      phase: "chatgpt_running",
      status: "human_required",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })

  const result = await context.engine.tick()
  assert.equal(result.classification.state, MonitorState.HUMAN_REQUIRED_OTHER)
  assert.equal(result.state.humanRequired.required, true)
  assert.equal(result.state.semantic.classification, "suspect")
  assert.equal(result.state.semantic.dimensions.humanBoundary, false)
})

test("a stopping daemon cannot cross a final recovery dispatch boundary", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  await context.engine.tick()
  context.time.wall += context.config.policy.deadConfirmationMs
  context.time.monotonic += context.config.policy.deadConfirmationMs
  context.setBeforeObserve(async () => context.revokeDispatch())

  await assert.rejects(
    context.engine.tick(),
    (error) => error.code === "monitor_stopping",
  )
  assert.equal(context.actions.some(([action]) => action === "start"), false)
})

test("duplicate and stale monitor owners cannot issue fenced recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-fence-"))
  const brokerData = path.join(root, "broker")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const config = loadEagleMonitorConfig({
    brokerConfig: {
      dataDir: brokerData,
      egoBrowserCommand: process.execPath,
      socketPath: path.join(os.tmpdir(), `egc-eagle-fence-${process.pid}.sock`),
    },
    dataDir: path.join(brokerData, "eagle-monitor"),
    launchAgentsDir: path.join(root, "LaunchAgents"),
    platform: "darwin",
  })
  let firstAlive = true
  const processIsAlive = (pid) => pid === 101 ? firstAlive : true
  const first = await acquireMonitorLease(config, { pid: 101, processIsAlive })
  await assert.rejects(
    acquireMonitorLease(config, { pid: 202, processIsAlive }),
    (error) => error.code === "monitor_already_running",
  )
  firstAlive = false
  const second = await acquireMonitorLease(config, { pid: 202, processIsAlive })
  assert.equal(second.identity.epoch, first.identity.epoch + 1)
  await assert.rejects(first.assertCurrent(), (error) => error.code === "monitor_lease_lost")
  await second.release()
})

test("recovery-state writes require the current monitor fence", async (t) => {
  const context = await fixture(t)
  const state = {
    incidents: [],
    schemaVersion: 1,
    state: MonitorState.STARTUP,
    updatedAt: new Date(context.time.wall).toISOString(),
  }

  await assert.rejects(
    context.store.writeState(state),
    (error) => error.code === "monitor_dispatch_unfenced",
  )
  await context.store.writeState(state, context.lease)
  assert.equal((await context.store.readState()).state, MonitorState.STARTUP)
})

test("a monitor fenced during observation cannot dispatch recovery", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  context.setBeforeObserve(async () => {
    await fs.writeFile(context.config.paths.lock, `${JSON.stringify({
      ...context.lease.identity,
      epoch: context.lease.identity.epoch + 1,
      ownerId: randomUUID(),
    })}\n`, { mode: 0o600 })
  })

  await assert.rejects(
    context.engine.tick(),
    (error) => error.code === "monitor_lease_lost",
  )
  assert.deepEqual(context.actions.map(([action]) => action), ["observe"])
})

test("a monitor fenced after dispatch persistence cannot cross the broker action boundary", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: false,
    conclusivelyDead: true,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  await context.engine.tick()
  context.time.wall += context.config.policy.deadConfirmationMs
  context.time.monotonic += context.config.policy.deadConfirmationMs
  context.setBeforeDispatch(async (action) => {
    if (action !== "start") return
    await fs.writeFile(context.config.paths.lock, `${JSON.stringify({
      ...context.lease.identity,
      epoch: context.lease.identity.epoch + 1,
      ownerId: randomUUID(),
    })}\n`, { mode: 0o600 })
  })

  await assert.rejects(
    context.engine.tick(),
    (error) => error.code === "monitor_lease_lost",
  )
  assert.equal(context.actions.some(([action]) => action === "start"), false)
  const state = await context.store.readState()
  assert.equal(state.lastAction.action, MonitorAction.START_BROKER)
  assert.equal(state.lastAction.outcome, "dispatching")
  assert.equal(state.lastAction.monitorEpoch, context.lease.identity.epoch)
})

test("a malformed lease fails closed and remains intact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-corrupt-lease-"))
  const brokerData = path.join(root, "broker")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const config = loadEagleMonitorConfig({
    brokerConfig: {
      dataDir: brokerData,
      egoBrowserCommand: process.execPath,
      socketPath: path.join(os.tmpdir(), `egc-eagle-corrupt-${process.pid}.sock`),
    },
    dataDir: path.join(brokerData, "eagle-monitor"),
    launchAgentsDir: path.join(root, "LaunchAgents"),
    platform: "darwin",
  })
  await fs.mkdir(config.dataDir, { mode: 0o700 })
  const malformed = `${JSON.stringify({ schemaVersion: 1, state: "active" })}\n`
  await fs.writeFile(config.paths.lock, malformed, { mode: 0o600 })

  await assert.rejects(
    acquireMonitorLease(config),
    (error) => error.code === "corrupt_monitor_lease",
  )
  assert.equal(await fs.readFile(config.paths.lock, "utf8"), malformed)
})

test("crash-loop history suppresses a fourth broker start and notifies", async (t) => {
  const context = await fixture(t)
  await context.store.writeState({
    brokerStarts: [context.time.wall - 3_000, context.time.wall - 2_000, context.time.wall - 1_000],
    incidents: [],
    lastTick: null,
    recoveryCount: 3,
    schemaVersion: 1,
    state: MonitorState.STARTUP,
    updatedAt: new Date(context.time.wall).toISOString(),
  }, context.lease)
  context.setObservation({ available: false, conclusivelyDead: true, workflow: null })
  const result = await context.engine.tick()
  assert.equal(result.classification.state, MonitorState.CRASH_LOOP)
  assert.equal(context.actions.some(([action]) => action === "start"), false)
  assert.equal(context.actions.filter(([action]) => action === "notify").length, 1)

})

test("a wake discontinuity pauses recovery for one full revalidation", async (t) => {
  const context = await fixture(t)
  const initial = await context.engine.tick()
  assert.equal(initial.classification.state, MonitorState.HEALTHY)
  const attachedBeforeWake = context.actions.filter(([action]) => action === "attach").length

  context.time.wall += 10_000
  context.time.monotonic += 1_000
  const wake = await context.engine.tick()
  assert.equal(wake.classification.state, MonitorState.POWER_SLEEP)
  assert.equal(context.actions.filter(([action]) => action === "attach").length, attachedBeforeWake)

  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const resumed = await context.engine.tick()
  assert.equal(resumed.classification.state, MonitorState.HEALTHY)
  assert.equal(context.actions.filter(([action]) => action === "attach").length, attachedBeforeWake + 1)
})

test("a long phase-aware backoff is not mistaken for sleep when both clocks advance", async (t) => {
  const context = await fixture(t)
  const initial = await context.engine.tick()
  assert.equal(initial.backoffMs, 5_000)
  context.time.wall += initial.backoffMs
  context.time.monotonic += initial.backoffMs

  const next = await context.engine.tick()
  assert.equal(next.classification.state, MonitorState.HEALTHY)
  assert.equal(next.backoffMs, 15_000)

  context.time.wall += next.backoffMs
  context.time.monotonic += next.backoffMs
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      phase: "codex_running",
      status: "running",
      updatedAt: "2026-09-04T00:00:20.000Z",
    },
  })
  const progressed = await context.engine.tick()
  assert.equal(progressed.backoffMs, 5_000)
})

test("a changed monitor policy blocks attachment and requires human review", async (t) => {
  const context = await fixture(t)
  context.config.policy = { ...context.config.policy, digest: "f".repeat(64) }

  const result = await context.engine.tick()
  assert.equal(result.classification.state, MonitorState.VERSION_SKEW)
  assert.equal(result.classification.reasonCode, "monitor_policy_version_skew")
  assert.equal(context.actions.some(([action]) => action === "attach"), false)
  assert.equal(context.actions.filter(([action]) => action === "notify").length, 1)
})

test("keep-awake is explicit, AC-gated, and otherwise releases idle-sleep assertion", async (t) => {
  const defaultSleep = await fixture(t)
  await defaultSleep.engine.tick()
  assert.deepEqual(defaultSleep.actions.filter(([action]) => action === "power"), [["power", false]])

  const onAc = await fixture(t, { powerPolicy: "keep-awake-on-ac" })
  await onAc.engine.tick()
  assert.deepEqual(onAc.actions.filter(([action]) => action === "power"), [["power", true]])

  const onBattery = await fixture(t, { onAc: false, powerPolicy: "keep-awake-on-ac" })
  await onBattery.engine.tick()
  assert.deepEqual(onBattery.actions.filter(([action]) => action === "power"), [["power", false]])
})

test("idle-sleep assertion replacement ignores late exit and handles spawn failure", async () => {
  const children = []
  const spawnProcess = () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.kill = () => {
      child.exitCode = 0
      return true
    }
    children.push(child)
    queueMicrotask(() => child.emit(children.length === 3 ? "error" : "spawn", new Error("missing")))
    return child
  }
  const controller = createPowerController({
    commands: { caffeinate: "/usr/bin/caffeinate", pmset: "/usr/bin/pmset" },
  }, { spawnProcess })

  await controller.setIdleSleepAssertion(true)
  await controller.setIdleSleepAssertion(false)
  await controller.setIdleSleepAssertion(true)
  children[0].emit("exit", 0)
  assert.equal(await controller.setIdleSleepAssertion(true), true)
  assert.equal(children.length, 2)

  await controller.setIdleSleepAssertion(false)
  await assert.rejects(
    controller.setIdleSleepAssertion(true),
    (error) => error.message === "idle_sleep_assertion_failed",
  )
  assert.equal(children.length, 3)
})

test("the bounded pmset observer reports sleep and wake once without persisting raw output", async () => {
  const observer = new EventEmitter()
  observer.exitCode = null
  observer.kill = () => {
    observer.exitCode = 0
    return true
  }
  observer.stdout = new EventEmitter()
  observer.stdout.setEncoding = () => {}
  let observerStarts = 0
  const controller = createPowerController({
    commands: { caffeinate: "/usr/bin/caffeinate", pmset: "/usr/bin/pmset" },
  }, {
    runCommand: async () => ({ code: 0, stdout: "Now drawing from 'AC Power'\n" }),
    spawnPowerObserver: () => {
      observerStarts += 1
      return observer
    },
  })

  assert.deepEqual(await controller.observe(), {
    onAc: true,
    sleepDetected: false,
    wakeDetected: false,
  })
  observer.stdout.emit("data", [
    "2026-09-04 01:00:00 +0930 IORegisterForSystemPower: ...Sleeping...",
    "private diagnostic detail that must never leave this parser",
    "2026-09-04 01:01:00 +0930 IORegisterForSystemPower: ...HasPoweredOn... Wake Reason = test",
    "",
  ].join("\n"))
  assert.deepEqual(await controller.observe(), {
    onAc: true,
    sleepDetected: true,
    wakeDetected: true,
  })
  assert.deepEqual(await controller.observe(), {
    onAc: true,
    sleepDetected: false,
    wakeDetected: false,
  })
  assert.equal(observerStarts, 1)
  controller.close()
  assert.equal(observer.exitCode, 0)
})

test("corrupt durable state fails closed before observing or recovering", async (t) => {
  const context = await fixture(t)
  await fs.writeFile(context.config.paths.state, "{not-json\n", { mode: 0o600 })
  await assert.rejects(context.engine.tick(), (error) => error.code === "corrupt_monitor_state")
  assert.equal(context.actions.length, 0)
})

test("well-formed JSON with unsupported private state fields fails closed", async (t) => {
  const context = await fixture(t)
  await fs.writeFile(context.config.paths.state, `${JSON.stringify({
    incidents: [],
    prompt: "must not persist",
    schemaVersion: 1,
    state: MonitorState.HEALTHY,
  })}\n`, { mode: 0o600 })
  await assert.rejects(context.engine.tick(), (error) => error.code === "corrupt_monitor_state")
  assert.equal(context.actions.length, 0)
})

test("pre-Send, ambiguous, and confirmed-Send recovery stay exact and never resend", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      phase: "browser_owned",
      status: "running",
      updatedAt: "2026-09-03T23:00:00.000Z",
    },
  })
  const preSend = await context.engine.tick()
  assert.equal(preSend.classification.state, MonitorState.STALLED_BEFORE_SEND)
  assert.deepEqual(context.actions.filter(([action]) => action === "attach").at(-1), [
    "attach",
    WORKFLOW_ID,
  ])
  assert.equal(context.actions.some(([action]) => action === "reconcile"), false)

  context.time.wall += 1_000
  context.time.monotonic += 1_000
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      humanRequired: { code: "send_confirmation_ambiguous" },
      phase: "recovery_required",
      status: "human_required",
    },
  })
  const ambiguous = await context.engine.tick()
  assert.equal(ambiguous.classification.state, MonitorState.HUMAN_REQUIRED_OTHER)
  assert.equal(ambiguous.classification.reasonCode, "terminal_reconciliation_unresolved")
  assert.deepEqual(context.actions.filter(([action]) => action === "reconcile").at(-1), [
    "reconcile",
    "ego-chat-main",
    WORKFLOW_ID,
  ])
  assert.equal(context.actions.filter(([action]) => action === "notify").length, 1)
  assert.equal(ambiguous.state.lastAction.outcome, "terminal_observed")
  assert.match(ambiguous.state.reconciliation.observationDigest, /^[a-f0-9]{64}$/)

  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const unchangedTerminal = await context.engine.tick()
  assert.equal(unchangedTerminal.classification.state, MonitorState.HUMAN_REQUIRED_OTHER)
  assert.equal(unchangedTerminal.classification.reasonCode, "terminal_reconciliation_unresolved")
  assert.equal(unchangedTerminal.state.lastAction.action, MonitorAction.NOTIFY_USER)
  assert.equal(unchangedTerminal.state.lastAction.outcome, "already_reported")
  assert.equal(context.actions.filter(([action]) => action === "reconcile").length, 1)
  assert.equal(context.actions.filter(([action]) => action === "notify").length, 1)

  const reconciliationCount = context.actions.filter(([action]) => action === "reconcile").length
  context.time.wall += 1_000
  context.time.monotonic += 1_000
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      phase: "send_confirmed",
      status: "running",
      updatedAt: "2026-09-04T00:00:01.000Z",
    },
  })
  const confirmed = await context.engine.tick()
  assert.equal(confirmed.classification.state, MonitorState.SEND_CONFIRMED_CAPTURE)
  assert.deepEqual(context.actions.filter(([action]) => action === "attach").at(-1), [
    "attach",
    WORKFLOW_ID,
  ])
  assert.equal(
    context.actions.filter(([action]) => action === "reconcile").length,
    reconciliationCount,
  )
})

test("convergence ambiguity stays durable, redacted, and exact-parent-bound across restart", async (t) => {
  for (const scenario of [
    ["not_confirmed", "convergence_delivery_not_confirmed"],
    ["reconciling_delivery", "convergence_delivery_reconciling"],
  ]) {
    await t.test(scenario[0], async (t) => {
      const [delivery, reasonCode] = scenario
      const context = await fixture(t)
      context.setObservation({
        available: true,
        conclusivelyDead: false,
        epoch: 7,
        runtimeIdentity: RUNTIME_IDENTITY,
        workflow: {
          bindingKey: "ego-chat-main",
          kind: "convergence",
          phase: "chatgpt_running",
          status: "running",
          supervision: {
            chatGpt: { delivery },
            lastTransitionAt: "2026-09-03T23:00:00.000Z",
          },
        },
      })

      const first = await context.engine.tick()
      assert.equal(first.classification.state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
      assert.equal(first.classification.reasonCode, reasonCode)
      assert.equal(first.classification.humanRequired, false)
      assert.equal(first.state.state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
      assert.equal(first.state.humanRequired.reasonCode, reasonCode)
      assert.deepEqual(context.actions.filter(([action]) => action === "attach").at(-1), [
        "attach",
        WORKFLOW_ID,
      ])
      assert.equal(context.actions.some(([action]) => action === "reconcile"), false)

      const session = await context.store.readSession()
      const persisted = await context.store.readState()
      const publicStatus = context.store.publicStatus(session, persisted, { loaded: true })
      const incidents = context.store.publicIncidents(persisted, 200)
      assert.equal(publicStatus.state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
      assert.equal(publicStatus.humanRequired.reasonCode, reasonCode)
      assert.equal(publicStatus.phase, "chatgpt_running")
      assert.equal(incidents[0].state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
      assert.equal(incidents[0].reasonCode, reasonCode)
      assert.equal(incidents[0].humanRequired, false)
      assert.equal(JSON.stringify({ incidents, publicStatus }).includes(WORKFLOW_ID), false)

      const restarted = context.createEngine()
      const second = await restarted.tick()
      assert.equal(second.classification.state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
      assert.equal(second.classification.reasonCode, reasonCode)
      assert.deepEqual(context.actions.filter(([action]) => action === "attach").at(-1), [
        "attach",
        WORKFLOW_ID,
      ])
      assert.equal(context.actions.filter(([action]) => action === "reconcile").length, 0)
      assert.equal((await context.store.readState()).incidents.length, 1)
    })
  }
})

test("an exact workflow bound to a different key stops before attachment", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      bindingKey: "other-binding",
      phase: "send_confirmed",
      status: "running",
    },
  })

  const result = await context.engine.tick()
  assert.equal(result.classification.reasonCode, "exact_workflow_binding_mismatch")
  assert.equal(result.classification.state, MonitorState.HUMAN_REQUIRED_OTHER)
  assert.equal(context.actions.some(([action]) => action === "attach"), false)
  assert.equal(context.actions.some(([action]) => action === "reconcile"), false)
  assert.equal(context.actions.filter(([action]) => action === "notify").length, 1)
})

test("public state and incidents are bounded and redact raw identities and content", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      error: { code: "disk_write_failed", message: "prompt and response secret" },
      phase: "https://chatgpt.com/c/private",
      privateCanonicalUrl: "https://chatgpt.com/c/private",
      prompt: "never persist me",
      responseText: "never persist me either",
      status: "failed",
    },
  })
  await context.engine.tick()
  const session = await context.store.readSession()
  const state = await context.store.readState()
  const publicValue = context.store.publicStatus(session, state, { loaded: true })
  const incidents = context.store.publicIncidents(state, 200)
  const serialized = JSON.stringify({ incidents, publicValue })
  assert.equal(serialized.includes(WORKFLOW_ID), false)
  assert.equal(serialized.includes("ego-chat-main"), false)
  assert.equal(serialized.includes("chatgpt.com"), false)
  assert.equal(serialized.includes("never persist"), false)
  assert.equal(incidents[0].workflowDigest.length, 64)
  assert.equal(incidents[0].bindingDigest.length, 64)
  assert.equal(incidents[0].phase, null)
  assert.equal(incidents.length <= 200, true)
})

test("semantic hysteresis, loop incidents, and deduplication survive monitor restarts", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })

  const first = await context.engine.tick()
  assert.equal(first.state.semantic.classification, "suspect")
  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const second = await context.createEngine().tick()
  assert.equal(second.state.semantic.classification, "stagnant")
  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const third = await context.createEngine().tick()
  assert.equal(third.state.semantic.classification, "looping")
  assert.equal(third.state.semantic.metrics.loopPattern, "repeated")
  const incidentCount = third.state.incidents.length
  const loopIncident = third.state.incidents.at(-1)
  assert.equal(loopIncident.kind, "semantic")
  assert.equal(loopIncident.semanticState, "looping")
  assert.equal(loopIncident.semanticIncidentKey, third.state.semantic.incidentKey)

  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const fourth = await context.createEngine().tick()
  assert.equal(fourth.state.semantic.classification, "looping")
  assert.equal(fourth.state.incidents.length, incidentCount)
  assert.equal(fourth.state.incidents.at(-1).id, loopIncident.id)

  const session = await context.store.readSession()
  const publicStatus = context.store.publicStatus(session, fourth.state, { loaded: true })
  assert.equal(publicStatus.semantic.classification, "looping")
  assert.equal(publicStatus.semantic.metrics.loopPattern, "repeated")
  assert.equal(JSON.stringify(publicStatus).includes(WORKFLOW_ID), false)

  const waitCheckpoint = projectEagleSemanticCheckpoint({
    createdAt: "2026-09-04T00:00:00.000Z",
    id: WORKFLOW_ID,
    phase: "working",
    status: "running",
    updatedAt: "2026-09-04T00:00:00.000Z",
  })
  waitCheckpoint.expectedWait = {
    deadlineAt: "2026-09-04T00:00:10.000Z",
    identityDigest: "e".repeat(64),
    maxExtensionMs: EAGLE_SEMANTIC_POLICY.expectedWaitExtensionMs,
    operation: "required_verification",
    startAt: "2026-09-04T00:00:00.000Z",
  }
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    semanticCheckpoint: waitCheckpoint,
    workflow: {
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })
  context.time.wall = Date.parse("2026-09-04T00:00:05.000Z")
  context.time.monotonic += 1_000
  const waiting = await context.createEngine().tick()
  assert.equal(waiting.state.semantic.classification, "expected_wait")
  context.time.wall = Date.parse("2026-09-04T00:00:11.000Z")
  context.time.monotonic += 6_000
  const extended = await context.createEngine().tick()
  assert.equal(extended.state.semantic.classification, "expected_wait")
  assert.equal(extended.state.semantic.expectedWaitLease.extensionUsed, 1)

  context.time.wall = Date.parse("2026-09-04T00:01:10.001Z")
  context.time.monotonic += 59_001
  const afterWait = await context.createEngine().tick()
  assert.equal(afterWait.state.semantic.classification, "suspect")
  context.time.wall += 1
  context.time.monotonic += 1
  const sameLoop = await context.createEngine().tick()
  assert.equal(sameLoop.state.semantic.classification, "looping")
  assert.equal(sameLoop.state.incidents.length, incidentCount)
  assert.equal(sameLoop.state.incidents.at(-1).id, loopIncident.id)
  const reconstructed = await context.store.readState()
  const regressedStatus = context.store.publicStatus(
    await context.store.readSession(),
    reconstructed,
    { loaded: true },
    null,
    null,
    Date.parse("2026-09-04T00:00:30.000Z"),
  )
  assert.equal(regressedStatus.semantic.classification, "looping")
  assert.equal(regressedStatus.semantic.expectedWaitLease.active, false)
})

test("public store status cannot revive expired useful progress after clock regression", async (t) => {
  const context = await fixture(t)
  const candidateDigest = "c".repeat(64)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    semanticCheckpoint: projectEagleSemanticCheckpoint({
      createdAt: "2026-09-04T00:00:00.000Z",
      cycle: 1,
      id: WORKFLOW_ID,
      phase: "review_captured",
      private: {
        cycles: [{
          candidate: {
            blockers: [],
            criteria: [{ evidence: "failed", id: "AC-1", status: "fail" }],
          },
          candidateDigest,
          cycle: 1,
          review: {
            criteria: [{ evidence: "passed", id: "AC-1", status: "pass" }],
            findings: [],
          },
          reviewSignature: "d".repeat(64),
        }],
      },
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    }),
    workflow: {
      bindingKey: "ego-chat-main",
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })
  const progressing = await context.engine.tick()
  assert.equal(progressing.state.semantic.classification, "progressing")

  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    semanticCheckpoint: projectEagleSemanticCheckpoint({
      createdAt: "2026-09-04T00:00:00.000Z",
      id: WORKFLOW_ID,
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:15:00.001Z",
    }),
    workflow: {
      bindingKey: "ego-chat-main",
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:15:00.001Z",
    },
  })
  context.time.wall += EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1
  context.time.monotonic += EAGLE_SEMANTIC_POLICY.usefulProgressLeaseMs + 1
  const expired = await context.createEngine().tick()
  assert.equal(expired.state.semantic.classification, "suspect")

  const status = context.store.publicStatus(
    await context.store.readSession(),
    await context.store.readState(),
    { loaded: true },
    null,
    null,
    Date.parse("2026-09-04T00:14:59.999Z"),
  )
  assert.equal(status.semantic.classification, "suspect")
  assert.equal(status.semantic.usefulProgressLease.active, false)
})

test("a mismatched semantic checkpoint fails closed before fenced state or recovery mutation", async (t) => {
  const context = await fixture(t)
  const wrongWorkflowId = "00000000-0000-4000-8000-000000000099"
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    semanticCheckpoint: projectEagleSemanticCheckpoint({
      createdAt: "2026-09-04T00:00:00.000Z",
      id: wrongWorkflowId,
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    }),
    workflow: {
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })

  await assert.rejects(
    context.engine.tick(),
    (error) => error.code === "invalid_semantic_checkpoint",
  )
  assert.deepEqual(context.actions.map(([action]) => action), ["observe"])
  assert.equal(await context.store.readState(), null)
})

test("cross-workflow semantic persistence is rejected without replacing valid state", async (t) => {
  const context = await fixture(t)
  const valid = await context.engine.tick()
  const before = await fs.readFile(context.config.paths.state, "utf8")
  const corrupt = structuredClone(valid.state)
  corrupt.semantic.workflowDigest = "f".repeat(64)

  await assert.rejects(
    context.store.writeState(corrupt, context.lease),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
})

test("a same-workflow clock regression fails before recovery dispatch or state mutation", async (t) => {
  const context = await fixture(t)
  await context.engine.tick()
  const before = await fs.readFile(context.config.paths.state, "utf8")
  const actionCount = context.actions.length
  context.time.wall -= 1_000

  await assert.rejects(
    context.createEngine().tick(),
    (error) => error.code === "invalid_semantic_observation",
  )
  assert.deepEqual(
    context.actions.slice(actionCount).map(([action]) => action),
    ["observe"],
  )
  assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
})

test("an unbounded persisted expected wait is rejected without replacing valid state", async (t) => {
  const context = await fixture(t)
  const valid = await context.engine.tick()
  const before = await fs.readFile(context.config.paths.state, "utf8")
  const corrupt = structuredClone(valid.state)
  corrupt.semantic.expectedWaitLease.deadlineAt = "2099-09-04T00:00:00.000Z"
  corrupt.semantic.expectedWaitLease.effectiveDeadlineAt = "2099-09-04T00:00:00.000Z"
  corrupt.semantic.expectedWaitLease.extensionUsed = 0

  await assert.rejects(
    context.store.writeState(corrupt, context.lease),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
})

test("relationally impossible semantic states are rejected without replacing valid state", async (t) => {
  const context = await fixture(t)
  const valid = await context.engine.tick()
  const before = await fs.readFile(context.config.paths.state, "utf8")
  const incidentKey = "d".repeat(64)
  const evidenceIdentity = "e".repeat(64)
  const derivedIncidentKey = (semantic, phase) => safeDigest(JSON.stringify({
    brokerEpoch: semantic.brokerEpoch,
    classification: semantic.classification,
    evidenceWindow: semantic.usefulProgressLease?.evidenceDigest ?? null,
    loopPattern: semantic.classification === "looping" ? semantic.metrics.loopPattern : null,
    phase,
    stepFingerprint: semantic.fingerprintHistory.at(-1),
    workflowDigest: semantic.workflowDigest,
  }))
  const forgedProgress = structuredClone(valid.state)
  forgedProgress.semantic.classification = "progressing"
  forgedProgress.semantic.reasonCode = "useful_progress_lease_active"
  forgedProgress.semantic.usefulProgressLease = {
    evidenceDigest: safeDigest(JSON.stringify([evidenceIdentity])),
    evidenceDigests: [evidenceIdentity],
    expiresAt: "2026-09-04T00:15:00.000Z",
    renewedAt: "2026-09-04T00:00:00.000Z",
  }
  forgedProgress.semantic.seenEvidenceDigests = []

  const falseSettled = structuredClone(valid.state)
  falseSettled.semantic.classification = "settled"
  falseSettled.semantic.reasonCode = "verified_settlement_observed"

  const coordinatedFalseSettled = structuredClone(valid.state)
  coordinatedFalseSettled.semantic.classification = "settled"
  coordinatedFalseSettled.semantic.reasonCode = "verified_settlement_observed"
  coordinatedFalseSettled.semantic.dimensions.settlement = "settled"
  coordinatedFalseSettled.semantic.incidentKey = null
  coordinatedFalseSettled.semantic.suspectCount = 0

  const falseHuman = structuredClone(valid.state)
  falseHuman.semantic.classification = "human_required"
  falseHuman.semantic.reasonCode = "genuine_human_boundary_observed"
  falseHuman.semantic.incidentKey = incidentKey

  const coordinatedFalseHuman = structuredClone(valid.state)
  coordinatedFalseHuman.semantic.classification = "human_required"
  coordinatedFalseHuman.semantic.reasonCode = "genuine_human_boundary_observed"
  coordinatedFalseHuman.semantic.dimensions.humanBoundary = true
  coordinatedFalseHuman.semantic.suspectCount = 0
  coordinatedFalseHuman.semantic.incidentKey = derivedIncidentKey(
    coordinatedFalseHuman.semantic,
    coordinatedFalseHuman.phase,
  )

  const waitWithoutLease = structuredClone(valid.state)
  waitWithoutLease.semantic.expectedWaitLease = null

  const loopWithoutPattern = structuredClone(valid.state)
  loopWithoutPattern.semantic.classification = "looping"
  loopWithoutPattern.semantic.reasonCode = "repeated_loop_detected"
  loopWithoutPattern.semantic.incidentKey = incidentKey

  const inconsistentIncident = structuredClone(valid.state)
  inconsistentIncident.semantic.incidentKey = incidentKey

  const impossibleLoop = structuredClone(valid.state)
  impossibleLoop.semantic.classification = "looping"
  impossibleLoop.semantic.reasonCode = "repeated_loop_detected"
  impossibleLoop.semantic.expectedWaitLease = null
  impossibleLoop.semantic.fingerprintHistory = ["a".repeat(64), "b".repeat(64)]
  impossibleLoop.semantic.metrics.loopPattern = "repeated"
  impossibleLoop.semantic.observationCount = 2
  impossibleLoop.semantic.suspectCount = 2
  impossibleLoop.semantic.incidentKey = derivedIncidentKey(
    impossibleLoop.semantic,
    impossibleLoop.phase,
  )

  const forgedIncidentKey = structuredClone(coordinatedFalseHuman)
  forgedIncidentKey.state = MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE
  forgedIncidentKey.humanRequired = {
    reasonCode: "authentication_required",
    required: true,
  }
  forgedIncidentKey.semantic.incidentKey = incidentKey

  const mismatchedNewEvidence = structuredClone(valid.state)
  mismatchedNewEvidence.semantic.classification = "progressing"
  mismatchedNewEvidence.semantic.reasonCode = "new_attributable_evidence"
  mismatchedNewEvidence.semantic.seenEvidenceDigests = [evidenceIdentity]
  mismatchedNewEvidence.semantic.usefulProgressLease = {
    evidenceDigest: safeDigest(JSON.stringify([evidenceIdentity])),
    evidenceDigests: [evidenceIdentity],
    expiresAt: "2026-09-04T00:15:00.000Z",
    renewedAt: "2026-09-04T00:00:00.000Z",
  }
  mismatchedNewEvidence.semantic.metrics.qualifyingEvidenceCount = 0
  mismatchedNewEvidence.semantic.metrics.unseenEvidenceCount = 0
  mismatchedNewEvidence.semantic.suspectCount = 0

  const stagnantWithLoopHistory = structuredClone(valid.state)
  stagnantWithLoopHistory.semantic.classification = "stagnant"
  stagnantWithLoopHistory.semantic.reasonCode = "useful_progress_lease_expired"
  stagnantWithLoopHistory.semantic.expectedWaitLease = null
  stagnantWithLoopHistory.semantic.fingerprintHistory = Array(3).fill("a".repeat(64))
  stagnantWithLoopHistory.semantic.metrics.loopPattern = null
  stagnantWithLoopHistory.semantic.observationCount = 3
  stagnantWithLoopHistory.semantic.suspectCount = 2
  stagnantWithLoopHistory.semantic.incidentKey = derivedIncidentKey(
    stagnantWithLoopHistory.semantic,
    stagnantWithLoopHistory.phase,
  )

  const newEvidenceWithLoopHistory = structuredClone(mismatchedNewEvidence)
  newEvidenceWithLoopHistory.semantic.fingerprintHistory = Array(3).fill("a".repeat(64))
  newEvidenceWithLoopHistory.semantic.metrics.loopPattern = "repeated"
  newEvidenceWithLoopHistory.semantic.metrics.qualifyingEvidenceCount = 1
  newEvidenceWithLoopHistory.semantic.metrics.unseenEvidenceCount = 1

  const oneObservationLoop = structuredClone(valid.state)
  oneObservationLoop.semantic.classification = "looping"
  oneObservationLoop.semantic.reasonCode = "repeated_loop_detected"
  oneObservationLoop.semantic.fingerprintHistory = Array(3).fill("a".repeat(64))
  oneObservationLoop.semantic.metrics.loopPattern = "repeated"
  oneObservationLoop.semantic.metrics.noveltyScore = 0.333
  oneObservationLoop.semantic.observationCount = 1
  oneObservationLoop.semantic.suspectCount = 0
  oneObservationLoop.semantic.incidentKey = derivedIncidentKey(
    oneObservationLoop.semantic,
    oneObservationLoop.phase,
  )

  for (const corrupt of [
    forgedProgress,
    falseSettled,
    coordinatedFalseSettled,
    falseHuman,
    coordinatedFalseHuman,
    waitWithoutLease,
    loopWithoutPattern,
    inconsistentIncident,
    impossibleLoop,
    forgedIncidentKey,
    mismatchedNewEvidence,
    stagnantWithLoopHistory,
    newEvidenceWithLoopHistory,
    oneObservationLoop,
  ]) {
    await assert.rejects(
      context.store.writeState(corrupt, context.lease),
      (error) => error.code === "corrupt_monitor_state",
    )
    assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
  }
})

test("semantic incident deduplication is derived only from validated retained incidents", async (t) => {
  const context = await fixture(t)
  context.setObservation({
    available: true,
    conclusivelyDead: false,
    epoch: 7,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: {
      phase: "working",
      status: "running",
      updatedAt: "2026-09-04T00:00:00.000Z",
    },
  })
  await context.engine.tick()
  context.time.wall += 1_000
  context.time.monotonic += 1_000
  await context.createEngine().tick()
  context.time.wall += 1_000
  context.time.monotonic += 1_000
  const loop = await context.createEngine().tick()
  const semanticIncident = loop.state.incidents.at(-1)
  assert.equal(semanticIncident.kind, "semantic")
  const before = await fs.readFile(context.config.paths.state, "utf8")

  const removedIncident = structuredClone(loop.state)
  removedIncident.incidents = removedIncident.incidents.filter((entry) => entry.kind !== "semantic")
  removedIncident.semanticIncidentKeys = [semanticIncident.semanticIncidentKey]

  const orphanKey = structuredClone(loop.state)
  orphanKey.semanticIncidentKeys = ["f".repeat(64)]

  const forgedKey = structuredClone(loop.state)
  forgedKey.incidents.at(-1).semanticIncidentKey = "d".repeat(64)

  const forgedId = structuredClone(loop.state)
  forgedId.incidents.at(-1).id = randomUUID()

  const downgradedOperational = structuredClone(loop.state)
  downgradedOperational.incidents.at(-1).kind = "operational"

  const downgradedLegacy = structuredClone(loop.state)
  delete downgradedLegacy.incidents.at(-1).kind

  const duplicatedIncident = structuredClone(loop.state)
  duplicatedIncident.incidents.push(structuredClone(semanticIncident))

  const operationalLoop = structuredClone(loop.state)
  const operationalIncident = operationalLoop.incidents.at(-1)
  operationalIncident.kind = "operational"
  for (const field of [
    "semanticCheckpointDigest",
    "semanticEvidenceWindow",
    "semanticIncidentKey",
    "semanticReasonCode",
    "semanticState",
    "semanticStepFingerprint",
  ]) delete operationalIncident[field]

  const legacyLoop = structuredClone(operationalLoop)
  delete legacyLoop.incidents.at(-1).kind

  for (const corrupt of [
    removedIncident,
    orphanKey,
    forgedKey,
    forgedId,
    downgradedOperational,
    downgradedLegacy,
    duplicatedIncident,
    operationalLoop,
    legacyLoop,
  ]) {
    await assert.rejects(
      context.store.writeState(corrupt, context.lease),
      (error) => error.code === "corrupt_monitor_state",
    )
    assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
  }
})

test("a genuine PR #20 legacy operational incident without semantic fields still loads", async (t) => {
  const context = await fixture(t)
  const valid = await context.engine.tick()
  const legacy = {
    bindingDigest: "a".repeat(64),
    brokerEpoch: 7,
    humanRequired: false,
    id: randomUUID(),
    monitorEpoch: 1,
    occurredAt: "2026-09-04T00:00:00.000Z",
    phase: null,
    reasonCode: "workflow_progressing",
    recoveryCount: 0,
    runtimeDigest: null,
    state: MonitorState.HEALTHY,
    workflowDigest: safeDigest(WORKFLOW_ID),
  }
  await context.store.writeState({ ...valid.state, incidents: [legacy] }, context.lease)
  const restored = await context.store.readState()
  assert.equal(restored.incidents.length, 1)
  assert.equal(restored.incidents[0].reasonCode, "workflow_progressing")
})

test("unsupported persisted semantic state fails closed before observation or mutation", async (t) => {
  const context = await fixture(t)
  const valid = await context.engine.tick()
  const corrupt = structuredClone(valid.state)
  corrupt.semantic.schema = "EagleSemanticState.v2"
  await fs.writeFile(
    context.config.paths.state,
    `${JSON.stringify(corrupt, null, 2)}\n`,
    { mode: 0o600 },
  )
  const before = await fs.readFile(context.config.paths.state, "utf8")
  context.actions.length = 0

  await assert.rejects(
    context.createEngine().tick(),
    (error) => error.code === "corrupt_monitor_state",
  )
  assert.equal(context.actions.length, 0)
  assert.equal(await fs.readFile(context.config.paths.state, "utf8"), before)
})

test("the atomic state store retains only the newest bounded incidents", async (t) => {
  const context = await fixture(t)
  const incidents = Array.from({ length: 205 }, (_, index) => ({
    bindingDigest: "b".repeat(64),
    brokerEpoch: 7,
    humanRequired: true,
    id: randomUUID(),
    monitorEpoch: context.lease.identity.epoch,
    occurredAt: new Date(context.time.wall + index).toISOString(),
    phase: "stopped",
    reasonCode: `reason_${index}`,
    recoveryCount: index,
    runtimeDigest: "c".repeat(64),
    state: MonitorState.HUMAN_REQUIRED_OTHER,
    workflowDigest: "d".repeat(64),
  }))
  await context.store.writeState({
    incidents,
    schemaVersion: 1,
    state: MonitorState.HUMAN_REQUIRED_OTHER,
    updatedAt: new Date(context.time.wall).toISOString(),
  }, context.lease)

  const state = await context.store.readState()
  assert.equal(state.incidents.length, 200)
  assert.equal(state.incidents[0].reasonCode, "reason_5")
  assert.equal(state.incidents.at(-1).reasonCode, "reason_204")
})
