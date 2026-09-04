import { inspectBrokerLease } from "./broker-lease.mjs"
import { RUNTIME_IDENTITY } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"
import { requestBroker } from "./ipc-client.mjs"

const CONNECTION_ERRORS = new Set(["ECONNREFUSED", "ENOENT", "ipc_timeout"])

async function assertDispatchFence(dispatchFence) {
  if (!dispatchFence || typeof dispatchFence.assertCurrent !== "function") {
    throw new EgoChatError(
      "monitor_dispatch_unfenced",
      "Eagle Monitor recovery dispatch requires the current monitor lease.",
    )
  }
  return dispatchFence.assertCurrent()
}

export const EAGLE_MONITOR_BROKER_METHODS = Object.freeze({
  ATTACH: "workflow.await",
  FALLBACK_GET: "workflow.get",
  OBSERVE_BROKER: "broker.status",
  OBSERVE_WORKFLOW: "workflow.get",
  RECONCILE: "workflow.reconcile_observation",
  START: "broker.status",
})

export class EagleMonitorBrokerAdapter {
  #config
  #inspectLease
  #request

  constructor(brokerConfig, {
    inspectLease = inspectBrokerLease,
    request = requestBroker,
  } = {}) {
    this.#config = brokerConfig
    this.#inspectLease = inspectLease
    this.#request = request
  }

  async #assertBrokerStartAllowed(dispatchFence) {
    await assertDispatchFence(dispatchFence)
    const ownership = await this.#inspectLease(this.#config.dataDir)
    if (ownership.conclusivelyDead !== true) {
      throw new EgoChatError(
        "broker_liveness_ambiguous",
        "The canonical Ego Chat broker lease no longer proves the broker dead.",
      )
    }
    if (
      ownership.runtimeIdentity !== null
      && ownership.runtimeIdentity !== undefined
      && JSON.stringify(ownership.runtimeIdentity) !== JSON.stringify(RUNTIME_IDENTITY)
    ) {
      throw new EgoChatError(
        "broker_runtime_version_skew",
        "The retained canonical broker lease belongs to an incompatible runtime.",
      )
    }
  }

  async observeExact(workflowId) {
    try {
      const status = await this.#request(
        this.#config,
        EAGLE_MONITOR_BROKER_METHODS.OBSERVE_BROKER,
        {},
        { autostart: false, timeoutMs: 2_000 },
      )
      let workflow = null
      try {
        workflow = await this.#request(
          this.#config,
          EAGLE_MONITOR_BROKER_METHODS.OBSERVE_WORKFLOW,
          { workflowId },
          { autostart: false, timeoutMs: 2_000 },
        )
      } catch (error) {
        if (error.code !== "workflow_not_found") throw error
      }
      const running = status.runningWorkflows?.find((candidate) => candidate.id === workflowId)
      if (workflow && running?.supervision) {
        workflow = { ...workflow, supervision: running.supervision }
      }
      return {
        available: true,
        conclusivelyDead: false,
        epoch: status.broker.epoch,
        runtimeIdentity: status.broker.runtimeIdentity,
        workflow,
      }
    } catch (error) {
      if (!CONNECTION_ERRORS.has(error.code)) throw error
      const ownership = await this.#inspectLease(this.#config.dataDir)
      return {
        available: false,
        conclusivelyDead: ownership.conclusivelyDead,
        epoch: ownership.epoch,
        runtimeIdentity: ownership.runtimeIdentity,
        workflow: null,
      }
    }
  }

  async startBroker(dispatchFence) {
    await this.#assertBrokerStartAllowed(dispatchFence)
    return this.#request(
      this.#config,
      EAGLE_MONITOR_BROKER_METHODS.START,
      {},
      {
        beforeAutostart: () => this.#assertBrokerStartAllowed(dispatchFence),
        legacyFallback: false,
        timeoutMs: 10_000,
      },
    )
  }

  async attachExactWorkflow(workflowId, dispatchFence) {
    await assertDispatchFence(dispatchFence)
    try {
      return await this.#request(
        this.#config,
        EAGLE_MONITOR_BROKER_METHODS.ATTACH,
        { timeoutMs: 1, workflowId },
        { autostart: false, timeoutMs: 2_000 },
      )
    } catch (error) {
      if (error.code !== "wait_timeout") throw error
      return this.#request(
        this.#config,
        EAGLE_MONITOR_BROKER_METHODS.FALLBACK_GET,
        { workflowId },
        { autostart: false, timeoutMs: 2_000 },
      )
    }
  }

  async reconcileExactWorkflow(bindingKey, workflowId, dispatchFence) {
    await assertDispatchFence(dispatchFence)
    return this.#request(
      this.#config,
      EAGLE_MONITOR_BROKER_METHODS.RECONCILE,
      { bindingKey, workflowId },
      { autostart: false, timeoutMs: 65_000 },
    )
  }
}
