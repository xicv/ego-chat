import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ALERT_ATTENTION_PHASES,
  ALERT_ATTENTION_STATUSES,
  createLocalAlertSink,
  formatAlertMessage,
  isAttentionState,
} from "../src/local-alerts.mjs"

async function createDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-local-alerts-test-"))
  await fs.chmod(dataDir, 0o700)
  return dataDir
}

function recordingRunner(result = { code: 0 }) {
  const calls = []
  const runner = async (executable, args) => {
    calls.push([executable, args])
    if (result instanceof Error) throw result
    return result
  }
  runner.calls = calls
  return runner
}

function sampleAlert(overrides = {}) {
  return {
    kind: "workflow_attention",
    workflowId: "00000000-0000-4000-8000-000000000001",
    workflowKind: "convergence",
    bindingKey: "ego-chat-main",
    status: "human_required",
    phase: null,
    code: "authentication_required",
    message: "Human review is required.",
    at: new Date().toISOString(),
    ...overrides,
  }
}

test("describe() reports enabled defaults when no config file exists", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: true, sound: "Glass", webhook: false, reason: null })
})

test("describe() reflects a valid alerts.json", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({
    sound: "Ping",
    webhookUrl: "https://example.invalid/hook",
    webhookHeaders: { Authorization: "Bearer x" },
  }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: true, sound: "Ping", webhook: true, reason: null })
})

test("describe() disables the sink on invalid JSON", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), "{ not json")
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: false, reason: "config_invalid", sound: null, webhook: false })
  assert.deepEqual(await sink.notify(sampleAlert()), { channels: [] })
})

test("describe() disables the sink on an unknown key", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({ sound: "Ping", extra: true }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: false, reason: "config_invalid", sound: null, webhook: false })
})

test("describe() disables the sink on an over-long sound name", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({ sound: "x".repeat(65) }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: false, reason: "config_invalid", sound: null, webhook: false })
})

test("describe() disables the sink on a non-http(s) webhook URL", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({ webhookUrl: "ftp://example.invalid/hook" }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: false, reason: "config_invalid", sound: null, webhook: false })
})

