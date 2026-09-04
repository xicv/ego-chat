import { safeDigest } from "./eagle-monitor-config.mjs"
import {
  EAGLE_MONITOR_SCHEMA_VERSION,
  safeEvidenceCode,
} from "./eagle-monitor-constants.mjs"
import { TERMINAL_STATUSES } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"
import {
  classifyEagleSemanticLiveness,
  projectEagleSemanticCheckpoint,
} from "./eagle-monitor-semantic.mjs"
import {
  assertMonitorActionAllowed,
  chooseMonitorAction,
  classifyMonitorState,
  MonitorAction,
  MonitorState,
  monitorBackoffMs,
} from "./eagle-monitor-policy.mjs"

function defaultState(nowMs) {
  return {
    backoffAttempt: 0,
    backoffKey: null,
    broker: null,
    brokerStarts: [],
    deadSinceAt: null,
    incidents: [],
    lastAction: null,
    lastIncidentKey: null,
    lastTick: null,
    monitorEpoch: null,
    phase: null,
    reconciliation: null,
    recoveryCount: 0,
    schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
    semantic: null,
    state: MonitorState.STARTUP,
    updatedAt: new Date(nowMs).toISOString(),
  }
}

function isActiveWorkflow(classification) {
  return ![
    MonitorState.CRASH_LOOP,
    MonitorState.DISK_FULL,
    MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE,
    MonitorState.HUMAN_REQUIRED_OTHER,
    MonitorState.POWER_SLEEP,
    MonitorState.SETTLED,
    MonitorState.VERSION_SKEW,
  ].includes(classification.state)
}

function detectsWake(previousTick, currentTick, pollIntervalMs) {
  if (!previousTick) return false
  const wallDelta = currentTick.wallMs - previousTick.wallMs
  const monotonicDelta = currentTick.monotonicMs - previousTick.monotonicMs
  return wallDelta - monotonicDelta > pollIntervalMs * 2
}

function safeBrokerEvidence(broker) {
  return {
    available: broker.available === true,
    epoch: broker.epoch ?? null,
    runtimeDigest: safeDigest(broker.runtimeIdentity?.contractDigest),
  }
}

function terminalObservationDigest(broker) {
  const workflow = broker.workflow
  if (!TERMINAL_STATUSES.has(workflow?.status)) return null
  return safeDigest(JSON.stringify({
    brokerEpoch: broker.epoch ?? null,
    phase: workflow.phase ?? null,
    reasonCode: workflow.humanRequired?.code ?? workflow.error?.code ?? null,
    status: workflow.status,
    updatedAt: workflow.updatedAt ?? null,
  }))
}

function unresolvedTerminalClassification() {
  return {
    humanRequired: true,
    reasonCode: "terminal_reconciliation_unresolved",
    state: MonitorState.HUMAN_REQUIRED_OTHER,
  }
}

function semanticProcessHealth(broker) {
  if (broker.available === true) return "healthy"
  return broker.conclusivelyDead === true ? "dead" : "unknown"
}

function semanticTransportHealth(observation) {
  if (observation.broker?.available !== true) return "unknown"
  if (observation.bindingMatches !== true) return "degraded"
  const delivery = observation.workflow?.supervision?.chatGpt?.delivery
  return [
    "child_stopped",
    "child_unavailable",
    "not_confirmed",
    "reconciling_delivery",
    "workflow_stopped",
  ].includes(delivery)
    ? "degraded"
    : "healthy"
}

const GENUINE_HUMAN_BOUNDARY_CODES = new Set([
  "authentication_required",
  "captcha_required",
  "human_verification_required",
  "verification_challenge",
])

function genuineHumanBoundary(classification, workflow) {
  if (classification.state === MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE) return true
  const code = workflow?.humanRequired?.code ?? workflow?.error?.code
  return GENUINE_HUMAN_BOUNDARY_CODES.has(code)
}

