import { randomUUID } from "node:crypto"

import { EgoChatError } from "./errors.mjs"
import {
  assertEffectStatus,
  cloneTaskValue,
  digestTaskValue,
  selectConversation,
} from "./task-domain.mjs"
import { DurableTaskStore } from "./task-store.mjs"

export const EFFECT_CRASH_POINTS = Object.freeze([
  "after_reserved",
  "after_dispatching",
  "after_external_apply",
  "after_applied",
  "after_succeeded",
])

export class InjectedEffectCrash extends Error {
  constructor(crashPoint) {
    super(`Injected effect crash at ${crashPoint}`)
    this.code = "injected_effect_crash"
    this.crashPoint = crashPoint
    this.name = "InjectedEffectCrash"
  }
}

function defaultIdFactory(kind) {
  return `${kind}_${randomUUID()}`
}

function validateClockValue(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError("clock must return a valid date")
  return date
}

function maybeCrash(expected, actual) {
  if (expected === actual) throw new InjectedEffectCrash(actual)
}

export class DurableTaskSpine {
  #clock
  #idFactory
  #store

  constructor({ clock = () => new Date(), idFactory = defaultIdFactory, store }) {
    if (!store || typeof store.transact !== "function" || typeof store.snapshot !== "function") {
      throw new TypeError("store must implement the durable task store contract")
    }
    this.#clock = clock
    this.#idFactory = idFactory
    this.#store = store
  }

  async initialize() {
    return this.#store.initialize()
  }

  getMetrics() {
    return this.#store.getMetrics()
  }

