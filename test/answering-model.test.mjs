import assert from "node:assert/strict"
import test from "node:test"

import { ANSWERING_MODEL_RANKS } from "../src/constants.mjs"
import { answeringModelRank, isAnsweringModelDowngrade } from "../src/answering-model.mjs"

test("answeringModelRank ranks an exact match by its position in the list, highest first", () => {
  const ranks = ANSWERING_MODEL_RANKS.map((slug) => answeringModelRank(slug))
  for (let index = 1; index < ranks.length; index += 1) {
    assert.ok(ranks[index - 1] > ranks[index], `${ANSWERING_MODEL_RANKS[index - 1]} must outrank ${ANSWERING_MODEL_RANKS[index]}`)
  }
  assert.ok(ranks.every((rank) => rank > 0))
})

test("answeringModelRank matches the longest known prefix for a versioned slug", () => {
  assert.equal(answeringModelRank("gpt-6-pro-2026"), answeringModelRank("gpt-6-pro"))
  assert.equal(answeringModelRank("gpt-5-6-thinking-latest"), answeringModelRank("gpt-5-6-thinking"))
  // "gpt-5-6" is a prefix of "gpt-5-6-thinking" and "gpt-5-6-pro"; the longer,
  // more specific known prefix must win.
  assert.equal(answeringModelRank("gpt-5-6-pro-2026"), answeringModelRank("gpt-5-6-pro"))
  assert.notEqual(answeringModelRank("gpt-5-6-pro-2026"), answeringModelRank("gpt-5-6"))
})

test("answeringModelRank treats an unknown slug as the lowest rank", () => {
  assert.equal(answeringModelRank("some-other-provider-model"), 0)
  assert.equal(answeringModelRank(""), 0)
  assert.ok(answeringModelRank("gpt-5-5") > answeringModelRank("some-other-provider-model"))
})

test("answeringModelRank treats null, undefined, and non-string input as the lowest rank", () => {
  assert.equal(answeringModelRank(null), 0)
  assert.equal(answeringModelRank(undefined), 0)
  assert.equal(answeringModelRank(42), 0)
})

test("isAnsweringModelDowngrade is true only when the rank strictly drops", () => {
  assert.equal(isAnsweringModelDowngrade("gpt-6-pro", "gpt-5-6-thinking"), true)
  assert.equal(isAnsweringModelDowngrade("gpt-5-6-thinking", "gpt-6-pro"), false)
  assert.equal(isAnsweringModelDowngrade("gpt-6-pro", "gpt-6-pro"), false)
})

test("isAnsweringModelDowngrade is false when either side is unknown, null, or not a string", () => {
  assert.equal(isAnsweringModelDowngrade(null, "gpt-5-5"), false)
  assert.equal(isAnsweringModelDowngrade("gpt-6-pro", null), false)
  assert.equal(isAnsweringModelDowngrade(undefined, undefined), false)
  assert.equal(isAnsweringModelDowngrade("some-other-provider-model", "gpt-5-5"), false)
  assert.equal(isAnsweringModelDowngrade(42, "gpt-5-5"), false)
})
