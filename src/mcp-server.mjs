import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_CHATGPT_GENERATION_MS,
  MAX_RESULT_BYTES,
  MAX_WAIT_MS,
} from "./constants.mjs"
import { loadConfig } from "./config.mjs"
import { requestBroker } from "./ipc-client.mjs"
import { completeAgentReview, prepareAgentReview } from "./convergence.mjs"
import { EgoChatError, asPublicError } from "./errors.mjs"

const WAIT_MODES = ["progress", "token_saver"]
const MAX_AGENT_REVIEW_DELIVERY_ATTEMPTS = 3

function waitModeSchema(defaultMode = "progress") {
  return z.enum(WAIT_MODES).default(defaultMode)
}

const EGO_EXCHANGE_INPUT_SCHEMA = {
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
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  candidate: z.object({
    blockers: z.array(z.string().trim().min(1).max(2_000)).max(8),
    criteria: z.array(CRITERION_RESULT_SCHEMA).min(1).max(8),
    reviewPacket: z.string().trim().min(1).max(28_000),
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
  "Give every exact strict candidate review one stable operationId; reuse it only with byte-identical arguments to recover a lost tool result, and generate a new ID for any changed candidate or cycle.",
  "A strict review may retry internally with a deterministic fresh marker only after durable reconciliation proves the prior prompt was never delivered and the exact prior conversation head remains unchanged; it never retries an interleaved, ambiguous, or possibly accepted send.",
  "Use ego_converge_until_settled only when the user explicitly wants a detached broker-owned Codex implementation loop; supply an immutable target, observable acceptance criteria, and the absolute working directory.",
  "Keep post-settlement commit, push, merge, deploy, or release work outside the review target so the current host can run its normal authority and verification gates after settlement.",
  "For Token-Saver waiting, set waitMode to token_saver, keep the one tool call open, and do not poll workflow_status or await_workflow; this suppresses progress chatter but does not reduce required ChatGPT or implementing-agent reasoning.",
  "Default convergence to read-only; use workspace-write only when local implementation is authorized.",
  "Never infer commit, push, deployment, production, credential, approval, or scope-expansion authority.",
  "Never retry an ambiguous send. A strict review may perform one evidence-only reconciliation of its exact durable workflow and markers, and may retry only a proven delivery absence; otherwise surface the exact human_required stop.",
  "Never abandon a stopped recovery unless the user explicitly authorizes that exact workflow and acknowledges that visible ChatGPT delivery or a Codex turn may remain ambiguous; abandonment preserves any at-most-once operation tombstone.",
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
      description: "Read one durable named ChatGPT conversation binding without changing browser or broker state.",
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
    "ego_verify_conversation",
    {
      description: "Verify the canonical URL and stable conversation head for a named binding. Establishes the first head checkpoint for a reconciled or migrated binding; otherwise rejects any mismatch.",
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
      description: "Send one uniquely marked free-form prompt through a durable named ChatGPT binding and return the complete captured review into this same agent turn. Set waitMode to token_saver for one silent durable wait without progress chatter.",
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
      description: "Review one schema-constrained candidate from the current ZCode, Codex, or compatible host against an immutable target. A stable operationId makes an exact lost-result retry rediscover its original workflow and rejects changed content. Ego Chat creates exact target/candidate/cycle digests, enforces strongest-available ChatGPT plus maximum thinking before the send, reconciles a completed late browser turn without resending, and retries a proven non-delivery only with a deterministic fresh marker and unchanged prior-head anchor. It validates the strict review envelope and returns settled only when every criterion passes with no blocking finding. Set waitMode to token_saver for a silent durable wait.",
      inputSchema: AGENT_REVIEW_INPUT_SCHEMA,
    },
    async (input, extra) => {
      let workflow
      try {
        const { waitMode } = input
        const initialPrepared = prepareAgentReview(input)
        const deliveryAbsentWorkflowIds = []
        let retryAnchor
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
            retryAnchor = deliveryAbsenceAnchor(completed)
            deliveryAbsentWorkflowIds.push(workflow.id)
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
              retryAnchor = deliveryAbsenceAnchor(workflow)
              deliveryAbsentWorkflowIds.push(workflow.id)
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
          const { review, settled } = completeAgentReview(prepared, responseText)
          return waitedToolResult({
            bindingKey: input.bindingKey,
            candidateDigest: prepared.candidateDigest,
            cycle: input.cycle,
            deliveryAbsentWorkflowIds,
            deliveryAttemptCount: deliveryAttempt,
            exchangeWorkflowId: workflow.id,
            modelPolicy: exchangeResult.modelPolicy,
            operationId: prepared.operationId,
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
      description: "Submit one uniquely marked prompt through a durable named ChatGPT conversation binding. Returns a workflow ID immediately; call await_workflow next.",
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
      description: "Start a detached broker-owned Codex implementation and ChatGPT review loop against an immutable target and explicit acceptance criteria. Use this only when the current host task is not the implementation owner. It reserves one canonical conversation, enforces strongest-available ChatGPT plus maximum thinking on every review, and returns a durable workflow ID immediately.",
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
      description: "Run a detached broker-owned Codex implementation and ChatGPT review loop until every acceptance criterion is independently settled or a fail-closed stop requires human reconciliation. When the current Codex or ZCode task owns the candidate, use ego_review_candidate_and_wait instead. Set waitMode to token_saver to suppress progress chatter while broker ownership continues.",
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
