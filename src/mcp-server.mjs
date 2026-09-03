import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_CHATGPT_GENERATION_MS,
  MAX_PROMPT_BYTES,
  MAX_REVIEW_PACKET_BYTES,
  MAX_RESULT_BYTES,
  MAX_WAIT_MS,
} from "./constants.mjs"
import { loadConfig } from "./config.mjs"
import { requestBroker } from "./ipc-client.mjs"
import {
  completeAgentReview,
  prepareAgentReview,
} from "./convergence.mjs"
import { EgoChatError, asPublicError } from "./errors.mjs"
import { superviseWorkflow } from "./workflow-supervision.mjs"

const WAIT_MODES = ["progress", "token_saver"]
const PROGRESS_HEARTBEAT_MS = 60 * 1_000
const PROGRESS_POLL_MS = 10 * 1_000

function waitModeSchema(defaultMode = "progress") {
  return z.enum(WAIT_MODES).default(defaultMode)
    .describe("progress reports semantic durable-state changes plus at most one unchanged-state heartbeat per minute; token_saver performs no supervision reads or notifications.")
}

const EGO_EXCHANGE_INPUT_SCHEMA = {
  allowTaskSpaceReclaim: z.literal(true).default(true).describe("Ego Chat automatically reclaims only the exact deterministic task space owned by this binding, including read-only recovery after Send."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  expectedTerminalMarker: z.string().min(1).max(200),
  prompt: z.string().min(1).max(MAX_PROMPT_BYTES),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS),
  turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/),
}

const CONVERSATION_ADOPTION_INPUT_SCHEMA = {
  allowTaskSpaceReclaim: z.literal(true).default(true)
    .describe("Read-only adoption automatically reclaims only its dedicated Ego task space."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
  canonicalUrl: z.string().url().refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === "https:"
        && (parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com")
        && parsed.username === ""
        && parsed.password === ""
        && parsed.port === ""
        && /(?:^|\/)c\/[^/]+(?:\/|$)/.test(parsed.pathname)
    } catch (_error) {
      return false
    }
  }, "URL must identify a canonical HTTPS ChatGPT conversation"),
  projectUrl: z.string().url().optional(),
  targetId: z.string().min(1).max(200).optional(),
  taskSpace: z.union([z.string().min(1).max(120), z.number().int().positive()])
    .default("ego-chat-adoptions"),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS - 60_000).default(15 * 60 * 1_000),
}

const CONVERGENCE_INPUT_SCHEMA = {
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
  allowTaskSpaceReclaim: z.literal(true).default(true).describe("Every ChatGPT review cycle and its read-only recovery may reclaim only this binding's exact deterministic Ego task space."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  chatGptTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000)
    .describe("Per-review browser recovery deadline. This does not bound the durable workflow or its host attachment."),
  codexSandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  codexTurnTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000)
    .describe("Per-turn App Server recovery deadline. This does not bound the durable workflow or its host attachment."),
  cwd: z.string().min(1).max(1_024),
  maxCycles: z.number().int().min(1).optional().describe("Optional caller-selected cycle budget. Omit it to continue until objective settlement."),
  target: z.string().trim().min(1).max(8_000),
  wallClockTimeoutMs: z.number().int().min(120_000).max(MAX_WAIT_MS).default(MAX_WAIT_MS)
    .describe("Host attachment window. Expiry detaches this waiter but does not terminate the durable convergence workflow."),
}

const CRITERION_RESULT_SCHEMA = z.object({
  evidence: z.string().trim().min(1).max(4_000),
  id: z.string().regex(/^AC-[1-8]$/),
  status: z.enum(["pass", "fail", "unknown"]),
}).strict()

const REVIEW_PACKET_INPUT_SCHEMA = z.string().trim().min(1).max(MAX_REVIEW_PACKET_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_REVIEW_PACKET_BYTES,
    `Review packet must be at most ${MAX_REVIEW_PACKET_BYTES} UTF-8 bytes`,
  )

const AGENT_REVIEW_INPUT_SCHEMA = {
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
  allowTaskSpaceReclaim: z.literal(true).default(true).describe("This review and its read-only recovery automatically reclaim only the exact deterministic Ego task space owned by the binding."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  candidate: z.object({
    blockers: z.array(z.string().trim().min(1).max(2_000)).max(8),
    criteria: z.array(CRITERION_RESULT_SCHEMA).min(1).max(8),
    reviewPacket: REVIEW_PACKET_INPUT_SCHEMA,
    status: z.enum(["candidate", "blocked"]),
    summary: z.string().trim().min(1).max(4_000),
  }).strict(),
  cycle: z.number().int().min(1),
  operationId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,119}$/).optional(),
  target: z.string().trim().min(1).max(8_000),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000),
  waitMode: waitModeSchema(),
}

