import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"

import { EGO_DRIVER_RESULT_PREFIX, EGO_DRIVER_SOURCE } from "./ego-driver-source.mjs"
import { EgoChatError } from "./errors.mjs"
import { MAX_IPC_LINE_BYTES, MAX_RESULT_BYTES } from "./constants.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function decodeDriverResult(stdout) {
  const lines = stdout.split("\n")
  const resultLines = lines.filter((line) => line.includes(EGO_DRIVER_RESULT_PREFIX))
  if (resultLines.length !== 1) {
    throw new EgoChatError("invalid_driver_output", "The Ego Browser driver did not return exactly one result envelope.", {
      outputBytes: Buffer.byteLength(stdout, "utf8"),
      outputDigest: digest(stdout),
      resultEnvelopeCount: resultLines.length,
    })
  }

  let decoded
  try {
    const prefixIndex = resultLines[0].indexOf(EGO_DRIVER_RESULT_PREFIX)
    const encoded = resultLines[0].slice(prefixIndex + EGO_DRIVER_RESULT_PREFIX.length).trim()
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch (_error) {
    throw new EgoChatError("invalid_driver_output", "The Ego Browser driver returned an invalid result envelope.")
  }

  if (decoded?.ok === true && decoded.result && typeof decoded.result === "object") {
    return decoded.result
  }
  if (decoded?.humanRequired === true) {
    throw new EgoChatError("human_required", decoded.message ?? "Human browser intervention is required.", {
      evidence: decoded.evidence ?? {},
      reason: decoded.reason ?? "browser_intervention_required",
    })
  }
  throw new EgoChatError(
    decoded?.error?.code ?? "ego_driver_failed",
    decoded?.error?.message ?? "The Ego Browser driver failed.",
    decoded?.error?.diagnosticDigest
      ? { diagnosticDigest: decoded.error.diagnosticDigest }
      : undefined,
  )
}

async function writePrivateJson(filePath, value) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  )
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class EgoAdapter {
  #command

  constructor({ command }) {
    this.#command = command
  }

  async preflight({ taskSpace }) {
    return this.#run({ mode: "preflight", taskSpace }, 60_000)
  }

  async bind(params, signal = undefined) {
    const { mode: bindingMode, ...bindingInput } = params
    return this.#run({ ...bindingInput, bindingMode, mode: "bind" }, 60_000, signal)
  }

  async exchange(params, signal = undefined) {
    return this.#run({ mode: "exchange", ...params }, params.timeoutMs + 60_000, signal)
  }

  async ensureModelPolicy(params, signal = undefined) {
    return this.#run({ mode: "model_policy", ...params }, 60_000, signal)
  }

  async reconcile(params, signal = undefined) {
    return this.#run({ mode: "reconcile", ...params }, 60_000, signal)
  }

  async reconcileBound(params, signal = undefined) {
    return this.#run({ mode: "reconcile_bound", ...params }, 60_000, signal)
  }

  async verify(params, signal = undefined) {
    return this.#run({ mode: "verify", ...params }, 60_000, signal)
  }

  async #run(input, timeoutMs, signal = undefined) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user"
    const mailboxDirectory = `/tmp/egc-driver-${uid}`
    await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
    const mailboxStat = await fs.stat(mailboxDirectory)
    if (
      !mailboxStat.isDirectory()
      || (typeof process.getuid === "function" && mailboxStat.uid !== process.getuid())
      || (mailboxStat.mode & 0o077) !== 0
    ) {
      throw new EgoChatError("unsafe_driver_mailbox", "The fixed Ego driver mailbox is not private to the current user.")
    }
    const inputPath = `${mailboxDirectory}/input.json`
    await writePrivateJson(inputPath, input)

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.#command, ["nodejs"], {
          env: process.env,
          signal,
          stdio: ["pipe", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let overflow = false
        let settled = false

        const timer = setTimeout(() => {
          child.kill("SIGTERM")
          finish(reject, new EgoChatError("ego_driver_timeout", "The Ego Browser driver exceeded its local deadline."))
        }, timeoutMs)
        const finish = (callback, value) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          callback(value)
        }

        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk) => {
          stdout += chunk
          if (Buffer.byteLength(stdout, "utf8") > MAX_RESULT_BYTES) {
            overflow = true
            child.kill("SIGTERM")
          }
        })
        child.stderr.on("data", (chunk) => {
          stderr += chunk
          if (Buffer.byteLength(stderr, "utf8") > MAX_IPC_LINE_BYTES) {
            stderr = stderr.slice(-MAX_IPC_LINE_BYTES)
          }
        })
        child.on("error", (error) => finish(reject, error))
        child.on("close", (code, closeSignal) => {
          if (overflow) {
            finish(reject, new EgoChatError("driver_output_too_large", "The Ego Browser driver output exceeded the configured limit."))
          } else if (code === 0) {
            try {
              finish(resolve, decodeDriverResult(`${stdout}\n${stderr}`))
            } catch (error) {
              finish(reject, error)
            }
          } else {
            finish(reject, new EgoChatError("ego_browser_process_failed", "The Ego Browser process exited unsuccessfully.", {
              diagnosticDigest: digest(stderr),
              exitCode: code,
              signal: closeSignal,
            }))
          }
        })

        child.stdin.end(EGO_DRIVER_SOURCE)
      })
      return result
    } finally {
      await fs.unlink(inputPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error
        }
      })
    }
  }
}

export { decodeDriverResult }
