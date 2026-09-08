import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { EgoAdapter } from "../src/ego-adapter.mjs"
import { buildPreparedSuccessorBinding, chatgptProjectScope } from "../src/conversation-continuation.mjs"
import { loadConfig } from "../src/config.mjs"
import { requestBroker } from "../src/ipc-client.mjs"

// Explicit native preparation qualification only. This cannot Send, simulate a
// provider error, alter an installed binding, or claim an overnight soak.
const [confirmation, argument] = process.argv.slice(2)
const resume = confirmation === "--resume-blank-preparation"
const prior = resume ? JSON.parse(await fs.readFile(path.join(argument, "intent.json"), "utf8")) : undefined
const startUrl = resume ? prior?.plan?.startUrl : argument
if ((!resume && confirmation !== "--confirm-blank-preparation") || chatgptProjectScope(startUrl, true) === undefined
  || (resume && (prior?.qualificationOnly !== true || !/^ego-chat-successor-[a-f0-9]{32}$/.test(prior?.plan?.taskSpaceName)))) {
  throw new Error("Usage: --confirm-blank-preparation <ChatGPT starting URL> or --resume-blank-preparation <owned gate directory>")
}
const status = await requestBroker(loadConfig(), "broker.status", {}, { autostart: false })
if (status.driverMailbox?.activeBrowserOperations !== 0 || status.driverMailbox?.queuedBrowserOperations !== 0) {
  throw new Error("The installed broker must have no active or queued browser operations during this scoped qualification.")
}
const directory = resume ? argument : await fs.mkdtemp(path.join(os.tmpdir(), "ego-successor-native-gate-"))
await fs.chmod(directory, 0o700)
const token = randomUUID().replaceAll("-", "")
const lease = { brokerId: `native-qualification-${token}`, epoch: 1, pid: process.pid, ownerPath: path.join(directory, `owner-${token}.json`) }
await fs.writeFile(lease.ownerPath, JSON.stringify(lease), { mode: 0o600, flag: "wx" })
const adapter = new EgoAdapter({ command: loadConfig().egoBrowserCommand, brokerLease: lease })
const plan = prior?.plan ?? {
  schema: "ego-chat-successor-preparation/v1", checkpointDigest: "0".repeat(64),
  bindingKey: `successor-${token}`, taskSpaceName: `ego-chat-successor-${token}`,
  startUrl, state: "dispatched", createdAt: new Date().toISOString(),
}
if (!resume) await fs.writeFile(path.join(directory, "intent.json"), JSON.stringify({ qualificationOnly: true, plan }), { mode: 0o600, flag: "wx" })
process.stdout.write(`${JSON.stringify({ gate: "blank_preparation_started", directory, taskSpaceName: plan.taskSpaceName })}\n`)
try {
  await adapter.initialize()
  const result = await adapter.prepareSuccessor({ taskSpaceName: plan.taskSpaceName, startUrl, allowCreate: !resume }, undefined, undefined,
    () => ({ taskSpaceGuard: { revision: 1, ownerSelector: { kind: "name", value: plan.taskSpaceName }, deniedSelectors: [], deniedIdentities: [] } }))
  const binding = buildPreparedSuccessorBinding(plan, result, new Date().toISOString())
  const report = { gate: "blank_preparation", native: true, passed: true, sends: 0, modelCalls: 0, binding }
  await fs.writeFile(path.join(directory, `report-${token}.json`), JSON.stringify(report), { mode: 0o600, flag: "wx" })
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  await adapter.drain()
}
