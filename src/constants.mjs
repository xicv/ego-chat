import { createHash } from "node:crypto"

export const APP_NAME = "ego-chat"
export const APP_VERSION = "0.2.19"
export const BROWSER_CONTRACT_REVISION = 13
export const IPC_VERSION = 1

const RUNTIME_CONTRACT = {
  appVersion: APP_VERSION,
  browserContractRevision: BROWSER_CONTRACT_REVISION,
  ipcVersion: IPC_VERSION,
  mcpSchemaRevision: 10,
  runtimeGeneration: "2026-09-04.1",
  storeSchemaRevision: 7,
  taskStoreSchemaRevision: 1,
}

export const RUNTIME_IDENTITY = Object.freeze({
  ...RUNTIME_CONTRACT,
  contractDigest: createHash("sha256")
    .update(JSON.stringify(RUNTIME_CONTRACT), "utf8")
    .digest("hex"),
})

export const DEFAULT_MODEL_POLICY = Object.freeze({
  enforcement: "repair_then_verify",
  key: "chatgpt-web-default",
  modelSelection: "strongest_available",
  thinkingEffort: "maximum_available",
})

export const MAX_IPC_LINE_BYTES = 1024 * 1024
export const MAX_DRIVER_INPUT_BYTES = 512 * 1024
export const MAX_PROMPT_BYTES = 192 * 1024
export const MAX_REVIEW_PACKET_BYTES = 512 * 1024
export const MAX_RESULT_BYTES = 256 * 1024
export const DEFAULT_CHATGPT_GENERATION_MS = 2 * 60 * 60 * 1000
export const DEFAULT_BROWSER_CAPTURE_SLICE_MS = 15 * 1000
export const MAX_WAIT_MS = 8 * 60 * 60 * 1000
export const ATTACHMENT_EVIDENCE_RESERVATION_BYTES = 1024 * 1024
export const MAX_ATTACHMENT_EVIDENCE_INTENTS = 16
export const MAX_ATTACHMENT_EVIDENCE_RESERVED_BYTES = 16 * 1024 * 1024
export const ATTACHMENT_PERMANENT_RESERVATION_BYTES = 32 * 1024
export const MAX_ATTACHMENT_PERMANENT_BINDINGS = 512
export const MAX_ATTACHMENT_PERMANENT_RESERVED_BYTES = 16 * 1024 * 1024

export const READ_ONLY_IPC_METHODS = new Set([
  "attachment.evidence",
  "broker.status",
  "conversation.get",
  "model_policy.get",
  "ping",
  "result.read",
  "workflow.await",
  "workflow.get",
  "workflow.reconcile_observation",
])

export const TERMINAL_STATUSES = new Set([
  "cancelled",
  "failed",
  "human_required",
  "succeeded",
])
