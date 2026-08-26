import assert from "node:assert/strict"
import test from "node:test"

import {
  CODEX_CANDIDATE_OUTPUT_SCHEMA,
  buildChatGptPrompt,
  buildCodexInspectionCorrectionPrompt,
  buildCodexPrompt,
  createContract,
  digestJson,
  completeAgentReview,
  evaluateReview,
  parseChatGptReview,
  prepareAgentReview,
  scanForSecrets,
  validateAgentCandidate,
  validateCodexCandidate,
} from "../src/convergence.mjs"
import { MAX_PROMPT_BYTES } from "../src/constants.mjs"

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

test("Codex convergence prompts require workspace inspection before final-only JSON", () => {
  const contract = createContract("Review and improve the checked-out project.", [
    "The project was inspected with local tools.",
  ])
  const initial = buildCodexPrompt({
    contract,
    cycle: 1,
    priorReview: null,
    sandbox: "workspace-write",
  })
  const correction = buildCodexInspectionCorrectionPrompt({ contract, cycle: 1 })

  assert.match(initial, /MUST inspect the supplied cwd with local tools/)
  assert.match(initial, /only the final answer format/i)
  assert.match(correction, /made no observable workspace tool call/i)
  assert.match(correction, new RegExp(contract.targetDigest))
  assert.match(correction, /do not merely repeat the prior blocked envelope/i)
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

test("a host-owned candidate receives the same identity-bound strict review", () => {
  const target = "Settle a candidate while the current host remains side A."
  const acceptanceCriteria = [
    "The current host retains implementation ownership.",
    "The review is bound to exact evidence.",
  ]
  const contract = createContract(target, acceptanceCriteria)
  const candidate = validateAgentCandidate(candidateFor(contract), contract.criteria)
  const prepared = prepareAgentReview({
    acceptanceCriteria,
    candidate,
    cycle: 1,
    markerToken: "HOSTOWNEDREVIEW1234",
    target,
  })

  assert.match(prepared.prompt, /Implementing-agent candidate summary/)
  assert.doesNotMatch(prepared.prompt, /Codex candidate summary/)
  assert.equal(prepared.contract.targetDigest, contract.targetDigest)
  const review = reviewFor(contract, prepared.candidateDigest)
  const completed = completeAgentReview(
    prepared,
    `${JSON.stringify(review)}\n${prepared.terminalMarker}`,
  )
  assert.equal(completed.settled, true)
  assert.deepEqual(completed.review, review)
})

test("review packet admission defers to the exact UTF-8 prompt byte budget", () => {
  const target = "Review a large but transport-safe candidate packet."
  const acceptanceCriteria = ["The review packet obeys the exact outbound byte budget."]
  const contract = createContract(target, acceptanceCriteria)
  const reviewPacket = "x".repeat(50_000)
  const prepared = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract, { reviewPacket }),
    cycle: 1,
    markerToken: "LARGEREVIEWPACKET1234",
    target,
  })

  assert.equal(
    CODEX_CANDIDATE_OUTPUT_SCHEMA.properties.reviewPacket.maxLength,
    MAX_PROMPT_BYTES,
  )
  assert.ok(Buffer.byteLength(prepared.prompt, "utf8") < MAX_PROMPT_BYTES)

  const oversizedPacket = "界".repeat(22_000)
  assert.throws(
    () => prepareAgentReview({
      acceptanceCriteria,
      candidate: candidateFor(contract, { reviewPacket: oversizedPacket }),
      cycle: 1,
      markerToken: "MULTIBYTETESTPACKET1234",
      target,
    }),
    (error) => {
      assert.equal(error.code, "invalid_input")
      assert.equal(error.details?.reason, "review_prompt_too_large")
      assert.equal(error.details?.maxBytes, MAX_PROMPT_BYTES)
      assert.equal(
        error.details?.reviewPacketBytes,
        Buffer.byteLength(oversizedPacket, "utf8"),
      )
      assert.ok(error.details?.actualBytes > error.details?.maxBytes)
      assert.equal(
        error.details?.overageBytes,
        error.details?.actualBytes - error.details?.maxBytes,
      )
      assert.equal(
        error.details?.promptOverheadBytes,
        error.details?.actualBytes - error.details?.reviewPacketBytes,
      )
      return true
    },
  )

  assert.throws(
    () => validateAgentCandidate(
      candidateFor(contract, { reviewPacket: "x".repeat(MAX_PROMPT_BYTES + 1) }),
      contract.criteria,
    ),
    (error) => error.details?.reason === "convergence_protocol_invalid",
  )
})

test("proven-absent review retries keep the root operation but use deterministic unique markers", () => {
  const target = "Retry only a review proven absent before delivery."
  const acceptanceCriteria = ["Every delivery attempt remains identity-bound."]
  const contract = createContract(target, acceptanceCriteria)
  const input = {
    acceptanceCriteria,
    bindingKey: "ego-chat-main",
    candidate: candidateFor(contract),
    cycle: 1,
    operationId: "review-delivery-retry-test",
    target,
  }
  const initial = prepareAgentReview(input)
  const replayedInitial = prepareAgentReview(input)
  const retry = prepareAgentReview({ ...input, deliveryAttempt: 2 })

  assert.equal(replayedInitial.turnMarker, initial.turnMarker)
  assert.equal(retry.operationId, initial.operationId)
  assert.equal(retry.candidateDigest, initial.candidateDigest)
  assert.equal(retry.contract.targetDigest, initial.contract.targetDigest)
  assert.notEqual(retry.turnMarker, initial.turnMarker)
  assert.notEqual(retry.terminalMarker, initial.terminalMarker)
  assert.equal(retry.deliveryAttempt, 2)
})

test("a blocked or secret-bearing host candidate stops before browser submission", () => {
  const target = "Stop unsafe review packets."
  const acceptanceCriteria = ["No unresolved blocker or secret is sent."]
  const contract = createContract(target, acceptanceCriteria)

  assert.throws(
    () => prepareAgentReview({
      acceptanceCriteria,
      candidate: candidateFor(contract, {
        blockers: ["Missing authority."],
        status: "blocked",
      }),
      cycle: 1,
      markerToken: "BLOCKEDREVIEW1234",
      target,
    }),
    (error) => error.details?.reason === "agent_candidate_blocked",
  )
  assert.throws(
    () => prepareAgentReview({
      acceptanceCriteria,
      candidate: candidateFor(contract, {
        reviewPacket: `Unsafe ${OPENAI_LIKE_TEST_TOKEN}`,
      }),
      cycle: 1,
      markerToken: "SECRETREVIEW12345",
      target,
    }),
    (error) => error.details?.reason === "review_packet_secret_detected",
  )
})
