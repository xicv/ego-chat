import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_CHATGPT_GENERATION_MS,
  MAX_PROMPT_BYTES,
  MAX_RESULT_BYTES,
  MAX_WAIT_MS,
} from "./constants.mjs"
import { loadConfig } from "./config.mjs"
import { requestBroker } from "./ipc-client.mjs"
import { completeAgentReview, prepareAgentReview } from "./convergence.mjs"
import { EgoChatError, asPublicError } from "./errors.mjs"

const WAIT_MODES = ["progress", "token_saver"]
const MAX_AGENT_REVIEW_DELIVERY_ATTEMPTS = 3
const SUGGESTED_COMPACT_REVIEW_PACKET_BYTES = 16 * 1024
const COMPOSER_TRANSPORT_STAGES = new Set([
  "anchoring_prompt_chunk",
  "inserting_prompt_chunk",
  "inserting_prompt_content",
])

function waitModeSchema(defaultMode = "progress") {
  return z.enum(WAIT_MODES).default(defaultMode)
}

const EGO_EXCHANGE_INPUT_SCHEMA = {
  allowTaskSpaceReclaim: z.literal(true).optional().describe("Set only when the user explicitly authorizes Ego Chat to reclaim the exact deterministic task space owned by this binding before a fresh Send. This authority never applies after Send or during capture/reconciliation."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  expectedTerminalMarker: z.string().min(1).max(200),
  prompt: z.string().min(1).max(64 * 1024),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS),
  turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/),
}

const CONVERSATION_ADOPTION_INPUT_SCHEMA = {
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
  allowTaskSpaceReclaim: z.literal(true).optional().describe("Set only when the user explicitly authorizes every fresh ChatGPT review cycle to reclaim this binding's exact deterministic Ego task space. It never authorizes capture/reconciliation takeover."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  chatGptTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000),
  codexSandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  codexTurnTimeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000),
  cwd: z.string().min(1).max(1_024),
  maxCycles: z.number().int().min(1).max(6).default(4),
  target: z.string().trim().min(1).max(8_000),
  wallClockTimeoutMs: z.number().int().min(120_000).max(MAX_WAIT_MS).default(MAX_WAIT_MS),
}

const CRITERION_RESULT_SCHEMA = z.object({
  evidence: z.string().trim().min(1).max(4_000),
  id: z.string().regex(/^AC-[1-8]$/),
  status: z.enum(["pass", "fail", "unknown"]),
}).strict()

