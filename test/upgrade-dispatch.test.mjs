import assert from "node:assert/strict"
import test from "node:test"

import { createUpgradeAwareDispatch } from "../src/upgrade-dispatch.mjs"

const broker = {
  brokerId: "broker-one",
  epoch: 7,
  pid: 123,
  runtimeIdentity: { appVersion: "0.2.2" },
  socketPath: "/tmp/egc-upgrade-test.sock",
}
const targetRuntime = { appVersion: "0.2.3" }

function idleStatus() {
  return {
    activeBindings: [],
    broker,
    driverMailbox: { files: 0, reservations: 0 },
    runningWorkflows: [],
  }
}

function prepareParams() {
  return { expectedBroker: broker, targetRuntime }
}

test("upgrade preparation closes mutation admission before waiting for admitted work", async () => {
  let releaseMutation
  let accepted = false
  const mutationBarrier = new Promise((resolve) => {
    releaseMutation = resolve
  })
  const gated = createUpgradeAwareDispatch({
    dispatch: async (method) => {
      if (method === "test.mutate") await mutationBarrier
      return { method }
    },
    getStatus: idleStatus,
    onUpgradeAccepted: () => {
      accepted = true
    },
    runtimeIdentity: broker.runtimeIdentity,
  })

  const mutation = gated("test.mutate", {}, undefined)
  await Promise.resolve()
  const preparation = gated("broker.prepare_upgrade", prepareParams(), undefined)
  await Promise.resolve()

  await assert.rejects(
    gated("test.second_mutation", {}, undefined),
    (error) => error.code === "broker_draining",
  )
  releaseMutation()
  await mutation
  const result = await preparation

  assert.equal(result.status, "accepted")
  assert.equal(accepted, true)
  await assert.rejects(
    gated("test.after_acceptance", {}, undefined),
    (error) => error.code === "broker_draining",
  )
})

test("a rejected upgrade preparation reopens mutation admission", async () => {
  const gated = createUpgradeAwareDispatch({
    dispatch: async (method) => ({ method }),
    getStatus: () => ({
      ...idleStatus(),
      runningWorkflows: [{ id: "active", kind: "ego_exchange" }],
    }),
    onUpgradeAccepted: () => assert.fail("active work must not be accepted"),
    runtimeIdentity: broker.runtimeIdentity,
  })

  await assert.rejects(
    gated("broker.prepare_upgrade", prepareParams(), undefined),
    (error) => error.code === "upgrade_blocked_active_work",
  )
  assert.deepEqual(await gated("test.mutate", {}, undefined), { method: "test.mutate" })
})

test("upgrade preparation rejects a changed broker identity", async () => {
  const gated = createUpgradeAwareDispatch({
    dispatch: async () => ({}),
    getStatus: idleStatus,
    onUpgradeAccepted: () => assert.fail("changed identity must not be accepted"),
    runtimeIdentity: broker.runtimeIdentity,
  })

  await assert.rejects(
    gated("broker.prepare_upgrade", {
      ...prepareParams(),
      expectedBroker: { ...broker, epoch: broker.epoch + 1 },
    }, undefined),
    (error) => error.code === "broker_handoff_identity_changed",
  )
})
