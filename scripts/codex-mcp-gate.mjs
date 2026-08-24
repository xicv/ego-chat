import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { requestBroker } from "../src/ipc-client.mjs"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const mcpPath = path.join(projectRoot, "bin", "ego-chat-mcp.mjs")
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-codex-gate-"))
await fs.chmod(dataDir, 0o700)
const socketPath = path.join(os.tmpdir(), `egc-c-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
const config = { dataDir, egoBrowserCommand: "ego-browser", socketPath }
const marker = `EGO_CHAT_CODEX_MCP_GATE_OK_${randomUUID().replaceAll("-", "").toUpperCase()}`
const delayMs = Number(process.env.EGO_CHAT_CODEX_GATE_DELAY_MS ?? "65000")
if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > 80_000) {
  throw new Error("EGO_CHAT_CODEX_GATE_DELAY_MS must be an integer from 1 through 80000")
}

const args = [
  "exec",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--ephemeral",
  "--json",
  "--sandbox",
  "read-only",
  "-C",
  projectRoot,
  "-c",
  "approval_policy=\"never\"",
  "-c",
  `mcp_servers.ego_chat.command=${JSON.stringify(process.execPath)}`,
  "-c",
  `mcp_servers.ego_chat.args=${JSON.stringify([mcpPath])}`,
  "-c",
  "mcp_servers.ego_chat.required=true",
  "-c",
  "mcp_servers.ego_chat.tool_timeout_sec=90",
  "-c",
  "mcp_servers.ego_chat.enabled_tools=[\"gate0_probe_and_wait\"]",
  "-c",
  "mcp_servers.ego_chat.tools.gate0_probe_and_wait.approval_mode=\"approve\"",
  `Call the ego_chat MCP tool gate0_probe_and_wait exactly once with delayMs ${delayMs} and value \"codex-long-call\". Do not call shell or any other tool. Wait for the tool result in this same turn. If and only if it succeeds with status succeeded and text codex-long-call, reply exactly ${marker}`,
]

const startedAt = Date.now()
let stdout = ""
let stderr = ""
let child

try {
  await new Promise((resolve, reject) => {
    child = spawn("codex", args, {
      env: {
        ...process.env,
        EGO_CHAT_DATA_DIR: dataDir,
        EGO_CHAT_EGO_BROWSER: "ego-browser",
        EGO_CHAT_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error("Codex MCP Gate 0 probe exceeded five minutes"))
    }, 5 * 60 * 1000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, "utf8") > 2 * 1024 * 1024) {
        child.kill("SIGTERM")
        reject(new Error("Codex MCP Gate 0 stdout exceeded its limit"))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-256 * 1024)
    })
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Codex exited unsuccessfully: code=${code} signal=${signal} stderr-bytes=${Buffer.byteLength(stderr, "utf8")}`))
      }
    })
  })

  const elapsedMs = Date.now() - startedAt
  const toolObserved = stdout.includes("gate0_probe_and_wait")
    && stdout.includes("codex-long-call")
  const finalMarkerObserved = stdout.includes(marker)
  if (elapsedMs < delayMs || !toolObserved || !finalMarkerObserved) {
    const diagnostics = stdout
      .trim()
      .split("\n")
      .map((line) => {
        try {
          const event = JSON.parse(line)
          return {
            error: event.error?.message,
            itemStatus: event.item?.status,
            itemText: event.item?.type === "agent_message" ? event.item.text : undefined,
            itemType: event.item?.type,
            type: event.type,
          }
        } catch (_error) {
          return { type: "invalid_jsonl_event" }
        }
      })
    throw new Error(`Codex did not return the expected MCP result: ${JSON.stringify(diagnostics)}`)
  }
  process.stdout.write(`${JSON.stringify({
    elapsedMs,
    finalMarkerObserved,
    gate: "codex_mcp_same_turn_beyond_default_timeout",
    ok: true,
    toolObserved,
  })}\n`)
} finally {
  try {
    const ping = await requestBroker(config, "ping", {}, { autostart: false, timeoutMs: 1_000 })
    process.kill(ping.pid, "SIGTERM")
  } catch (error) {
    if (!["ECONNREFUSED", "ENOENT", "ESRCH"].includes(error.code)) {
      throw error
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  await fs.rm(dataDir, { force: false, recursive: true })
}
