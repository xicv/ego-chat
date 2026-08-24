import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import readline from "node:readline"

import { APP_VERSION } from "./constants.mjs"
import { EgoChatError } from "./errors.mjs"

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function classifyRemoteError(message) {
  if (typeof message === "string" && message.includes("already has an active writer")) {
    return "active_writer"
  }
  if (typeof message === "string" && /active turn|turn is active/i.test(message)) {
    return "active_turn"
  }
  return "unclassified"
}

export class AppServerClient {
  #args
  #command
  #nextId = 1
  #notifications = []
  #pending = new Map()
  #process
  #stderr = ""
  #waiters = new Set()

  constructor({ args = ["app-server"], command = "codex" } = {}) {
    this.#args = args
    this.#command = command
  }

  async connect() {
    if (this.#process) {
      throw new EgoChatError("app_server_state", "The App Server client is already connected.")
    }

    this.#process = spawn(this.#command, this.#args, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#process.stderr.setEncoding("utf8")
    this.#process.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-64 * 1024)
    })
    this.#process.on("error", (error) => this.#failAll(error))
    this.#process.on("exit", (code, signal) => {
      if (this.#pending.size > 0 || this.#waiters.size > 0) {
        this.#failAll(new EgoChatError("app_server_exited", "Codex App Server exited before the operation completed.", {
          diagnosticDigest: digest(this.#stderr),
          exitCode: code,
          signal,
        }))
      }
    })

    const lines = readline.createInterface({ input: this.#process.stdout })
    lines.on("line", (line) => this.#handleLine(line))

    await this.request("initialize", {
      capabilities: {
        experimentalApi: true,
      },
      clientInfo: {
        name: "ego_chat",
        title: "Ego Chat",
        version: APP_VERSION,
      },
    })
    this.notify("initialized", {})
  }

  async startThread({
    cwd,
    developerInstructions = null,
    sandbox = "read-only",
    serviceName = "ego_chat",
  }) {
    const response = await this.request("thread/start", {
      approvalPolicy: "never",
      cwd,
      developerInstructions,
      ephemeral: false,
      sandbox,
      serviceName,
    })
    if (!response?.thread?.id || response.thread.sessionId !== response.thread.id) {
      throw new EgoChatError("invalid_app_server_response", "App Server did not return a root thread identity.")
    }
    return response.thread
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", {
      approvalPolicy: "never",
      sandbox: "read-only",
      threadId,
    })
    if (response?.thread?.id !== threadId) {
      throw new EgoChatError("thread_identity_mismatch", "App Server resumed a different thread than requested.")
    }
    return response.thread
  }

  async readThread(threadId, includeTurns = false, timeoutMs = 30_000) {
    const response = await this.request("thread/read", { includeTurns, threadId }, timeoutMs)
    if (response?.thread?.id !== threadId) {
      throw new EgoChatError("thread_identity_mismatch", "App Server read a different thread than requested.")
    }
    return response.thread
  }

  async unsubscribeThread(threadId) {
    await this.request("thread/unsubscribe", { threadId })
  }

  async runMarkerTurn(threadId, marker, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    await this.#waitForThreadIdle(threadId, deadline)
    const response = await this.request("turn/start", {
      input: [{
        text: `This is a harmless integration probe. Do not use tools or inspect files. Reply with exactly this marker and nothing else: ${marker}`,
        type: "text",
      }],
      threadId,
    }, timeoutMs)
    const completed = await this.waitForNotification(
      "turn/completed",
      (params) => params?.threadId === threadId && params?.turn?.id === response?.turn?.id,
      Math.max(1, deadline - Date.now()),
    )
    if (response?.turn?.id !== completed?.turn?.id) {
      throw new EgoChatError("turn_identity_mismatch", "The completed App Server turn does not match the started turn.")
    }
    if (completed.turn.status !== "completed") {
      throw new EgoChatError("app_server_turn_failed", "The App Server probe turn did not complete successfully.", {
        status: completed.turn.status,
      })
    }

    const responseText = completed.turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("\n")
      .trim()
    if (responseText !== marker) {
      throw new EgoChatError("marker_mismatch", "The App Server probe response did not match the expected marker.", {
        actualDigest: digest(responseText),
        expectedDigest: digest(marker),
      })
    }
    return {
      durationMs: completed.turn.durationMs ?? null,
      responseDigest: digest(responseText),
      turnId: completed.turn.id,
    }
  }

  async runStructuredTurn({ additionalContext = undefined, outputSchema, prompt, threadId, timeoutMs }) {
    const deadline = Date.now() + timeoutMs
    await this.#waitForThreadIdle(threadId, deadline)
    const response = await this.request("turn/start", {
      ...(additionalContext ? { additionalContext } : {}),
      approvalPolicy: "never",
      input: [{ text: prompt, type: "text" }],
      outputSchema,
      threadId,
    }, timeoutMs)
    const completed = await this.waitForNotification(
      "turn/completed",
      (params) => params?.threadId === threadId && params?.turn?.id === response?.turn?.id,
      Math.max(1, deadline - Date.now()),
    )
    if (response?.turn?.id !== completed?.turn?.id) {
      throw new EgoChatError("turn_identity_mismatch", "The completed App Server turn does not match the started turn.")
    }
    if (completed.turn.status !== "completed") {
      throw new EgoChatError("app_server_turn_failed", "The App Server turn did not complete successfully.", {
        status: completed.turn.status,
      })
    }

    const responseText = completed.turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("\n")
      .trim()
    let value
    try {
      value = JSON.parse(responseText)
    } catch (_error) {
      throw new EgoChatError("invalid_codex_envelope", "Codex did not return the required structured result.", {
        responseDigest: digest(responseText),
      })
    }
    return {
      durationMs: completed.turn.durationMs ?? null,
      responseDigest: digest(responseText),
      turnId: completed.turn.id,
      value,
    }
  }

  request(method, params, timeoutMs = 30_000) {
    if (!this.#process?.stdin.writable) {
      return Promise.reject(new EgoChatError("app_server_state", "Codex App Server is not connected."))
    }
    const id = this.#nextId
    this.#nextId += 1

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new EgoChatError("app_server_timeout", `App Server did not answer ${method} before the deadline.`))
      }, timeoutMs)
      this.#pending.set(id, {
        reject,
        resolve,
        timer,
      })
      this.#write({ id, method, params })
    })
  }

  notify(method, params) {
    this.#write({ method, params })
  }

  waitForNotification(method, predicate, timeoutMs = 30_000) {
    const existing = this.#notifications.find((notification) => (
      notification.method === method && predicate(notification.params)
    ))
    if (existing) {
      return Promise.resolve(existing.params)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        reject,
        resolve,
        timer: undefined,
      }
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter)
        reject(new EgoChatError("app_server_event_timeout", `App Server did not emit ${method} before the deadline.`))
      }, timeoutMs)
      this.#waiters.add(waiter)
    })
  }

  async close() {
    const child = this.#process
    this.#process = undefined
    if (!child || child.exitCode !== null) {
      return
    }

    child.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        resolve()
      }, 2_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async #waitForThreadIdle(threadId, deadline) {
    let lastStatus = null
    while (Date.now() < deadline) {
      const thread = await this.readThread(threadId, false, Math.max(1, deadline - Date.now()))
      lastStatus = thread.status?.type ?? null
      if (lastStatus === "idle") {
        return
      }
      if (lastStatus === "notLoaded" || lastStatus === "systemError" || lastStatus === null) {
        throw new EgoChatError("app_server_thread_not_ready", "Codex App Server did not report the owned thread as idle.", {
          status: lastStatus,
        })
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())))
    }
    throw new EgoChatError("app_server_thread_not_ready", "Codex App Server did not make the owned thread idle before the deadline.", {
      status: lastStatus,
    })
  }

  #write(message) {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch (_error) {
      this.#failAll(new EgoChatError("invalid_app_server_json", "Codex App Server returned an invalid JSONL message."))
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id)
      if (!pending) {
        return
      }
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new EgoChatError("app_server_request_failed", "Codex App Server rejected a request.", {
          code: message.error.code,
          reason: classifyRemoteError(message.error.message),
          messageDigest: digest(message.error.message ?? ""),
        }))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id !== undefined && typeof message.method === "string") {
      this.#write({
        error: { code: -32601, message: "Ego Chat does not service App Server callbacks." },
        id: message.id,
      })
      return
    }

    if (typeof message.method !== "string") {
      return
    }
    const notification = { method: message.method, params: message.params }
    this.#notifications.push(notification)
    if (this.#notifications.length > 200) {
      this.#notifications.shift()
    }
    for (const waiter of [...this.#waiters]) {
      if (waiter.method === message.method && waiter.predicate(message.params)) {
        clearTimeout(waiter.timer)
        this.#waiters.delete(waiter)
        waiter.resolve(message.params)
      }
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.#waiters.clear()
  }
}
