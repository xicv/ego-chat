import assert from "node:assert/strict"
import test from "node:test"

import {
  buildChatGptPrompt,
  buildCodexPrompt,
  createContract,
  digestJson,
  evaluateReview,
  parseChatGptReview,
  scanForSecrets,
  validateCodexCandidate,
} from "../src/convergence.mjs"

const OPENAI_LIKE_TEST_TOKEN = `sk-proj-${"A".repeat(26)}123456`
const PRIVATE_KEY_TEST_HEADER = ["-----BEGIN", "PRIVATE KEY-----"].join(" ")

function candidateFor(contract, overrides = {}) {
  return {
    blockers: [],
    criteria: contract.criteria.map(({ id }) => ({
      evidence: `${id} has deterministic evidence.`,
      id,
      status: "pass",
    })),
    reviewPacket: "A bounded, self-contained review packet.",
    status: "candidate",
    summary: "The candidate meets the contract.",
    ...overrides,
  }
}

function reviewFor(contract, candidateDigest, overrides = {}) {
  return {
    candidateDigest,
    criteria: contract.criteria.map(({ id }) => ({
      evidence: `${id} was independently verified.`,
      id,
      status: "pass",
    })),
    cycle: 1,
    decision: "settled",
    findings: [],
    summary: "Every criterion is proven.",
    targetDigest: contract.targetDigest,
    ...overrides,
  }
}

test("settlement binds exact target, candidate, cycle, and complete criterion evidence", () => {
  const contract = createContract("Produce a deterministic protocol proof.", [
    "The proof binds the immutable target.",
    "The reviewer reports every criterion.",
  ])
  assert.equal(contract.targetDigest, createContract(contract.target, contract.criteria.map(({ text }) => text)).targetDigest)

  const candidate = validateCodexCandidate(candidateFor(contract), contract.criteria)
  const candidateDigest = digestJson(candidate)
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_TEST1234"
  const review = reviewFor(contract, candidateDigest)
  const parsed = parseChatGptReview(`${JSON.stringify(review)}\n${terminalMarker}`, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.deepEqual(evaluateReview(parsed), { settled: true })
})

test("forged identities and incomplete settlement claims fail closed", () => {
  const contract = createContract("Settle safely.", ["One criterion passes."])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_TEST5678"
  const forged = reviewFor(contract, candidateDigest, { targetDigest: "0".repeat(64) })

  assert.throws(
    () => parseChatGptReview(`${JSON.stringify(forged)}\n${terminalMarker}`, {
      candidateDigest,
      criteria: contract.criteria,
      cycle: 1,
      targetDigest: contract.targetDigest,
      terminalMarker,
    }),
    (error) => error.details?.reason === "settlement_identity_mismatch",
  )

  const incomplete = reviewFor(contract, candidateDigest, {
    criteria: [{ evidence: "Evidence is still unknown.", id: "AC-1", status: "unknown" }],
  })
  assert.throws(
    () => evaluateReview(incomplete),
    (error) => error.details?.reason === "invalid_settlement_claim",
  )
})

test("continuation must be actionable and browser feedback stays explicitly untrusted", () => {
  const contract = createContract("Improve a candidate.", ["The final value is verified."])
  const candidateDigest = digestJson(candidateFor(contract))
  const actionable = reviewFor(contract, candidateDigest, {
    criteria: [{ evidence: "The final value is not verified yet.", id: "AC-1", status: "fail" }],
    decision: "continue",
    findings: [{
      action: "Add deterministic validation evidence.",
      id: "B-VALIDATION",
      severity: "blocking",
      title: "Validation evidence is missing",
    }],
  })
  assert.deepEqual(evaluateReview(actionable), { settled: false })

  assert.throws(
    () => evaluateReview(reviewFor(contract, candidateDigest, { decision: "continue" })),
    (error) => error.details?.reason === "review_not_actionable",
  )
  assert.match(buildCodexPrompt({
    contract,
    cycle: 2,
    priorReview: actionable,
    sandbox: "read-only",
  }), /untrusted context/)

  assert.match(buildChatGptPrompt({
    candidate: candidateFor(contract),
    candidateDigest,
    contract,
    cycle: 1,
    terminalMarker: "EGO_CHAT_REVIEW_DONE_SCHEMA123",
    turnMarker: "EGO_CHAT_CONVERGENCE_SCHEMA123_C1",
  }), /finding id must start with B-/)
})

test("high-confidence secret signatures block the exact outbound packet", () => {
  assert.deepEqual(scanForSecrets("safe review packet"), [])
  assert.deepEqual(
    scanForSecrets(`token ${OPENAI_LIKE_TEST_TOKEN}`),
    ["openai_api_key"],
  )
  assert.deepEqual(
    scanForSecrets(`${PRIVATE_KEY_TEST_HEADER}\nredacted`),
    ["private_key"],
  )
})
