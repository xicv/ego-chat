import { createHash } from "node:crypto"

export const EAGLE_MONITOR_SCHEMA_VERSION = 1
export const EAGLE_MONITOR_LABEL = "com.xicv.ego-chat.eagle-monitor"
export const EAGLE_MONITOR_INCIDENT_LIMIT = 200

export const EAGLE_MONITOR_MODES = Object.freeze(["safe", "shadow"])
export const EAGLE_MONITOR_POWER_POLICIES = Object.freeze([
  "allow-sleep",
  "keep-awake-on-ac",
])

const POLICY_CONTRACT = {
  actions: [
    "attach_exact_workflow",
    "hold_idle_sleep_assertion",
    "notify_user",
    "observe",
    "reconcile_exact_workflow",
    "release_idle_sleep_assertion",
    "start_broker",
  ],
  crashLoop: { limit: 3, windowMs: 10 * 60 * 1000 },
  deadConfirmationMs: 1_000,
  postSendStallMs: 2 * 60 * 60 * 1000,
  preSendStallMs: 5 * 60 * 1000,
  schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
}

export const EAGLE_MONITOR_POLICY = Object.freeze({
  ...POLICY_CONTRACT,
  digest: createHash("sha256")
    .update(JSON.stringify(POLICY_CONTRACT), "utf8")
    .digest("hex"),
})

export const EAGLE_MONITOR_EXIT = Object.freeze({
  ATTENTION_REQUIRED: 2,
  NOT_RUNNING: 3,
  OK: 0,
  SOFTWARE: 70,
  UNAVAILABLE: 69,
  USAGE: 64,
})

const EVIDENCE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export function safeEvidenceCode(value) {
  return typeof value === "string" && EVIDENCE_CODE_PATTERN.test(value) ? value : null
}
