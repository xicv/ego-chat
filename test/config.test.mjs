import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadConfig } from "../src/config.mjs"

test("config confines the broker socket to the Ego Chat temporary namespace", () => {
  const valid = path.join(os.tmpdir(), "egc-config-test.sock")
  assert.equal(loadConfig({ socketPath: valid }).socketPath, valid)

  assert.throws(
    () => loadConfig({ socketPath: path.join(os.tmpdir(), "another-app.sock") }),
    (error) => error.code === "invalid_socket_path",
  )
  assert.throws(
    () => loadConfig({ socketPath: path.join(os.tmpdir(), "nested", "egc-test.sock") }),
    (error) => error.code === "invalid_socket_path",
  )
})

test("canonical broker identity and default socket do not change with TMPDIR", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-config-data-"))
  await fs.chmod(dataDir, 0o700)
  t.after(() => fs.rm(dataDir, { force: false, recursive: true }))
  const originalTmpdir = process.env.TMPDIR
  const originalSocketPath = process.env.EGO_CHAT_SOCKET_PATH
  t.after(() => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR
    } else {
      process.env.TMPDIR = originalTmpdir
    }
    if (originalSocketPath === undefined) {
      delete process.env.EGO_CHAT_SOCKET_PATH
    } else {
      process.env.EGO_CHAT_SOCKET_PATH = originalSocketPath
    }
  })

  delete process.env.EGO_CHAT_SOCKET_PATH
  process.env.TMPDIR = "/tmp/ego-chat-config-a"
  const first = loadConfig({ dataDir })
  process.env.TMPDIR = "/tmp/ego-chat-config-b"
  const second = loadConfig({ dataDir })

  assert.equal(first.brokerKey, second.brokerKey)
  assert.equal(first.dataDir, second.dataDir)
  assert.equal(first.socketPath, second.socketPath)
  assert.equal(first.reserveLegacySockets, true)
  assert.equal(second.reserveLegacySockets, true)
  assert.equal(new Set(first.legacySocketPaths).size, first.legacySocketPaths.length)
  assert.equal(new Set(second.legacySocketPaths).size, second.legacySocketPaths.length)
  assert.match(first.socketPath, /\/ego-chat-[^/]+\/[a-f0-9]{20}\/broker\.sock$/)
})
