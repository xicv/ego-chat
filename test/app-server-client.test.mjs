import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { AppServerClient } from "../src/app-server-client.mjs"
import { CODEX_CANDIDATE_OUTPUT_SCHEMA } from "../src/convergence.mjs"

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-app-server.mjs")

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

  await assert.rejects(
    () => client.runStructuredTurn({
      outputSchema: CODEX_CANDIDATE_OUTPUT_SCHEMA,
      prompt: "Return the structured candidate.",
      threadId: thread.id,
      timeoutMs: 30_000,
    }),
    (error) => {
      assert.equal(error.code, "app_server_exited")
      assert.equal(error.details.exitCode, 70)
      assert.match(error.details.diagnosticDigest, /^[a-f0-9]{64}$/)
      assert.match(error.details.turnId, /^019d0000-/)
      return true
    },
  )
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