const AGENT_REVIEW_INPUT_SCHEMA = {
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(8),
  allowTaskSpaceReclaim: z.literal(true).optional().describe("Set only when the user explicitly authorizes this fresh review send to reclaim the exact deterministic Ego task space owned by the binding. It never authorizes post-Send takeover."),
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  candidate: z.object({
    blockers: z.array(z.string().trim().min(1).max(2_000)).max(8),
    criteria: z.array(CRITERION_RESULT_SCHEMA).min(1).max(8),
    reviewPacket: z.string().trim().min(1).max(MAX_PROMPT_BYTES),
    status: z.enum(["candidate", "blocked"]),
    summary: z.string().trim().min(1).max(4_000),
  }).strict(),
  cycle: z.number().int().min(1).max(6),
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
  "When the user supplies a private canonical ChatGPT /c/ URL to continue, adopt it with ego_adopt_conversation_and_wait and omit bindingKey unless the user names one; use ego_start_conversation_adoption only when detachment is required.",
  "For one free-form ChatGPT review returned to the current agent turn, use ego_exchange_and_wait.",
  "When the current Codex or ZCode task remains the implementer, use ego_review_candidate_and_wait once per candidate and continue in that same host task until settled; do not spawn a nested broker-owned Codex task just to review work the current task already owns.",
  "A successful strict review with settled false is a machine continuation, not a stopping condition. Read its complete review, address the in-scope blocking findings, and immediately submit nextCycle in the same host task without asking the user to relay or approve the review. A protocolNormalization result records a bounded local schema normalization and does not require another browser send.",
  `Finalize and UTF-8 byte-check a strict review packet before creating its operationId. The complete generated review prompt, including protocol overhead, must not exceed ${MAX_PROMPT_BYTES} bytes; prefer an accessible PR URL plus exact revisions, changed-file inventory, critical excerpts, tests, and unresolved risks over an entire diff. Never split one candidate across multiple sends automatically.`,
  "Give every exact strict candidate review one stable operationId; reuse it only with byte-identical arguments to recover a lost tool result, and generate a new ID for any changed candidate or cycle.",
  "A strict review may retry internally with a deterministic fresh marker only after durable reconciliation proves the prior prompt was never delivered and the exact prior conversation head remains unchanged; it never retries an interleaved, ambiguous, or possibly accepted send.",
  "When the user explicitly authorizes reclaiming the exact binding-owned Ego task space, including an explicit request for Ego Chat to take it back for an unattended until-settled loop, set allowTaskSpaceReclaim to true on every fresh review cycle. This permits one verified pre-Send claim or take-back of only the deterministic binding space; it never applies to capture, reconciliation, another task space, or a possibly delivered operation.",
  "Never call ego_verify_conversation as a preflight for a fresh send. A fresh exchange or review performs its own canonical URL, stable-head, browser-readiness, and live model-policy checks, and is the only operation that may apply an explicitly authorized task-space reclaim. If binding identity is uncertain before a send, use ego_get_conversation instead because it reads durable state without browser control. Reserve ego_verify_conversation for an explicitly requested maintenance checkpoint or a documented migration or reconciliation case.",
  `If ego_review_candidate_and_wait returns review_packet_compaction_required, both prior deliveries were durably proven absent and no human action is required. Automatically rebuild one semantically complete review packet no larger than the returned suggestedReviewPacketMaxBytes (normally ${SUGGESTED_COMPACT_REVIEW_PACKET_BYTES}), mint a new operationId, and retry once on the same binding. Do not ask the user to log in, open ego-chat-main, or provide another conversation URL unless the exact broker code is authentication_required. Never substitute another conversation to route around a delivery fault.`,
  "Use ego_converge_until_settled only when the user explicitly wants a detached broker-owned Codex implementation loop; supply an immutable target, observable acceptance criteria, and the absolute working directory.",
  "Keep post-settlement commit, push, merge, deploy, or release work outside the review target so the current host can run its normal authority and verification gates after settlement.",
  "For Token-Saver waiting, set waitMode to token_saver, keep the one tool call open, and do not poll workflow_status or await_workflow; this suppresses progress chatter but does not reduce required ChatGPT or implementing-agent reasoning.",
  "Default convergence to read-only; use workspace-write only when local implementation is authorized.",
  "Never infer commit, push, deployment, production, credential, approval, or scope-expansion authority.",
  "Never retry an ambiguous send. A strict review may perform one evidence-only reconciliation of its exact durable workflow and markers, and may retry only a proven delivery absence; otherwise surface the exact human_required stop.",
  "Never abandon a stopped recovery unless the user explicitly authorizes that exact workflow and acknowledges that visible ChatGPT delivery or a Codex turn may remain ambiguous; abandonment preserves any at-most-once operation tombstone.",
  "A conversation_head_changed stop is not retryable. Only after the user explicitly authorizes accepting that exact stable external head may ego_reanchor_conversation advance the binding, using the stopped workflow ID, binding revision, and observed fingerprint returned by the broker. Never re-anchor an ambiguous or possibly sent workflow.",
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

function deliveryAbsenceEvidence(workflow, prompt) {
  const interruption = workflow?.reconciliation?.browserInterruption
  if (!interruption || typeof interruption !== "object") {
    return null
  }
  return {
    ...(typeof interruption.compositionMethod === "string"
      ? { compositionMethod: interruption.compositionMethod }
      : {}),
    ...(typeof interruption.diagnosticDigest === "string"
      ? { diagnosticDigest: interruption.diagnosticDigest }
      : {}),
    ...(typeof interruption.draftCleared === "boolean"
      ? { draftCleared: interruption.draftCleared }
      : {}),
    ...(typeof interruption.driverStage === "string"
      ? { driverStage: interruption.driverStage }
      : {}),
    ...(typeof interruption.errorCode === "string"
      ? { errorCode: interruption.errorCode }
      : {}),
    promptBytes: Number.isSafeInteger(interruption.promptBytes)
      ? interruption.promptBytes
      : Buffer.byteLength(prompt, "utf8"),
    promptCharacters: Number.isSafeInteger(interruption.promptCharacters)
      ? interruption.promptCharacters
      : prompt.length,
  }
}

function repeatedComposerTransportFailure(attempts) {
  if (attempts.length < 2) {
    return false
  }
  const previous = attempts.at(-2)
  const current = attempts.at(-1)
  return Boolean(
    previous
    && current
    && COMPOSER_TRANSPORT_STAGES.has(previous.driverStage)
    && current.driverStage === previous.driverStage
    && typeof previous.diagnosticDigest === "string"
    && current.diagnosticDigest === previous.diagnosticDigest
    && current.errorCode === previous.errorCode
    && current.compositionMethod === previous.compositionMethod
    && current.promptBytes === previous.promptBytes,
  )
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
    throw new EgoChatError("result_too_large", "The ChatGPT review exceeded the supported strict-review size.")
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

async function withProgress(extra, description, operation) {
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    if (extra._meta?.progressToken !== undefined) {
      extra.sendNotification({
        method: "notifications/progress",
        params: {
          message: `${description}; the broker-owned workflow remains attachable`,
          progress,
          progressToken: extra._meta.progressToken,
        },
      }).catch(() => {})
    }
  }, 25_000)

  try {
    return await operation()
  } finally {
    clearInterval(timer)
  }
}

