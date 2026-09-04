import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { RUNTIME_IDENTITY } from "../src/constants.mjs"
import { loadEagleMonitorConfig, safeDigest } from "../src/eagle-monitor-config.mjs"
import { EagleMonitorEngine } from "../src/eagle-monitor-engine.mjs"
import { acquireMonitorLease } from "../src/eagle-monitor-lease.mjs"
import { MonitorAction, MonitorState } from "../src/eagle-monitor-policy.mjs"
import { createPowerController } from "../src/eagle-monitor-runtime.mjs"
import { EagleMonitorStore } from "../src/eagle-monitor-store.mjs"

const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001"

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
