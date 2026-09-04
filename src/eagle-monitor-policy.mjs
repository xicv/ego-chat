import { RUNTIME_IDENTITY, TERMINAL_STATUSES } from "./constants.mjs"
import { EAGLE_MONITOR_POLICY } from "./eagle-monitor-constants.mjs"
import { EgoChatError } from "./errors.mjs"

export const MonitorState = Object.freeze({
  AMBIGUOUS_UNCONFIRMED_DELIVERY: "ambiguous_unconfirmed_delivery",
  CRASH_LOOP: "crash_loop",
  DISK_FULL: "disk_full",
  HEALTHY: "healthy",
  HUMAN_REQUIRED_AUTH_CHALLENGE: "human_required_auth_challenge",
  HUMAN_REQUIRED_OTHER: "human_required_other",
  POWER_SLEEP: "power_sleep",
  SEND_CONFIRMED_CAPTURE: "send_confirmed_capture",
  SETTLED: "settled",
  STALLED_BEFORE_SEND: "stalled_before_send",
  STARTUP: "startup",
  VERSION_SKEW: "version_skew",
})

export const MonitorAction = Object.freeze({
  ATTACH_EXACT_WORKFLOW: "attach_exact_workflow",
  HOLD_IDLE_SLEEP_ASSERTION: "hold_idle_sleep_assertion",
  NOTIFY_USER: "notify_user",
  OBSERVE: "observe",
  RECONCILE_EXACT_WORKFLOW: "reconcile_exact_workflow",
  RELEASE_IDLE_SLEEP_ASSERTION: "release_idle_sleep_assertion",
  START_BROKER: "start_broker",
})

const observe = [MonitorAction.OBSERVE, MonitorAction.RELEASE_IDLE_SLEEP_ASSERTION]
const activePower = [MonitorAction.HOLD_IDLE_SLEEP_ASSERTION, MonitorAction.RELEASE_IDLE_SLEEP_ASSERTION]
const attach = [MonitorAction.OBSERVE, MonitorAction.ATTACH_EXACT_WORKFLOW, ...activePower]
const reconcile = [...attach, MonitorAction.RECONCILE_EXACT_WORKFLOW, MonitorAction.NOTIFY_USER]

export const MONITOR_ACTION_POLICY = Object.freeze({
  [MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY]: Object.freeze(reconcile),
  [MonitorState.CRASH_LOOP]: Object.freeze([...observe, MonitorAction.NOTIFY_USER]),
  [MonitorState.DISK_FULL]: Object.freeze([...observe, MonitorAction.NOTIFY_USER]),
  [MonitorState.HEALTHY]: Object.freeze(attach),
  [MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE]: Object.freeze([
    ...observe,
    MonitorAction.NOTIFY_USER,
  ]),
  [MonitorState.HUMAN_REQUIRED_OTHER]: Object.freeze([...observe, MonitorAction.NOTIFY_USER]),
  [MonitorState.POWER_SLEEP]: Object.freeze(observe),
  [MonitorState.SEND_CONFIRMED_CAPTURE]: Object.freeze(reconcile),
  [MonitorState.SETTLED]: Object.freeze(observe),
  [MonitorState.STALLED_BEFORE_SEND]: Object.freeze(attach),
  [MonitorState.STARTUP]: Object.freeze([
    ...observe,
    MonitorAction.START_BROKER,
    MonitorAction.HOLD_IDLE_SLEEP_ASSERTION,
  ]),
  [MonitorState.VERSION_SKEW]: Object.freeze([...observe, MonitorAction.NOTIFY_USER]),
})

const AUTH_CHALLENGE_CODES = new Set([
  "authentication_required",
  "captcha_required",
  "human_verification_required",
  "verification_challenge",
])

const AMBIGUOUS_CODES = new Set([
  "browser_operation_interrupted_before_send_confirmation",
  "completion_timeout_after_confirmed_send",
  "conversation_head_commit_mismatch",
  "marker_count_changed",
  "send_confirmation_ambiguous",
])

const SEND_CONFIRMED_PHASES = new Set([
  "capture_pending",
  "restart_reconciling",
  "send_confirmed",
])

const PRE_SEND_PHASES = new Set([
  "browser_owned",
  "created",
  "model_policy_verified",
  "preflight",
  "prompt_staged",
])

const SUPERVISED_SEND_CONFIRMED_DELIVERIES = new Set([
  "sent_waiting_response",
])

