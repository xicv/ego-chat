import { randomUUID } from "node:crypto"

import {
  EAGLE_MONITOR_INCIDENT_LIMIT,
  EAGLE_MONITOR_MODES,
  EAGLE_MONITOR_POLICY,
  EAGLE_MONITOR_POWER_POLICIES,
  EAGLE_MONITOR_SCHEMA_VERSION,
  safeEvidenceCode,
} from "./eagle-monitor-constants.mjs"
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removeFileIfPresent,
  writeAtomicJson,
} from "./eagle-monitor-fs.mjs"
import { safeDigest } from "./eagle-monitor-config.mjs"
import { MonitorAction, MonitorState } from "./eagle-monitor-policy.mjs"
import { EgoChatError } from "./errors.mjs"

const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BINDING_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SESSION_KEYS = new Set([
  "active",
  "bindingKey",
  "configuredAt",
  "launchAgentDigest",
  "mode",
  "policyDigest",
  "powerPolicy",
  "schemaVersion",
  "stoppedAt",
  "workflowId",
])
const STATE_KEYS = new Set([
  "backoffAttempt",
  "backoffKey",
  "broker",
  "brokerStarts",
  "deadSinceAt",
  "humanRequired",
  "incidents",
  "lastAction",
  "lastIncidentKey",
  "lastTick",
  "monitorEpoch",
  "nextObservationAt",
  "phase",
  "reconciliation",
  "recoveryCount",
  "schemaVersion",
  "state",
  "updatedAt",
  "workflowDigest",
])

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function failCorrupt(message) {
  throw new EgoChatError("corrupt_monitor_state", message)
}

function assertKeys(value, allowed, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    failCorrupt(`${label} contains an unsupported field or value.`)
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function validNullableString(value, maximum = 200) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= maximum)
}

function validNullableEvidenceCode(value) {
  return value === null || safeEvidenceCode(value) === value
}

function validNullableInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function assertSession(value) {
  assertKeys(value, SESSION_KEYS, "The Eagle Monitor session")
  if (
    value.schemaVersion !== EAGLE_MONITOR_SCHEMA_VERSION
    || typeof value.active !== "boolean"
    || !(value.bindingKey === null || BINDING_PATTERN.test(value.bindingKey ?? ""))
    || !validTimestamp(value.configuredAt)
    || !DIGEST_PATTERN.test(value.launchAgentDigest ?? "")
    || !EAGLE_MONITOR_MODES.includes(value.mode)
    || !DIGEST_PATTERN.test(value.policyDigest ?? "")
    || !EAGLE_MONITOR_POWER_POLICIES.includes(value.powerPolicy)
    || !(value.stoppedAt === null || validTimestamp(value.stoppedAt))
    || !UUID_PATTERN.test(value.workflowId ?? "")
  ) {
    failCorrupt("The Eagle Monitor session has an invalid value.")
  }
  return value
}

function assertIncident(value) {
  const allowed = new Set([
    "bindingDigest",
    "brokerEpoch",
    "humanRequired",
    "id",
    "monitorEpoch",
    "occurredAt",
    "phase",
    "reasonCode",
    "recoveryCount",
    "runtimeDigest",
    "state",
    "workflowDigest",
  ])
  assertKeys(value, allowed, "An Eagle Monitor incident")
  if (
    !(value.bindingDigest === null || DIGEST_PATTERN.test(value.bindingDigest ?? ""))
    || !validNullableInteger(value.brokerEpoch)
    || typeof value.humanRequired !== "boolean"
    || !UUID_PATTERN.test(value.id ?? "")
    || !Number.isSafeInteger(value.monitorEpoch)
    || value.monitorEpoch < 1
    || !validTimestamp(value.occurredAt)
    || !validNullableEvidenceCode(value.phase)
    || !validNullableEvidenceCode(value.reasonCode)
    || !Number.isSafeInteger(value.recoveryCount)
    || value.recoveryCount < 0
    || !(value.runtimeDigest === null || DIGEST_PATTERN.test(value.runtimeDigest ?? ""))
    || !Object.values(MonitorState).includes(value.state)
    || !DIGEST_PATTERN.test(value.workflowDigest ?? "")
  ) {
    failCorrupt("An Eagle Monitor incident has an invalid value.")
  }
  return value
}