const RECOVERABLE_AGENT_REVIEW_CODES = new Set([
  "broker_restarted_during_browser_operation",
  "browser_operation_interrupted_before_send_confirmation",
  "completion_timeout_after_confirmed_send",
  "conversation_head_commit_mismatch",
  "marker_count_changed",
  "send_confirmation_ambiguous",
])

const MCP_INSTRUCTIONS = [
  "Use binding ego-chat-main unless the user explicitly names another binding.",
  "Codex and ZCode share one authoritative broker and do not automatically receive separate bindings or task spaces. Ego Chat serializes its own browser operations across bindings and yields long confirmed-send capture in bounded read-only slices. Never evade conversation_busy with another binding; use distinct bindings only for genuinely independent user-authorized conversations and spaces.",
  "When the user supplies a private canonical ChatGPT /c/ URL to continue, adopt it with ego_adopt_conversation_and_wait and omit bindingKey unless the user names one; use ego_start_conversation_adoption only when detachment is required.",
  "For one free-form ChatGPT review returned to the current agent turn, use ego_exchange_and_wait.",
  "For an explicit until-settled or keep-discussing request, prefer one ego_converge_until_settled call so the durable broker owns both the Codex App Server and ChatGPT sides across host detachment or restart. Use ego_review_candidate_and_wait for a one-candidate review or only as a fallback when detached convergence is unavailable.",
  "A successful review with settled false is a machine continuation, not a stopping condition. Read its complete review, address the in-scope blocking findings, and immediately submit nextCycle in the same host task without asking the user to relay or approve the review. Ordinary prose and imperfect formatting are consumed as continuation feedback without another browser send.",
  "Do not invent a cycle ceiling for an until-settled loop. Current-host reviews have no fixed cycle limit. Detached convergence also continues without a cycle limit when maxCycles is omitted; set maxCycles only when the user explicitly requests that budget.",
  `The complete generated review prompt uses a ${MAX_PROMPT_BYTES}-byte transport budget. Prefer an accessible PR URL plus exact revisions, changed-file inventory, critical excerpts, tests, and unresolved risks over an entire diff. If the assembled prompt is still too large, Ego Chat deterministically compacts it, treats that cycle as continuation, and asks for a smaller next-cycle packet; it never stops merely for packet size or splits one candidate across multiple sends.`,
  "Give every exact candidate review one stable operationId; reuse it only with byte-identical arguments to recover a lost tool result, and generate a new ID for any changed candidate or cycle.",
  "Preserve at-most-once delivery without ending the conversation: after a possibly accepted Send, reconcile the same durable workflow until the response is attributable or delivery is proven absent. Only a proven absence may create a fresh uniquely marked attempt.",
  "Task-space ownership is automatic for the exact deterministic binding space. Pass allowTaskSpaceReclaim as true (the default) so Send, capture, and reconciliation can reclaim that one space; this never authorizes another task space or clearing an unrelated human draft.",
  "Never call ego_verify_conversation as a preflight for a fresh send. A fresh exchange or review performs its own canonical URL, stable-head, browser-readiness, automatic exact-space reclaim, and live model-policy checks. If binding identity is uncertain before a send, use ego_get_conversation instead because it reads durable state without browser control. Reserve ego_verify_conversation for an explicitly requested maintenance checkpoint or a documented migration or reconciliation case.",
  "A proven pre-Send delivery absence is retried automatically in the same binding with a new unique marker and unchanged candidate identity. There is no fixed retry ceiling and no packet-compaction ceremony. Do not ask the user to log in, open ego-chat-main, or provide another conversation URL unless the exact broker code is authentication_required or verification_challenge.",
  "Use ego_converge_until_settled for durable multi-cycle work; supply an immutable target, observable acceptance criteria, and the absolute working directory. Use workspace-write when the user authorized local fixes and read-only for review-only targets.",
  "Keep post-settlement commit, push, merge, deploy, or release work outside the review target so the current host can run its normal authority and verification gates after settlement.",
  "Keep the default progress wait for unattended convergence so deterministic broker supervision reports phase changes, recovery counters, and whether ChatGPT delivery is not started, unconfirmed, confirmed, or captured. These local status reads do not invoke another model. Use token_saver only when the user explicitly prefers a silent wait; keep that one tool call open and do not poll workflow_status or await_workflow.",
  "Default convergence to read-only; use workspace-write only when local implementation is authorized.",
  "Never infer commit, push, deployment, production, credential, approval, or scope-expansion authority.",
  "Never duplicate an ambiguous send. Keep its durable workflow alive and reconcile it; retry delivery only after exact evidence proves the prior marked prompt absent.",
  "A stable assistant-only conversation-head advance before composition is re-anchored automatically. Unstable, generating, or possibly sent states remain inside durable reconciliation and must not become a human relay ceremony.",
].join(" ")