const SUPERVISED_PRE_SEND_DELIVERIES = new Set([
  "queued",
])

const SUPERVISED_AMBIGUOUS_DELIVERIES = new Map([
  ["not_confirmed", "convergence_delivery_not_confirmed"],
  ["reconciling_delivery", "convergence_delivery_reconciling"],
])

const SUPERVISED_HUMAN_REQUIRED_DELIVERIES = new Map([
  ["child_stopped", "convergence_child_stopped"],
  ["child_unavailable", "convergence_child_unavailable"],
  ["workflow_stopped", "convergence_workflow_stopped"],
])

const BACKOFF_MS = Object.freeze({
  [MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY]: [15_000, 30_000, 60_000],
  [MonitorState.CRASH_LOOP]: [5 * 60_000],
  [MonitorState.DISK_FULL]: [5 * 60_000],
  [MonitorState.HEALTHY]: [5_000, 15_000, 30_000],
  [MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE]: [5 * 60_000],
  [MonitorState.HUMAN_REQUIRED_OTHER]: [5 * 60_000],
  [MonitorState.POWER_SLEEP]: [30_000],
  [MonitorState.SEND_CONFIRMED_CAPTURE]: [5_000, 15_000, 30_000, 60_000],
  [MonitorState.SETTLED]: [60_000],
  [MonitorState.STALLED_BEFORE_SEND]: [15_000, 30_000, 60_000],
  [MonitorState.STARTUP]: [1_000, 5_000, 15_000, 30_000],
  [MonitorState.VERSION_SKEW]: [5 * 60_000],
})

function sameRuntime(candidate) {
  return JSON.stringify(candidate) === JSON.stringify(RUNTIME_IDENTITY)
}

function failureCode(workflow) {
  return workflow?.humanRequired?.code ?? workflow?.error?.code ?? null
}

function updatedAgeMs(workflow, nowMs) {
  const updated = Date.parse(
    workflow?.supervision?.lastTransitionAt ?? workflow?.updatedAt ?? workflow?.createdAt ?? "",
  )
  return Number.isFinite(updated) ? Math.max(0, nowMs - updated) : Number.POSITIVE_INFINITY
}

