import assert from "node:assert/strict"
import test from "node:test"

import { RUNTIME_IDENTITY } from "../src/constants.mjs"
import {
  chooseMonitorAction,
  classifyMonitorState,
  MONITOR_ACTION_POLICY,
  MonitorAction,
  MonitorState,
  monitorBackoffMs,
} from "../src/eagle-monitor-policy.mjs"

const NOW = Date.parse("2026-09-04T00:10:00.000Z")

function observation(overrides = {}) {
  const baseline = {
    bindingAvailable: true,
    bindingMatches: true,
    broker: {
      available: true,
      conclusivelyDead: false,
      epoch: 7,
      runtimeIdentity: RUNTIME_IDENTITY,
    },
    crashLoop: false,
    deadConfirmed: false,
    monitorPolicyMatches: true,
    nowMs: NOW,
    power: { onAc: true, sleepDetected: false, wakeDetected: false },
    storage: { spaceAvailable: true, writable: true },
    workflow: {
      createdAt: "2026-09-04T00:09:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
      kind: "ego_exchange",
      phase: "codex_running",
      status: "running",
      updatedAt: "2026-09-04T00:09:30.000Z",
    },
  }
  return {
    ...baseline,
    ...overrides,
    workflow: Object.hasOwn(overrides, "workflow")
      ? (overrides.workflow === null ? null : { ...baseline.workflow, ...overrides.workflow })
      : baseline.workflow,
  }
}

test("the typed policy is exhaustive and contains no browser or delivery-creation action", () => {
  assert.deepEqual(
    Object.keys(MONITOR_ACTION_POLICY).sort(),
    Object.values(MonitorState).sort(),
  )
  const actions = new Set(Object.values(MONITOR_ACTION_POLICY).flat())
  assert.deepEqual(
    [...actions].sort(),
    Object.values(MonitorAction).sort(),
  )
  for (const forbidden of ["send", "compose", "create_workflow", "select_conversation", "select_model"]) {
    assert.equal(actions.has(forbidden), false)
  }
})

test("the reducer distinguishes every required operational condition", () => {
  const cases = [
    [MonitorState.HEALTHY, observation()],
    [MonitorState.STARTUP, observation({ broker: { available: false, conclusivelyDead: false } })],
    [MonitorState.STALLED_BEFORE_SEND, observation({
      workflow: { phase: "browser_owned", status: "running", updatedAt: "2026-09-04T00:00:00.000Z" },
    })],
    [MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY, observation({
      workflow: {
        humanRequired: { code: "send_confirmation_ambiguous" },
        phase: "recovery_required",
        status: "human_required",
      },
    })],
    [MonitorState.SEND_CONFIRMED_CAPTURE, observation({
      workflow: { phase: "send_confirmed", status: "running", updatedAt: "2026-09-04T00:09:30.000Z" },
    })],
    [MonitorState.SETTLED, observation({ workflow: { phase: "settled", status: "succeeded" } })],
    [MonitorState.HUMAN_REQUIRED_AUTH_CHALLENGE, observation({
      workflow: {
        humanRequired: { code: "authentication_required" },
        phase: "stopped",
        status: "human_required",
      },
    })],
    [MonitorState.HUMAN_REQUIRED_OTHER, observation({ bindingMatches: false })],
    [MonitorState.POWER_SLEEP, observation({
      power: { onAc: true, sleepDetected: false, wakeDetected: true },
    })],
    [MonitorState.DISK_FULL, observation({
      storage: { spaceAvailable: false, writable: true },
    })],
    [MonitorState.VERSION_SKEW, observation({
      broker: {
        available: true,
        conclusivelyDead: false,
        runtimeIdentity: { ...RUNTIME_IDENTITY, contractDigest: "f".repeat(64) },
      },
    })],
    [MonitorState.CRASH_LOOP, observation({ crashLoop: true })],
  ]
  for (const [expected, input] of cases) {
    assert.equal(classifyMonitorState(input).state, expected)
  }
})

test("pre-Send and post-Send recovery never select a Send or replacement workflow", () => {
  const preSend = observation({
    workflow: { phase: "browser_owned", status: "running", updatedAt: "2026-09-04T00:00:00.000Z" },
  })
  const preClassification = classifyMonitorState(preSend)
  assert.equal(chooseMonitorAction(preClassification, preSend), MonitorAction.ATTACH_EXACT_WORKFLOW)

  const confirmed = observation({
    workflow: { phase: "send_confirmed", status: "running", updatedAt: "2026-09-04T00:09:30.000Z" },
  })
  const confirmedClassification = classifyMonitorState(confirmed)
  assert.equal(
    chooseMonitorAction(confirmedClassification, confirmed),
    MonitorAction.ATTACH_EXACT_WORKFLOW,
  )

  const ambiguous = observation({
    workflow: {
      humanRequired: { code: "send_confirmation_ambiguous" },
      phase: "recovery_required",
      status: "human_required",
    },
  })
  const ambiguousClassification = classifyMonitorState(ambiguous)
  assert.equal(
    chooseMonitorAction(ambiguousClassification, ambiguous),
    MonitorAction.RECONCILE_EXACT_WORKFLOW,
  )
  assert.equal(
    MONITOR_ACTION_POLICY[MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY]
      .some((action) => /send|create|browser/.test(action)),
    false,
  )
})

