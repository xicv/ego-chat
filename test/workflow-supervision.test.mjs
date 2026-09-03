import assert from "node:assert/strict"
import test from "node:test"

import { superviseWorkflow } from "../src/workflow-supervision.mjs"

function convergence(overrides = {}) {
  return {
    appServerRecoveryCount: 4,
    activeCodexInspectionRetryCount: 2,
    codexAppServerLivenessCheckpointCount: 1,
    codexInspectionRetryCount: 7,
    codexInspectionLivenessCheckpointCount: 1,
    createdAt: "2026-09-03T00:00:00.000Z",
    cycle: 1,
    id: "workflow-1",
    kind: "convergence",
    phase: "codex_running",
    status: "running",
    updatedAt: "2026-09-03T00:01:00.000Z",
    ...overrides,
  }
}

test("supervision says when side A has not sent anything to ChatGPT", () => {
  const supervision = superviseWorkflow(convergence())

  assert.equal(supervision.stage, "codex")
  assert.equal(supervision.chatGpt.delivery, "not_started")
  assert.equal(supervision.codex.appServerRecoveryCount, 4)
  assert.equal(supervision.codex.appServerLivenessCheckpointCount, 1)
  assert.equal(supervision.codex.activeInspectionRetryCount, 2)
  assert.equal(supervision.codex.inspectionRetryCount, 7)
  assert.equal(supervision.codex.livenessCheckpointCount, 1)
  assert.match(supervision.message, /App Server recoveries 4/)
  assert.match(supervision.message, /App Server liveness checkpoints 1/)
  assert.match(supervision.message, /inspection retries 7/)
  assert.match(supervision.message, /liveness checkpoints 1/)
  assert.match(supervision.message, /ChatGPT review has not been sent/)
})

test("supervision distinguishes an unconfirmed delivery from a confirmed Send", () => {
  const parent = convergence({
    childWorkflowId: "child-1",
    phase: "chatgpt_running",
  })
  const unconfirmed = superviseWorkflow(parent, {
    kind: "ego_exchange",
    phase: "browser_owned",
    status: "running",
    updatedAt: "2026-09-03T00:02:00.000Z",
  })
  const confirmed = superviseWorkflow(parent, {
    kind: "ego_exchange",
    phase: "send_confirmed",
    status: "running",
    updatedAt: "2026-09-03T00:03:00.000Z",
  })

  assert.equal(unconfirmed.chatGpt.delivery, "not_confirmed")
  assert.match(unconfirmed.message, /Send is not confirmed/)
  assert.equal(confirmed.chatGpt.delivery, "sent_waiting_response")
  assert.match(confirmed.message, /durably sent/)
  assert.equal(confirmed.lastTransitionAt, "2026-09-03T00:03:00.000Z")
})

test("supervision distinguishes active generation from a markerless completed response", () => {
  const parent = convergence({
    childWorkflowId: "child-1",
    phase: "chatgpt_running",
  })
  const generating = superviseWorkflow(parent, {
    capturePending: {
      generationRunning: true,
      observedAt: "2026-09-03T00:02:00.000Z",
      reason: "generation_running",
    },
    phase: "send_confirmed",
    status: "running",
  })
  const markerless = superviseWorkflow(parent, {
    capturePending: {
      generationRunning: false,
      observedAt: "2026-09-03T00:03:00.000Z",
      reason: "response_not_terminal",
    },
    phase: "send_confirmed",
    status: "running",
  })

  assert.equal(generating.chatGpt.delivery, "sent_generating")
  assert.equal(generating.chatGpt.pendingReason, "generation_running")
  assert.match(generating.message, /actively generating/)
  assert.equal(markerless.chatGpt.delivery, "sent_response_incomplete")
  assert.equal(markerless.chatGpt.pendingReason, "response_not_terminal")
  assert.match(markerless.message, /response is present but not terminal/)
})

test("supervision reports a captured response without inspecting private workflow data", () => {
  const supervision = superviseWorkflow(convergence({
    childWorkflowId: "child-1",
    phase: "review_captured",
  }))

  assert.equal(supervision.chatGpt.delivery, "response_captured")
  assert.equal(supervision.stage, "review")
  assert.match(supervision.message, /response is durably captured/)
})

