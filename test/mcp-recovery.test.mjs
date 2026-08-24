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
    waitMode: "token_saver",
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
  assert.ok(tools.tools.some((tool) => tool.name === "ego_adopt_conversation_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_start_conversation_adoption"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_review_candidate_and_wait"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_ensure_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_get_model_policy"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_start_convergence"))
  assert.ok(tools.tools.some((tool) => tool.name === "ego_converge_until_settled"))
  for (const toolName of [
    "ego_adopt_conversation_and_wait",
    "ego_exchange_and_wait",
    "ego_review_candidate_and_wait",
    "ego_converge_until_settled",
    "await_workflow",
  ]) {
    const waitMode = tools.tools.find((tool) => tool.name === toolName)
      ?.inputSchema?.properties?.waitMode
    assert.deepEqual(waitMode?.enum, ["progress", "token_saver"])
  }
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
    arguments: { timeoutMs: 5_000, waitMode: "token_saver", workflowId },
    name: "await_workflow",
  })

  assert.equal(completed.isError, undefined)
  assert.equal(completed.structuredContent.status, "succeeded")
  assert.equal(completed.structuredContent.result.text, "facade-recovery")
  assert.equal(completed.structuredContent.waitMode, "token_saver")
  assert.equal(completed.content[0].text.includes("\n"), false)
})

test("conversation adoption returns the stable ChatGPT tail into the same MCP turn", async (t) => {
  const { config, env } = await createTestConfig()
  const canonicalUrl = "https://chatgpt.com/c/mcp-adoption"
  const derivedBindingKey = `adopt-${digest(canonicalUrl).slice(0, 24)}`
  const responseText = "The existing ChatGPT long-think response is ready."
  const responseDigest = digest(responseText)
  let adoptionCalls = 0
  let exchangeCalls = 0
  let receivedTaskSpace
  let receivedTimeoutMs
  const egoAdapter = {
    adopt: async (input) => {
      adoptionCalls += 1
      receivedTaskSpace = input.taskSpace
      receivedTimeoutMs = input.timeoutMs
      return {
        adoptedWhileGenerating: true,
        anchor: { contentDigest: "a".repeat(64), messageId: "mcp-adopt-user" },
        canonicalUrl,
        durationMs: 10_000,
        head: {
          fingerprint: "mcp-adopt-head",
          fingerprintVersion: "tail-v1",
          lastContentDigest: responseDigest,
          lastMessageId: "mcp-adopt-assistant",
          lastRole: "assistant",
          messageCount: 2,
          renderedMessageCount: 2,
        },
        modelPolicy: modelPolicyObservation(),
        responseDigest,
        responseText,
        targetId: "mcp-adopt-tab",
        taskSpaceId: 12,
      }
    },
    exchange: async () => {
      exchangeCalls += 1
      throw new Error("adoption must not send")
    },
  }
  const broker = new Broker({ egoAdapter, store: new EventStore(config.dataDir) })
  await broker.initialize()
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const methods = new Map([
    ["conversation.start_adoption", (params) => broker.startConversationAdoption(params)],
    ["workflow.await", (params, signal) => broker.awaitWorkflow(params, signal)],
  ])
  const ipc = await startIpcServer({
    dispatch: async (method, params, signal) => {
      const handler = methods.get(method)
      if (!handler) {
        throw new EgoChatError("method_not_found", "Unexpected controlled adoption method.")
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

  const adopted = await client.callTool({
    arguments: {
      canonicalUrl,
    },
    name: "ego_adopt_conversation_and_wait",
  })
  assert.equal(adopted.isError, undefined)
  assert.equal(adopted.structuredContent.status, "succeeded")
  assert.equal(adopted.structuredContent.result.bindingKey, derivedBindingKey)
  assert.equal(adopted.structuredContent.result.responseText, responseText)
  assert.equal(adopted.structuredContent.result.responseDigest, responseDigest)
  assert.equal(adopted.structuredContent.result.modelPolicy.powerLevel, 5)
  assert.equal(adopted.structuredContent.waitMode, "token_saver")
  assert.equal(adopted.content[0].text.includes("\n"), false)
  assert.equal(adoptionCalls, 1)
  assert.equal(exchangeCalls, 0)
  assert.equal(receivedTaskSpace, "ego-chat-adoptions")
  assert.equal(receivedTimeoutMs > 0 && receivedTimeoutMs <= 15 * 60 * 1_000, true)
  assert.equal(broker.getConversationBinding({ bindingKey: derivedBindingKey }).state, "bound")
})

test("Token-Saver wait errors preserve the durable workflow recovery handle", async (t) => {
  const { config, env } = await createTestConfig()
  const workflowId = "a2397352-b40f-428a-87d6-379abb262573"
  const token = await loadOrCreateBrokerToken(config.dataDir)
  const ipc = await startIpcServer({
    dispatch: async (method) => {
      if (method === "ego.start_exchange") {
        return { id: workflowId, kind: "ego_exchange", status: "running" }
      }
      if (method === "workflow.await") {
        throw new EgoChatError("wait_timeout", "The controlled workflow is still running.")
      }
      throw new EgoChatError("method_not_found", "Unexpected Token-Saver recovery method.")
    },
    socketPath: config.socketPath,
    token,
  })
  t.after(async () => {
    await ipc.close()
    await removeTestConfig(config)
  })
  const client = await connectClient(env)
  t.after(() => client.close())

  const turnMarker = "EGO_CHAT_TOKEN_SAVER_RECOVERY"
  const result = await client.callTool({
    arguments: {
      bindingKey: "ego-chat-main",
      expectedTerminalMarker: "TOKEN_SAVER_RECOVERY_DONE",
      prompt: `${turnMarker}\nreview`,
      timeoutMs: 30_000,
      turnMarker,
      waitMode: "token_saver",
    },
    name: "ego_exchange_and_wait",
  })
  const error = JSON.parse(result.content[0].text)
  assert.equal(result.isError, true)
  assert.equal(error.code, "wait_timeout")
  assert.equal(error.details.waitMode, "token_saver")
  assert.equal(error.details.workflowId, workflowId)
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
  assert.equal(settled.structuredContent.waitMode, "token_saver")
  assert.equal(settled.content[0].text.includes("\n"), false)

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