export class EagleMonitorEngine {
  #broker
  #clock
  #config
  #lease
  #notifier
  #power
  #storage
  #store

  constructor({ broker, clock, config, lease, notifier, power, storage, store }) {
    this.#broker = broker
    this.#clock = clock
    this.#config = config
    this.#lease = lease
    this.#notifier = notifier
    this.#power = power
    this.#storage = storage
    this.#store = store
  }

  async #recordDispatch(state, action, nowMs) {
    state.lastAction = {
      action,
      at: new Date(nowMs).toISOString(),
      monitorEpoch: this.#lease.identity.epoch,
      outcome: "dispatching",
    }
    await this.#lease.assertCurrent()
    await this.#store.writeState(state, this.#lease)
    await this.#lease.assertCurrent()
  }

  async tick() {
    await this.#lease.assertCurrent()
    const session = await this.#store.readSession()
    if (!session?.active) return { active: false, backoffMs: this.#config.pollIntervalMs }
    const nowMs = this.#clock.wallMs()
    const workflowDigest = safeDigest(session.workflowId)
    let state = await this.#store.readState() ?? defaultState(nowMs)
    if (state.workflowDigest && state.workflowDigest !== workflowDigest) {
      const previousState = state
      state = {
        ...defaultState(nowMs),
        brokerStarts: previousState.brokerStarts ?? [],
        incidents: previousState.incidents ?? [],
      }
    }
    const tickClock = { monotonicMs: this.#clock.monotonicMs(), wallMs: nowMs }
    const [storage, observedPower, broker] = await Promise.all([
      this.#storage.observe(),
      this.#power.observe(),
      this.#broker.observeExact(session.workflowId),
    ])
    const wakeDetected = detectsWake(state.lastTick, tickClock, this.#config.pollIntervalMs)
    const power = { ...observedPower, wakeDetected: observedPower.wakeDetected || wakeDetected }
    const windowStart = nowMs - this.#config.policy.crashLoop.windowMs
    const brokerStarts = (state.brokerStarts ?? []).filter((startedAt) => startedAt >= windowStart)
    const crashLoop = brokerStarts.length >= this.#config.policy.crashLoop.limit

    let deadSinceAt = state.deadSinceAt
    if (broker.available || !broker.conclusivelyDead) {
      deadSinceAt = null
    } else if (!Number.isFinite(deadSinceAt)) {
      deadSinceAt = nowMs
    }
    const deadConfirmed = Number.isFinite(deadSinceAt)
      && nowMs - deadSinceAt >= this.#config.policy.deadConfirmationMs
    const observation = {
      bindingAvailable: typeof session.bindingKey === "string",
      bindingMatches: session.bindingKey === null
        || broker.workflow?.bindingKey === session.bindingKey,
      broker,
      crashLoop,
      deadConfirmed,
      monitorPolicyMatches: session.policyDigest === this.#config.policy.digest,
      nowMs,
      power,
      storage,
      workflow: broker.workflow,
    }
    const terminalDigest = terminalObservationDigest(broker)
    if (state.reconciliation && state.reconciliation.observationDigest !== terminalDigest) {
      state.reconciliation = null
    }
    let classification = state.reconciliation?.observationDigest === terminalDigest
      ? unresolvedTerminalClassification()
      : classifyMonitorState(observation)
    const action = chooseMonitorAction(classification, observation)
    assertMonitorActionAllowed(classification.state, action)

    const semanticCheckpoint = broker.semanticCheckpoint ?? projectEagleSemanticCheckpoint({
      createdAt: session.configuredAt,
      id: session.workflowId,
      ...(broker.workflow ?? {}),
    }, null, broker.workflow?.supervision)
    if (semanticCheckpoint.workflowDigest !== workflowDigest) {
      throw new EgoChatError(
        "invalid_semantic_checkpoint",
        "The semantic checkpoint does not match the exact monitored workflow.",
      )
    }
    const semantic = classifyEagleSemanticLiveness({
      brokerEpoch: broker.epoch ?? null,
      checkpoint: semanticCheckpoint,
      humanRequired: genuineHumanBoundary(classification, broker.workflow),
      nowMs,
      previous: state.semantic,
      processHealth: semanticProcessHealth(broker),
      recoveryActive: broker.workflow?.phase === "codex_recovering" || (
        session.mode === "safe"
        && [
          MonitorAction.RECONCILE_EXACT_WORKFLOW,
          MonitorAction.START_BROKER,
        ].includes(action)
      ),
      settled: classification.state === MonitorState.SETTLED,
      transportHealth: semanticTransportHealth(observation),
    })

    const shouldHoldAwake = session.powerPolicy === "keep-awake-on-ac"
      && power.onAc === true
      && isActiveWorkflow(classification)
    const powerAction = shouldHoldAwake
      ? MonitorAction.HOLD_IDLE_SLEEP_ASSERTION
      : MonitorAction.RELEASE_IDLE_SLEEP_ASSERTION
    assertMonitorActionAllowed(classification.state, powerAction)
    await this.#lease.assertCurrent()
    await this.#power.setIdleSleepAssertion(shouldHoldAwake, this.#lease)

    const incidents = Array.isArray(state.incidents) ? [...state.incidents] : []
    const semanticIncidentKeys = [...new Set(incidents
      .filter((incident) => incident.kind === "semantic")
      .map((incident) => incident.semanticIncidentKey)
      .filter(Boolean))]
    if (session.mode === "safe") {
      try {
        if (action === MonitorAction.START_BROKER) {
          state.recoveryCount = (state.recoveryCount ?? 0) + 1
          brokerStarts.push(nowMs)
          state.brokerStarts = brokerStarts
          await this.#recordDispatch(state, action, nowMs)
          await this.#broker.startBroker(this.#lease)
          state.lastAction.outcome = "succeeded"
        } else if (action === MonitorAction.ATTACH_EXACT_WORKFLOW) {
          await this.#lease.assertCurrent()
          await this.#broker.attachExactWorkflow(session.workflowId, this.#lease)
          state.lastAction = {
            action,
            at: new Date(nowMs).toISOString(),
            monitorEpoch: this.#lease.identity.epoch,
            outcome: "succeeded",
          }
        } else if (action === MonitorAction.RECONCILE_EXACT_WORKFLOW) {
          state.recoveryCount = (state.recoveryCount ?? 0) + 1
          await this.#recordDispatch(state, action, nowMs)
          const reconciliation = await this.#broker.reconcileExactWorkflow(
            session.bindingKey,
            session.workflowId,
            this.#lease,
          )
          if (
            reconciliation?.observationOnly !== true
            || !TERMINAL_STATUSES.has(reconciliation.status)
            || reconciliation.workflowId !== session.workflowId
          ) {
            throw new Error("invalid_monitor_reconciliation_result")
          }
          state.reconciliation = {
            observationDigest: terminalDigest,
            observedAt: new Date(nowMs).toISOString(),
            phase: safeEvidenceCode(reconciliation.phase),
            status: reconciliation.status,
          }
          state.lastAction.outcome = "terminal_observed"
          classification = unresolvedTerminalClassification()
          const incidentKey = `${classification.state}:${classification.reasonCode}`
          if (classification.humanRequired && state.lastIncidentKey !== incidentKey) {
            await this.#lease.assertCurrent()
            await this.#notifier.notify(classification, this.#lease).catch(() => {})
          }
        } else if (action === MonitorAction.NOTIFY_USER) {
          const incidentKey = `${classification.state}:${classification.reasonCode}`
          if (state.lastIncidentKey !== incidentKey) {
            await this.#lease.assertCurrent()
            await this.#notifier.notify(classification, this.#lease)
          }
          state.lastAction = {
            action,
            at: new Date(nowMs).toISOString(),
            monitorEpoch: this.#lease.identity.epoch,
            outcome: state.lastIncidentKey === incidentKey ? "already_reported" : "succeeded",
          }
        }
      } catch (_error) {
        const failedAction = action
        classification = {
          humanRequired: true,
          reasonCode: `${failedAction}_failed`,
          state: MonitorState.HUMAN_REQUIRED_OTHER,
        }
        state.lastAction = {
          action: failedAction,
          at: new Date(nowMs).toISOString(),
          monitorEpoch: this.#lease.identity.epoch,
          outcome: "failed",
        }
        if (failedAction !== MonitorAction.NOTIFY_USER) {
          await this.#lease.assertCurrent()
          await this.#notifier.notify(classification, this.#lease).catch(() => {})
        }
      }
    } else {
      state.lastAction = {
        action,
        at: new Date(nowMs).toISOString(),
        monitorEpoch: this.#lease.identity.epoch,
        outcome: "predicted_shadow_only",
      }
    }

    const incidentKey = `${classification.state}:${classification.reasonCode}`
    if (
      state.lastIncidentKey !== incidentKey
      && ![MonitorState.HEALTHY, MonitorState.SETTLED].includes(classification.state)
    ) {
      incidents.push(this.#store.createIncident({
        classification,
        monitorEpoch: this.#lease.identity.epoch,
        observation,
        recoveryCount: state.recoveryCount ?? 0,
        semantic,
        session,
      }))
      state.lastIncidentKey = incidentKey
    } else if ([MonitorState.HEALTHY, MonitorState.SETTLED].includes(classification.state)) {
      state.lastIncidentKey = null
    }
    if (
      [MonitorState.HEALTHY, MonitorState.SEND_CONFIRMED_CAPTURE].includes(classification.state)
      && ["looping", "stagnant", "suspect"].includes(semantic.classification)
    ) {
      if (!semanticIncidentKeys.includes(semantic.incidentKey)) {
        incidents.push(this.#store.createSemanticIncident({
          classification,
          monitorEpoch: this.#lease.identity.epoch,
          observation,
          recoveryCount: state.recoveryCount ?? 0,
          semantic,
          session,
        }))
        semanticIncidentKeys.push(semantic.incidentKey)
      }
    }

    const backoffKey = safeDigest(JSON.stringify({
      brokerEpoch: broker.epoch ?? null,
      phase: safeEvidenceCode(broker.workflow?.phase),
      reasonCode: classification.reasonCode,
      state: classification.state,
      supervisedChildPhase: safeEvidenceCode(broker.workflow?.supervision?.chatGpt?.childPhase),
      supervisedDelivery: safeEvidenceCode(broker.workflow?.supervision?.chatGpt?.delivery),
      supervisedLastTransitionAt: broker.workflow?.supervision?.lastTransitionAt ?? null,
      workflowUpdatedAt: broker.workflow?.updatedAt ?? null,
    }))
    const backoffAttempt = state.backoffKey === backoffKey
      ? (state.backoffAttempt ?? 0) + 1
      : 0
    const backoffMs = monitorBackoffMs(classification.state, backoffAttempt)
    state = {
      ...state,
      backoffAttempt,
      backoffKey,
      broker: safeBrokerEvidence(broker),
      brokerStarts,
      deadSinceAt,
      humanRequired: {
        reasonCode: classification.reasonCode,
        required: classification.humanRequired,
      },
      incidents,
      lastTick: tickClock,
      monitorEpoch: this.#lease.identity.epoch,
      nextObservationAt: new Date(nowMs + backoffMs).toISOString(),
      phase: safeEvidenceCode(broker.workflow?.phase),
      reconciliation: state.reconciliation ?? null,
      recoveryCount: state.recoveryCount ?? 0,
      semantic,
      state: classification.state,
      updatedAt: new Date(nowMs).toISOString(),
      workflowDigest,
    }
    await this.#lease.assertCurrent()
    await this.#store.writeState(state, this.#lease)
    return { active: true, backoffMs, classification, state }
  }
}