test("current Codex phase overrides a retained completed child from an earlier cycle", () => {
  const completedChild = {
    phase: "head_committed",
    status: "succeeded",
  }
  for (const phase of ["created", "codex_ready", "codex_recovering", "codex_running"]) {
    const supervision = superviseWorkflow(convergence({
      childWorkflowId: "prior-child",
      phase,
    }), completedChild)

    assert.equal(supervision.chatGpt.delivery, "not_started", phase)
    assert.match(supervision.message, /review has not been sent/, phase)
    assert.doesNotMatch(supervision.message, /response is durably captured/, phase)
  }

  const queued = superviseWorkflow(convergence({
    childWorkflowId: "prior-child",
    phase: "codex_captured",
  }), completedChild)
  assert.equal(queued.chatGpt.delivery, "queued")
  assert.match(queued.message, /delivery is queued/)
})

test("supervision exposes pending Codex thread rotation and its setup recoveries", () => {
  const supervision = superviseWorkflow(convergence({
    appServerSetupRecoveryCount: 3,
    childWorkflowId: "child-1",
    codexThreadRotationCount: 1,
    codexThreadRotationPending: { afterCycle: 1 },
    phase: "review_captured",
  }))

  assert.equal(supervision.stage, "codex")
  assert.equal(supervision.codex.appServerSetupRecoveryCount, 3)
  assert.equal(supervision.codex.threadRotationCount, 1)
  assert.equal(supervision.codex.threadRotationPending, true)
  assert.match(supervision.message, /App Server setup recoveries 3/)
  assert.match(supervision.message, /Codex thread rotation pending/)
})

test("terminal convergence status overrides pending Codex thread rotation", () => {
  for (const status of ["human_required", "failed", "cancelled"]) {
    const supervision = superviseWorkflow(convergence({
      childWorkflowId: "child-1",
      codexThreadRotationPending: { afterCycle: 1 },
      phase: "review_captured",
      status,
    }))

    assert.equal(supervision.stage, "stopped", status)
    assert.equal(supervision.chatGpt.delivery, "workflow_stopped", status)
    assert.match(supervision.message, /cycle 1: stopped/, status)
    assert.doesNotMatch(supervision.message, /cycle 1: codex/, status)
  }
})

test("supervision gives stopped state precedence over retained active phases", () => {
  const cases = [
    {
      delivery: "not_started",
      name: "not started",
      parent: convergence({ appServerRecoveryCount: 0, phase: "created" }),
      stage: "codex",
    },
    {
      delivery: "queued",
      name: "queued",
      parent: convergence({ appServerRecoveryCount: 0, phase: "codex_captured" }),
      stage: "handoff",
    },
    {
      child: { phase: "browser_owned", status: "running" },
      delivery: "not_confirmed",
      name: "Send unconfirmed",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
    },
    {
      child: { phase: "send_confirmed", status: "running" },
      delivery: "sent_waiting_response",
      name: "durably sent",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
    },
    {
      child: { phase: "restart_reconciling", status: "running" },
      delivery: "reconciling_delivery",
      name: "delivery reconciling",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
    },
    {
      child: { phase: "head_committed", status: "succeeded" },
      delivery: "response_captured",
      name: "response captured",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
    },
    {
      delivery: "workflow_stopped",
      name: "terminal parent retaining codex phase",
      parent: convergence({ phase: "codex_captured", status: "human_required" }),
      stage: "stopped",
      stopped: true,
    },
    {
      child: { phase: "send_confirmed", status: "human_required" },
      delivery: "child_stopped",
      name: "terminal child retaining Send phase",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
      stopped: true,
    },
    {
      child: { phase: "restart_reconciling", status: "failed" },
      delivery: "child_stopped",
      name: "terminal child retaining reconciliation phase",
      parent: convergence({ childWorkflowId: "child", phase: "chatgpt_running" }),
      stage: "chatgpt",
      stopped: true,
    },
    {
      delivery: "response_captured",
      name: "settled parent",
      parent: convergence({ phase: "settled", status: "succeeded" }),
      stage: "settled",
    },
  ]

  for (const scenario of cases) {
    const supervision = superviseWorkflow(scenario.parent, scenario.child)
    assert.equal(supervision.chatGpt.delivery, scenario.delivery, scenario.name)
    assert.equal(supervision.stage, scenario.stage, scenario.name)
    if (scenario.stopped) {
      assert.match(supervision.message, /stopped/, scenario.name)
      assert.doesNotMatch(supervision.message, /queued|awaiting|reconciling/, scenario.name)
    }
  }
})
