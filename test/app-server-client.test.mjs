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
  const resumed = await client.resumeThread(thread.id)
  const read = await client.readThread(thread.id)
  await client.unsubscribeThread(thread.id)

  assert.equal(resumed.id, thread.id)
  assert.equal(read.id, thread.id)
  assert.match(turn.responseDigest, /^[a-f0-9]{64}$/)
  assert.equal(structured.value.criteria[0].id, "AC-1")
  assert.equal(structured.value.status, "candidate")
  assert.notEqual(structured.turnId, turn.turnId)
})
