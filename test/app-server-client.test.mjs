import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { AppServerClient } from "../src/app-server-client.mjs"
import { CODEX_CANDIDATE_OUTPUT_SCHEMA } from "../src/convergence.mjs"

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-app-server.mjs")

test("App Server reconciles a dispatched launch whose acknowledgement was lost", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-lost-launch-"))
  t.after(() => fs.rm(directory, { recursive: true }))
  const args = [fixture, "--lose-turn-start-ack", "--state-file", path.join(directory, "turns.json")]
  const client = new AppServerClient({ command: process.execPath, args })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: directory })
  let intent
  await assert.rejects(client.runStructuredTurn({
    onDispatching: async (value) => { intent = value },
    outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
    prompt: "Inspect the workspace and return the candidate once.",
    threadId: thread.id,
    timeoutMs: 2_000,
  }), (error) => error.code === "app_server_exited")
  assert.ok(intent, "the launch intent must be durable before the provider accepts work")
  await client.close()
  const resumed = new AppServerClient({ command: process.execPath, args })
  t.after(() => resumed.close())
  await resumed.connect()
  await resumed.resumeThread(thread.id)
  const receipt = await resumed.recoverStructuredLaunch(thread.id, intent, 1_000)
  const recovered = await resumed.recoverStructuredTurn(thread.id, receipt.turnId, 1_000)
  assert.equal(recovered.disposition, "completed")
  assert.equal((await resumed.readThread(thread.id, true)).turns.length, 1)
  await assert.rejects(
    resumed.recoverStructuredLaunch(thread.id, { ...intent, inputDigest: "f".repeat(64) }, 10),
    (error) => error.code === "app_server_launch_ambiguous",
  )
  await assert.rejects(
    resumed.recoverStructuredLaunch(thread.id, { ...intent, beforeTurnCount: 1, beforeTurnId: "different-boundary" }, 10),
    (error) => error.code === "app_server_launch_ambiguous",
  )
  await assert.rejects(
    resumed.recoverStructuredLaunch(thread.id, { ...intent, marker: `EGO_CHAT_CODEX_LAUNCH_${"B".repeat(32)}` }, 10),
    (error) => error.code === "app_server_launch_ambiguous",
  )
  const duplicate = new AppServerClient({ command: process.execPath, args: [...args, "--duplicate-turn-reads"] })
  t.after(() => duplicate.close())
  await duplicate.connect()
  await assert.rejects(
    duplicate.recoverStructuredLaunch(thread.id, intent, 10),
    (error) => error.code === "app_server_launch_ambiguous",
  )
})

test("App Server client preserves identities and waits for idle between exact turns", async (t) => {
  const client = new AppServerClient({ args: [fixture], command: process.execPath })
  await client.connect()
  t.after(() => client.close())

  const thread = await client.startThread({ cwd: process.cwd() })
  const marker = "EGO_CHAT_FAKE_APP_SERVER_MARKER"
  const turn = await client.runMarkerTurn(thread.id, marker)
  const structured = await client.runStructuredTurn({
    additionalContext: {
      reviewer: { kind: "untrusted", value: "Fake review feedback" },
    },
    outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
    prompt: "Return the structured candidate.",
    threadId: thread.id,
    timeoutMs: 30_000,
  })
  const recovered = await client.recoverStructuredTurn(thread.id, structured.turnId)
  const resumed = await client.resumeThread(thread.id)
  const read = await client.readThread(thread.id)
  await client.unsubscribeThread(thread.id)

  assert.equal(resumed.id, thread.id)
  assert.equal(read.id, thread.id)
  assert.match(turn.responseDigest, /^[a-f0-9]{64}$/)
  assert.equal(recovered.disposition, "completed")
  assert.deepEqual(recovered.result.value, structured.value)
  assert.equal(structured.value.criteria[0].id, "AC-1")
  assert.equal(structured.value.status, "candidate")
  assert.deepEqual(structured.workspaceActivity, {
    count: 1,
    types: ["commandExecution"],
  })
  assert.notEqual(structured.turnId, turn.turnId)
})

