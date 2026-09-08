import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { decodeDriverResult } from "../src/ego-adapter.mjs"
import { BROWSER_CONTRACT_REVISION } from "../src/constants.mjs"
import { EGO_DRIVER_SOURCE } from "../src/ego-driver-source.mjs"

async function runCase(t, options = {}) {
  const directory = await fs.mkdtemp("/tmp/egc-driver-successor-test-")
  t.after(() => fs.rm(directory, { recursive: true, force: false }))
  const name = `ego-chat-successor-${"a".repeat(32)}`
  const startUrl = options.startUrl || "https://chatgpt.com/g/g-p-successor-test"
  const ownerPath = path.join(directory, "owner.json")
  const lease = { brokerId: "successor-test-broker", epoch: 1, pid: process.pid, ownerPath }
  await fs.writeFile(ownerPath, JSON.stringify(lease), { mode: 0o600 })
  const inputPath = path.join(directory, "input.json")
  await fs.writeFile(inputPath, JSON.stringify({
    brokerLease: lease, browserContractRevision: BROWSER_CONTRACT_REVISION,
    mode: "prepare_successor", taskSpaceName: name, startUrl, allowCreate: options.allowCreate ?? true,
    taskSpaceGuard: { revision: 1, ownerSelector: { kind: "name", value: name }, deniedSelectors: [], deniedIdentities: [] },
  }), { mode: 0o600 })
  const harness = `
process.getuid = () => ${JSON.stringify(directory.slice("/tmp/egc-driver-".length))}
const options = ${JSON.stringify(options)}
const name = ${JSON.stringify(name)}
const startUrl = ${JSON.stringify(startUrl)}
let spaces = options.existingSpace ? [{ id: 80, name, taskId: 'opaque-born-space', ownership: options.ownership || 'agent' }] : []
let tabs = options.existingTab ? [{ targetId: 'blank-successor', active: true, url: options.url || startUrl }] : []
let infoReads = 0
let spaceReads = 0
const counts = { createdSpaces: 0, openedTabs: 0, send: 0 }
globalThis.cliLog = console.log
globalThis.listTaskSpaces = async () => {
  spaceReads++
  if (options.vanishAfterDiscovery && spaceReads === 2) spaces = []
  if (options.appearAfterDiscovery && spaceReads === 2) spaces = [{ id: 80, name, taskId: 'foreign-created-space', ownership: 'agent' }]
  return spaces
}
globalThis.useOrCreateTaskSpace = async (id) => {
  if (!spaces.length) { counts.createdSpaces++; spaces = [{ id: 80, name, taskId: 'opaque-born-space', ownership: 'agent' }] }
  if (options.nativeDefaultTab && !tabs.length) tabs = [{ targetId: 'native-default', url: 'chrome://newtab/', active: true }]
  return spaces.find(space => space.id === id || space.name === id)
}
globalThis.listTabs = async () => options.extraTab && tabs.length ? [...tabs, { targetId: 'foreign-tab', active: false, url: startUrl }] : tabs
globalThis.currentTab = async () => options.wrongActive ? { targetId: 'foreign-tab' } : tabs[0]
globalThis.switchTab = async (id) => { if (!tabs.some(tab => tab.targetId === id)) throw new Error('unknown tab') }
globalThis.openOrReuseTab = async (url) => {
  counts.openedTabs++
  tabs = [{ targetId: 'blank-successor', active: true, url: options.url || url }]
  return tabs[0]
}
globalThis.gotoAndWait = async (url) => { counts.navigations = (counts.navigations || 0) + 1; tabs[0].url = options.redirectUrl || url }
globalThis.pageInfo = async () => {
  infoReads++
  if (options.drift && infoReads >= 2) spaces = spaces.map(space => ({ ...space, taskId: 'foreign-identity' }))
  return { url: options.nativePageInfo && tabs[0]?.url === 'chrome://newtab/' ? 'chrome://new-tab-page/' : tabs[0]?.url, w: 800, h: 600 }
}
globalThis.snapshotText = async () => ''
globalThis.wait = async () => {}
globalThis.click = globalThis.fillInput = globalThis.pressKey = globalThis.typeText = async () => { counts.send++; throw new Error('no content mutation is authorized') }
globalThis.js = async (source) => {
  if (source.includes('hasLoginAction')) return { composerCount: options.authentication ? 0 : 1, composerSemanticId: true, draft: options.draft || '', hasComposer: !options.authentication, hasLoginAction: Boolean(options.authentication) }
  if (source.includes('const messageNodes = [')) return options.messages || []
  if (source.includes('stop-button')) return Boolean(options.generating)
  throw new Error('unexpected browser evaluation')
}
await ${EGO_DRIVER_SOURCE}
console.log('__COUNTS__' + JSON.stringify(counts))
`
  const executed = spawnSync(process.execPath, ["--input-type=module"], { input: harness, encoding: "utf8", timeout: 10_000 })
  assert.equal(executed.status, 0, executed.stderr)
  const counts = JSON.parse(executed.stdout.split("\n").find(line => line.startsWith("__COUNTS__")).slice(10))
  try { return { result: decodeDriverResult(executed.stdout), counts } }
  catch (error) { return { error, counts } }
}

