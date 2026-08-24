import { randomUUID } from "node:crypto"

import { loadConfig } from "../src/config.mjs"
import { requestBroker } from "../src/ipc-client.mjs"

const config = loadConfig()
const configuredTaskSpace = process.env.EGO_CHAT_GATE0_TASK_SPACE ?? "Ego Chat Gate 0"
const bindingKey = process.env.EGO_CHAT_GATE0_BINDING ?? "ego-chat-main"
const numericTaskSpace = Number(configuredTaskSpace)
const taskSpace = Number.isInteger(numericTaskSpace) && numericTaskSpace > 0
  ? numericTaskSpace
  : configuredTaskSpace

let binding
try {
  binding = await requestBroker(config, "conversation.get", { bindingKey })
} catch (error) {
  if (error.code !== "binding_not_found") {
    throw error
  }
}

if (!binding) {
  const preflight = await requestBroker(config, "ego.preflight", { taskSpace }, { timeoutMs: 65_000 })
  process.stdout.write(`${JSON.stringify({ gate: "ego_chatgpt_preflight", ...preflight })}\n`)
  if (preflight.accountState !== "authenticated") {
    process.stdout.write(`${JSON.stringify({
      action: "Human must log in and verify the expected ChatGPT account in the reported Ego task space.",
      gate: "ego_chatgpt_binding",
      ok: false,
      reason: preflight.accountState,
    })}\n`)
    process.exit(2)
  }
  binding = await requestBroker(config, "conversation.bind", {
    bindingKey,
    mode: "create_once",
    startUrl: preflight.url,
    targetId: preflight.targetId,
    taskSpace: preflight.taskSpaceId,
  }, { timeoutMs: 65_000 })
}
process.stdout.write(`${JSON.stringify({ binding, gate: "ego_chatgpt_binding" })}\n`)

if (process.env.EGO_CHAT_GATE0_CONFIRM_SEND !== "1") {
  process.stdout.write(`${JSON.stringify({
    action: "Set EGO_CHAT_GATE0_CONFIRM_SEND=1 to authorize two harmless marked prompts in the bound conversation.",
    gate: "ego_chatgpt_exchange",
    ok: false,
    reason: "send_not_confirmed",
  })}\n`)
} else if ((binding.messageCount ?? 0) > 0 && process.env.EGO_CHAT_GATE0_ALLOW_REPEAT !== "1") {
  process.stdout.write(`${JSON.stringify({
    action: "The binding already has messages. Set EGO_CHAT_GATE0_ALLOW_REPEAT=1 only for an intentional repeat run.",
    gate: "ego_chatgpt_exchange",
    ok: false,
    reason: "repeat_send_not_confirmed",
  })}\n`)
} else {
  async function exchange(label, body) {
    const suffix = randomUUID().replaceAll("-", "").toUpperCase()
    const turnMarker = `EGO_CHAT_GATE0_${suffix}`
    const expectedTerminalMarker = `EGO_CHAT_GATE0_DONE_${suffix}`
    const prompt = [turnMarker, body, `End your response with this exact terminal marker on its own line: ${expectedTerminalMarker}`].join("\n\n")
    const workflow = await requestBroker(config, "ego.start_exchange", {
      bindingKey,
      expectedTerminalMarker,
      prompt,
      timeoutMs: 15 * 60 * 1000,
      turnMarker,
    })
    process.stdout.write(`${JSON.stringify({ gate: `${label}_started`, workflowId: workflow.id })}\n`)
    const completed = await requestBroker(
      config,
      "workflow.await",
      { timeoutMs: 16 * 60 * 1000, workflowId: workflow.id },
      { timeoutMs: 16 * 60 * 1000 + 5_000 },
    )
    process.stdout.write(`${JSON.stringify({
      canonicalUrl: completed.result?.canonicalUrl,
      durationMs: completed.result?.durationMs,
      gate: label,
      responseDigest: completed.result?.responseDigest,
      status: completed.status,
      workflowId: completed.id,
    })}\n`)
    return completed
  }

  const first = await exchange(
    "ego_chatgpt_exchange_first",
    "Perform a careful, adversarial architecture review of this Gate 0 invariant: one local broker persists a named ChatGPT conversation lease; the first send captures its canonical URL; all later sends must resolve that exact URL; concurrent writers are rejected; redirects, missing tabs before promotion, unexpected drafts, authentication challenges, restarts during browser work, and ambiguous send/capture states fail closed for human reconciliation. Identify the three most important remaining failure modes and concise mitigations. This is a harmless integration test; do not use external tools or connected data.",
  )
  if (first.status !== "succeeded") {
    process.stdout.write(`${JSON.stringify({
      gate: "ego_chatgpt_persistent_reuse",
      ok: false,
      reason: "first_exchange_did_not_succeed",
      secondExchangeStarted: false,
    })}\n`)
    process.exitCode = 2
  } else {
    const second = await exchange(
      "ego_chatgpt_exchange_reuse",
      "This is the follow-up persistence check. Briefly confirm that this turn is in the same conversation as the immediately preceding Gate 0 architecture review, and name its core invariant in one sentence. Do not use external tools or connected data.",
    )
    const persisted = await requestBroker(config, "conversation.get", { bindingKey })
    const sameCanonicalUrl = first.result?.canonicalUrl === second.result?.canonicalUrl
      && second.result?.canonicalUrl === persisted.canonicalUrl
    process.stdout.write(`${JSON.stringify({
      bindingKey,
      gate: "ego_chatgpt_persistent_reuse",
      ok: first.status === "succeeded" && second.status === "succeeded" && sameCanonicalUrl,
      revision: persisted.revision,
      sameCanonicalUrl,
      state: persisted.state,
    })}\n`)
  }
}