function assertState(value) {
  assertKeys(value, STATE_KEYS, "The Eagle Monitor state")
  if (value.schemaVersion !== EAGLE_MONITOR_SCHEMA_VERSION) {
    failCorrupt("The Eagle Monitor state has an unsupported or missing schema version.")
  }
  if (
    value.backoffAttempt !== undefined
    && (!Number.isSafeInteger(value.backoffAttempt) || value.backoffAttempt < 0)
  ) failCorrupt("The monitor backoff attempt is invalid.")
  if (
    value.backoffKey !== undefined
    && !(value.backoffKey === null || DIGEST_PATTERN.test(value.backoffKey ?? ""))
  ) failCorrupt("The monitor backoff key is invalid.")
  if (value.broker !== undefined && value.broker !== null) {
    assertKeys(value.broker, new Set(["available", "epoch", "runtimeDigest"]), "Broker evidence")
    if (
      typeof value.broker.available !== "boolean"
      || !validNullableInteger(value.broker.epoch)
      || !(value.broker.runtimeDigest === null || DIGEST_PATTERN.test(value.broker.runtimeDigest ?? ""))
    ) failCorrupt("Broker evidence has an invalid value.")
  }
  if (
    value.brokerStarts !== undefined
    && (!Array.isArray(value.brokerStarts) || value.brokerStarts.some((entry) => (
      !Number.isSafeInteger(entry) || entry < 0
    )) || value.brokerStarts.length > EAGLE_MONITOR_POLICY.crashLoop.limit)
  ) failCorrupt("The broker-start history is invalid.")
  if (value.deadSinceAt !== undefined && !validNullableInteger(value.deadSinceAt)) {
    failCorrupt("The dead-broker timestamp is invalid.")
  }
  if (value.humanRequired !== undefined) {
    assertKeys(value.humanRequired, new Set(["reasonCode", "required"]), "Human-action evidence")
    if (
      typeof value.humanRequired.required !== "boolean"
      || !validNullableEvidenceCode(value.humanRequired.reasonCode)
    ) failCorrupt("Human-action evidence has an invalid value.")
  }
  if (
    !Array.isArray(value.incidents)
    || value.incidents.length > EAGLE_MONITOR_INCIDENT_LIMIT
  ) failCorrupt("The incident history is invalid.")
  value.incidents.forEach(assertIncident)
  if (value.lastAction !== undefined && value.lastAction !== null) {
    assertKeys(
      value.lastAction,
      new Set(["action", "at", "monitorEpoch", "outcome"]),
      "The last monitor action",
    )
    if (
      !Object.values(MonitorAction).includes(value.lastAction.action)
      || !validTimestamp(value.lastAction.at)
      || !Number.isSafeInteger(value.lastAction.monitorEpoch)
      || value.lastAction.monitorEpoch < 1
      || ![
        "already_reported",
        "dispatching",
        "failed",
        "predicted_shadow_only",
        "succeeded",
        "terminal_observed",
      ]
        .includes(value.lastAction.outcome)
    ) failCorrupt("The last monitor action has an invalid value.")
  }
  if (value.lastIncidentKey !== undefined && !validNullableString(value.lastIncidentKey, 400)) {
    failCorrupt("The incident key is invalid.")
  }
  if (value.lastTick !== undefined && value.lastTick !== null) {
    assertKeys(value.lastTick, new Set(["monotonicMs", "wallMs"]), "The last monitor clock")
    if (
      !Number.isFinite(value.lastTick.monotonicMs)
      || value.lastTick.monotonicMs < 0
      || !Number.isSafeInteger(value.lastTick.wallMs)
      || value.lastTick.wallMs < 0
    ) failCorrupt("The last monitor clock has an invalid value.")
  }
  if (value.monitorEpoch !== undefined && !validNullableInteger(value.monitorEpoch)) {
    failCorrupt("The monitor epoch is invalid.")
  }
  if (
    value.nextObservationAt !== undefined
    && !(value.nextObservationAt === null || validTimestamp(value.nextObservationAt))
  ) failCorrupt("The next-observation timestamp is invalid.")
  if (value.phase !== undefined && !validNullableEvidenceCode(value.phase)) {
    failCorrupt("The workflow phase is invalid.")
  }
  if (value.reconciliation !== undefined && value.reconciliation !== null) {
    assertKeys(
      value.reconciliation,
      new Set(["observationDigest", "observedAt", "phase", "status"]),
      "Terminal reconciliation evidence",
    )
    if (
      !DIGEST_PATTERN.test(value.reconciliation.observationDigest ?? "")
      || !validTimestamp(value.reconciliation.observedAt)
      || !validNullableEvidenceCode(value.reconciliation.phase)
      || !["cancelled", "failed", "human_required", "succeeded"]
        .includes(value.reconciliation.status)
    ) failCorrupt("Terminal reconciliation evidence has an invalid value.")
  }
  if (
    value.recoveryCount !== undefined
    && (!Number.isSafeInteger(value.recoveryCount) || value.recoveryCount < 0)
  ) failCorrupt("The recovery count is invalid.")
  if (
    value.state !== undefined
    && ![...Object.values(MonitorState), "stopped"].includes(value.state)
  ) failCorrupt("The monitor state is invalid.")
  if (value.updatedAt !== undefined && !validTimestamp(value.updatedAt)) {
    failCorrupt("The state timestamp is invalid.")
  }
  if (
    value.workflowDigest !== undefined
    && !(value.workflowDigest === null || DIGEST_PATTERN.test(value.workflowDigest ?? ""))
  ) failCorrupt("The workflow digest is invalid.")
  return value
}

