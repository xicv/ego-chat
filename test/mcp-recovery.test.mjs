import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { loadOrCreateBrokerToken } from "../src/auth-token.mjs"
import { Broker } from "../src/broker.mjs"
import { prepareAgentReview } from "../src/convergence.mjs"
import { EgoChatError } from "../src/errors.mjs"
import { startIpcServer } from "../src/ipc-server.mjs"
import { EventStore } from "../src/store.mjs"
import {
  MCP_PATH,
  createTestConfig,
  removeTestConfig,
  stopTestDaemon,
} from "./helpers.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function modelPolicyObservation() {
  return {
    adjusted: false,
    effortLabel: "Pro",
    key: "chatgpt-web-default",
    modelLabel: "GPT-5.6 Sol",
    pillLabel: "Pro",
    powerLevel: 5,
    powerMax: 5,
  }
}

function strictReviewResponse(input) {
  const candidateDigest = input.prompt.match(/Candidate digest: ([a-f0-9]{64})/)?.[1]
  const cycle = Number(input.prompt.match(/Cycle: (\d+)/)?.[1])
  const targetDigest = input.prompt.match(/Target digest: ([a-f0-9]{64})/)?.[1]
  assert.match(candidateDigest, /^[a-f0-9]{64}$/)
  assert.match(targetDigest, /^[a-f0-9]{64}$/)
  assert.equal(Number.isInteger(cycle), true)
  return `${JSON.stringify({
    candidateDigest,
    criteria: [{ evidence: "The controlled candidate meets AC-1.", id: "AC-1", status: "pass" }],
    cycle,
    decision: "settled",
    findings: [],
    summary: "The controlled strict review is settled.",
    targetDigest,
  })}\n${input.expectedTerminalMarker}`
}

function reviewInput(label) {
  return {
    acceptanceCriteria: ["The controlled candidate passes its exact criterion."],
    bindingKey: "ego-chat-main",
    candidate: {
      blockers: [],
      criteria: [{ evidence: `Controlled evidence for ${label}.`, id: "AC-1", status: "pass" }],
      reviewPacket: `Controlled review packet for ${label}.`,
      status: "candidate",
      summary: `Controlled candidate ${label}.`,
    },
    cycle: 1,
    target: `Settle controlled candidate ${label}.`,
    timeoutMs: 30_000,
  }
}

async function connectClient(env) {
  const transport = new StdioClientTransport({
    args: [MCP_PATH],
    command: process.execPath,
    env,
    stderr: "pipe",
  })
  const client = new Client({ name: "ego-chat-test", version: "1.0.0" })
  await client.connect(transport)
  return client
}