function toolResult(value, { compact = false } = {}) {
  return {
    content: [{ type: "text", text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function waitedToolResult(value, waitMode) {
  const structured = { ...value, waitMode }
  if (waitMode !== "token_saver") {
    return toolResult(structured)
  }
  const result = structured.result ?? {}
  const modelPolicy = structured.modelPolicy ?? result.modelPolicy
  const summary = {
    ...(structured.bindingKey ? { bindingKey: structured.bindingKey } : {}),
    ...(Number.isInteger(structured.deliveryAttemptCount)
      ? { deliveryAttemptCount: structured.deliveryAttemptCount }
      : {}),
    ...(structured.exchangeWorkflowId ? { exchangeWorkflowId: structured.exchangeWorkflowId } : {}),
    ...(modelPolicy
      ? {
          modelPolicy: {
            effortLabel: modelPolicy.effortLabel,
            modelLabel: modelPolicy.modelLabel,
            powerLevel: modelPolicy.powerLevel,
            powerMax: modelPolicy.powerMax,
          },
        }
      : {}),
    ...(result.responseRef ? { responseRef: result.responseRef } : {}),
    ...(structured.settled !== undefined ? { settled: structured.settled } : {}),
    ...(structured.nextAction ? { nextAction: structured.nextAction } : {}),
    ...(Number.isInteger(structured.nextCycle) ? { nextCycle: structured.nextCycle } : {}),
    ...(structured.protocolNormalization?.applied
      ? { protocolNormalization: structured.protocolNormalization }
      : {}),
    ...(Number.isInteger(structured.protocolRepairCount)
      ? { protocolRepairCount: structured.protocolRepairCount }
      : {}),
    ...(structured.settled === false && structured.review
      ? { review: structured.review }
      : {}),
    ...(structured.status ? { status: structured.status } : {}),
    waitMode,
    ...(structured.id ? { workflowId: structured.id } : {}),
  }
  return {
    content: [{ type: "text", text: JSON.stringify(summary) }],
    structuredContent: structured,
  }
}

function isDurablyProvenDeliveryAbsent(workflow) {
  return workflow?.status === "cancelled"
    && workflow.phase === "delivery_absent"
    && workflow.result?.deliveryState === "absent"
    && workflow.result.reconciled === true
}

function deliveryAbsenceAnchor(workflow) {
  const beforeHead = workflow?.reconciliation?.beforeHead
  const fields = ["contentDigest", "fingerprint", "fingerprintVersion", "messageId", "role"]
  if (
    !beforeHead
    || fields.some((field) => !Object.hasOwn(beforeHead, field))
    || fields.some((field) => beforeHead[field] !== null && typeof beforeHead[field] !== "string")
    || (beforeHead.role !== null && !["assistant", "user"].includes(beforeHead.role))
  ) {
    throw new EgoChatError(
      "human_required",
      "The proven-absent review does not retain a complete prior conversation-head anchor.",
      { reason: "review_delivery_absence_anchor_missing", workflowId: workflow?.id },
    )
  }
  return Object.fromEntries(fields.map((field) => [field, beforeHead[field]]))
}

function exchangeWaitMs(requestedTimeoutMs) {
  return Math.min(
    MAX_WAIT_MS,
    Math.max(requestedTimeoutMs, DEFAULT_CHATGPT_GENERATION_MS) + 60_000,
  )
}

async function resolveResponseText(config, workflowId, result) {
  if (typeof result?.responseText === "string") {
    return result.responseText
  }
  if (!result?.responseRef) {
    throw new EgoChatError("result_not_found", "The completed ChatGPT workflow has no readable response body.")
  }
  const captured = await requestBroker(config, "result.read", {
    expectedDigest: result.responseRef.digest,
    maxBytes: MAX_RESULT_BYTES,
    offset: 0,
    workflowId,
  })
  if (!captured.complete) {
    throw new EgoChatError("result_too_large", "The ChatGPT review exceeded the supported result size.")
  }
  return captured.text
}

function attachWaitRecovery(error, workflow, waitMode) {
  if (workflow && error instanceof EgoChatError) {
    error.details = {
      ...(error.details ?? {}),
      waitMode,
      workflowId: workflow.id,
    }
  }
}

function toolError(error) {
  const value = asPublicError(error)
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: true,
  }
}

export async function readSupervisedWorkflow(
  config,
  workflowId,
  signal = undefined,
  request = requestBroker,
) {
  const workflow = await request(
    config,
    "workflow.get",
    { workflowId },
    { signal },
  )
  let child
  if (workflow.kind === "convergence" && typeof workflow.childWorkflowId === "string") {
    try {
      child = await request(
        config,
        "workflow.get",
        { workflowId: workflow.childWorkflowId },
        { signal },
      )
    } catch (_error) {
      child = undefined
    }
  }
  return {
    ...workflow,
    supervision: superviseWorkflow(workflow, child),
  }
}

export async function withProgress(extra, description, operation, {
  config,
  heartbeatMs = PROGRESS_HEARTBEAT_MS,
  now = Date.now,
  pollMs = PROGRESS_POLL_MS,
  readWorkflow = readSupervisedWorkflow,
  clearIntervalFn = clearInterval,
  setIntervalFn = setInterval,
  workflowId,
} = {}) {
  let progress = 0
  let lastFingerprint
  let lastNotificationAt = 0
  let reading = false
  let closed = false
  let activePoll = Promise.resolve()
  let activeSend = Promise.resolve()
  let pendingNotification
  let sending = false
  let timer
  const statusController = new AbortController()
  const flushNotification = () => {
    if (closed || sending || !pendingNotification) return
    const notification = pendingNotification
    pendingNotification = undefined
    sending = true
    activeSend = Promise.resolve()
      .then(() => extra.sendNotification(notification))
      .catch(() => {})
      .finally(() => {
        sending = false
        flushNotification()
      })
  }
  const notify = async (force = false) => {
    if (closed || reading || extra._meta?.progressToken === undefined) return
    reading = true
    try {
      let fingerprint = description
      let message = `${description}; the broker-owned workflow remains attachable`
      if (config && workflowId) {
        try {
          const workflow = await readWorkflow(config, workflowId, statusController.signal)
          if (workflow.supervision?.message) {
            message = workflow.supervision.message
            fingerprint = message
          }
        } catch (_error) {
          fingerprint = `${workflowId}:status_unavailable`
          message = `Ego Chat cannot read durable status for ${workflowId}; the supervisor will retry without resending.`
        }
      }
      if (closed) return
      const observedAt = now()
      if (!force && fingerprint === lastFingerprint && observedAt - lastNotificationAt < heartbeatMs) return
      progress += 1
      lastFingerprint = fingerprint
      lastNotificationAt = observedAt
      if (closed) return
      pendingNotification = {
        method: "notifications/progress",
        params: {
          message,
          progress,
          progressToken: extra._meta.progressToken,
        },
      }
      flushNotification()
    } finally {
      reading = false
    }
  }
  const operationPromise = Promise.resolve().then(operation)
  activePoll = notify(true)
    .catch(() => {})
    .finally(() => {
      if (closed) return
      timer = setIntervalFn(() => {
        if (closed || reading) return
        activePoll = notify().catch(() => {})
        return activePoll
      }, pollMs)
    })

  try {
    return await operationPromise
  } finally {
    closed = true
    clearIntervalFn(timer)
    statusController.abort()
    await activePoll.catch(() => {})
    pendingNotification = undefined
    await activeSend.catch(() => {})
  }
}

export async function withWaitMode(
  extra,
  description,
  waitMode,
  operation,
  supervision = undefined,
) {
  if (waitMode === "token_saver") {
    return operation()
  }
  return withProgress(extra, description, operation, supervision)
}

export function createMcpServer(config = loadConfig()) {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  )

  server.registerTool(
    "ego_status",
    {
      description: "Read authoritative broker generation, runtime compatibility, active workflow, and bounded-store diagnostics without opening the browser.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(await requestBroker(config, "broker.status"))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "gate0_start_probe",
    {
      description: "Start a harmless broker-owned delay probe and return its durable workflow ID immediately.",
      inputSchema: {
        delayMs: z.number().int().min(1).max(MAX_WAIT_MS),
        value: z.string().min(1).max(64 * 1024),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "workflow.start_probe", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "gate0_probe_and_wait",
    {
      description: "Run a harmless broker-owned delay probe and keep this MCP call open until it completes.",
      inputSchema: {
        delayMs: z.number().int().min(1).max(MAX_WAIT_MS),
        value: z.string().min(1).max(64 * 1024),
        waitMode: waitModeSchema(),
      },
    },
    async (input, extra) => {
      try {
        const { waitMode, ...request } = input
        const workflow = await requestBroker(config, "workflow.start_probe", request)
        const result = await withWaitMode(extra, `Waiting for workflow ${workflow.id}`, waitMode, () => requestBroker(
          config,
          "workflow.await",
          { timeoutMs: Math.min(MAX_WAIT_MS, request.delayMs + 60_000), workflowId: workflow.id },
          {
            signal: extra.signal,
            timeoutMs: Math.min(MAX_WAIT_MS, request.delayMs + 65_000),
          },
        ), { config, workflowId: workflow.id })
        return waitedToolResult(result, waitMode)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_preflight",
    {
      description: "Open or reuse ChatGPT in one Ego task space and report only login/composer safety state; never sends a prompt.",
      inputSchema: {
        taskSpace: z.union([z.string().min(1).max(120), z.number().int().positive()]),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "ego.preflight", input, { timeoutMs: 65_000 }))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_get_model_policy",
    {
      description: "Read the durable ChatGPT web policy and its last observed model, effort, and power level. Never opens the browser.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(await requestBroker(config, "model_policy.get"))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_ensure_model_policy",
    {
      description: "Set ChatGPT's provider-defined power control to its maximum for one bound conversation, then read back the resolved model and effort. Never sends a prompt and fails closed on unknown UI.",
      inputSchema: {
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "model_policy.ensure", input, { timeoutMs: 65_000 }))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_bind_conversation",
    {
      description: "Create one durable named ChatGPT conversation binding. Use create_once for a verified new-chat tab or existing for a canonical conversation URL; an existing key is never replaced.",
      inputSchema: {
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        canonicalUrl: z.string().url().optional(),
        mode: z.enum(["create_once", "existing"]),
        projectUrl: z.string().url().optional(),
        startUrl: z.string().url().optional(),
        targetId: z.string().min(1).max(200).optional(),
        taskSpace: z.union([z.string().min(1).max(120), z.number().int().positive()]),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "conversation.bind", input, { timeoutMs: 65_000 }))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_start_conversation_adoption",
    {
      description: "Start a durable read-only takeover of a supplied private ChatGPT /c/ conversation. It anchors the latest user turn, waits outside the coding model for exactly one stable assistant tail, never sends, derives a stable binding key when omitted, and returns a workflow ID immediately.",
      inputSchema: CONVERSATION_ADOPTION_INPUT_SCHEMA,
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "conversation.start_adoption", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_adopt_conversation_and_wait",
    {
      description: "Take over a supplied private ChatGPT /c/ conversation and return its latest stable assistant response into this same agent turn. The broker performs the long read-only wait and never sends to ChatGPT; Token-Saver is the default wait mode.",
      inputSchema: {
        ...CONVERSATION_ADOPTION_INPUT_SCHEMA,
        waitMode: waitModeSchema("token_saver"),
      },
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode, ...request } = input
        workflow = await requestBroker(config, "conversation.start_adoption", request)
        const waitMs = Math.min(MAX_WAIT_MS, request.timeoutMs + 60_000)
        const result = await withWaitMode(
          extra,
          `Waiting for conversation adoption ${workflow.id}`,
          waitMode,
          () => requestBroker(
            config,
            "workflow.await",
            { timeoutMs: waitMs, workflowId: workflow.id },
            { signal: extra.signal, timeoutMs: waitMs + 5_000 },
          ),
          { config, workflowId: workflow.id },
        )
        return waitedToolResult(result, waitMode)
      } catch (error) {
        attachWaitRecovery(error, workflow, input.waitMode)
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_get_conversation",
    {
      description: "Read one durable named ChatGPT conversation binding without changing browser or broker state. This is the preferred preflight for binding identity before a fresh exchange or review; the send path performs its own live browser checks.",
      inputSchema: {
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "conversation.get", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_reconcile_conversation",
    {
      description: "Reconcile an attributable late browser send without sending again. Supports create-once promotion and a bound workflow's exact tail-anchored user/assistant pair; durably stores the recovered response and completes that exact workflow.",
      inputSchema: {
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        expectedPreviousContentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        expectedPreviousMessageId: z.string().min(1).max(200).optional(),
        expectedTerminalMarker: z.string().min(1).max(200).optional(),
        turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/).optional(),
        workflowId: z.uuid(),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "conversation.reconcile", input, { timeoutMs: 65_000 }))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_reanchor_conversation",
    {
      description: "Explicitly accept one stable externally changed assistant tail after an exact pre-send conversation_head_changed stop. This read-only browser observation advances the durable binding only with literal user acknowledgement, the stopped workflow ID, the expected binding revision, and the exact observed head fingerprint. It never sends a prompt and rejects ambiguous delivery state, generation, drafts, unstable heads, and races.",
      inputSchema: {
        acknowledgeExternalChange: z.literal(true),
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        expectedBindingRevision: z.number().int().positive(),
        expectedObservedHeadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        sourceWorkflowId: z.uuid(),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(
          config,
          "conversation.reanchor",
          input,
          { timeoutMs: 65_000 },
        ))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_verify_conversation",
    {
      description: "Run a browser-backed maintenance checkpoint for a named binding. It verifies the canonical URL and stable conversation head, establishes the first head checkpoint for a reconciled or migrated binding, and otherwise rejects any mismatch. It never reclaims browser control and is not a preflight for an exchange or review because every fresh send performs its own live checks.",
      inputSchema: {
        bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "conversation.verify", input, { timeoutMs: 65_000 }))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_exchange_and_wait",
    {
      description: "Send one uniquely marked free-form prompt through a durable named ChatGPT binding and return the complete captured review into this same agent turn. The broker performs its own canonical URL, stable-head, browser-readiness, binding-space recovery, and live model-policy checks; do not call ego_verify_conversation first. Set waitMode to token_saver for one silent durable wait without progress chatter.",
      inputSchema: {
        ...EGO_EXCHANGE_INPUT_SCHEMA,
        waitMode: waitModeSchema(),
      },
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode, ...request } = input
        workflow = await requestBroker(config, "ego.start_exchange", request)
        const waitMs = exchangeWaitMs(request.timeoutMs)
        const result = await withWaitMode(extra, `Waiting for Ego exchange ${workflow.id}`, waitMode, () => requestBroker(
          config,
          "workflow.await",
          { timeoutMs: waitMs, workflowId: workflow.id },
          { signal: extra.signal, timeoutMs: waitMs + 5_000 },
        ), { config, workflowId: workflow.id })
        return waitedToolResult(result, waitMode)
      } catch (error) {
        attachWaitRecovery(error, workflow, input.waitMode)
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_review_candidate_and_wait",
    {
      description: `Review one candidate from the current ZCode, Codex, or compatible host against an immutable target. The broker performs its own canonical URL, stable-head, browser-readiness, exact binding-space recovery, and live model-policy checks; do not call ego_verify_conversation first. The complete UTF-8 review prompt has a ${MAX_PROMPT_BYTES}-byte transport budget; oversized assembled prompts are compacted deterministically and returned as continuation instead of stopping. Prefer exact accessible revision references plus focused evidence over a full diff. A stable operationId makes an exact lost-result retry rediscover its original workflow and rejects changed content. Ego Chat enforces strongest-available ChatGPT plus maximum thinking before every Send, reconciles a possibly delivered browser turn without duplication, and retries only a proven non-delivery with a fresh marker. Ordinary Markdown and imperfect formatting are continuation feedback; only the explicit settled verdict at the exact terminal marker can settle. When settled is false, nextAction and nextCycle direct the current host to address the review and continue immediately without human relay. Set waitMode to token_saver for a silent durable wait.`,
      inputSchema: AGENT_REVIEW_INPUT_SCHEMA,
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode } = input
        const initialPrepared = prepareAgentReview(input)
        const deliveryAbsentWorkflowIds = []
        const recordDeliveryAbsence = (absentWorkflow) => {
          deliveryAbsentWorkflowIds.push(absentWorkflow.id)
          return deliveryAbsenceAnchor(absentWorkflow)
        }
        const waitMs = exchangeWaitMs(input.timeoutMs)
        let anyRecoveredLateResponse = false
        let delivered
        let retryAnchor
        for (let deliveryAttempt = 1; ; deliveryAttempt += 1) {
          if (extra.signal?.aborted) {
            throw new EgoChatError(
              "client_disconnected",
              "The host disconnected before the next review operation could start.",
            )
          }
          const prepared = deliveryAttempt === 1
            ? initialPrepared
            : prepareAgentReview({
                ...input,
                deliveryAttempt,
                operationId: initialPrepared.operationId,
              })
          workflow = await requestBroker(config, "ego.start_exchange", {
            allowProtocolRepairCapture: true,
            allowTaskSpaceReclaim: true,
            bindingKey: input.bindingKey,
            ...(retryAnchor ? { expectedPreviousHead: retryAnchor } : {}),
            expectedTerminalMarker: prepared.terminalMarker,
            prompt: prepared.prompt,
            timeoutMs: input.timeoutMs,
            turnMarker: prepared.turnMarker,
          })
          const completed = await withWaitMode(
            extra,
            `Waiting for candidate review ${workflow.id} attempt ${deliveryAttempt}`,
            waitMode,
            () => requestBroker(
              config,
              "workflow.await",
              { timeoutMs: waitMs, workflowId: workflow.id },
              { signal: extra.signal, timeoutMs: waitMs + 5_000 },
            ),
            { config, workflowId: workflow.id },
          )
          let exchangeResult = completed.result
          let recoveredLateResponse = false
          if (isDurablyProvenDeliveryAbsent(completed)) {
            retryAnchor = recordDeliveryAbsence(completed)
            continue
          }
          if (
            completed.status === "human_required"
            && RECOVERABLE_AGENT_REVIEW_CODES.has(completed.humanRequired?.code)
          ) {
            const reconciled = await requestBroker(
              config,
              "conversation.reconcile",
              {
                allowProtocolRepairCapture: true,
                bindingKey: input.bindingKey,
                expectedTerminalMarker: prepared.terminalMarker,
                turnMarker: prepared.turnMarker,
                workflowId: workflow.id,
              },
              { timeoutMs: 65_000 },
            )
            if (reconciled.recovery?.deliveryState === "absent") {
              const absentWorkflow = await requestBroker(config, "workflow.get", {
                workflowId: workflow.id,
              })
              retryAnchor = recordDeliveryAbsence(absentWorkflow)
              continue
            }
            if (
              typeof reconciled.recovery?.responseText !== "string"
              || typeof reconciled.recovery?.responseDigest !== "string"
              || !reconciled.recovery.modelPolicy
            ) {
              throw new EgoChatError(
                "human_required",
                "The late ChatGPT review was attributable, but its exact response and pre-send maximum-model proof were not both recoverable.",
                { reason: "review_recovery_proof_missing", workflowId: workflow.id },
              )
            }
            exchangeResult = reconciled.recovery
            recoveredLateResponse = true
            anyRecoveredLateResponse = true
          } else if (completed.status !== "succeeded") {
            throw new EgoChatError(
              "human_required",
              "The ChatGPT browser review did not complete unambiguously.",
              {
                reason: completed.humanRequired?.code
                  ?? completed.error?.code
                  ?? "chatgpt_review_incomplete",
                workflowId: workflow.id,
              },
            )
          }
          delivered = {
            deliveryAttempt,
            exchangeResult,
            prepared,
            recoveredLateResponse,
            responseText: await resolveResponseText(config, workflow.id, exchangeResult),
            workflowId: workflow.id,
          }
          break
        }

        const { protocolNormalization, review, settled } = completeAgentReview(
          delivered.prepared,
          delivered.responseText,
        )
        return waitedToolResult({
          bindingKey: input.bindingKey,
          candidateDigest: delivered.prepared.candidateDigest,
          cycle: input.cycle,
          deliveryAbsentWorkflowIds,
          deliveryAttemptCount: delivered.deliveryAttempt,
          exchangeWorkflowId: delivered.workflowId,
          modelPolicy: delivered.exchangeResult.modelPolicy,
          nextAction: settled ? "settled" : "address_review_and_submit_next_cycle",
          ...(!settled ? { nextCycle: input.cycle + 1 } : {}),
          operationId: delivered.prepared.operationId,
          protocolNormalization,
          protocolRepairCount: 0,
          protocolRepairWorkflowIds: [],
          redactedSecretSignatures: delivered.prepared.redactedSecretSignatures,
          recoveredLateResponse: anyRecoveredLateResponse || delivered.recoveredLateResponse,
          responseDigest: delivered.exchangeResult.responseDigest,
          review,
          settled,
          targetDigest: delivered.prepared.contract.targetDigest,
          transportCompaction: delivered.prepared.transportCompaction,
        }, waitMode)
      } catch (error) {
        attachWaitRecovery(error, workflow, input.waitMode)
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_read_result",
    {
      description: "Read a digest-bound byte range from a private large ChatGPT result. Use the workflow and response reference returned by a prior Ego Chat call.",
      inputSchema: {
        expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
        maxBytes: z.number().int().min(4).max(MAX_RESULT_BYTES).default(64 * 1024),
        offset: z.number().int().min(0).max(MAX_RESULT_BYTES).default(0),
        workflowId: z.uuid(),
      },
    },
    async (input) => {
      try {
        const result = await requestBroker(config, "result.read", input)
        const { text, ...metadata } = result
        return {
          content: [{ type: "text", text }],
          structuredContent: metadata,
        }
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_start_exchange",
    {
      description: "Submit one uniquely marked prompt through a durable named ChatGPT conversation binding. The broker performs its own live checks and automatically recovers its exact binding-owned task space; do not call ego_verify_conversation first. Returns a workflow ID immediately; call await_workflow next.",
      inputSchema: EGO_EXCHANGE_INPUT_SCHEMA,
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "ego.start_exchange", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_start_convergence",
    {
      description: "Start a detached broker-owned Codex implementation and ChatGPT review loop against an immutable target and explicit acceptance criteria. This is the durable path for multi-cycle or until-settled work, including when the current host initiated it; do not call ego_verify_conversation first. The broker reserves one canonical conversation, recovers its exact binding-owned task space, enforces strongest-available ChatGPT plus maximum thinking on every review, and returns a durable workflow ID immediately. Omit maxCycles to continue until objective settlement; set it only for an explicit caller-selected cycle budget.",
      inputSchema: CONVERGENCE_INPUT_SCHEMA,
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "convergence.start", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_converge_until_settled",
    {
      description: "Run a durable broker-owned Codex implementation and ChatGPT review loop until every acceptance criterion is settled. This is the preferred path whenever the user asks for multi-cycle discussion or review until settled, even when the current host initiated the work, because broker ownership survives host detachment and restart. Recoverable browser, model-policy, protocol, task-space, App Server, and oversized-packet states remain inside the durable workflow; do not call ego_verify_conversation first. Omit maxCycles for no arbitrary cycle ceiling; set it only for an explicit caller-selected budget. wallClockTimeoutMs bounds this host attachment, not the durable workflow. The default progress mode reports deterministic phase and delivery supervision without another model; choose token_saver only for an explicitly silent wait.",
      inputSchema: {
        ...CONVERGENCE_INPUT_SCHEMA,
        waitMode: waitModeSchema(),
      },
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode, ...request } = input
        workflow = await requestBroker(config, "convergence.start", request)
        const waitMs = request.wallClockTimeoutMs ?? MAX_WAIT_MS
        const result = await withWaitMode(
          extra,
          `Waiting for convergence ${workflow.id}`,
          waitMode,
          () => requestBroker(
            config,
            "workflow.await",
            { timeoutMs: waitMs, workflowId: workflow.id },
            { signal: extra.signal, timeoutMs: waitMs + 5_000 },
          ),
          { config, workflowId: workflow.id },
        )
        return waitedToolResult(result, waitMode)
      } catch (error) {
        attachWaitRecovery(error, workflow, input.waitMode)
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "await_workflow",
    {
      description: "Attach to a durable workflow and wait for a terminal result. Safe to call again after an MCP facade or client restart.",
      inputSchema: {
        timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS),
        waitMode: waitModeSchema(),
        workflowId: z.uuid(),
      },
    },
    async (input, extra) => {
      try {
        const { waitMode, ...request } = input
        const result = await withWaitMode(extra, `Waiting for workflow ${request.workflowId}`, waitMode, () => requestBroker(
          config,
          "workflow.await",
          request,
          { signal: extra.signal, timeoutMs: Math.min(MAX_WAIT_MS + 5_000, request.timeoutMs + 5_000) },
        ), { config, workflowId: request.workflowId })
        return waitedToolResult(result, waitMode)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "workflow_status",
    {
      description: "Read the current durable state of one Ego Chat workflow without changing it.",
      inputSchema: { workflowId: z.uuid() },
    },
    async (input) => {
      try {
        return toolResult(await readSupervisedWorkflow(config, input.workflowId))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "cancel_workflow",
    {
      description: "Cancel a probe or non-sending conversation adoption cleanly. Message-sending browser and convergence workflows become human_required because visible delivery or an agent turn may be ambiguous.",
      inputSchema: { workflowId: z.uuid() },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "workflow.cancel", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "abandon_workflow_recovery",
    {
      description: "Explicitly abandon one stopped adoption, browser, or convergence recovery and release its protected capacity. This never permits the same durable operation identity to run again and requires acknowledging that visible ChatGPT delivery or a Codex turn may remain ambiguous.",
      inputSchema: {
        acknowledgePotentialDelivery: z.literal(true),
        workflowId: z.uuid(),
      },
    },
    async (input) => {
      try {
        return toolResult(await requestBroker(config, "workflow.abandon", input))
      } catch (error) {
        return toolError(error)
      }
    },
  )

  return server
}

export async function runMcpServer(config = loadConfig()) {
  const server = createMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
