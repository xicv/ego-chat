const CODEX_PHASES = new Set([
  "codex_launching",
  "codex_ready",
  "codex_recovering",
  "codex_running",
  "created",
])

const CONFIRMED_PENDING_DELIVERIES = new Set([
  "sent_generating",
  "sent_response_incomplete",
  "sent_waiting_response",
])

/** Whether the projection proves Send confirmed while response capture remains pending. */
export function isConfirmedPendingDelivery(delivery) {
  return CONFIRMED_PENDING_DELIVERIES.has(delivery)
}

function finiteCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function chatGptDelivery(workflow, childWorkflow) {
  if (["failed", "human_required", "cancelled"].includes(workflow.status)) {
    return "workflow_stopped"
  }
  if (workflow.phase === "review_captured" || workflow.phase === "settled") {
    return "response_captured"
  }
  if (CODEX_PHASES.has(workflow.phase)) return "not_started"
  if (["codex_captured", "successor_preparing"].includes(workflow.phase)) return "queued"
  if (!workflow.childWorkflowId) {
    return "not_started"
  }
  if (!childWorkflow) return "child_unavailable"
  return exchangeDelivery(childWorkflow)
}

function exchangeDelivery(childWorkflow) {
  if (childWorkflow.status === "succeeded") {
    return "response_captured"
  }
  if (["failed", "human_required", "cancelled"].includes(childWorkflow.status)) {
    return "child_stopped"
  }
  if (["head_committed", "response_captured"].includes(childWorkflow.phase)) {
    return "response_captured"
  }
  if (childWorkflow.phase === "send_confirmed") {
    if (childWorkflow.capturePending?.reason === "generation_running") {
      return "sent_generating"
    }
    if (childWorkflow.capturePending?.reason === "response_not_terminal") {
      return "sent_response_incomplete"
    }
    return "sent_waiting_response"
  }
  if (childWorkflow.phase === "restart_reconciling") return "reconciling_delivery"
  return "not_confirmed"
}

function convergenceStage(workflow) {
  if (["failed", "human_required", "cancelled"].includes(workflow.status)) return "stopped"
  if (workflow.status === "succeeded") return workflow.phase === "settled" ? "settled" : "stopped"
  if (CODEX_PHASES.has(workflow.phase)) return "codex"
  if (["codex_captured", "successor_preparing"].includes(workflow.phase)) return "handoff"
  if (["chatgpt_running", "successor_reviewing"].includes(workflow.phase)) return "chatgpt"
  if (workflow.phase === "review_captured") return "review"
  if (workflow.phase === "settled") return "settled"
  return workflow.status === "running" ? "recovering" : "stopped"
}

function deliveryMessage(delivery) {
  const messages = {
    child_stopped: "the ChatGPT child is durably stopped; inspect its terminal reason",
    child_unavailable: "the durable ChatGPT child record is unavailable",
    not_confirmed: "ChatGPT delivery has started but Send is not confirmed",
    not_started: "the ChatGPT review has not been sent",
    queued: "the candidate is captured and ChatGPT delivery is queued",
    reconciling_delivery: "the broker is reconciling whether ChatGPT received the marked prompt",
    response_captured: "the ChatGPT response is durably captured",
    sent_generating: "the ChatGPT prompt is durably sent; the last browser observation found active generation (not proof of task progress)",
    sent_response_incomplete: "the ChatGPT prompt is durably sent; the last browser observation found a response present but not terminal",
    sent_waiting_response: "the ChatGPT prompt is durably sent and awaiting its response",
    workflow_stopped: "the convergence workflow is durably stopped",
  }
  return messages[delivery] ?? "ChatGPT delivery state is unknown"
}

function deliveryObservation(workflow, delivery) {
  return {
    canonicalUrl: workflow?.delivery?.canonicalUrl ?? null,
    delivery,
    lastObservationAt: workflow?.captureObservation?.observedAt
      ?? workflow?.capturePending?.observedAt ?? null,
    pendingReason: workflow?.capturePending?.reason ?? null,
  }
}

