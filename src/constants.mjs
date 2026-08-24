export const APP_NAME = "ego-chat"
export const APP_VERSION = "0.0.0-gate0"
export const IPC_VERSION = 1

export const DEFAULT_MODEL_POLICY = Object.freeze({
  enforcement: "repair_then_verify",
  key: "chatgpt-web-default",
  modelSelection: "strongest_available",
  thinkingEffort: "maximum_available",
})

export const MAX_IPC_LINE_BYTES = 1024 * 1024
export const MAX_PROMPT_BYTES = 64 * 1024
export const MAX_RESULT_BYTES = 256 * 1024
export const MAX_WAIT_MS = 30 * 60 * 1000

export const TERMINAL_STATUSES = new Set([
  "cancelled",
  "failed",
  "human_required",
  "succeeded",
])