test("every convergence delivery projection preserves the Send boundary", () => {
  const cases = [
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "not_started",
      phase: "codex_running",
      state: MonitorState.HEALTHY,
    },
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "queued",
      phase: "codex_captured",
      state: MonitorState.STALLED_BEFORE_SEND,
    },
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "not_confirmed",
      phase: "chatgpt_running",
      state: MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY,
    },
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "sent_waiting_response",
      phase: "chatgpt_running",
      state: MonitorState.SEND_CONFIRMED_CAPTURE,
    },
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "reconciling_delivery",
      phase: "chatgpt_running",
      state: MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY,
    },
    {
      action: MonitorAction.ATTACH_EXACT_WORKFLOW,
      delivery: "response_captured",
      phase: "review_captured",
      state: MonitorState.HEALTHY,
    },
    {
      action: MonitorAction.NOTIFY_USER,
      delivery: "child_unavailable",
      phase: "chatgpt_running",
      state: MonitorState.HUMAN_REQUIRED_OTHER,
    },
    {
      action: MonitorAction.NOTIFY_USER,
      delivery: "child_stopped",
      phase: "chatgpt_running",
      state: MonitorState.HUMAN_REQUIRED_OTHER,
    },
    {
      action: MonitorAction.NOTIFY_USER,
      delivery: "workflow_stopped",
      phase: "stopped",
      state: MonitorState.HUMAN_REQUIRED_OTHER,
      status: "failed",
    },
  ]

  for (const scenario of cases) {
    const input = observation({
      workflow: {
        bindingKey: "ego-chat-main",
        kind: "convergence",
        phase: scenario.phase,
        status: scenario.status ?? "running",
        supervision: {
          chatGpt: { delivery: scenario.delivery },
          lastTransitionAt: "2026-09-04T00:00:00.000Z",
        },
      },
    })
    const classification = classifyMonitorState(input)
    const action = chooseMonitorAction(classification, input)
    assert.equal(classification.state, scenario.state, scenario.delivery)
    assert.equal(action, scenario.action, scenario.delivery)
    assert.doesNotMatch(action, /send|compose|create|replacement|conversation|browser/, scenario.delivery)
  }

  const confirmed = cases.filter(({ state }) => state === MonitorState.SEND_CONFIRMED_CAPTURE)
  assert.deepEqual(confirmed.map(({ delivery }) => delivery), ["sent_waiting_response"])

  const notConfirmed = cases.find(({ delivery }) => delivery === "not_confirmed")
  assert.notEqual(notConfirmed.state, MonitorState.STALLED_BEFORE_SEND)
  const reconciling = cases.find(({ delivery }) => delivery === "reconciling_delivery")
  assert.notEqual(reconciling.state, MonitorState.SEND_CONFIRMED_CAPTURE)

  const terminalParent = observation({
    workflow: {
      bindingKey: "ego-chat-main",
      humanRequired: { code: "send_confirmation_ambiguous" },
      kind: "convergence",
      phase: "stopped",
      status: "human_required",
    },
  })
  const terminalClassification = classifyMonitorState(terminalParent)
  assert.equal(terminalClassification.state, MonitorState.AMBIGUOUS_UNCONFIRMED_DELIVERY)
  assert.equal(
    chooseMonitorAction(terminalClassification, terminalParent),
    MonitorAction.NOTIFY_USER,
  )
})

test("policy skew and an exhausted confirmed-Send service budget notify without recovery", () => {
  const policySkew = observation({ monitorPolicyMatches: false })
  const skewClassification = classifyMonitorState(policySkew)
  assert.equal(skewClassification.state, MonitorState.VERSION_SKEW)
  assert.equal(skewClassification.reasonCode, "monitor_policy_version_skew")
  assert.equal(chooseMonitorAction(skewClassification, policySkew), MonitorAction.NOTIFY_USER)

  const stalledCapture = observation({
    workflow: {
      phase: "send_confirmed",
      status: "running",
      updatedAt: "2026-09-03T20:00:00.000Z",
    },
  })
  const stalledClassification = classifyMonitorState(stalledCapture)
  assert.equal(stalledClassification.state, MonitorState.SEND_CONFIRMED_CAPTURE)
  assert.equal(stalledClassification.reasonCode, "send_confirmed_capture_stalled")
  assert.equal(stalledClassification.humanRequired, true)
  assert.equal(chooseMonitorAction(stalledClassification, stalledCapture), MonitorAction.NOTIFY_USER)
})

test("a dead broker from an incompatible runtime fails closed before restart", () => {
  const staleRuntime = observation({
    broker: {
      available: false,
      conclusivelyDead: true,
      epoch: 6,
      runtimeIdentity: { ...RUNTIME_IDENTITY, contractDigest: "f".repeat(64) },
    },
    deadConfirmed: true,
    workflow: null,
  })
  const classification = classifyMonitorState(staleRuntime)
  assert.equal(classification.state, MonitorState.VERSION_SKEW)
  assert.equal(classification.reasonCode, "broker_runtime_version_skew")
  assert.equal(chooseMonitorAction(classification, staleRuntime), MonitorAction.NOTIFY_USER)
})

test("phase-aware backoff is bounded", () => {
  assert.equal(monitorBackoffMs(MonitorState.STARTUP, 0), 1_000)
  assert.equal(monitorBackoffMs(MonitorState.STARTUP, 99), 30_000)
  assert.equal(monitorBackoffMs(MonitorState.SEND_CONFIRMED_CAPTURE, 99), 60_000)
  assert.equal(monitorBackoffMs(MonitorState.CRASH_LOOP, 99), 5 * 60_000)
})
