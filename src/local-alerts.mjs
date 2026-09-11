import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod/v4"

const execFileAsync = promisify(execFile)

const MAX_ALERT_RECEIPTS = 200
const MESSAGE_MAX_LENGTH = 120
const NOTIFY_TIMEOUT_MS = 5_000

const AlertsConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  sound: z.string().min(1).max(64).default("Glass"),
  webhookHeaders: z.record(z.string(), z.string())
    .refine((headers) => Object.keys(headers).length <= 8, "At most 8 webhook headers are allowed")
    .optional(),
  webhookUrl: z.url({ protocol: /^https?$/ }).optional(),
})

async function defaultRunner(executable, args) {
  try {
    await execFileAsync(executable, args, { maxBuffer: 64 * 1024, timeout: NOTIFY_TIMEOUT_MS })
    return { code: 0 }
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1 }
  }
}

function loadConfig(dataDir) {
  let raw
  try {
    raw = readFileSync(path.join(dataDir, "alerts.json"), "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return { config: AlertsConfigSchema.parse({}), reason: null, valid: true }
    }
    return { config: null, reason: "config_invalid", valid: false }
  }
  let parsedJson
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return { config: null, reason: "config_invalid", valid: false }
  }
  const result = AlertsConfigSchema.safeParse(parsedJson)
  if (!result.success) {
    return { config: null, reason: "config_invalid", valid: false }
  }
  return { config: result.data, reason: null, valid: true }
}

export function formatAlertMessage(alert) {
  const shortId = String(alert.workflowId ?? "").slice(0, 8)
  const body = String(alert.message ?? "").slice(0, MESSAGE_MAX_LENGTH)
  return `${alert.workflowKind} · ${alert.status} · ${alert.code} · ${shortId}: ${body}`
}

export const ALERT_ATTENTION_STATUSES = new Set(["human_required", "failed"])
export const ALERT_ATTENTION_PHASES = new Set(["provider_paused", "capture_paused", "continuation_paused"])

export function isAttentionState(workflow) {
  return ALERT_ATTENTION_STATUSES.has(workflow?.status) || ALERT_ATTENTION_PHASES.has(workflow?.phase)
}

export function createLocalAlertSink({
  dataDir,
  fetchImpl = globalThis.fetch,
  osascript = "/usr/bin/osascript",
  runner = defaultRunner,
} = {}) {
  const loaded = loadConfig(dataDir)
  // Serializes record() writes so concurrent, fire-and-forget alert dispatches
  // cannot race on the read-truncate-rewrite sequence.
  let recordChain = Promise.resolve()

  async function macosChannel(alert, config) {
    const script = `display notification ${JSON.stringify(formatAlertMessage(alert))} `
      + `with title "Ego Chat" sound name ${JSON.stringify(config.sound)}`
    try {
      const result = await runner(osascript, ["-e", script])
      if (result?.code === 0) {
        return { channel: "macos", outcome: "accepted" }
      }
      return { channel: "macos", error: "notification_failed", outcome: "failed" }
    } catch {
      return { channel: "macos", error: "runner_error", outcome: "failed" }
    }
  }

  async function webhookChannel(alert, config) {
    try {
      const response = await fetchImpl(config.webhookUrl, {
        body: JSON.stringify(alert),
        headers: { "content-type": "application/json", ...(config.webhookHeaders ?? {}) },
        method: "POST",
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      })
      if (response?.ok) {
        return { channel: "webhook", outcome: "accepted" }
      }
      return { channel: "webhook", error: "webhook_failed", outcome: "failed" }
    } catch {
      return { channel: "webhook", error: "webhook_failed", outcome: "failed" }
    }
  }

  async function recordReceipt(receipt) {
    const filePath = path.join(dataDir, "alerts.jsonl")
    let existing = ""
    try {
      existing = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const lines = existing.length > 0 ? existing.trimEnd().split("\n") : []
    lines.push(JSON.stringify(receipt))
    const bounded = lines.slice(-MAX_ALERT_RECEIPTS)
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmpPath, `${bounded.join("\n")}\n`, { mode: 0o600 })
    await fs.rename(tmpPath, filePath)
  }

  return {
    describe() {
      if (!loaded.valid) {
        return { enabled: false, reason: "config_invalid", sound: null, webhook: false }
      }
      const { config } = loaded
      return { enabled: config.enabled, reason: null, sound: config.sound, webhook: config.webhookUrl !== undefined }
    },

    async notify(alert) {
      if (!loaded.valid || !loaded.config.enabled) {
        return { channels: [] }
      }
      const { config } = loaded
      const channels = [await macosChannel(alert, config)]
      if (config.webhookUrl !== undefined) {
        channels.push(await webhookChannel(alert, config))
      }
      await this.record({
        at: alert.at,
        channels,
        code: alert.code,
        workflowId: alert.workflowId,
      })
      return { channels }
    },

    async record(receipt) {
      recordChain = recordChain.then(() => recordReceipt(receipt))
      await recordChain
    },
  }
}
