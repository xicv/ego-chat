import assert from "node:assert/strict"
import test from "node:test"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"

import {
  MCP_PATH,
  createTestConfig,
  removeTestConfig,
  stopTestDaemon,
} from "./helpers.mjs"

const runLongTest = process.env.EGO_CHAT_RUN_LONG_TESTS === "1"

test("progress and Token-Saver MCP calls both stay active beyond the SDK default timeout", {
  skip: !runLongTest,
  timeout: 90_000,
}, async (t) => {
  const { config, env } = await createTestConfig()
  t.after(async () => {
    await stopTestDaemon(config)
    await removeTestConfig(config)
  })
  const transport = new StdioClientTransport({
    args: [MCP_PATH],
    command: process.execPath,
    env,
    stderr: "pipe",
  })
  const client = new Client({ name: "ego-chat-long-test", version: "1.0.0" })
  await client.connect(transport)
  t.after(() => client.close())

  let progressEvents = 0
  let tokenSaverProgressEvents = 0
  const startedAt = Date.now()
  const [progressResult, tokenSaverResult] = await Promise.all([
    client.callTool({
      arguments: { delayMs: 65_000, value: "long-progress-call", waitMode: "progress" },
      name: "gate0_probe_and_wait",
    }, CallToolResultSchema, {
      maxTotalTimeout: 80_000,
      onprogress: () => {
        progressEvents += 1
      },
      resetTimeoutOnProgress: true,
      timeout: 70_000,
    }),
    client.callTool({
      arguments: { delayMs: 65_000, value: "long-token-saver-call", waitMode: "token_saver" },
      name: "gate0_probe_and_wait",
    }, CallToolResultSchema, {
      maxTotalTimeout: 80_000,
      onprogress: () => {
        tokenSaverProgressEvents += 1
      },
      resetTimeoutOnProgress: true,
      timeout: 70_000,
    }),
  ])
  const elapsedMs = Date.now() - startedAt

  assert.equal(progressResult.structuredContent.status, "succeeded")
  assert.equal(progressResult.structuredContent.waitMode, "progress")
  assert.equal(tokenSaverResult.structuredContent.status, "succeeded")
  assert.equal(tokenSaverResult.structuredContent.waitMode, "token_saver")
  assert.ok(elapsedMs >= 65_000, `expected at least 65000ms, observed ${elapsedMs}ms`)
  assert.ok(progressEvents >= 2, `expected at least two progress events, observed ${progressEvents}`)
  assert.equal(tokenSaverProgressEvents, 0)
})