test("blank successor driver creates only its reserved Space and verifies one empty tab", async (t) => {
  const { result, error, counts } = await runCase(t)
  assert.equal(error, undefined)
  assert.equal(result.canonicalUrl, null)
  assert.equal(result.head.messageCount, 0)
  assert.equal(result.taskSpaceIdentity.taskId, "opaque-born-space")
  assert.deepEqual(counts, { createdSpaces: 1, openedTabs: 1, send: 0 })
})

test("a lost acknowledgement can recover its sole blank tab without creating anything", async (t) => {
  const { result, error, counts } = await runCase(t, { allowCreate: false, existingSpace: true, existingTab: true })
  assert.equal(error, undefined)
  assert.equal(result.targetId, "blank-successor")
  assert.deepEqual(counts, { createdSpaces: 0, openedTabs: 0, send: 0 })
})

test("a new native Space's sole internal tab is navigated in place without creating or deleting tabs", async (t) => {
  const { result, error, counts } = await runCase(t, { nativeDefaultTab: true, nativePageInfo: true })
  assert.equal(error, undefined)
  assert.equal(result.targetId, "native-default")
  assert.deepEqual(counts, { createdSpaces: 1, openedTabs: 0, send: 0, navigations: 1 })
})

test("replay completes navigation of the reserved Space's sole native blank tab without creating anything", async (t) => {
  const { result, error, counts } = await runCase(t, { allowCreate: false, existingSpace: true, nativeDefaultTab: true, nativePageInfo: true })
  assert.equal(error, undefined)
  assert.equal(result.targetId, "native-default")
  assert.deepEqual(counts, { createdSpaces: 0, openedTabs: 0, send: 0, navigations: 1 })
})

test("the same stable Project may redirect to its titled project starting route", async (t) => {
  const startUrl = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef"
  const redirectUrl = `${startUrl}-ego-chat/project`
  const { result, error } = await runCase(t, { startUrl, redirectUrl, nativeDefaultTab: true })
  assert.equal(error, undefined)
  assert.equal(result.startUrl, redirectUrl)
})

test("observation-only replay cannot recreate a Space that disappears after discovery", async (t) => {
  const { error, counts } = await runCase(t, { allowCreate: false, existingSpace: true, existingTab: true, vanishAfterDiscovery: true })
  assert.equal(error?.code, "human_required")
  assert.equal(counts.createdSpaces, 0)
  assert.equal(counts.openedTabs, 0)
})

test("initial preparation cannot adopt a Space that appears after the absence check", async (t) => {
  const { error, counts } = await runCase(t, { appearAfterDiscovery: true })
  assert.equal(error?.code, "human_required")
  assert.equal(counts.openedTabs, 0)
})

for (const [name, options, reason] of [
  ["missing Space after possible creation", { allowCreate: false }, "successor_preparation_ambiguous"],
  ["missing tab after possible creation", { allowCreate: false, existingSpace: true }, "successor_preparation_ambiguous"],
  ["pre-existing Space on first attempt", { existingSpace: true }, "successor_preparation_ambiguous"],
  ["multiple tabs", { extraTab: true }, "successor_preparation_ambiguous"],
  ["a permanent conversation", { url: "https://chatgpt.com/c/foreign-conversation" }, "successor_not_blank"],
  ["another Project", { url: "https://chatgpt.com/g/g-p-foreign" }, "successor_not_blank"],
  ["existing messages", { messages: [{ role: "user", messageId: "foreign-user", text: "Do not overwrite me" }] }, "successor_not_blank"],
  ["ongoing generation", { generating: true }, "successor_not_blank"],
  ["an existing draft", { draft: "User draft" }, "unexpected_draft"],
  ["authentication", { authentication: true }, "authentication_required"],
  ["wrong active tab", { wrongActive: true }, "successor_preparation_ambiguous"],
  ["stable Space identity drift", { drift: true }, "bound_task_space_identity_conflict"],
  ["user-owned Space", { allowCreate: false, existingSpace: true, existingTab: true, ownership: "user" }, "browser_control_unavailable"],
]) {
  test(`blank successor rejects ${name} without content mutation`, async (t) => {
    const { error, counts } = await runCase(t, options)
    assert.equal(error?.code, "human_required")
    assert.equal(error?.details?.reason, reason)
    assert.equal(counts.send, 0)
    if (options.allowCreate === false) {
      assert.equal(counts.createdSpaces, 0)
      assert.equal(counts.openedTabs, 0)
    }
  })
}
