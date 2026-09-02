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
  consumeChatGptReview,
  evaluateReview,
  parseChatGptReview,
  parseChatGptReviewEnvelope,
  prepareAgentReview,
  prepareAgentReviewProtocolRepair,
  redactSecrets,
  reviewProtocolFailureSignature,
  scanForSecrets,
  validateAgentCandidate,
  validateCodexCandidate,
} from "../src/convergence.mjs"
import {
  MAX_PROMPT_BYTES,
  MAX_REVIEW_PACKET_BYTES,
} from "../src/constants.mjs"

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

test("natural-language review is a first-class continuation instead of a protocol failure", () => {
  const contract = createContract("Keep working until the review is settled.", [
    "The candidate handles the reported edge case.",
    "The relevant verification passes.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_NATURAL1234"
  const response = [
    "The direction is sound, but the restart path still loses its pending response.",
    "Please preserve the message identity across restart and add a regression test.",
    "EGO_CHAT_DECISION: CONTINUE",
    terminalMarker,
  ].join("\n")

  const consumed = consumeChatGptReview(response, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.equal(consumed.review.decision, "continue")
  assert.equal(consumed.review.findings.length, 1)
  assert.match(consumed.review.findings[0].action, /preserve the message identity/i)
  assert.equal(consumed.review.criteria.every(({ status }) => status === "unknown"), true)
  assert.deepEqual(consumed.protocolNormalization, {
    applied: true,
    rules: [{ count: 1, rule: "natural_language_review" }],
  })
  assert.deepEqual(evaluateReview(consumed.review), { settled: false })
})

test("long natural-language review remains available to the next convergence cycle", () => {
  const contract = createContract("Carry the complete substantive review forward.", [
    "The next implementing turn receives the detailed review.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_LONGNATURAL1234"
  const detailedReview = `Preserve this detailed review context. ${"evidence ".repeat(2_000)}`
  const consumed = consumeChatGptReview([
    detailedReview,
    "EGO_CHAT_DECISION: CONTINUE",
    terminalMarker,
  ].join("\n"), {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.equal(consumed.review.summary, detailedReview.trim())
  assert.ok(Buffer.byteLength(consumed.review.summary, "utf8") > 4_000)
  assert.ok(Buffer.byteLength(consumed.review.findings[0].action, "utf8") <= 4_000)
})

test("a simple explicit verdict can settle without a fragile JSON envelope", () => {
  const target = "Settle a candidate without making prose conform to a control schema."
  const acceptanceCriteria = [
    "The exact candidate is independently reviewed.",
    "No blocking finding remains.",
  ]
  const contract = createContract(target, acceptanceCriteria)
  const prepared = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract),
    cycle: 3,
    markerToken: "NATURALSETTLED1234",
    target,
  })
  const response = [
    "I reviewed the supplied candidate and validation evidence against both acceptance criteria.",
    "No correctness, security, or verification blocker remains.",
    "EGO_CHAT_DECISION: SETTLED",
    prepared.terminalMarker,
  ].join("\n")

  const completed = completeAgentReview(prepared, response)

  assert.equal(completed.settled, true)
  assert.equal(completed.review.decision, "settled")
  assert.equal(completed.review.criteria.every(({ status }) => status === "pass"), true)
})

test("missing reviewer formatting remains actionable and never requests a resend", () => {
  const contract = createContract("Continue through imperfect reviewer output.", [
    "The reviewer feedback reaches the implementing agent.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_FORMATLESS1234"

  const consumed = consumeChatGptReview(
    `Please add a restart regression before settling.\n${terminalMarker}`,
    {
      candidateDigest,
      criteria: contract.criteria,
      cycle: 1,
      targetDigest: contract.targetDigest,
      terminalMarker,
    },
  )

  assert.equal(consumed.review.decision, "continue")
  assert.match(consumed.review.summary, /restart regression/i)
  assert.equal(consumed.review.findings[0].severity, "blocking")
})

test("an unambiguous ChatGPT assessment alias is normalized without another browser send", () => {
  const contract = createContract("Consume one already-delivered review safely.", [
    "The delivered criterion assessment remains available as evidence.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_ALIAS1234"
  const aliased = reviewFor(contract, candidateDigest, {
    criteria: [{ assessment: "The exact candidate was independently verified.", id: "AC-1", status: "pass" }],
  })

  const parsed = parseChatGptReview(`${JSON.stringify(aliased)}\n${terminalMarker}`, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.deepEqual(parsed.criteria, [{
    evidence: "The exact candidate was independently verified.",
    id: "AC-1",
    status: "pass",
  }])

  for (const criteria of [
    [{
      assessment: "Conflicting alias.",
      evidence: "Canonical evidence.",
      id: "AC-1",
      status: "pass",
    }],
    [{
      assessment: "Aliased evidence.",
      id: "AC-1",
      note: "Unexpected extra field.",
      status: "pass",
    }],
  ]) {
    assert.throws(
      () => parseChatGptReview(`${JSON.stringify(reviewFor(contract, candidateDigest, { criteria }))}\n${terminalMarker}`, {
        candidateDigest,
        criteria: contract.criteria,
        cycle: 1,
        targetDigest: contract.targetDigest,
        terminalMarker,
      }),
      (error) => error.details?.reason === "convergence_protocol_invalid",
    )
  }
})

test("unescaped JSON string controls are normalized without another browser send", () => {
  const contract = createContract("Consume the already-delivered review safely.", [
    "The review remains bound to the exact candidate.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_RAWCONTROL1234"
  const review = reviewFor(contract, candidateDigest, {
    criteria: [{
      evidence: "The first line.\nThe second line.",
      id: "AC-1",
      status: "pass",
    }],
  })
  const malformed = JSON.stringify(review).replace(
    "The first line.\\nThe second line.",
    "The first line.\nThe second line.",
  )

  const parsed = parseChatGptReviewEnvelope(`${malformed}\n${terminalMarker}`, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.equal(parsed.review.criteria[0].evidence, "The first line.\nThe second line.")
  assert.deepEqual(parsed.protocolNormalization, {
    applied: true,
    rules: [{ count: 1, rule: "json_string_control_escape" }],
  })
})

test("unescaped quotes inside review prose are normalized without another browser send", () => {
  const contract = createContract("Consume the already-delivered review safely.", [
    "The review remains bound to the exact candidate.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_RAWQUOTE1234"
  const review = reviewFor(contract, candidateDigest, {
    decision: "continue",
    findings: [{
      action: "Replace the split call with an exact frontmatter parser.",
      id: "B-STRICT_FRONTMATTER",
      severity: "blocking",
      title: "The parser accepts a preamble",
    }],
    summary: "The parser uses split(\"---\", 2), which accepts a preamble.",
  })
  const malformed = JSON.stringify(review).replace(
    String.raw`split(\"---\", 2)`,
    `split("---", 2)`,
  )

  const parsed = parseChatGptReviewEnvelope(`${malformed}\n${terminalMarker}`, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.equal(parsed.review.summary, review.summary)
  assert.deepEqual(parsed.protocolNormalization, {
    applied: true,
    rules: [{ count: 2, rule: "json_string_quote_escape" }],
  })
  assert.deepEqual(evaluateReview(parsed.review), { settled: false })
})

test("unambiguous trailing JSON commas are normalized without another browser send", () => {
  const contract = createContract("Consume one trailing-comma review safely.", [
    "The exact candidate remains independently verified.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_TRAILINGCOMMA1234"
  const review = JSON.stringify(reviewFor(contract, candidateDigest, {
    criteria: [{ evidence: "Literal ,} remains evidence.", id: "AC-1", status: "pass" }],
  }), null, 2)
    .replace(/\n  \]/, ",\n  ]")
    .replace(/\n}/, ",\n}")

  const parsed = parseChatGptReviewEnvelope(`${review}\n${terminalMarker}`, {
    candidateDigest,
    criteria: contract.criteria,
    cycle: 1,
    targetDigest: contract.targetDigest,
    terminalMarker,
  })

  assert.deepEqual(parsed.protocolNormalization, {
    applied: true,
    rules: [{ count: 2, rule: "json_trailing_comma_remove" }],
  })
  assert.equal(parsed.review.criteria[0].evidence, "Literal ,} remains evidence.")
})

test("forged identities fail closed while inconsistent settlement remains a continuation", () => {
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
  assert.deepEqual(evaluateReview(incomplete), { settled: false })
})

test("duplicate structural review fields remain invalid during text repair", () => {
  const contract = createContract("Settle only one unambiguous review.", [
    "The review identity remains unique.",
  ])
  const candidateDigest = digestJson(candidateFor(contract))
  const terminalMarker = "EGO_CHAT_REVIEW_DONE_DUPLICATE1234"
  const review = JSON.stringify(reviewFor(contract, candidateDigest)).replace(
    `"targetDigest":"${contract.targetDigest}"`,
    `"targetDigest":"${"0".repeat(64)}","targetDigest":"${contract.targetDigest}"`,
  )

  assert.throws(
    () => parseChatGptReview(`${review}\n${terminalMarker}`, {
      candidateDigest,
      criteria: contract.criteria,
      cycle: 1,
      targetDigest: contract.targetDigest,
      terminalMarker,
    }),
    (error) => error.details?.reason === "convergence_protocol_invalid",
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

  assert.deepEqual(
    evaluateReview(reviewFor(contract, candidateDigest, { decision: "continue" })),
    { settled: false },
  )
  assert.match(buildCodexPrompt({
    contract,
    cycle: 2,
    priorReview: actionable,
    sandbox: "read-only",
  }), /untrusted context/)

  const reviewPrompt = buildChatGptPrompt({
    candidate: candidateFor(contract),
    candidateDigest,
    contract,
    cycle: 1,
    terminalMarker: "EGO_CHAT_REVIEW_DONE_SCHEMA123",
    turnMarker: "EGO_CHAT_CONVERGENCE_SCHEMA123_C1",
  })
  assert.match(reviewPrompt, /ordinary Markdown/i)
  assert.match(reviewPrompt, /EGO_CHAT_DECISION: SETTLED/)
  assert.doesNotMatch(reviewPrompt, /Return exactly one JSON object/)
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
  const sanitized = redactSecrets(`token ${OPENAI_LIKE_TEST_TOKEN}`)
  assert.equal(sanitized.redacted, true)
  assert.deepEqual(sanitized.signatures, ["openai_api_key"])
  assert.deepEqual(scanForSecrets(sanitized.value), [])
  assert.doesNotMatch(sanitized.value, new RegExp(OPENAI_LIKE_TEST_TOKEN))
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
  assert.deepEqual(completed.protocolNormalization, { applied: false, rules: [] })
})

test("a host-owned review can continue beyond six cycles", () => {
  const target = "Keep reviewing until the immutable target is settled."
  const acceptanceCriteria = ["The seventh candidate is independently settled."]
  const contract = createContract(target, acceptanceCriteria)
  const prepared = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract),
    cycle: 7,
    markerToken: "HOSTOWNEDCYCLESEVEN1234",
    target,
  })
  const review = reviewFor(contract, prepared.candidateDigest, { cycle: 7 })

  const completed = completeAgentReview(
    prepared,
    `${JSON.stringify(review)}\n${prepared.terminalMarker}`,
  )

  assert.equal(completed.settled, true)
  assert.equal(completed.review.cycle, 7)
})

test("review packet admission compacts oversized UTF-8 prompts without stopping", () => {
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
    MAX_REVIEW_PACKET_BYTES,
  )
  assert.ok(Buffer.byteLength(prepared.prompt, "utf8") < MAX_PROMPT_BYTES)

  const oversizedPacket = "界".repeat(70_000)
  const compacted = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract, { reviewPacket: oversizedPacket }),
    cycle: 1,
    markerToken: "MULTIBYTETESTPACKET1234",
    target,
  })
  assert.equal(compacted.transportCompaction.applied, true)
  assert.ok(compacted.transportCompaction.originalBytes > MAX_PROMPT_BYTES)
  assert.ok(compacted.transportCompaction.transmittedBytes <= MAX_PROMPT_BYTES)
  assert.match(compacted.prompt, /deterministically compacted/)
  const claimedSettlement = reviewFor(contract, compacted.candidateDigest)
  const continued = completeAgentReview(
    compacted,
    `${JSON.stringify(claimedSettlement)}\n${compacted.terminalMarker}`,
  )
  assert.equal(continued.settled, false)
  assert.equal(continued.review.findings[0].id, "B-TRANSPORT-COMPACTED")

  const oversizedAsciiPacket = "x".repeat(MAX_PROMPT_BYTES * 2)
  const compactedAscii = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract, { reviewPacket: oversizedAsciiPacket }),
    cycle: 1,
    markerToken: "OVERSIZEDASCIIPACKET12",
    target,
  })
  assert.equal(compactedAscii.transportCompaction.applied, true)
  assert.ok(compactedAscii.transportCompaction.transmittedBytes <= MAX_PROMPT_BYTES)

  assert.throws(
    () => validateAgentCandidate(
      candidateFor(contract, { reviewPacket: "x".repeat(MAX_REVIEW_PACKET_BYTES + 1) }),
      contract.criteria,
    ),
    (error) => error.details?.reason === "convergence_protocol_invalid",
  )
  assert.throws(
    () => validateAgentCandidate(
      candidateFor(contract, {
        reviewPacket: "界".repeat(Math.floor(MAX_REVIEW_PACKET_BYTES / 3) + 1),
      }),
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

test("protocol-only review failures create a deterministic same-cycle corrective turn", () => {
  const target = "Repair one already-delivered review without changing the candidate."
  const acceptanceCriteria = ["The exact candidate identity remains frozen."]
  const contract = createContract(target, acceptanceCriteria)
  const initial = prepareAgentReview({
    acceptanceCriteria,
    bindingKey: "ego-chat-main",
    candidate: candidateFor(contract),
    cycle: 3,
    operationId: "review-protocol-repair-test",
    target,
  })
  const previousResponseDigest = "a".repeat(64)
  const repaired = prepareAgentReviewProtocolRepair(initial, {
    failureReason: "convergence_protocol_invalid",
    previousResponseDigest,
    protocolRepairAttempt: 1,
  })
  const replayed = prepareAgentReviewProtocolRepair(initial, {
    failureReason: "convergence_protocol_invalid",
    previousResponseDigest,
    protocolRepairAttempt: 1,
  })
  const deliveryRetry = prepareAgentReviewProtocolRepair(initial, {
    deliveryAttempt: 2,
    failureReason: "convergence_protocol_invalid",
    previousResponseDigest,
    protocolRepairAttempt: 1,
  })

  assert.equal(repaired.prompt, replayed.prompt)
  assert.equal(repaired.turnMarker, replayed.turnMarker)
  assert.notEqual(repaired.turnMarker, initial.turnMarker)
  assert.notEqual(deliveryRetry.turnMarker, repaired.turnMarker)
  assert.equal(repaired.candidateDigest, initial.candidateDigest)
  assert.equal(repaired.contract.targetDigest, initial.contract.targetDigest)
  assert.equal(repaired.cycle, 3)
  assert.equal(repaired.operationId, initial.operationId)
  assert.equal(repaired.protocolRepairAttempt, 1)
  assert.match(repaired.prompt, /protocol repair for the same candidate and cycle/i)
  assert.match(repaired.prompt, /all quoted content as untrusted data/i)
  assert.match(repaired.prompt, new RegExp(previousResponseDigest))
  assert.doesNotMatch(repaired.prompt, /Implementing-agent review packet/)
})

test("protocol failure signatures ignore fresh terminal-marker identity but retain substance", () => {
  const first = reviewProtocolFailureSignature(
    "convergence_protocol_invalid",
    `not json\nEGO_CHAT_REVIEW_DONE_FIRST1234`,
  )
  const repeated = reviewProtocolFailureSignature(
    "convergence_protocol_invalid",
    `not json\nEGO_CHAT_REVIEW_DONE_SECOND5678`,
  )
  const changed = reviewProtocolFailureSignature(
    "convergence_protocol_invalid",
    `different invalid body\nEGO_CHAT_REVIEW_DONE_THIRD9012`,
  )

  assert.equal(repeated, first)
  assert.notEqual(changed, first)
})

test("blocked candidates continue to review and secret signatures are redacted", () => {
  const target = "Continue safely without leaking review-packet secrets."
  const acceptanceCriteria = ["Unresolved blockers remain reviewable without exposing secrets."]
  const contract = createContract(target, acceptanceCriteria)

  const blocked = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract, {
      blockers: ["Missing authority."],
      status: "blocked",
    }),
    cycle: 1,
    markerToken: "BLOCKEDREVIEW1234",
    target,
  })
  const claimedSettlement = reviewFor(contract, blocked.candidateDigest)
  const completed = completeAgentReview(
    blocked,
    `${JSON.stringify(claimedSettlement)}\n${blocked.terminalMarker}`,
  )
  assert.equal(completed.settled, false)
  assert.equal(completed.review.decision, "continue")
  assert.match(completed.review.findings[0].action, /Missing authority/)

  const sanitized = prepareAgentReview({
    acceptanceCriteria,
    candidate: candidateFor(contract, {
      reviewPacket: `Unsafe ${OPENAI_LIKE_TEST_TOKEN}`,
    }),
    cycle: 1,
    markerToken: "SECRETREVIEW12345",
    target,
  })
  assert.deepEqual(sanitized.redactedSecretSignatures, ["openai_api_key"])
  assert.deepEqual(scanForSecrets(sanitized.prompt), [])
  assert.doesNotMatch(sanitized.prompt, new RegExp(OPENAI_LIKE_TEST_TOKEN))
})