async function withWaitMode(extra, description, waitMode, operation) {
  if (waitMode === "token_saver") {
    return operation()
  }
  return withProgress(extra, description, operation)
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
        ))
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
      description: "Send one uniquely marked free-form prompt through a durable named ChatGPT binding and return the complete captured review into this same agent turn. This fresh send performs its own canonical URL, stable-head, browser-readiness, and live model-policy checks; do not call ego_verify_conversation first. Set waitMode to token_saver for one silent durable wait without progress chatter. Set allowTaskSpaceReclaim only after explicit user authorization to recover the binding-owned space before this fresh Send.",
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
        ))
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
      description: `Review one schema-constrained candidate from the current ZCode, Codex, or compatible host against an immutable target. This fresh review performs its own canonical URL, stable-head, browser-readiness, and live model-policy checks; do not call ego_verify_conversation first. The complete UTF-8 review prompt is limited to ${MAX_PROMPT_BYTES} bytes; finalize the packet before minting operationId and prefer exact accessible revision references plus focused evidence over a full diff. Ego Chat never auto-splits a candidate across sends. A stable operationId makes an exact lost-result retry rediscover its original workflow and rejects changed content. Ego Chat creates exact target/candidate/cycle digests, enforces strongest-available ChatGPT plus maximum thinking before the send, reconciles a completed late browser turn without resending, and retries a proven non-delivery only with a deterministic fresh marker and unchanged prior-head anchor. It validates the strict review envelope and returns settled only when every criterion passes with no blocking finding. When settled is false, nextAction and nextCycle direct the current host to address the complete returned review and continue immediately without human relay. Set allowTaskSpaceReclaim only after explicit user authorization to recover the binding-owned space before each fresh review Send. Set waitMode to token_saver for a silent durable wait.`,
      inputSchema: AGENT_REVIEW_INPUT_SCHEMA,
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode } = input
        const initialPrepared = prepareAgentReview(input)
        const deliveryAbsenceAttempts = []
        const deliveryAbsentWorkflowIds = []
        let retryAnchor
        const recordDeliveryAbsence = (absentWorkflow, prepared, deliveryAttempt) => {
          retryAnchor = deliveryAbsenceAnchor(absentWorkflow)
          deliveryAbsenceAttempts.push(deliveryAbsenceEvidence(absentWorkflow, prepared.prompt))
          deliveryAbsentWorkflowIds.push(absentWorkflow.id)
          if (
            Buffer.byteLength(input.candidate.reviewPacket, "utf8")
              > SUGGESTED_COMPACT_REVIEW_PACKET_BYTES
            && repeatedComposerTransportFailure(deliveryAbsenceAttempts)
          ) {
            throw new EgoChatError(
              "review_packet_compaction_required",
              "Repeated identical pre-send composer transport failures were durably proven not delivered. Rebuild one compact review packet and retry automatically on the same binding without human intervention.",
              {
                browserInterruption: deliveryAbsenceAttempts.at(-1),
                deliveryAbsentWorkflowIds,
                deliveryAttemptCount: deliveryAttempt,
                deliveryState: "absent",
                ...(absentWorkflow.reconciliation?.modelPolicyObservation
                  ? { modelPolicy: absentWorkflow.reconciliation.modelPolicyObservation }
                  : {}),
                newOperationIdRequired: true,
                reason: "repeated_presend_composer_transport_failure",
                sameBindingRequired: true,
                suggestedReviewPacketMaxBytes: SUGGESTED_COMPACT_REVIEW_PACKET_BYTES,
                userActionRequired: false,
              },
            )
          }
        }
        const waitMs = exchangeWaitMs(input.timeoutMs)
        for (
          let deliveryAttempt = 1;
          deliveryAttempt <= MAX_AGENT_REVIEW_DELIVERY_ATTEMPTS;
          deliveryAttempt += 1
        ) {
          if (extra.signal?.aborted) {
            throw new EgoChatError(
              "client_disconnected",
              "The host disconnected before the next proven-absent review attempt could start.",
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
            ...(input.allowTaskSpaceReclaim ? { allowTaskSpaceReclaim: true } : {}),
            bindingKey: input.bindingKey,
            ...(deliveryAttempt > 1 ? { expectedPreviousHead: retryAnchor } : {}),
            expectedTerminalMarker: prepared.terminalMarker,
            prompt: prepared.prompt,
            timeoutMs: input.timeoutMs,
            turnMarker: prepared.turnMarker,
          })
          const completed = await withWaitMode(
            extra,
            `Waiting for strict candidate review ${workflow.id} attempt ${deliveryAttempt}`,
            waitMode,
            () => requestBroker(
              config,
              "workflow.await",
              { timeoutMs: waitMs, workflowId: workflow.id },
              { signal: extra.signal, timeoutMs: waitMs + 5_000 },
            ),
          )
          let exchangeResult = completed.result
          let recoveredLateResponse = false
          if (isDurablyProvenDeliveryAbsent(completed)) {
            recordDeliveryAbsence(completed, prepared, deliveryAttempt)
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
              recordDeliveryAbsence(absentWorkflow, prepared, deliveryAttempt)
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
          const responseText = await resolveResponseText(config, workflow.id, exchangeResult)
          const { protocolNormalization, review, settled } = completeAgentReview(prepared, responseText)
          const canContinue = !settled && input.cycle < 6
          return waitedToolResult({
            bindingKey: input.bindingKey,
            candidateDigest: prepared.candidateDigest,
            cycle: input.cycle,
            deliveryAbsentWorkflowIds,
            deliveryAttemptCount: deliveryAttempt,
            exchangeWorkflowId: workflow.id,
            modelPolicy: exchangeResult.modelPolicy,
            nextAction: settled
              ? "settled"
              : (canContinue
                  ? "address_review_and_submit_next_cycle"
                  : "cycle_limit_reached"),
            ...(canContinue ? { nextCycle: input.cycle + 1 } : {}),
            operationId: prepared.operationId,
            protocolNormalization,
            recoveredLateResponse,
            responseDigest: exchangeResult.responseDigest,
            review,
            settled,
            targetDigest: prepared.contract.targetDigest,
          }, waitMode)
        }
        throw new EgoChatError(
          "human_required",
          "ChatGPT review delivery was proven absent for every bounded automatic attempt.",
          {
            browserInterruptions: deliveryAbsenceAttempts.filter(Boolean),
            deliveryAbsentWorkflowIds,
            deliveryAttemptCount: MAX_AGENT_REVIEW_DELIVERY_ATTEMPTS,
            reason: "review_delivery_retries_exhausted",
            workflowId: workflow?.id,
          },
        )
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
      description: "Submit one uniquely marked prompt through a durable named ChatGPT conversation binding. This fresh send performs its own live checks; do not call ego_verify_conversation first. Returns a workflow ID immediately; call await_workflow next. Set allowTaskSpaceReclaim only after explicit user authorization to recover the binding-owned space before this fresh Send.",
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
      description: "Start a detached broker-owned Codex implementation and ChatGPT review loop against an immutable target and explicit acceptance criteria. Use this only when the current host task is not the implementation owner. Each fresh review performs its own live checks; do not call ego_verify_conversation first. It reserves one canonical conversation, enforces strongest-available ChatGPT plus maximum thinking on every review, and returns a durable workflow ID immediately. Set allowTaskSpaceReclaim only after explicit user authorization to recover the exact binding-owned space before each fresh review Send.",
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
      description: "Run a detached broker-owned Codex implementation and ChatGPT review loop until every acceptance criterion is independently settled or a fail-closed stop requires human reconciliation. When the current Codex or ZCode task owns the candidate, use ego_review_candidate_and_wait instead. Each fresh review performs its own live checks; do not call ego_verify_conversation first. Set allowTaskSpaceReclaim only after explicit user authorization to recover the exact binding-owned space before each fresh review Send. Set waitMode to token_saver to suppress progress chatter while broker ownership continues.",
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
        ))
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
        return toolResult(await requestBroker(config, "workflow.get", input))
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
