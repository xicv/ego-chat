import assert from "node:assert/strict"
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