test("describe() disables the sink on more than 8 webhook headers", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const webhookHeaders = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-Header-${index}`, "value"]))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({
    webhookUrl: "https://example.invalid/hook",
    webhookHeaders,
  }))
  const sink = createLocalAlertSink({ dataDir })
  assert.deepEqual(sink.describe(), { enabled: false, reason: "config_invalid", sound: null, webhook: false })
})

test("notify() runs the macOS channel and accepts on exit code 0", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, runner })
  const alert = sampleAlert()
  const result = await sink.notify(alert)
  assert.deepEqual(result.channels, [{ channel: "macos", outcome: "accepted" }])
  assert.equal(runner.calls.length, 1)
  const [executable, args] = runner.calls[0]
  assert.equal(executable, "/usr/bin/osascript")
  assert.deepEqual(args.slice(0, 1), ["-e"])
  const script = args[1]
  assert.match(script, /with title "Ego Chat"/)
  assert.match(script, /sound name "Glass"/)
  assert.match(script, /convergence · human_required · authentication_required/)
})

test("notify() reports a failed macOS channel on a non-zero exit code", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const runner = recordingRunner({ code: 1 })
  const sink = createLocalAlertSink({ dataDir, runner })
  const result = await sink.notify(sampleAlert())
  assert.deepEqual(result.channels, [{ channel: "macos", outcome: "failed", error: "notification_failed" }])
})

test("notify() reports a failed macOS channel and never rejects when the runner throws", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const runner = recordingRunner(new Error("boom"))
  const sink = createLocalAlertSink({ dataDir, runner })
  const result = await sink.notify(sampleAlert())
  assert.deepEqual(result.channels, [{ channel: "macos", outcome: "failed", error: "runner_error" }])
})

test("notify() posts the webhook with merged headers and a JSON body", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({
    webhookUrl: "https://example.invalid/hook",
    webhookHeaders: { "X-Token": "abc" },
  }))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push([url, init])
    return { ok: true, status: 200 }
  }
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, fetchImpl, runner })
  const alert = sampleAlert()
  const result = await sink.notify(alert)
  assert.deepEqual(result.channels, [
    { channel: "macos", outcome: "accepted" },
    { channel: "webhook", outcome: "accepted" },
  ])
  assert.equal(calls.length, 1)
  const [url, init] = calls[0]
  assert.equal(url, "https://example.invalid/hook")
  assert.equal(init.method, "POST")
  assert.equal(init.headers["content-type"], "application/json")
  assert.equal(init.headers["X-Token"], "abc")
  assert.deepEqual(JSON.parse(init.body), alert)
})

test("notify() reports a failed webhook when fetchImpl rejects", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({ webhookUrl: "https://example.invalid/hook" }))
  const fetchImpl = async () => { throw new Error("network down") }
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, fetchImpl, runner })
  const result = await sink.notify(sampleAlert())
  assert.deepEqual(result.channels, [
    { channel: "macos", outcome: "accepted" },
    { channel: "webhook", outcome: "failed", error: "webhook_failed" },
  ])
})

test("notify() reports a failed webhook when fetchImpl resolves not-ok", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  await fs.writeFile(path.join(dataDir, "alerts.json"), JSON.stringify({ webhookUrl: "https://example.invalid/hook" }))
  const fetchImpl = async () => ({ ok: false, status: 500 })
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, fetchImpl, runner })
  const result = await sink.notify(sampleAlert())
  assert.deepEqual(result.channels, [
    { channel: "macos", outcome: "accepted" },
    { channel: "webhook", outcome: "failed", error: "webhook_failed" },
  ])
})

test("formatAlertMessage truncates the message to 120 characters and includes identity", () => {
  const alert = sampleAlert({
    workflowId: "abcdefgh-1234-4000-8000-000000000001",
    message: "x".repeat(200),
  })
  const message = formatAlertMessage(alert)
  assert.match(message, /^convergence · human_required · authentication_required · abcdefgh: /)
  const truncatedPortion = message.split(": ")[1]
  assert.equal(truncatedPortion.length, 120)
})

test("formatAlertMessage is safe to JSON-quote for AppleScript when it contains quotes and newlines", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, runner })
  const alert = sampleAlert({ message: 'has "quotes"\nand a newline' })
  await sink.notify(alert)
  const script = runner.calls[0][1][1]
  assert.match(script, /display notification "convergence[\s\S]*" with title "Ego Chat" sound name "Glass"/)
  // The overall script string must remain valid JS-quoted content; confirm no unescaped quote breaks it.
  assert.doesNotThrow(() => new Function(`return ${script.match(/display notification (".*") with title/s)[1]}`))
})

test("record() appends receipts and keeps at most 200 lines", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const sink = createLocalAlertSink({ dataDir })
  for (let index = 0; index < 205; index += 1) {
    await sink.record({ workflowId: `workflow-${index}`, code: "c", channels: [], at: new Date().toISOString() })
  }
  const contents = await fs.readFile(path.join(dataDir, "alerts.jsonl"), "utf8")
  const lines = contents.trim().split("\n")
  assert.equal(lines.length, 200)
  const parsedLast = JSON.parse(lines.at(-1))
  assert.equal(parsedLast.workflowId, "workflow-204")
  const parsedFirst = JSON.parse(lines[0])
  assert.equal(parsedFirst.workflowId, "workflow-5")
})

test("notify() calls record() itself with a bounded receipt", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const runner = recordingRunner({ code: 0 })
  const sink = createLocalAlertSink({ dataDir, runner })
  const alert = sampleAlert({ workflowId: "record-me" })
  await sink.notify(alert)
  const contents = await fs.readFile(path.join(dataDir, "alerts.jsonl"), "utf8")
  const receipt = JSON.parse(contents.trim())
  assert.equal(receipt.workflowId, "record-me")
  assert.equal(receipt.code, alert.code)
  assert.deepEqual(receipt.channels, [{ channel: "macos", outcome: "accepted" }])
  assert.equal(typeof receipt.at, "string")
})

test("ALERT_ATTENTION_STATUSES, ALERT_ATTENTION_PHASES, and isAttentionState classify workflows", () => {
  assert.equal(ALERT_ATTENTION_STATUSES.has("human_required"), true)
  assert.equal(ALERT_ATTENTION_STATUSES.has("failed"), true)
  assert.equal(ALERT_ATTENTION_STATUSES.has("running"), false)
  assert.equal(ALERT_ATTENTION_PHASES.has("provider_paused"), true)
  assert.equal(ALERT_ATTENTION_PHASES.has("capture_paused"), true)
  assert.equal(ALERT_ATTENTION_PHASES.has("continuation_paused"), true)
  assert.equal(isAttentionState({ status: "human_required", phase: null }), true)
  assert.equal(isAttentionState({ status: "failed", phase: null }), true)
  assert.equal(isAttentionState({ status: "running", phase: "provider_paused" }), true)
  assert.equal(isAttentionState({ status: "running", phase: "browser_owned" }), false)
})
