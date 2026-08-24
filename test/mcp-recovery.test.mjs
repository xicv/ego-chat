import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import {
  MCP_PATH,
  createTestConfig,
  removeTestConfig,
  stopTestDaemon,
} from "./helpers.mjs"

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