function assertSchema(value, label) {
  if (!value || value.schemaVersion !== EAGLE_MONITOR_SCHEMA_VERSION) {
    throw new EgoChatError(
      "corrupt_monitor_state",
      `${label} has an unsupported or missing schema version.`,
    )
  }
  return value
}

function publicSession(session) {
  if (!session) return null
  return {
    active: session.active === true,
    bindingDigest: safeDigest(session.bindingKey),
    configuredAt: session.configuredAt,
    mode: session.mode,
    policyDigest: session.policyDigest,
    powerPolicy: session.powerPolicy,
    stoppedAt: session.stoppedAt ?? null,
    workflowDigest: safeDigest(session.workflowId),
  }
}

function safeIncident(incident) {
  return {
    bindingDigest: incident.bindingDigest ?? null,
    brokerEpoch: incident.brokerEpoch ?? null,
    humanRequired: incident.humanRequired === true,
    id: incident.id,
    monitorEpoch: incident.monitorEpoch,
    occurredAt: incident.occurredAt,
    phase: incident.phase ?? null,
    reasonCode: incident.reasonCode,
    recoveryCount: incident.recoveryCount ?? 0,
    runtimeDigest: incident.runtimeDigest ?? null,
    state: incident.state,
    workflowDigest: incident.workflowDigest,
  }
}

export class EagleMonitorStore {
  #config

  constructor(config) {
    this.#config = config
  }