test("App Server exits retain the exact interrupted turn identity for recovery", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--exit-after-turn-start"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })
  let startedTurnId

  await assert.rejects(
    () => client.runStructuredTurn({
      onStarted: async ({ turnId }) => {
        startedTurnId = turnId
      },
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 30_000,
    }),
    (error) => {
      assert.equal(error.code, "app_server_exited")
      assert.equal(error.details.exitCode, 70)
      assert.ok(Number.isInteger(error.details.lifetimeMs))
      assert.ok(error.details.lifetimeMs >= 0)
      assert.ok(Number.isInteger(error.details.processId))
      assert.ok(error.details.processId > 0)
      assert.match(error.details.diagnosticDigest, /^[a-f0-9]{64}$/)
      assert.match(error.details.turnId, /^019d0000-/)
      return true
    },
  )
  assert.match(startedTurnId, /^019d0000-/)
})

test("App Server recovery retains workspace activity from an interrupted turn", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--interrupted-turn-reads"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })
  let turnId

  await assert.rejects(
    () => client.runStructuredTurn({
      onStarted: async (started) => {
        turnId = started.turnId
      },
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 30_000,
    }),
    (error) => error.code === "app_server_turn_failed",
  )
  const recovered = await client.recoverStructuredTurn(thread.id, turnId)

  assert.equal(recovered.disposition, "retry")
  assert.equal(recovered.status, "interrupted")
  assert.deepEqual(recovered.workspaceActivity, {
    count: 1,
    types: ["commandExecution"],
  })
})

test("App Server client detects a terminal turn when the completion notification is lost", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--interrupted-turn-reads", "--omit-turn-completed"],
    command: process.execPath,
    completionPollIntervalMs: 10,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })
  let turnId
  const startedAt = Date.now()

  await assert.rejects(
    () => client.runStructuredTurn({
      onStarted: async (started) => {
        turnId = started.turnId
      },
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 1_000,
    }),
    (error) => error.code === "app_server_turn_failed"
      && error.details.status === "interrupted"
      && error.details.turnId === turnId,
  )

  assert.ok(Date.now() - startedAt < 500)
})

test("App Server recovery treats a partial interrupted turn without items as no activity", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--interrupted-turn-reads", "--interrupted-turn-without-items"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })
  let turnId

  await assert.rejects(
    () => client.runStructuredTurn({
      onStarted: async (started) => {
        turnId = started.turnId
      },
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 30_000,
    }),
    (error) => error.code === "app_server_turn_failed",
  )
  const recovered = await client.recoverStructuredTurn(thread.id, turnId)

  assert.equal(recovered.disposition, "retry")
  assert.deepEqual(recovered.workspaceActivity, { count: 0, types: [] })
})

test("closing an App Server already terminated by signal does not wait for the kill timeout", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--signal-after-turn-start"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })

  await assert.rejects(
    () => client.runStructuredTurn({
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 30_000,
    }),
    (error) => error.code === "app_server_exited"
      && error.details.signal === "SIGTERM",
  )

  const startedAt = Date.now()
  await client.close()
  assert.ok(Date.now() - startedAt < 1_000)
})

test("phase-unknown App Server turns parse only the terminal compatibility message", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--phase-unknown-messages"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })

  const structured = await client.runStructuredTurn({
    outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
    prompt: "Return the structured candidate.",
    threadId: thread.id,
    timeoutMs: 30_000,
  })

  assert.equal(structured.value.status, "candidate")
  assert.equal(structured.value.summary, "Fake structured result.")
})

test("multiple final App Server items parse only the terminal final answer", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--multiple-final-messages"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })

  const structured = await client.runStructuredTurn({
    outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
    prompt: "Return the structured candidate.",
    threadId: thread.id,
    timeoutMs: 30_000,
  })

  assert.equal(structured.value.status, "candidate")
  assert.equal(structured.value.summary, "Fake structured result.")
})

test("recovery rejects duplicate exact App Server turn identities", async (t) => {
  const client = new AppServerClient({
    args: [fixture, "--duplicate-turn-reads"],
    command: process.execPath,
  })
  await client.connect()
  t.after(() => client.close())
  const thread = await client.startThread({ cwd: process.cwd() })
  const structured = await client.runStructuredTurn({
    outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
    prompt: "Return the structured candidate.",
    threadId: thread.id,
    timeoutMs: 30_000,
  })

  await assert.rejects(
    client.recoverStructuredTurn(thread.id, structured.turnId),
    (error) => error.code === "app_server_recovery_ambiguous"
      && error.details.turnId === structured.turnId,
  )
})