test("a new MCP facade reattaches to a broker workflow after the first facade exits", async (t) => {
  const { config, env } = await createTestConfig()
  t.after(async () => {
    await stopTestDaemon(config)
    await removeTestConfig(config)
  })

  const firstClient = await connectClient(env)
  const tools = await firstClient.listTools()
  assert.match(firstClient.getInstructions(), /binding ego-chat-main/)
  assert.match(firstClient.getInstructions(), /ego_converge_until_settled/)
  assert.ok(tools.tools.some((tool) => tool.name === "ego_exchange_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_review_candidate_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_ensure_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_get_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_start_convergence"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_converge_until_settled"))
  const modelPolicy = await firstClient.callTool({
    arguments: {},
    name: "ego_get_model_policy",
  })
  assert.equal(modelPolicy.isError, undefined)
  assert.equal(modelPolicy.structuredContent.modelSelection, "strongest_available")
  assert.equal(modelPolicy.structuredContent.thinkingEffort, "maximum_available")
  const started = await firstClient.callTool({
    arguments: { delayMs: 1_200, value: "facade-recovery" },
    name: "gate0_start_probe",
  })
  const workflowId = started.structuredContent.id
  await firstClient.close()

  const secondClient = await connectClient(env)
  t.after(() => secondClient.close())
  const completed = await secondClient.callTool({
    arguments: { timeoutMs: 5_000, workflowId },
    name: "await_workflow",
  })

  assert.equal(completed.isError, undefined)
  assert.equal(completed.structuredContent.status, "succeeded")
  assert.equal(completed.structuredContent.result.text, "facade-recovery")
})

test("strict candidate review crosses MCP, validates settlement, and reconciles without resending", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/controlled-mcp-review"
  const responseDigests = new Map()
  let exchanges = 0
  let pendingRecovery = null
  let reconciliations = 0
  const egoAdapter = {
    bind: async () => ({
      canonicalUrl,
      head: {
        fingerprint: "controlled-head-0",
        fingerprintVersion: "tail-v1",
        lastContentDigest: "0".repeat(64),
        lastMessageId: "controlled-assistant-0",
        lastRole: "assistant",
        messageCount: 2,
      },
      targetId: "controlled-tab",
      taskSpaceId: 10,
    }),
    exchange: async (input) => {
      exchanges += 1
      const responseText = strictReviewResponse(input)
      responseDigests.set(exchanges, digest(responseText))
      if (exchanges === 3) {
        pendingRecovery = { kind: "recover", responseText }
        throw new EgoChatError(
          "human_required",
          "The completed pair was captured late.",
          {
            evidence: { modelPolicy: modelPolicyObservation() },
            reason: "conversation_head_commit_mismatch",
          },
        )
      }
      if (exchanges === 4) {
        pendingRecovery = { kind: "reject", responseText }
        throw new EgoChatError(
          "human_required",
          "The send confirmation was ambiguous.",
          {
            evidence: { modelPolicy: modelPolicyObservation() },
            reason: "send_confirmation_ambiguous",
          },
        )
      }
      const returnedText = exchanges === 2
        ? `not-json\n${input.expectedTerminalMarker}`
        : responseText
      responseDigests.set(exchanges, digest(returnedText))
      return {
        canonicalUrl,
        head: {
          fingerprint: `controlled-head-${exchanges}`,
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(returnedText),
          lastMessageId: `controlled-assistant-${exchanges}`,
          lastRole: "assistant",
          messageCount: input.binding.messageCount + 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest: digest(returnedText),
        responseText: returnedText,
        targetId: "controlled-tab",
        taskSpaceId: 10,
        turnMarker: input.turnMarker,
      }
    },
    reconcileBound: async (input) => {
      reconciliations += 1
      assert.ok(pendingRecovery)
      assert.equal(input.turnMarker.length > 20, true)
      assert.equal(input.expectedTerminalMarker.length > 20, true)
      if (pendingRecovery.kind === "reject") {
        throw new EgoChatError(
          "human_required",
          "The browser pair is not attributable.",
          { reason: "bound_reconciliation_mismatch" },
        )
      }
      const responseText = pendingRecovery.responseText
      pendingRecovery = null
      return {
        canonicalUrl,
        head: {
          fingerprint: `controlled-reconciled-head-${reconciliations}`,
          fingerprintVersion: "tail-v1",
          lastContentDigest: digest(responseText),
          lastMessageId: `controlled-reconciled-assistant-${reconciliations}`,
          lastRole: "assistant",
          messageCount: input.binding.messageCount + 2,
        },
        responseDigest: digest(responseText),
        responseText,
        targetId: "controlled-tab",
        taskSpaceId: 10,
      }
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  await broker.bindConversation({
    bindingKey: "ego-chat-main",
    canonicalUrl,
    mode: "existing",
    taskSpace: 10,
  })
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["conversation.reconcile", (params) => broker.reconcileConversation(params)],
    ["ego.start_exchange", (params) => broker.startEgoExchange(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled test method.")
      }
      return handler(params, signal)
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    broker.close()
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const directInput = reviewInput("direct")
  const expectedDirect = prepareAgentReview({
    ...directInput,
    markerToken: "A".repeat(32),
  })
  const settled = await client.callTool({
    arguments: directInput,
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(settled.isError, undefined)
  assert.equal(settled.structuredContent.settled, true)
  assert.equal(settled.structuredContent.recoveredLateResponse, false)
  assert.equal(settled.structuredContent.modelPolicy.modelLabel, "GPT-5.6 Sol")
  assert.equal(settled.structuredContent.responseDigest, responseDigests.get(1))
  assert.equal(settled.structuredContent.candidateDigest, expectedDirect.candidateDigest)
  assert.equal(settled.structuredContent.targetDigest, expectedDirect.contract.targetDigest)
  assert.equal(settled.structuredContent.review.candidateDigest, expectedDirect.candidateDigest)
  assert.equal(settled.structuredContent.review.targetDigest, expectedDirect.contract.targetDigest)

  const malformed = await client.callTool({
    arguments: reviewInput("malformed"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(malformed.isError, true)
  assert.equal(JSON.parse(malformed.content[0].text).details.reason, "convergence_protocol_invalid")

  const recovered = await client.callTool({
    arguments: reviewInput("late-recovery"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(recovered.isError, undefined)
  assert.equal(recovered.structuredContent.settled, true)
  assert.equal(recovered.structuredContent.recoveredLateResponse, true)
  assert.equal(recovered.structuredContent.modelPolicy.powerLevel, 5)
  assert.equal(recovered.structuredContent.responseDigest, responseDigests.get(3))

  const ambiguous = await client.callTool({
    arguments: reviewInput("ambiguous"),
    name: "ego_review_candidate_and_wait",
  })
  assert.equal(ambiguous.isError, true)
  assert.equal(JSON.parse(ambiguous.content[0].text).details.reason, "bound_reconciliation_mismatch")
  assert.equal(exchanges, 4)
  assert.equal(reconciliations, 2)
})