export function superviseWorkflow(workflow, childWorkflow = undefined) {
  if (!workflow || typeof workflow !== "object") {
    throw new TypeError("workflow is required")
  }
  if (workflow.kind !== "convergence") {
    const delivery = workflow.kind === "ego_exchange" ? exchangeDelivery(workflow) : null
    return {
      ...(delivery ? { chatGpt: deliveryObservation(workflow, delivery) } : {}),
      lastTransitionAt: workflow.updatedAt ?? workflow.createdAt ?? null,
      message: `${workflow.kind ?? "workflow"} is ${workflow.status ?? "unknown"} in phase ${workflow.phase ?? "unknown"}${delivery ? `; ${deliveryMessage(delivery)}` : ""}.`,
      phase: workflow.phase ?? null,
      stage: workflow.status === "running" ? "working" : "stopped",
      status: workflow.status ?? "unknown",
    }
  }

  const delivery = chatGptDelivery(workflow, childWorkflow)
  const appServerRecoveryCount = finiteCount(workflow.appServerRecoveryCount)
  const appServerSetupRecoveryCount = finiteCount(workflow.appServerSetupRecoveryCount)
  const appServerLivenessCheckpointCount = finiteCount(
    workflow.codexAppServerLivenessCheckpointCount,
  )
  const candidateCorrectionCount = finiteCount(workflow.candidateCorrectionCount)
  const candidateCorrectionLivenessCheckpointCount = finiteCount(workflow.codexCandidateCorrectionLivenessCheckpointCount)
  const inspectionRetryCount = finiteCount(workflow.codexInspectionRetryCount)
  const livenessCheckpointCount = finiteCount(workflow.codexInspectionLivenessCheckpointCount)
  const activeInspectionRetryCount = finiteCount(workflow.activeCodexInspectionRetryCount)
  const cycleActivityCount = finiteCount(workflow.activeCodexWorkspaceActivity?.count)
  const cycle = Number.isSafeInteger(workflow.cycle) ? workflow.cycle : 0
  const threadRotationCount = finiteCount(workflow.codexThreadRotationCount)
  const threadRotationPending = Boolean(workflow.codexThreadRotationPending)
  const baseStage = convergenceStage(workflow)
  const stage = baseStage !== "stopped"
    && workflow.status === "running"
    && workflow.phase === "review_captured"
    && threadRotationPending
    ? "codex"
    : baseStage
  const recoveryParts = []
  if (appServerRecoveryCount > 0) recoveryParts.push(`App Server recoveries ${appServerRecoveryCount}`)
  if (appServerSetupRecoveryCount > 0) {
    recoveryParts.push(`App Server setup recoveries ${appServerSetupRecoveryCount}`)
  }
  if (appServerLivenessCheckpointCount > 0) {
    recoveryParts.push(`App Server liveness checkpoints ${appServerLivenessCheckpointCount}`)
  }
  if (inspectionRetryCount > 0) recoveryParts.push(`inspection retries ${inspectionRetryCount}`)
  if (candidateCorrectionCount > 0) recoveryParts.push(`candidate corrections ${candidateCorrectionCount}`)
  if (candidateCorrectionLivenessCheckpointCount > 0) recoveryParts.push(`candidate correction checkpoints ${candidateCorrectionLivenessCheckpointCount}`)
  if (livenessCheckpointCount > 0) recoveryParts.push(`liveness checkpoints ${livenessCheckpointCount}`)
  if (cycleActivityCount > 0) recoveryParts.push(`cycle workspace activity ${cycleActivityCount}`)
  if (threadRotationCount > 0) recoveryParts.push(`Codex thread rotations ${threadRotationCount}`)
  if (threadRotationPending) recoveryParts.push("Codex thread rotation pending")
  const detail = recoveryParts.length > 0 ? ` (${recoveryParts.join(", ")})` : ""

  return {
    chatGpt: {
      ...deliveryObservation(childWorkflow, delivery),
      childPhase: childWorkflow?.phase ?? null,
      childStatus: childWorkflow?.status ?? null,
    },
    codex: {
      appServerRecoveryCount,
      appServerSetupRecoveryCount,
      appServerLivenessCheckpointCount,
      activeInspectionRetryCount,
      candidateCorrectionCount,
      candidateCorrectionLivenessCheckpointCount,
      cycleActivityCount,
      inspectionRetryCount,
      livenessCheckpointCount,
      threadRotationCount,
      threadRotationPending,
    },
    cycle,
    lastTransitionAt: [workflow.updatedAt, childWorkflow?.updatedAt]
      .filter((value) => typeof value === "string")
      .sort()
      .at(-1) ?? null,
    message: `Ego Chat convergence cycle ${cycle}: ${stage}${detail}; ${deliveryMessage(delivery)}.`,
    phase: workflow.phase ?? null,
    stage,
    status: workflow.status ?? "unknown",
  }
}
