import { READ_ONLY_IPC_METHODS } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"

const UPGRADE_METHOD = "broker.prepare_upgrade"

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertBrokerIdentity(expected, actual) {
  if (
    !expected
    || typeof expected !== "object"
    || Array.isArray(expected)
    || typeof expected.brokerId !== "string"
    || !Number.isSafeInteger(expected.epoch)
    || !Number.isSafeInteger(expected.pid)
    || typeof expected.socketPath !== "string"
    || !expected.runtimeIdentity
    || typeof expected.runtimeIdentity !== "object"
    || Array.isArray(expected.runtimeIdentity)
    || !sameValue(expected, actual)
  ) {
    throw new EgoChatError(
      "broker_handoff_identity_changed",
      "The authoritative broker identity changed before it could enter upgrade drain mode.",
    )
  }
}

function assertTargetRuntime(targetRuntime, runtimeIdentity) {
  const targetKeys = targetRuntime && typeof targetRuntime === "object" && !Array.isArray(targetRuntime)
    ? Object.keys(targetRuntime).sort()
    : []
  const runtimeKeys = Object.keys(runtimeIdentity).sort()
  if (
    !targetRuntime
    || typeof targetRuntime !== "object"
    || Array.isArray(targetRuntime)
    || !sameValue(targetKeys, runtimeKeys)
    || runtimeKeys.some((key) => typeof targetRuntime[key] !== typeof runtimeIdentity[key])
    || sameValue(targetRuntime, runtimeIdentity)
  ) {
    throw new EgoChatError(
      "invalid_upgrade_target",
      "The requested upgrade target must identify a different complete Ego Chat runtime.",
    )
  }
}

function assertIdle(status) {
  if (
    !status
    || !Array.isArray(status.activeBindings)
    || !Array.isArray(status.runningWorkflows)
    || !status.driverMailbox
    || typeof status.driverMailbox !== "object"
    || !Number.isSafeInteger(status.driverMailbox.files)
    || status.driverMailbox.files < 0
    || !Number.isSafeInteger(status.driverMailbox.reservations)
    || status.driverMailbox.reservations < 0
  ) {
    throw new EgoChatError(
      "invalid_broker_status",
      "The authoritative broker returned incomplete evidence while entering upgrade drain mode.",
    )
  }
  if (
    status.activeBindings.length > 0
    || status.runningWorkflows.length > 0
    || status.driverMailbox.files > 0
    || status.driverMailbox.reservations > 0
  ) {
    throw new EgoChatError(
      "upgrade_blocked_active_work",
      "The authoritative broker still owns active work; leave it running and retry setup after every workflow stops.",
      {
        activeBindingCount: status.activeBindings.length,
        mailboxFileCount: status.driverMailbox.files,
        mailboxReservationCount: status.driverMailbox.reservations,
        runningWorkflowCount: status.runningWorkflows.length,
      },
    )
  }
}

export function createUpgradeAwareDispatch({
  dispatch,
  getStatus,
  onUpgradeAccepted,
  runtimeIdentity,
}) {
  let activeMutations = 0
  let draining = false
  let mutationWaiters = []

  const releaseMutationWaiters = () => {
    if (activeMutations !== 0) return
    const waiters = mutationWaiters
    mutationWaiters = []
    for (const resolve of waiters) resolve()
  }

  const waitForAdmittedMutations = () => activeMutations === 0
    ? Promise.resolve()
    : new Promise((resolve) => mutationWaiters.push(resolve))

  return async (method, params, signal) => {
    if (method === UPGRADE_METHOD) {
      if (draining) {
        throw new EgoChatError(
          "broker_draining",
          "The authoritative broker is already draining for a runtime upgrade.",
        )
      }

      draining = true
      let accepted = false
      try {
        assertTargetRuntime(params?.targetRuntime, runtimeIdentity)
        await waitForAdmittedMutations()
        const status = await getStatus()
        assertBrokerIdentity(params?.expectedBroker, status?.broker)
        assertIdle(status)
        const result = {
          broker: status.broker,
          status: "accepted",
          targetRuntime: params.targetRuntime,
        }
        await onUpgradeAccepted(result)
        accepted = true
        return result
      } finally {
        if (!accepted) draining = false
      }
    }

    const mutation = !READ_ONLY_IPC_METHODS.has(method)
    if (mutation) {
      if (draining) {
        throw new EgoChatError(
          "broker_draining",
          "The authoritative broker is draining for a runtime upgrade and cannot admit new durable work.",
        )
      }
      activeMutations += 1
    }

    try {
      return await dispatch(method, params, signal)
    } finally {
      if (mutation) {
        activeMutations -= 1
        releaseMutationWaiters()
      }
    }
  }
}
