#!/usr/bin/env node

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  createInstalledAttachmentReceiptAuthority,
  writeReceiptBuildManifest,
} from "../src/attachment-receipt-authority.mjs"
import { loadConfig } from "../src/config.mjs"
import { requestBroker } from "../src/ipc-client.mjs"
import { handoffBrokerRuntime, inspectBrokerRuntime } from "../src/runtime-handoff.mjs"

const config = loadConfig()
const [command, ...args] = process.argv.slice(2)
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function failUsage(message) {
  process.stderr.write(`${message}\n`)
  process.stderr.write("Usage: ego-chat ping | broker-status | broker-runtime-status | broker-handoff | receipt-build-manifest <executable-path> <implementation-git-sha> | receipt-signer-enroll | probe <delay-ms> <value> | status <id> | await <id> <timeout-ms> | read-result <workflow-id> <digest> [offset] [max-bytes] | cancel <id> | abandon <id> --acknowledge-potential-delivery | preflight <task-space> | model-policy | ensure-model-policy <binding-key> | bind <input-json-file> | adopt <input-json-file> | conversation <binding-key> | reanchor <input-json-file> | verify <binding-key> | reconcile <binding-key> <workflow-id> | exchange <input-json-file> | converge <input-json-file>\n")
  process.exit(64)
}

try {
  if (command === "ping") {
    print(await requestBroker(config, "ping"))
  } else if (command === "broker-status") {
    print(await requestBroker(config, "broker.status"))
  } else if (command === "broker-runtime-status") {
    if (args.length > 0) {
      failUsage("broker-runtime-status does not accept arguments")
    }
    print(await inspectBrokerRuntime(config))
  } else if (command === "broker-handoff") {
    if (args.length > 0) {
      failUsage("broker-handoff does not accept arguments")
    }
    print(await handoffBrokerRuntime(config))
  } else if (command === "receipt-build-manifest") {
    if (args.length !== 2) {
      failUsage("receipt-build-manifest requires an executable path and implementation Git SHA")
    }
    print(await writeReceiptBuildManifest({
      executablePath: args[0],
      implementationGitSha: args[1],
      runtimeRoot,
    }))
  } else if (command === "receipt-signer-enroll") {
    if (args.length !== 0) {
      failUsage("receipt-signer-enroll does not accept arguments")
    }
    const authority = createInstalledAttachmentReceiptAuthority({
      dataDir: config.dataDir,
      runtimeRoot,
    })
    print(await authority.enroll())
  } else if (command === "probe") {
    const delayMs = Number(args[0])
    const value = args[1]
    if (!Number.isInteger(delayMs) || !value) {
      failUsage("probe requires an integer delay and a non-empty value")
    }
    print(await requestBroker(config, "workflow.start_probe", { delayMs, value }))
  } else if (command === "status") {
    if (!args[0]) {
      failUsage("status requires a workflow ID")
    }
    print(await requestBroker(config, "workflow.get", { workflowId: args[0] }))
  } else if (command === "await") {
    const timeoutMs = Number(args[1])
    if (!args[0] || !Number.isInteger(timeoutMs)) {
      failUsage("await requires a workflow ID and integer timeout")
    }
    print(await requestBroker(
      config,
      "workflow.await",
      { timeoutMs, workflowId: args[0] },
      { timeoutMs: timeoutMs + 5_000 },
    ))
  } else if (command === "read-result") {
    const offset = args[2] === undefined ? 0 : Number(args[2])
    const maxBytes = args[3] === undefined ? 64 * 1024 : Number(args[3])
    if (!args[0] || !/^[a-f0-9]{64}$/.test(args[1] ?? "") || !Number.isInteger(offset) || !Number.isInteger(maxBytes)) {
      failUsage("read-result requires a workflow ID, SHA-256 digest, and optional integer offset/max-bytes")
    }
    print(await requestBroker(config, "result.read", {
      expectedDigest: args[1],
      maxBytes,
      offset,
      workflowId: args[0],
    }))
  } else if (command === "cancel") {
    if (!args[0]) {
      failUsage("cancel requires a workflow ID")
    }
    print(await requestBroker(config, "workflow.cancel", { workflowId: args[0] }))
  } else if (command === "abandon") {
    if (!args[0] || args[1] !== "--acknowledge-potential-delivery" || args.length !== 2) {
      failUsage("abandon requires one workflow ID and --acknowledge-potential-delivery")
    }
    print(await requestBroker(config, "workflow.abandon", {
      acknowledgePotentialDelivery: true,
      workflowId: args[0],
    }))
  } else if (command === "preflight") {
    if (!args[0]) {
      failUsage("preflight requires a task-space name or numeric ID")
    }
    const numeric = Number(args[0])
    const taskSpace = Number.isInteger(numeric) && numeric > 0 ? numeric : args[0]
    print(await requestBroker(config, "ego.preflight", { taskSpace }, { timeoutMs: 65_000 }))
  } else if (command === "model-policy") {
    print(await requestBroker(config, "model_policy.get"))
  } else if (command === "ensure-model-policy") {
    if (!args[0]) {
      failUsage("ensure-model-policy requires a binding key")
    }
    print(await requestBroker(
      config,
      "model_policy.ensure",
      { bindingKey: args[0] },
      { timeoutMs: 65_000 },
    ))
  } else if (command === "bind") {
    if (!args[0]) {
      failUsage("bind requires a JSON input file")
    }
    const input = JSON.parse(await fs.readFile(args[0], "utf8"))
    print(await requestBroker(config, "conversation.bind", input, { timeoutMs: 65_000 }))
  } else if (command === "adopt") {
    if (!args[0]) {
      failUsage("adopt requires a JSON input file")
    }
    const input = JSON.parse(await fs.readFile(args[0], "utf8"))
    print(await requestBroker(config, "conversation.start_adoption", input))
  } else if (command === "conversation") {
    if (!args[0]) {
      failUsage("conversation requires a binding key")
    }
    print(await requestBroker(config, "conversation.get", { bindingKey: args[0] }))
  } else if (command === "reanchor") {
    if (!args[0]) {
      failUsage("reanchor requires a JSON input file")
    }
    const input = JSON.parse(await fs.readFile(args[0], "utf8"))
    print(await requestBroker(
      config,
      "conversation.reanchor",
      input,
      { timeoutMs: 65_000 },
    ))
  } else if (command === "reconcile") {
    if (!args[0] || !args[1]) {
      failUsage("reconcile requires a binding key and workflow ID")
    }
    print(await requestBroker(
      config,
      "conversation.reconcile",
      { bindingKey: args[0], workflowId: args[1] },
      { timeoutMs: 65_000 },
    ))
  } else if (command === "verify") {
    if (!args[0]) {
      failUsage("verify requires a binding key")
    }
    print(await requestBroker(
      config,
      "conversation.verify",
      { bindingKey: args[0] },
      { timeoutMs: 65_000 },
    ))
  } else if (command === "exchange") {
    if (!args[0]) {
      failUsage("exchange requires a JSON input file")
    }
    const input = JSON.parse(await fs.readFile(args[0], "utf8"))
    print(await requestBroker(config, "ego.start_exchange", input))
  } else if (command === "converge") {
    if (!args[0]) {
      failUsage("converge requires a JSON input file")
    }
    const input = JSON.parse(await fs.readFile(args[0], "utf8"))
    print(await requestBroker(config, "convergence.start", input))
  } else {
    failUsage("Unknown or missing command")
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? "unexpected_error", message: error.message })}\n`)
  process.exit(1)
}
