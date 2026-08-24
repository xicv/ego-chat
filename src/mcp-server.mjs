import { randomUUID } from "node:crypto"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"

import { APP_NAME, APP_VERSION, MAX_WAIT_MS } from "./constants.mjs"
import { loadConfig } from "./config.mjs"
import { requestBroker } from "./ipc-client.mjs"
import { completeAgentReview, prepareAgentReview } from "./convergence.mjs"
import { EgoChatError, asPublicError } from "./errors.mjs"

const EGO_EXCHANGE_INPUT_SCHEMA = {
  bindingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  expectedTerminalMarker: z.string().min(1).max(200),
  prompt: z.string().min(1).max(64 * 1024),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS),
  turnMarker: z.string().regex(/^EGO_CHAT_[A-Z0-9_-]{8,160}$/),
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
  target: z.string().trim().min(1).max(8_000),
  timeoutMs: z.number().int().min(30_000).max(MAX_WAIT_MS).default(15 * 60 * 1_000),
}

const MCP_INSTRUCTIONS = [
  "Use binding ego-chat-main unless the user explicitly names another binding.",
  "For one free-form ChatGPT review returned to the current agent turn, use ego_exchange_and_wait.",
  "For a strict candidate review while the current ZCode or other agent remains the implementer, use ego_review_candidate_and_wait and continue in that same host task until settled.",
  "For broker-owned automatic Codex/ChatGPT convergence, use ego_converge_until_settled with an immutable target, observable acceptance criteria, and the absolute working directory.",
  "Default convergence to read-only; use workspace-write only when local implementation is authorized.",
  "Never infer commit, push, deployment, production, credential, approval, or scope-expansion authority.",
  "If a browser workflow returns human_required, surface the exact stop and never retry an ambiguous send.",
].join(" ")

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
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

export function createMcpServer(config = loadConfig()) {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { instructions: MCP_INSTRUCTIONS },
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
      },
    },
    async (input, extra) => {
      try {
        const workflow = await requestBroker(config, "workflow.start_probe", input)
        const result = await withProgress(extra, `Waiting for workflow ${workflow.id}`, () => requestBroker(
          config,
          "workflow.await",
          { timeoutMs: Math.min(MAX_WAIT_MS, input.delayMs + 60_000), workflowId: workflow.id },
          {
            signal: extra.signal,
            timeoutMs: Math.min(MAX_WAIT_MS, input.delayMs + 65_000),
          },
        ))
        return toolResult(result)
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
      description: "Reconcile an attributable late browser send without sending again. Supports create-once promotion and a bound workflow's exact tail-anchored user/assistant pair; never resurrects the stopped workflow.",
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
      description: "Send one uniquely marked free-form prompt through a durable named ChatGPT binding, wait with progress notifications, and return the complete captured review into this same agent turn.",
      inputSchema: EGO_EXCHANGE_INPUT_SCHEMA,
    },
    async (input, extra) => {
      try {
        const workflow = await requestBroker(config, "ego.start_exchange", input)
        const waitMs = Math.min(MAX_WAIT_MS, input.timeoutMs + 60_000)
        const result = await withProgress(extra, `Waiting for Ego exchange ${workflow.id}`, () => requestBroker(
          config,
          "workflow.await",
          { timeoutMs: waitMs, workflowId: workflow.id },
          { signal: extra.signal, timeoutMs: waitMs + 5_000 },
        ))
        return toolResult(result)
      } catch (error) {
        return toolError(error)
      }
    },
  )

  server.registerTool(
    "ego_review_candidate_and_wait",
    {
      description: "Review one schema-constrained candidate from the current ZCode, Codex, or compatible host against an immutable target. Ego Chat creates exact target/candidate/cycle digests, enforces strongest-available ChatGPT plus maximum thinking before the send, validates the strict review envelope, and returns settled only when every criterion passes with no blocking finding.",
      inputSchema: AGENT_REVIEW_INPUT_SCHEMA,
    },
    async (input, extra) => {
      try {
        const markerToken = randomUUID().replaceAll("-", "").toUpperCase()
        const prepared = prepareAgentReview({ ...input, markerToken })
        const workflow = await requestBroker(config, "ego.start_exchange", {
          bindingKey: input.bindingKey,
          expectedTerminalMarker: prepared.terminalMarker,
          prompt: prepared.prompt,
          timeoutMs: input.timeoutMs,
          turnMarker: prepared.turnMarker,
        })
        const waitMs = Math.min(MAX_WAIT_MS, input.timeoutMs + 60_000)
        const completed = await withProgress(
          extra,
          `Waiting for strict candidate review ${workflow.id}`,
          () => requestBroker(
            config,
            "workflow.await",
            { timeoutMs: waitMs, workflowId: workflow.id },
            { signal: extra.signal, timeoutMs: waitMs + 5_000 },
          ),
        )
        if (completed.status !== "succeeded") {
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
        const { review, settled } = completeAgentReview(prepared, completed.result.responseText)
        return toolResult({
          bindingKey: input.bindingKey,
          candidateDigest: prepared.candidateDigest,
          cycle: input.cycle,
          exchangeWorkflowId: workflow.id,
          modelPolicy: completed.result.modelPolicy,
          responseDigest: completed.result.digest,
          review,
          settled,
          targetDigest: prepared.contract.targetDigest,
        })
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
      description: "Start a broker-owned Codex/ChatGPT convergence loop against an immutable target and explicit acceptance criteria. It reserves one canonical conversation, enforces strongest-available ChatGPT plus maximum thinking on every review, and returns a durable workflow ID immediately.",
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
      description: "Run the bounded Codex/ChatGPT loop and wait until every acceptance criterion is independently settled or a fail-closed stop requires human reconciliation. Caller disconnect does not cancel broker ownership.",
      inputSchema: CONVERGENCE_INPUT_SCHEMA,
    },
    async (input, extra) => {
      try {
        const workflow = await requestBroker(config, "convergence.start", input)
        const waitMs = input.wallClockTimeoutMs ?? MAX_WAIT_MS
        const result = await withProgress(
          extra,
          `Waiting for convergence ${workflow.id}`,
          () => requestBroker(
            config,
            "workflow.await",
            { timeoutMs: waitMs, workflowId: workflow.id },
            { signal: extra.signal, timeoutMs: waitMs + 5_000 },
          ),
        )
        return toolResult(result)
      } catch (error) {
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
        workflowId: z.uuid(),
      },
    },
    async (input, extra) => {
      try {
        const result = await withProgress(extra, `Waiting for workflow ${input.workflowId}`, () => requestBroker(
          config,
          "workflow.await",
          input,
          { signal: extra.signal, timeoutMs: Math.min(MAX_WAIT_MS + 5_000, input.timeoutMs + 5_000) },
        ))
        return toolResult(result)
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
      description: "Cancel a probe. Browser and convergence workflows become human_required because an agent turn or visible delivery may be ambiguous.",
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

  return server
}

export async function runMcpServer(config = loadConfig()) {
  const server = createMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
