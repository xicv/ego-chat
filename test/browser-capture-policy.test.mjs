import assert from "node:assert/strict"
import test from "node:test"

import { browserCaptureWaitPolicy } from "../src/browser-capture-policy.mjs"

test("inactive capture backs off and reaches a durable strategy-change boundary without treating quiet generation as stuck", () => {
  const since = Date.parse("2026-09-08T00:00:00.000Z")
  const inactive = { generationRunning: false, observedAt: new Date(since).toISOString(), reason: "response_not_terminal" }
  assert.deepEqual(browserCaptureWaitPolicy(inactive, since), { delayMs: 2_000, inactiveForMs: 0, pause: false })
  assert.equal(browserCaptureWaitPolicy(inactive, since + 10_000).delayMs, 5_000)
  assert.equal(browserCaptureWaitPolicy(inactive, since + 60_000).delayMs, 15_000)
  assert.equal(browserCaptureWaitPolicy(inactive, since + 5 * 60_000).delayMs, 30_000)
  assert.equal(browserCaptureWaitPolicy(inactive, since + 30 * 60_000).pause, true)
  assert.equal(browserCaptureWaitPolicy({ ...inactive, generationRunning: true, reason: "generation_running" }, since + 8 * 60 * 60_000).pause, false)
  assert.equal(browserCaptureWaitPolicy(inactive, since - 5_000).pause, false)
})
