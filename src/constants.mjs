import { createHash } from "node:crypto"

export const APP_NAME = "ego-chat"
export const APP_VERSION = "0.2.13"
export const BROWSER_CONTRACT_REVISION = 11
export const IPC_VERSION = 1

const RUNTIME_CONTRACT = {
  appVersion: APP_VERSION,
  browserContractRevision: BROWSER_CONTRACT_REVISION,
  ipcVersion: IPC_VERSION,
  mcpSchemaRevision: 8,
  runtimeGeneration: "2026-09-02.3",
  storeSchemaRevision: 4,
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
export const MAX_PROMPT_BYTES = 64 * 1024
export const MAX_RESULT_BYTES = 256 * 1024
export const DEFAULT_CHATGPT_GENERATION_MS = 2 * 60 * 60 * 1000
export const DEFAULT_BROWSER_CAPTURE_SLICE_MS = 15 * 1000
export const MAX_WAIT_MS = 6 * 60 * 60 * 1000

export const READ_ONLY_IPC_METHODS = new Set([
  "broker.status",
  "conversation.get",
  "model_policy.get",
  "ping",
  "result.read",
  "workflow.await",
  "workflow.get",
])

export const TERMINAL_STATUSES = new Set([
  "cancelled",
  "failed",
  "human_required",
  "succeeded",
])
