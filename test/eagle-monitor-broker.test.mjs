import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { acquireBrokerLease, inspectBrokerLease } from "../src/broker-lease.mjs"
import {
  EAGLE_MONITOR_BROKER_METHODS,
  EagleMonitorBrokerAdapter,
} from "../src/eagle-monitor-broker.mjs"
import { READ_ONLY_IPC_METHODS, RUNTIME_IDENTITY } from "../src/constants.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { requestBroker } from "../src/ipc-client.mjs"

const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001"

test("the broker adapter is limited to status, exact-workflow attachment, and reconciliation", async () => {
  const brokerConfig = { dataDir: "/private/test/ego-chat" }
  const calls = []
  const request = async (config, method, params, options) => {
    calls.push({ config, method, options, params })
    if (method === EAGLE_MONITOR_BROKER_METHODS.OBSERVE_BROKER) {
      return {
        broker: { epoch: 7, runtimeIdentity: RUNTIME_IDENTITY },
        runningWorkflows: [{
          id: WORKFLOW_ID,
          supervision: {
            chatGpt: { delivery: "sent_waiting_response" },
            lastTransitionAt: "2026-09-04T00:00:00.000Z",
          },
        }],
      }
    }
    if (method === EAGLE_MONITOR_BROKER_METHODS.ATTACH) {
      const error = new Error("still running")
      error.code = "wait_timeout"
      throw error
    }
    return { id: WORKFLOW_ID, phase: "send_confirmed", status: "running" }
  }
  const adapter = new EagleMonitorBrokerAdapter(brokerConfig, {
    inspectLease: async () => ({
      conclusivelyDead: true,
      runtimeIdentity: RUNTIME_IDENTITY,
    }),
    request,
  })
  const dispatchFence = { assertCurrent: async () => {} }

  const observed = await adapter.observeExact(WORKFLOW_ID)
  assert.equal(observed.available, true)
  assert.equal(observed.workflow.id, WORKFLOW_ID)
  assert.equal(observed.workflow.supervision.chatGpt.delivery, "sent_waiting_response")
  await adapter.startBroker(dispatchFence)
  await adapter.attachExactWorkflow(WORKFLOW_ID, dispatchFence)
  await adapter.reconcileExactWorkflow("ego-chat-main", WORKFLOW_ID, dispatchFence)

  assert.deepEqual(calls.map(({ method }) => method), [
    "broker.status",
    "workflow.get",
    "broker.status",
    "workflow.await",
    "workflow.get",
    "workflow.reconcile_observation",
  ])
  assert.deepEqual(calls[1].params, { workflowId: WORKFLOW_ID })
  assert.equal(calls[1].options.autostart, false)
  assert.equal(calls[2].options.autostart, undefined)
  assert.equal(calls[2].options.legacyFallback, false)
  assert.deepEqual(calls[3].params, { timeoutMs: 1, workflowId: WORKFLOW_ID })
  assert.deepEqual(calls[5].params, {
    bindingKey: "ego-chat-main",
    workflowId: WORKFLOW_ID,
  })

  const methods = new Set(Object.values(EAGLE_MONITOR_BROKER_METHODS))
  for (const method of methods) {
    assert.equal(READ_ONLY_IPC_METHODS.has(method), true, method)
  }
  for (const forbidden of [
    "conversation.reconcile",
    "conversation.start_adoption",
    "conversation.reanchor",
    "convergence.start",
    "ego.start_exchange",
    "model_policy.ensure",
    "workflow.abandon",
    "workflow.cancel",
    "workflow.start_probe",
  ]) {
    assert.equal(methods.has(forbidden), false)
  }
})

test("broker autostart rechecks the monitor fence at the daemon-spawn boundary", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-autostart-fence-"))
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const expected = new EgoChatError(
    "monitor_lease_lost",
    "Injected fence loss immediately before broker autostart.",
  )
  let boundaryChecks = 0

  await assert.rejects(
    requestBroker({
      dataDir,
      legacySocketPaths: [],
      socketPath: path.join(os.tmpdir(), `egc-eagle-autostart-${process.pid}.sock`),
    }, "broker.status", {}, {
      beforeAutostart: async () => {
        boundaryChecks += 1
        throw expected
      },
      legacyFallback: false,
    }),
    (error) => error === expected,
  )
  assert.equal(boundaryChecks, 1)
  await assert.rejects(fs.lstat(path.join(dataDir, "broker.lock")), { code: "ENOENT" })
})

test("broker autostart re-proves canonical lease death at the daemon-spawn boundary", async () => {
  const brokerConfig = { dataDir: "/private/test/ego-chat" }
  const fence = { assertCurrent: async () => {} }
  let inspections = 0
  let requests = 0
  const adapter = new EagleMonitorBrokerAdapter(brokerConfig, {
    inspectLease: async (dataDir) => {
      assert.equal(dataDir, brokerConfig.dataDir)
      inspections += 1
      return {
        conclusivelyDead: inspections === 1,
        runtimeIdentity: RUNTIME_IDENTITY,
      }
    },
    request: async (_config, method, _params, options) => {
      requests += 1
      assert.equal(method, EAGLE_MONITOR_BROKER_METHODS.START)
      await options.beforeAutostart()
      return { broker: { epoch: 9, runtimeIdentity: RUNTIME_IDENTITY } }
    },
  })

  await assert.rejects(
    adapter.startBroker(fence),
    (error) => error.code === "broker_liveness_ambiguous",
  )
  assert.equal(inspections, 2)
  assert.equal(requests, 1)
})

test("the canonical broker lease prevents duplicate authoritative startup", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-broker-start-"))
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const socketPath = path.join(os.tmpdir(), `egc-eagle-start-${process.pid}.sock`)
  const first = await acquireBrokerLease({
    dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })
  t.after(() => first.release().catch(() => {}))

  await assert.rejects(
    acquireBrokerLease({ dataDir, runtimeIdentity: RUNTIME_IDENTITY, socketPath }),
    (error) => error.code === "broker_already_running"
      && error.details.brokerId === first.identity.brokerId
      && error.details.epoch === first.identity.epoch,
  )
})

test("connection failure checks the same canonical broker lease without autostart", async () => {
  const brokerConfig = { dataDir: "/private/test/ego-chat" }
  const calls = []
  const adapter = new EagleMonitorBrokerAdapter(brokerConfig, {
    inspectLease: async (dataDir) => {
      assert.equal(dataDir, brokerConfig.dataDir)
      return {
        conclusivelyDead: true,
        epoch: 8,
        runtimeIdentity: RUNTIME_IDENTITY,
      }
    },
    request: async (_config, method, _params, options) => {
      calls.push({ method, options })
      const error = new Error("unavailable")
      error.code = "ECONNREFUSED"
      throw error
    },
  })

  const observed = await adapter.observeExact(WORKFLOW_ID)
  assert.deepEqual(observed, {
    available: false,
    conclusivelyDead: true,
    epoch: 8,
    runtimeIdentity: RUNTIME_IDENTITY,
    workflow: null,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, "broker.status")
  assert.equal(calls[0].options.autostart, false)
})

test("an incomplete canonical broker claim never becomes dead-broker proof", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-broker-lease-"))
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(
    path.join(dataDir, "broker.lock"),
    `${JSON.stringify({ brokerId: "incomplete" })}\n`,
    { mode: 0o600 },
  )

  await assert.rejects(
    inspectBrokerLease(dataDir),
    (error) => error.code === "corrupt_broker_lease",
  )
})