  async initialize() {
    await ensurePrivateDirectory(this.#config.dataDir)
  }

  async readSession() {
    const value = await readPrivateJson(this.#config.paths.session, { allowMissing: true })
    return value ? assertSession(assertSchema(value, "The Eagle Monitor session")) : null
  }

  async configureSession(input) {
    await this.initialize()
    const existing = await this.readSession()
    const same = existing
      && existing.workflowId === input.workflowId
      && existing.bindingKey === (input.bindingKey ?? null)
      && existing.mode === input.mode
      && existing.powerPolicy === input.powerPolicy
      && existing.policyDigest === this.#config.policy.digest
      && existing.launchAgentDigest === input.launchAgentDigest
    if (existing?.active && !same) {
      throw new EgoChatError(
        "monitor_already_configured",
        "Stop the active Eagle Monitor before changing its exact workflow or policy.",
      )
    }
    const configuredAt = same ? existing.configuredAt : input.now
    const session = {
      active: true,
      bindingKey: input.bindingKey ?? null,
      configuredAt,
      launchAgentDigest: input.launchAgentDigest,
      mode: input.mode,
      policyDigest: this.#config.policy.digest,
      powerPolicy: input.powerPolicy,
      schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
      stoppedAt: null,
      workflowId: input.workflowId,
    }
    await writeAtomicJson(this.#config.paths.session, session)
    return { changed: !same || existing.active !== true, session }
  }

  async stopSession(now) {
    const existing = await this.readSession()
    if (!existing || !existing.active) return existing
    const stopped = { ...existing, active: false, stoppedAt: now }
    await writeAtomicJson(this.#config.paths.session, stopped)
    return stopped
  }

  async restoreSession(session) {
    await this.initialize()
    if (session === null) {
      await removeFileIfPresent(this.#config.paths.session)
      return null
    }
    assertSession(session)
    await writeAtomicJson(this.#config.paths.session, session)
    return session
  }

  async readState() {
    const value = await readPrivateJson(this.#config.paths.state, { allowMissing: true })
    return value ? assertState(assertSchema(value, "The Eagle Monitor state")) : null
  }

  async writeState(state, dispatchFence) {
    if (!dispatchFence || typeof dispatchFence.assertCurrent !== "function") {
      throw new EgoChatError(
        "monitor_dispatch_unfenced",
        "Eagle Monitor recovery-state writes require the current monitor lease.",
      )
    }
    await this.initialize()
    const incidents = Array.isArray(state.incidents)
      ? state.incidents.slice(-Math.min(this.#config.incidentLimit, EAGLE_MONITOR_INCIDENT_LIMIT))
      : []
    const persisted = {
      ...state,
      incidents: incidents.map(safeIncident),
      schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
    }
    assertState(persisted)
    await dispatchFence.assertCurrent()
    await writeAtomicJson(this.#config.paths.state, persisted)
  }

  createIncident({ classification, monitorEpoch, observation, recoveryCount, session }) {
    return safeIncident({
      bindingDigest: safeDigest(session.bindingKey),
      brokerEpoch: observation.broker?.epoch ?? null,
      humanRequired: classification.humanRequired,
      id: randomUUID(),
      monitorEpoch,
      occurredAt: new Date(observation.nowMs).toISOString(),
      phase: safeEvidenceCode(observation.workflow?.phase),
      reasonCode: classification.reasonCode,
      recoveryCount,
      runtimeDigest: safeDigest(observation.broker?.runtimeIdentity?.contractDigest),
      state: classification.state,
      workflowDigest: safeDigest(session.workflowId),
    })
  }

  publicStatus(session, state, service, monitor = null, policyMatches = null) {
    const active = session?.active === true
    const currentState = active && state?.workflowDigest !== safeDigest(session.workflowId)
      ? null
      : state
    return {
      broker: currentState?.broker ?? null,
      humanRequired: active
        ? (currentState?.humanRequired ?? { reasonCode: "monitor_starting", required: false })
        : { reasonCode: "monitor_not_started", required: false },
      lastAction: currentState?.lastAction ?? null,
      monitor,
      nextObservationAt: active ? (currentState?.nextObservationAt ?? null) : null,
      phase: currentState?.phase ?? null,
      policyMatches,
      recoveryCount: currentState?.recoveryCount ?? 0,
      service,
      session: publicSession(session),
      state: active ? (currentState?.state ?? MonitorState.STARTUP) : "stopped",
      updatedAt: currentState?.updatedAt ?? null,
    }
  }

  publicIncidents(state, limit) {
    const incidents = Array.isArray(state?.incidents) ? state.incidents : []
    return incidents.slice(-limit).reverse().map(safeIncident)
  }
}