  async createConversation({
    acceptanceContract,
    conversationId = this.#id("conversation"),
    requiredEvidenceKinds = ["verification"],
    taskId = this.#id("task"),
  }) {
    const transition = await this.#store.transact({
      acceptanceContract,
      at: this.#now(),
      conversationId,
      requiredEvidenceKinds,
      taskId,
      type: "create_conversation_and_task",
    })
    return this.#selectCreated(transition.state, conversationId, taskId)
  }

  async attachConversation({ conversationId, cursor = 0 }) {
    return selectConversation(await this.#store.snapshot(), conversationId, cursor)
  }

  async registerRunner({ capabilities = ["verification"], runnerId = this.#id("runner") }) {
    const transition = await this.#store.transact({
      at: this.#now(),
      capabilities,
      runnerId,
      type: "register_runner",
    })
    return structuredClone(transition.state.runners[runnerId])
  }

  async publishPullRequest({
    artifactId = this.#id("artifact"),
    baseSha,
    headSha,
    remoteRef,
    taskId,
  }) {
    const transition = await this.#store.transact({
      artifactId,
      at: this.#now(),
      baseSha,
      headSha,
      remoteRef,
      taskId,
      type: "publish_pull_request",
    })
    return structuredClone(transition.state.artifacts[artifactId])
  }

  async leaseVerification({
    activityId = this.#id("activity"),
    leaseId = this.#id("lease"),
    reassign = false,
    runnerId,
    taskId,
    ttlMs,
  }) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError("ttlMs must be a positive safe integer")
    }
    const now = validateClockValue(this.#clock())
    const transition = await this.#store.transact({
      activityId,
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      leaseId,
      reassign,
      runnerId,
      taskId,
      type: "lease_verification",
    })
    return structuredClone(transition.state.leases[leaseId])
  }

  async completeVerification({ evidence, fencingToken, leaseId, runnerId, success }) {
    const transition = await this.#store.transact({
      at: this.#now(),
      evidence,
      fencingToken,
      leaseId,
      runnerId,
      success,
      type: "complete_verification",
    })
    const lease = transition.state.leases[leaseId]
    return structuredClone({
      activity: transition.state.activities[lease.activityId],
      lease,
      task: transition.state.tasks[lease.taskId],
    })
  }

  async recordReview({
    activityId = this.#id("activity"),
    baseSha,
    evidence,
    headSha,
    outcome,
    taskId,
  }) {
    const transition = await this.#store.transact({
      activityId,
      at: this.#now(),
      baseSha,
      evidence,
      headSha,
      outcome,
      taskId,
      type: "record_review",
    })
    return structuredClone(transition.state.activities[activityId])
  }

  async grantApproval({
    approvalId = this.#id("approval"),
    approver,
    baseSha,
    evidenceActivityIds,
    headSha,
    taskId,
  }) {
    const transition = await this.#store.transact({
      approvalId,
      approver,
      at: this.#now(),
      baseSha,
      evidenceActivityIds,
      headSha,
      taskId,
      type: "grant_approval",
    })
    return structuredClone({
      approval: transition.state.approvals[approvalId],
      task: transition.state.tasks[taskId],
    })
  }

  async runEffect({ adapter, crashAfter = undefined, effectId, input, kind, taskId }) {
    if (!adapter || typeof adapter.apply !== "function" || typeof adapter.reconcile !== "function") {
      throw new TypeError("effect adapter must implement apply and reconcile")
    }
    if (crashAfter !== undefined && !EFFECT_CRASH_POINTS.includes(crashAfter)) {
      throw new TypeError("crashAfter must name a supported deterministic effect crash point")
    }
    if (typeof adapter.id !== "string" || adapter.id.length < 1) {
      throw new TypeError("effect adapter must expose a stable id")
    }
    const adapterId = adapter.id
    const reservedInput = cloneTaskValue(input)
    const inputDigest = digestTaskValue(reservedInput)
    let transition = await this.#store.transact({
      adapterId,
      at: this.#now(),
      effectId,
      input: reservedInput,
      inputDigest,
      kind,
      taskId,
      type: "reserve_effect",
    })
    let effect = assertEffectStatus(transition.state.effects[effectId])
    maybeCrash(crashAfter, "after_reserved")
    if (effect.status === "succeeded") return structuredClone(effect)

    if (effect.status === "reserved") {
      transition = await this.#store.transact({
        at: this.#now(),
        effectId,
        type: "dispatch_effect",
      })
      effect = transition.state.effects[effectId]
    }
    maybeCrash(crashAfter, "after_dispatching")

    if (effect.status === "dispatching") {
      const identity = {
        adapterId: effect.adapterId,
        effectId: effect.id,
        inputDigest: effect.inputDigest,
        kind: effect.kind,
        taskId: effect.taskId,
      }
      const observed = await adapter.reconcile(structuredClone(identity))
      let result
      if (observed?.found === true) {
        result = observed.result
      } else if (observed?.found === false) {
        await this.#store.transact({
          at: this.#now(),
          effectId,
          type: "note_effect_absent",
        })
        result = await adapter.apply({ ...identity, input: structuredClone(effect.input) })
        maybeCrash(crashAfter, "after_external_apply")
      } else {
        throw new EgoChatError(
          "effect_reconciliation_ambiguous",
          "The effect adapter did not prove whether the external effect exists.",
          { effectId },
        )
      }
      transition = await this.#store.transact({
        at: this.#now(),
        effectId,
        result,
        type: "record_effect_applied",
      })
      effect = transition.state.effects[effectId]
    }
    maybeCrash(crashAfter, "after_applied")

    if (effect.status === "applied") {
      transition = await this.#store.transact({
        at: this.#now(),
        effectId,
        type: "complete_effect",
      })
      effect = transition.state.effects[effectId]
    }
    maybeCrash(crashAfter, "after_succeeded")
    return structuredClone(assertEffectStatus(effect))
  }

  #id(kind) {
    const value = this.#idFactory(kind)
    if (typeof value !== "string") throw new TypeError("idFactory must return a string")
    return value
  }

  #now() {
    return validateClockValue(this.#clock()).toISOString()
  }

  #selectCreated(state, conversationId, taskId) {
    return structuredClone({
      conversation: state.conversations[conversationId],
      cursor: state.events.at(-1)?.seq ?? 0,
      task: state.tasks[taskId],
    })
  }
}

export function createDurableTaskSpine({ clock, dataDir, idFactory } = {}) {
  if (typeof dataDir !== "string" || dataDir.length < 1) {
    throw new TypeError("dataDir is required")
  }
  return new DurableTaskSpine({
    ...(clock ? { clock } : {}),
    ...(idFactory ? { idFactory } : {}),
    store: new DurableTaskStore(dataDir),
  })
}
