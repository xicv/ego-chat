import { EgoChatError } from "./errors.mjs"

export class FakeRemoteImplementer {
  #spine

  constructor(spine) {
    this.#spine = spine
  }

  async publishPullRequest({ baseSha, headSha, repository = "fake/example", taskId }) {
    return this.#spine.publishPullRequest({
      baseSha,
      headSha,
      remoteRef: {
        number: 1,
        repository,
        transport: "fake",
      },
      taskId,
    })
  }
}

export class FakeVerificationRunner {
  #runnerId
  #spine

  constructor(spine, runnerId) {
    this.#runnerId = runnerId
    this.#spine = spine
  }

  async register(capabilities = ["verification"]) {
    return this.#spine.registerRunner({ capabilities, runnerId: this.#runnerId })
  }

  async lease({ activityId, leaseId, reassign = false, taskId, ttlMs }) {
    return this.#spine.leaseVerification({
      activityId,
      leaseId,
      reassign,
      runnerId: this.#runnerId,
      taskId,
      ttlMs,
    })
  }

  async complete({ evidence, fencingToken, leaseId, success = true }) {
    return this.#spine.completeVerification({
      evidence,
      fencingToken,
      leaseId,
      runnerId: this.#runnerId,
      success,
    })
  }
}

export class FakeEffectAdapter {
  #applyCalls = new Map()
  #created = new Map()
  #id

  constructor(id = "fake-effect-adapter") {
    this.#id = id
  }

  get id() {
    return this.#id
  }

  async reconcile({ effectId, inputDigest }) {
    const record = this.#created.get(effectId)
    if (!record) return { found: false }
    if (record.inputDigest !== inputDigest) {
      throw new EgoChatError(
        "effect_identity_conflict",
        "The fake external system found an effect identity with a different input digest.",
      )
    }
    return { found: true, result: structuredClone(record.result) }
  }

  async apply({ effectId, input, inputDigest, kind, taskId }) {
    this.#applyCalls.set(effectId, (this.#applyCalls.get(effectId) ?? 0) + 1)
    const existing = this.#created.get(effectId)
    if (existing) {
      if (existing.inputDigest !== inputDigest) {
        throw new EgoChatError(
          "effect_identity_conflict",
          "The fake external system rejected conflicting idempotency input.",
        )
      }
      return structuredClone(existing.result)
    }
    const result = {
      externalId: `fake-effect-${this.#created.size + 1}`,
      kind,
      taskId,
      value: structuredClone(input),
    }
    this.#created.set(effectId, { inputDigest, result: structuredClone(result) })
    return result
  }

  applyCallCount(effectId) {
    return this.#applyCalls.get(effectId) ?? 0
  }

  creationCount(effectId) {
    return this.#created.has(effectId) ? 1 : 0
  }
}