export function classifyMonitorState(observation) {
  if (observation.storage?.writable !== true || observation.storage?.spaceAvailable !== true) {
    return { humanRequired: true, reasonCode: "monitor_storage_unavailable", state: MonitorState.DISK_FULL }
  }
  if (observation.power?.sleepDetected || observation.power?.wakeDetected) {
    return { humanRequired: false, reasonCode: "sleep_wake_revalidation", state: MonitorState.POWER_SLEEP }
  }
  if (observation.crashLoop === true) {
    return { humanRequired: true, reasonCode: "broker_crash_loop", state: MonitorState.CRASH_LOOP }
  }
  if (observation.monitorPolicyMatches !== true) {
    return { humanRequired: true, reasonCode: "monitor_policy_version_skew", state: MonitorState.VERSION_SKEW }
  }
  if (
    observation.broker?.runtimeIdentity !== null
    && observation.broker?.runtimeIdentity !== undefined
    && !sameRuntime(observation.broker.runtimeIdentity)
  ) {
    return { humanRequired: true, reasonCode: "broker_runtime_version_skew", state: MonitorState.VERSION_SKEW }
  }
  if (observation.broker?.available !== true) {
    return {
      humanRequired: false,
      reasonCode: observation.broker?.conclusivelyDead
        ? "broker_conclusively_dead"
        : "broker_liveness_ambiguous",
      state: MonitorState.STARTUP,
    }
  }
  const workflow = observation.workflow
  if (!workflow) {
    return { humanRequired: true, reasonCode: "exact_workflow_not_found", state: MonitorState.HUMAN_REQUIRED_OTHER }
  }
  if (observation.bindingMatches !== true) {
    return {
      humanRequired: true,
      reasonCode: "exact_workflow_binding_mismatch",
      state: MonitorState.HUMAN_REQUIRED_OTHER,
    }
  }
  const code = failureCode(workflow)
  if (AUTH_CHALLENGE_CODES.has(code)) {
    return { humanRequired: true, reasonCode: code, state: MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE }
  }
  if (AMBIGUOUS_CODES.has(code)) {
    return { humanRequired: true, reasonCode: code, state: MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY }
  }
  if (workflow.status === "succeeded" || workflow.phase === "settled") {
    return { humanRequired: false, reasonCode: "workflow_settled", state: MonitorState.SETTLED }
  }
  if (TERMINAL_STATUSES.has(workflow.status)) {
    return {
      humanRequired: true,
      reasonCode: `workflow_${workflow.status ?? "stopped"}`,
      state: MonitorState.HUMAN_REQUIRED_OTHER,
    }
  }
  const supervisedDelivery = workflow.supervision?.chatGpt?.delivery
  if (SUPERVISED_AMBIGUOUS_DELIVERIES.has(supervisedDelivery)) {
    return {
      humanRequired: false,
      reasonCode: SUPERVISED_AMBIGUOUS_DELIVERIES.get(supervisedDelivery),
      state: MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY,
    }
  }
  if (SUPERVISED_HUMAN_REQUIRED_DELIVERIES.has(supervisedDelivery)) {
    return {
      humanRequired: true,
      reasonCode: SUPERVISED_HUMAN_REQUIRED_DELIVERIES.get(supervisedDelivery),
      state: MonitorState.HUMAN_REQUIRED_OTHER,
    }
  }
  if (
    SEND_CONFIRMED_PHASES.has(workflow.phase)
    || SUPERVISED_SEND_CONFIRMED_DELIVERIES.has(supervisedDelivery)
  ) {
    const stalled = updatedAgeMs(workflow, observation.nowMs)
      >= EAGLE_MONITOR_POLICY.postSendStallMs
    return {
      humanRequired: stalled,
      reasonCode: stalled
        ? "send_confirmed_capture_stalled"
        : "send_confirmed_read_only_capture",
      state: MonitorState.SEND_CONFIRMED_CAPTURE,
    }
  }
  if (
    (
      PRE_SEND_PHASES.has(workflow.phase)
      || SUPERVISED_PRE_SEND_DELIVERIES.has(supervisedDelivery)
    )
    && updatedAgeMs(workflow, observation.nowMs) >= EAGLE_MONITOR_POLICY.preSendStallMs
  ) {
    return { humanRequired: false, reasonCode: "pre_send_progress_stalled", state: MonitorState.STALLED_BEFORE_SEND }
  }
  return { humanRequired: false, reasonCode: "workflow_progressing", state: MonitorState.HEALTHY }
}

export function chooseMonitorAction(classification, observation) {
  if (classification.state === MonitorState.STARTUP) {
    return observation.broker?.conclusivelyDead && observation.deadConfirmed
      ? MonitorAction.START_BROKER
      : MonitorAction.OBSERVE
  }
  if (
    [MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY, MonitorState.SEND_CONFIRMED_CAPTURE]
      .includes(classification.state)
    && TERMINAL_STATUSES.has(observation.workflow?.status)
    && observation.bindingAvailable
    && observation.workflow?.kind === "ego_exchange"
  ) {
    return MonitorAction.RECONCILE_EXACT_WORKFLOW
  }
  if (
    classification.state === MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY
    && observation.workflow?.kind === "convergence"
    && observation.workflow?.status === "running"
  ) {
    return MonitorAction.ATTACH_EXACT_WORKFLOW
  }
  if (classification.humanRequired) return MonitorAction.NOTIFY_USER
  if (
    [
      MonitorState.HEALTHY,
      MonitorState.STALLED_BEFORE_SEND,
      MonitorState.SEND_CONFIRMED_CAPTURE,
    ].includes(classification.state)
  ) {
    return MonitorAction.ATTACH_EXACT_WORKFLOW
  }
  return MonitorAction.OBSERVE
}

export function assertMonitorActionAllowed(state, action) {
  if (!MONITOR_ACTION_POLICY[state]?.includes(action)) {
    throw new EgoChatError(
      "monitor_action_forbidden",
      `Action ${action} is not allowed in monitor state ${state}.`,
    )
  }
}

export function monitorBackoffMs(state, attempt = 0) {
  const schedule = BACKOFF_MS[state] ?? [30_000]
  const index = Math.min(Math.max(0, attempt), schedule.length - 1)
  return schedule[index]
}

const missingPolicies = Object.values(MonitorState)
  .filter((state) => !Object.hasOwn(MONITOR_ACTION_POLICY, state))
if (missingPolicies.length > 0) {
  throw new Error(`Monitor action policy is incomplete: ${missingPolicies.join(", ")}`)
}
