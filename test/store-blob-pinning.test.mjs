import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { EventStore } from "../src/store.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

async function createDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-blob-pinning-test-"))
  await fs.chmod(dataDir, 0o700)
  return dataDir
}

function blobPathFor(dataDir, reference) {
  return path.join(dataDir, "blobs", "sha256", reference.digest.slice(0, 2), reference.digest)
}

// An unrelated, already-terminal workflow used purely to advance the event
// ledger so a store configured with a tiny maxEvents compacts on demand. It
// carries no blob reference, so it never affects blob-inventory reconciliation
// except through the compaction it triggers.
function fillerWorkflow() {
  const now = new Date().toISOString()
  return {
    createdAt: now,
    id: randomUUID(),
    kind: "ego_exchange",
    status: "succeeded",
    updatedAt: now,
  }
}

async function compactByPersistingFillers(store, count) {
  for (let index = 0; index < count; index += 1) {
    await store.persist("workflow.succeeded", fillerWorkflow())
  }
}

test("a result blob written before its referencing event survives a compaction that races ahead of it", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  // maxEvents: 3 means the third unrelated persist() call compacts, mirroring
  // how a run of 150 KB exchanges tripped #maxEventBytes/#maxEvents in production.
  const store = new EventStore(dataDir, { maxEvents: 3 })
  await store.initialize()

  const responseText = "the captured assistant response for this exchange"
  // This mirrors src/broker.mjs: putBlob() happens before the event carrying
  // result.responseRef is persisted (see broker.mjs ~2418, ~3926, ~4959).
  const responseRef = await store.putBlob(responseText, {
    mediaType: "text/markdown; charset=utf-8",
  })
  const blobPath = blobPathFor(dataDir, responseRef)
  assert.equal(await fs.readFile(blobPath, "utf8"), responseText)

  // Three unrelated persists trigger a compaction before the event that
  // references this blob has been persisted at all -- the exact race window
  // described in the incident.
  await compactByPersistingFillers(store, 3)

  // The blob must still be present: a compaction must not reap a blob that
  // was written moments ago and is still waiting on its own referencing event.
  await assert.doesNotReject(
    fs.access(blobPath),
    "a freshly written, not-yet-referenced blob must survive an intervening compaction",
  )

  const workflowId = randomUUID()
  const now = new Date().toISOString()
  await store.persist("workflow.succeeded", {
    createdAt: now,
    id: workflowId,
    kind: "ego_exchange",
    result: {
      responseDigest: responseRef.digest,
      responseRef,
    },
    status: "succeeded",
    updatedAt: now,
  })

  // A further compaction, now that the blob is genuinely referenced by
  // committed state, must keep retaining it (and must not throw
  // corrupt_result_blob_inventory, which is what the live incident observed).
  await compactByPersistingFillers(store, 3)

  await assert.doesNotReject(fs.access(blobPath))
  const captured = await store.readBlob(responseRef, { maxBytes: 1_024, offset: 0 })
  assert.equal(captured.complete, true)
  assert.equal(captured.text, responseText)
  assert.equal(store.getWorkflow(workflowId).result.responseRef.digest, responseRef.digest)
})

test("a result blob that is never referenced is still removed once its pending pin ages out", async (t) => {
  const dataDir = await createDataDir()
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  // An injectable, tiny pin TTL so the test doesn't need to wait on the real
  // 24h default before proving expired pins stop protecting orphaned blobs.
  const store = new EventStore(dataDir, { maxEvents: 3, pendingBlobTtlMs: 1 })
  await store.initialize()

  const orphanText = "a response blob that no workflow will ever reference"
  const orphanRef = await store.putBlob(orphanText)
  const blobPath = blobPathFor(dataDir, orphanRef)
  await assert.doesNotReject(fs.access(blobPath))
  assert.equal(digest(orphanText), orphanRef.digest)

  // Let the tiny pin TTL elapse before any compaction runs.
  await new Promise((resolve) => setTimeout(resolve, 20))

  await compactByPersistingFillers(store, 3)

  await assert.rejects(fs.access(blobPath), (error) => error.code === "ENOENT")
  await assert.rejects(
    store.readBlob(orphanRef, { maxBytes: 1_024, offset: 0 }),
    (error) => error.code === "result_not_found",
  )
})
