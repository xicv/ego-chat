import assert from "node:assert/strict"
import test from "node:test"

import { MAX_WAIT_MS } from "../src/constants.mjs"
import { StartConvergenceSchema, parse } from "../src/validation.mjs"

function convergenceInput(wallClockTimeoutMs) {
  return {
    acceptanceCriteria: ["The exact attachment bound is accepted."],
    bindingKey: "ego-chat-main",
    cwd: process.cwd(),
    target: "Validate the convergence attachment bound.",
    wallClockTimeoutMs,
  }
}

test("convergence accepts exactly eight hours and rejects a larger attachment window", () => {
  assert.equal(
    parse(StartConvergenceSchema, convergenceInput(MAX_WAIT_MS)).wallClockTimeoutMs,
    8 * 60 * 60 * 1_000,
  )
  assert.throws(
    () => parse(StartConvergenceSchema, convergenceInput(MAX_WAIT_MS + 1)),
    (error) => error.code === "invalid_input"
      && error.details.issues.some((issue) => issue.path === "wallClockTimeoutMs"),
  )
})
