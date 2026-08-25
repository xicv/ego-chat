import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { EgoAdapter, decodeDriverResult } from "../src/ego-adapter.mjs"
import {
  EGO_DRIVER_RESULT_PREFIX,
  EGO_DRIVER_SOURCE,
  egoDriverSourceForInput,
} from "../src/ego-driver-source.mjs"

function envelope(value) {
  return `${EGO_DRIVER_RESULT_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}\n`
}

let driverCase = 0

async function runMalformedModelPolicyCase(attributes) {
  driverCase += 1
  const driverUid = `ego-chat-test-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const ownerPath = `${mailboxDirectory}/owner.json`
  const input = {
    browserContractRevision: 6,
    binding: {
      startUrl: "https://chatgpt.com/",
      state: "unbound",
      targetId: "policy-tab",
      taskSpaceId: 10,
    },
    brokerLease: {
      brokerId: "policy-test-broker",
      epoch: 1,
      ownerPath,
      pid: process.pid,
    },
    expectedTerminalMarker: "EGO_CHAT_REVIEW_DONE_POLICY_TEST",
    mode: "exchange",
    modelPolicy: {
      enforcement: "repair_then_verify",
      key: "chatgpt-web-default",
      modelSelection: "strongest_available",
      thinkingEffort: "maximum_available",
    },
    prompt: "EGO_CHAT_POLICY_TEST_MARKER",
    timeoutMs: 1_000,
    turnMarker: "EGO_CHAT_POLICY_TEST_MARKER",
  }
  await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(ownerPath, JSON.stringify({
    brokerId: "policy-test-broker",
    epoch: 1,
    pid: process.pid,
  }), { mode: 0o600 })
  await fs.writeFile(`${mailboxDirectory}/input.json`, JSON.stringify(input), { mode: 0o600 })

  const harness = `
process.getuid = () => ${JSON.stringify(driverUid)}
const counters = { cdp: 0, fillInput: 0, pressKey: 0, typeText: 0 }
const attributes = ${JSON.stringify(attributes)}
const visible = { getClientRects: () => [{}] }
const slider = {
  getAttribute(name) {
    return Object.hasOwn(attributes, name) ? attributes[name] : null
  },
}
const powerItem = {
  ...visible,
  querySelector: (selector) => selector === '[role="slider"]' ? slider : null,
}
const row = (text) => ({ ...visible, innerText: text, textContent: text })
const menu = {
  ...visible,
  querySelectorAll(selector) {
    if (selector === '[role="menuitem"][aria-label="Power"]') return [powerItem]
    if (selector === '[role="menuitem"][aria-haspopup="menu"]') {
      return [row('Model GPT-5.6 Sol'), row('Effort Pro')]
    }
    return []
  },
}
const pill = {
  ...visible,
  innerText: 'Pro',
  textContent: 'Pro',
  getAttribute(name) {
    if (name === 'aria-controls') return 'policy-menu'
    if (name === 'aria-expanded') return 'true'
    return null
  },
}
const pageDocument = {
  getElementById: (id) => id === 'policy-menu' ? menu : null,
  querySelectorAll: (selector) => selector === 'button.__composer-pill[aria-haspopup="menu"]' ? [pill] : [],
}
globalThis.cliLog = (value) => console.log(value)
globalThis.useOrCreateTaskSpace = async () => ({ id: 10 })
globalThis.listTabs = async () => [{ active: true, targetId: 'policy-tab' }]
globalThis.switchTab = async () => {}
globalThis.openOrReuseTab = async () => { throw new Error('unexpected navigation') }
globalThis.pageInfo = async () => ({ url: 'https://chatgpt.com/' })
globalThis.snapshotText = async () => ''
globalThis.wait = async () => {}
globalThis.click = async () => {}
globalThis.fillInput = async () => { counters.fillInput += 1 }
globalThis.typeText = async () => { counters.typeText += 1 }
globalThis.pressKey = async () => { counters.pressKey += 1 }
globalThis.cdp = async () => { counters.cdp += 1 }
globalThis.js = async (source) => {
  if (source.includes('hasLoginAction')) {
    return { draft: '', hasComposer: true, hasLoginAction: false }
  }
  if (source.includes("return [...document.querySelectorAll('[data-message-author-role]')].map")) {
    return []
  }
  if (source.includes("const rendered = [...document.querySelectorAll('[data-message-author-role]')")) {
    return 0
  }
  if (source.includes('aria-valuemin')) {
    return Function('document', 'return ' + source)(pageDocument)
  }
  if (source.includes("composerCount: document.querySelectorAll('#prompt-textarea').length")) {
    return { composerCount: 1, count: 1, expanded: 'false' }
  }
  if (source.includes('button.__composer-pill[aria-haspopup="menu"]')) {
    return Function('document', 'return ' + source)(pageDocument)
  }
  if (source.trimStart().startsWith('Boolean(')) {
    return false
  }
  throw new Error('Unexpected page script: ' + source.slice(0, 80))
}
await ${EGO_DRIVER_SOURCE.trim()}
console.log('__EGO_CHAT_TEST_COUNTERS__' + JSON.stringify(counters))
`

  try {
    const executed = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: harness,
    })
    assert.equal(executed.status, 0, executed.stderr)
    let stopped
    try {
      decodeDriverResult(executed.stdout)
    } catch (error) {
      stopped = error
    }
    assert.equal(stopped?.code, "human_required")
    assert.equal(stopped?.details?.reason, "model_policy_ui_unknown")
    const countersLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_TEST_COUNTERS__"))
    assert.ok(countersLine)
    return JSON.parse(countersLine.slice("__EGO_CHAT_TEST_COUNTERS__".length))
  } finally {
    await fs.rm(mailboxDirectory, { force: true, recursive: true })
  }
}

async function runPreSendDriverCase({
  changeSendControlAtRecheck = false,
  downgradeAtPresend = false,
  fenceAtRecheck = false,
} = {}) {
  driverCase += 1
  const driverUid = `ego-chat-presend-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const ownerPath = `${mailboxDirectory}/owner.json`
  const turnMarker = "EGO_CHAT_PRESEND_POLICY_TEST_MARKER"
  const input = {
    browserContractRevision: 6,
    binding: {
      messageCount: 0,
      startUrl: "https://chatgpt.com/",
      state: "unbound",
      targetId: "presend-tab",
      taskSpaceId: 10,
    },
    brokerLease: {
      brokerId: "presend-test-broker",
      epoch: 1,
      ownerPath,
      pid: process.pid,
    },
    expectedTerminalMarker: "EGO_CHAT_REVIEW_DONE_PRESEND_TEST",
    mode: "exchange",
    modelPolicy: {
      enforcement: "repair_then_verify",
      key: "chatgpt-web-default",
      modelSelection: "strongest_available",
      thinkingEffort: "maximum_available",
    },
    prompt: `${turnMarker}\nReview the pre-send fence.`,
    timeoutMs: 1_000,
    turnMarker,
  }
  await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(ownerPath, JSON.stringify({
    brokerId: "presend-test-broker",
    epoch: 1,
    pid: process.pid,
  }), { mode: 0o600 })
  await fs.writeFile(`${mailboxDirectory}/input.json`, JSON.stringify(input), { mode: 0o600 })

  const harness = `
process.getuid = () => ${JSON.stringify(driverUid)}
const fs = await import('node:fs/promises')
const input = ${JSON.stringify(input)}
const ownerPath = ${JSON.stringify(ownerPath)}
let policyMenuOpen = false
let policyReads = 0
let sendTargetReads = 0
const counters = { insertText: 0, mouseEvents: 0, policyReads: 0, sendTargetReads: 0 }
globalThis.cliLog = (value) => console.log(value)
globalThis.useOrCreateTaskSpace = async () => ({ id: 10 })
globalThis.listTabs = async () => [{ active: true, targetId: 'presend-tab' }]
globalThis.switchTab = async () => {}
globalThis.openOrReuseTab = async () => { throw new Error('unexpected navigation') }
globalThis.pageInfo = async () => ({ url: 'https://chatgpt.com/' })
globalThis.snapshotText = async () => ''
globalThis.wait = async () => {}
globalThis.click = async (target) => {
  if (String(target).includes('__composer-pill')) policyMenuOpen = true
  if (target === '#prompt-textarea') policyMenuOpen = false
}
globalThis.fillInput = async () => { throw new Error('unexpected fillInput') }
globalThis.typeText = async () => { throw new Error('unexpected typeText') }
globalThis.pressKey = async () => {}
globalThis.cdp = async (method) => {
  if (method === 'Input.insertText') counters.insertText += 1
  if (method === 'Input.dispatchMouseEvent') counters.mouseEvents += 1
}
globalThis.js = async (source) => {
  if (source.includes('hasLoginAction')) {
    return {
      composerCount: 1,
      composerSemanticId: true,
      draft: '',
      hasComposer: true,
      hasLoginAction: false,
    }
  }
  if (source.includes("return [...document.querySelectorAll('[data-message-author-role]')].map")) return []
  if (source.trimStart().startsWith('Boolean(')) return false
  if (source.includes("const rendered = [...document.querySelectorAll('[data-message-author-role]')")) return 0
  if (source.includes("composerCount: document.querySelectorAll('#prompt-textarea').length")) {
    return { composerCount: 1, count: 1, expanded: policyMenuOpen ? 'true' : 'false' }
  }
  if (source.includes("expanded: pills[0]?.getAttribute('aria-expanded') === 'true'")) {
    return { count: 1, expanded: policyMenuOpen }
  }
  if (source.includes('aria-valuemin')) {
    policyReads += 1
    counters.policyReads = policyReads
    const current = ${JSON.stringify(downgradeAtPresend)} && policyReads >= 3 ? 3 : 4
    return {
      current,
      effortLabel: current === 4 ? 'Pro' : 'Extended',
      maximum: 4,
      minimum: 0,
      modelLabel: 'GPT-5.6 Sol',
      ok: true,
      pillLabel: current === 4 ? 'Pro' : 'Extended',
    }
  }
  if (source.includes('powerItems[0].focus()')) return true
  if (source.includes('enabledSendCount')) {
    return { composerCount: 1, draftEmpty: true, enabledSendCount: 0, sendCount: 1 }
  }
  if (source.includes('composer.focus()')) return true
  if (source.includes('const blockChildren')) return [input.prompt]
  if (source.includes('document.elementFromPoint')) {
    sendTargetReads += 1
    counters.sendTargetReads = sendTargetReads
    if (sendTargetReads === 2 && ${JSON.stringify(fenceAtRecheck)}) {
      await fs.writeFile(ownerPath, JSON.stringify({ ...input.brokerLease, brokerId: 'new-broker' }))
    }
    if (sendTargetReads === 2 && ${JSON.stringify(changeSendControlAtRecheck)}) return { ok: false }
    return { hit: true, ok: true, x: 10, y: 20 }
  }
  if (source.includes('composer.replaceChildren()')) return true
  if (source.includes("return String(draft).trim().length === 0")) return true
  throw new Error('Unexpected page script: ' + source.slice(0, 120))
}
await ${EGO_DRIVER_SOURCE.trim()}
console.log('__EGO_CHAT_PRESEND_COUNTERS__' + JSON.stringify(counters))
`

  try {
    const executed = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: harness,
    })
    assert.equal(executed.status, 0, executed.stderr)
    let error
    try {
      decodeDriverResult(executed.stdout)
    } catch (caught) {
      error = caught
    }
    const countersLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_PRESEND_COUNTERS__"))
    assert.ok(countersLine)
    return {
      counters: JSON.parse(countersLine.slice("__EGO_CHAT_PRESEND_COUNTERS__".length)),
      error,
    }
  } finally {
    await fs.rm(mailboxDirectory, { force: true, recursive: true })
  }
}

async function runAdoptionDriverCase({
  fallbackTaskSpaceOwnership = null,
  hydrateAnchorPrefix = false,
  interleave = false,
  initiallyGenerating = true,
  mutateAnchorAfterLock = false,
  pageStates = ["authenticated"],
  pageUrl = null,
  pageUrls = null,
  policyInitiallyMaximum = true,
  redirectAfterModelVerification = false,
  taskSpaceAvailable = true,
  taskSpaceOwnership = "agent",
  targetId = null,
  timeoutMs = 30_000,
  unrelatedActiveAfterOpen = false,
} = {}) {
  driverCase += 1
  const driverUid = `ego-chat-adopt-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const ownerPath = `${mailboxDirectory}/owner.json`
  const canonicalUrl = "https://chatgpt.com/c/adoption-driver-test"
  const fallbackName = `ego-chat-bound-${createHash("sha256").update("adoption-driver-test", "utf8").digest("hex").slice(0, 16)}`
  const listedTaskSpaces = [
    ...(taskSpaceAvailable
      ? [{ id: 10, name: "adoption-driver-space", ownership: taskSpaceOwnership, taskId: "adoption-driver-space" }]
      : []),
    ...(fallbackTaskSpaceOwnership
      ? [{ id: 12, name: fallbackName, ownership: fallbackTaskSpaceOwnership, taskId: fallbackName }]
      : []),
  ]
  const input = {
    bindingKey: "adoption-driver-test",
    brokerLease: {
      brokerId: "adoption-test-broker",
      epoch: 1,
      ownerPath,
      pid: process.pid,
    },
    canonicalUrl,
    mode: "adopt",
    modelPolicy: {
      enforcement: "repair_then_verify",
      key: "chatgpt-web-default",
      modelSelection: "strongest_available",
      thinkingEffort: "maximum_available",
    },
    targetId,
    taskSpace: 10,
    timeoutMs,
  }
  await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(ownerPath, JSON.stringify({
    brokerId: "adoption-test-broker",
    epoch: 1,
    pid: process.pid,
  }), { mode: 0o600 })
  await fs.writeFile(`${mailboxDirectory}/input.json`, JSON.stringify(input), { mode: 0o600 })

  const harness = `
process.getuid = () => ${JSON.stringify(driverUid)}
let generating = ${JSON.stringify(initiallyGenerating)}
let waits = 0
let policyMenuOpen = false
let policyCurrent = ${JSON.stringify(policyInitiallyMaximum ? 4 : 3)}
let pageInspection = 0
let pageInfoRead = 0
let pageUrlOverride = null
let openedRecoveredTab = false
let messageReads = 0
const pageStates = ${JSON.stringify(pageStates)}
const taskSpaceRequests = []
const counters = { click: 0, fillInput: 0, pressKey: 0, sendClick: 0, typeText: 0 }
const canonicalUrl = ${JSON.stringify(canonicalUrl)}
const pageUrl = ${JSON.stringify(pageUrl)}
const pageUrls = ${JSON.stringify(pageUrls)}
const messages = () => {
  messageReads += 1
  const values = [
    {
      messageId: 'adopt-user-1',
      role: 'user',
      text: ${JSON.stringify(hydrateAnchorPrefix)} && messageReads === 1
        ? 'Please perform a long review.'
        : ${JSON.stringify(mutateAnchorAfterLock)} && messageReads >= 3
          ? 'The user turn changed after the adoption anchor was locked.'
          : 'Please perform a long review with the fully hydrated prompt.',
    },
    {
      messageId: 'adopt-assistant-1',
      role: 'assistant',
      text: generating ? 'Partial review' : 'The stable long review is complete.',
    },
  ]
  if (${JSON.stringify(interleave)} && !generating) {
    values.push({ messageId: 'manual-user-2', role: 'user', text: 'Manual interleaving message.' })
  }
  return values
}
globalThis.cliLog = (value) => console.log(value)
globalThis.listTaskSpaces = async () => ${JSON.stringify(listedTaskSpaces)}
globalThis.useOrCreateTaskSpace = async (value) => {
  taskSpaceRequests.push(value)
  if (!${JSON.stringify(taskSpaceAvailable)} && value === 10) {
    throw new Error('No task space matches numeric id 10')
  }
  return { id: value === 10 ? 10 : 11 }
}
globalThis.listTabs = async () => {
  if (!${JSON.stringify(taskSpaceAvailable)}) {
    return openedRecoveredTab ? [{ active: true, targetId: 'adopt-recovered-tab' }] : []
  }
  if (${JSON.stringify(unrelatedActiveAfterOpen)} && openedRecoveredTab) {
    return [
      { active: true, targetId: 'unrelated-active-tab' },
      { active: false, targetId: 'adopt-recovered-tab' },
    ]
  }
  return [{ active: true, targetId: 'adopt-tab' }]
}
globalThis.switchTab = async () => {}
globalThis.openOrReuseTab = async () => {
  openedRecoveredTab = true
  return {
    active: true,
    targetId: ${JSON.stringify(taskSpaceAvailable && !unrelatedActiveAfterOpen)} ? 'adopt-tab' : 'adopt-recovered-tab',
  }
}
globalThis.pageInfo = async () => {
  const sequencedUrl = pageUrls?.[Math.min(pageInfoRead, pageUrls.length - 1)]
  pageInfoRead += 1
  return { url: pageUrlOverride || sequencedUrl || pageUrl || canonicalUrl }
}
globalThis.snapshotText = async () => (
  pageStates[Math.min(pageInspection, pageStates.length - 1)] === 'verification'
    ? 'Verify you are human'
    : ''
)
globalThis.wait = async () => {
  waits += 1
  generating = false
}
globalThis.click = async (target) => {
  counters.click += 1
  if (String(target).includes('send-button')) counters.sendClick += 1
  if (String(target).includes('__composer-pill')) policyMenuOpen = true
  if (target === '#prompt-textarea') policyMenuOpen = false
}
globalThis.fillInput = async () => { counters.fillInput += 1 }
globalThis.typeText = async () => { counters.typeText += 1 }
globalThis.pressKey = async () => {
  counters.pressKey += 1
  policyCurrent = 4
}
globalThis.cdp = async () => {}
globalThis.js = async (source) => {
  if (source.includes('hasLoginAction')) {
    const state = pageStates[Math.min(pageInspection, pageStates.length - 1)]
    pageInspection += 1
    if (state === 'unknown') {
      return {
        composerCount: 0,
        composerSemanticId: false,
        draft: '',
        hasComposer: false,
        hasLoginAction: false,
      }
    }
    if (state === 'unauthenticated') {
      return {
        composerCount: 0,
        composerSemanticId: false,
        draft: '',
        hasComposer: false,
        hasLoginAction: true,
      }
    }
    if (state === 'verification') {
      return {
        composerCount: 0,
        composerSemanticId: false,
        draft: '',
        hasComposer: false,
        hasLoginAction: false,
      }
    }
    return {
      composerCount: 1,
      composerSemanticId: true,
      draft: '',
      hasComposer: true,
      hasLoginAction: false,
    }
  }
  if (source.includes("return [...document.querySelectorAll('[data-message-author-role]')].map")) {
    return messages()
  }
  if (source.includes('aria-valuemin')) {
    if (${JSON.stringify(redirectAfterModelVerification)}) {
      pageUrlOverride = 'https://chatgpt.com/g/g-p-adoption-test/project'
    }
    return {
      current: policyCurrent,
      effortLabel: 'Pro',
      maximum: 4,
      minimum: 0,
      modelLabel: 'GPT-5.6 Sol',
      ok: true,
      pillLabel: 'Pro',
    }
  }
  if (source.includes('powerItems[0].focus()')) {
    return true
  }
  if (source.includes("composerCount: document.querySelectorAll('#prompt-textarea').length")) {
    return { composerCount: 1, count: 1, expanded: policyMenuOpen ? 'true' : 'false' }
  }
  if (source.includes("expanded: pills[0]?.getAttribute('aria-expanded') === 'true'")) {
    return { count: 1, expanded: policyMenuOpen }
  }
  if (source.trimStart().startsWith('Boolean(')) {
    return generating
  }
  throw new Error('Unexpected page script: ' + source.slice(0, 100))
}
await ${EGO_DRIVER_SOURCE.trim()}
console.log('__EGO_CHAT_ADOPT_COUNTERS__' + JSON.stringify({ ...counters, waits }))
console.log('__EGO_CHAT_ADOPT_TASK_SPACES__' + JSON.stringify(taskSpaceRequests))
`

  try {
    const executed = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: harness,
    })
    assert.equal(executed.status, 0, executed.stderr)
    const countersLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_ADOPT_COUNTERS__"))
    const taskSpacesLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_ADOPT_TASK_SPACES__"))
    assert.ok(countersLine)
    assert.ok(taskSpacesLine)
    let result
    let error
    try {
      result = decodeDriverResult(executed.stdout)
    } catch (caught) {
      error = caught
    }
    return {
      counters: JSON.parse(countersLine.slice("__EGO_CHAT_ADOPT_COUNTERS__".length)),
      error,
      result,
      taskSpaceRequests: JSON.parse(taskSpacesLine.slice("__EGO_CHAT_ADOPT_TASK_SPACES__".length)),
    }
  } finally {
    await fs.rm(mailboxDirectory, { force: true, recursive: true })
  }
}

async function runTaskSpaceReconciliationCase({
  fallbackTaskSpaceOwnership = null,
  requestedTaskSpaceOwnership = null,
} = {}) {
  driverCase += 1
  const driverUid = `ego-chat-reconcile-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const ownerPath = `${mailboxDirectory}/owner.json`
  const canonicalUrl = "https://chatgpt.com/c/reconcile-driver-test"
  const fallbackName = `ego-chat-bound-${createHash("sha256").update("ego-chat-main", "utf8").digest("hex").slice(0, 16)}`
  const listedTaskSpaces = [
    ...(requestedTaskSpaceOwnership
      ? [{ id: 10, name: "unrelated-agent-space", ownership: requestedTaskSpaceOwnership, taskId: "unrelated-agent-space" }]
      : []),
    ...(fallbackTaskSpaceOwnership
      ? [{ id: 12, name: fallbackName, ownership: fallbackTaskSpaceOwnership, taskId: fallbackName }]
      : []),
  ]
  const previousText = "Prior assistant response."
  const previousDigest = createHash("sha256").update(previousText, "utf8").digest("hex")
  const input = {
    allowDeliveryAbsent: true,
    binding: {
      canonicalUrl,
      headRole: "assistant",
      key: "ego-chat-main",
      messageCount: 2,
      state: "bound",
      targetId: "stale-bound-tab",
      taskSpaceId: 10,
    },
    brokerLease: {
      brokerId: "reconcile-test-broker",
      epoch: 1,
      ownerPath,
      pid: process.pid,
    },
    browserContractRevision: 6,
    canonicalUrl,
    expectedPreviousContentDigest: previousDigest,
    expectedPreviousMessageId: "previous-assistant",
    expectedTerminalMarker: "EGO_CHAT_REVIEW_DONE_RECONCILE_TEST",
    inputDigest: "0".repeat(64),
    mode: "reconcile_bound",
    timeoutMs: 1_000,
    turnMarker: "EGO_CHAT_RECONCILE_TEST_MARKER",
  }
  await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(ownerPath, JSON.stringify({
    brokerId: "reconcile-test-broker",
    epoch: 1,
    pid: process.pid,
  }), { mode: 0o600 })
  await fs.writeFile(`${mailboxDirectory}/input.json`, JSON.stringify(input), { mode: 0o600 })

  const harness = `
process.getuid = () => ${JSON.stringify(driverUid)}
let opened = false
const taskSpaceRequests = []
const counters = { click: 0, fillInput: 0, pressKey: 0, typeText: 0 }
globalThis.cliLog = (value) => console.log(value)
const fallbackName = ${JSON.stringify(fallbackName)}
globalThis.listTaskSpaces = async () => ${JSON.stringify(listedTaskSpaces)}
globalThis.useOrCreateTaskSpace = async (value) => {
  taskSpaceRequests.push(value)
  if (value === 10) return { id: 10 }
  if (value === 12) return { id: 12 }
  if (value === fallbackName) return { id: 11 }
  throw new Error('Unexpected task space request: ' + value)
}
globalThis.listTabs = async () => opened ? [{ active: true, targetId: 'recovered-bound-tab' }] : []
globalThis.switchTab = async () => {}
globalThis.openOrReuseTab = async () => {
  opened = true
  return { active: true, targetId: 'recovered-bound-tab' }
}
globalThis.pageInfo = async () => ({ url: ${JSON.stringify(canonicalUrl)} })
globalThis.snapshotText = async () => ''
globalThis.wait = async () => {}
globalThis.click = async () => { counters.click += 1 }
globalThis.fillInput = async () => { counters.fillInput += 1 }
globalThis.typeText = async () => { counters.typeText += 1 }
globalThis.pressKey = async () => { counters.pressKey += 1 }
globalThis.cdp = async () => {}
globalThis.js = async (source) => {
  if (source.includes('hasLoginAction')) {
    return {
      composerCount: 1,
      composerSemanticId: true,
      draft: '',
      hasComposer: true,
      hasLoginAction: false,
    }
  }
  if (source.includes("return [...document.querySelectorAll('[data-message-author-role]')].map")) {
    return [{ messageId: 'previous-assistant', role: 'assistant', text: ${JSON.stringify(previousText)} }]
  }
  if (source.trimStart().startsWith('Boolean(')) return false
  throw new Error('Unexpected page script: ' + source.slice(0, 100))
}
await ${EGO_DRIVER_SOURCE.trim()}
console.log('__EGO_CHAT_RECONCILE_COUNTERS__' + JSON.stringify(counters))
console.log('__EGO_CHAT_RECONCILE_TASK_SPACES__' + JSON.stringify(taskSpaceRequests))
`

  try {
    const executed = spawnSync(process.execPath, ["--input-type=module"], {
      encoding: "utf8",
      input: harness,
    })
    assert.equal(executed.status, 0, executed.stderr)
    const countersLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_RECONCILE_COUNTERS__"))
    const taskSpacesLine = executed.stdout
      .split("\n")
      .find((line) => line.startsWith("__EGO_CHAT_RECONCILE_TASK_SPACES__"))
    assert.ok(countersLine)
    assert.ok(taskSpacesLine)
    let result
    let error
    try {
      result = decodeDriverResult(executed.stdout)
    } catch (caught) {
      error = caught
    }
    return {
      counters: JSON.parse(countersLine.slice("__EGO_CHAT_RECONCILE_COUNTERS__".length)),
      error,
      result,
      taskSpaceRequests: JSON.parse(taskSpacesLine.slice("__EGO_CHAT_RECONCILE_TASK_SPACES__".length)),
    }
  } finally {
    await fs.rm(mailboxDirectory, { force: true, recursive: true })
  }
}

test("fixed Ego driver source is valid ESM", () => {
  const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    encoding: "utf8",
    input: EGO_DRIVER_SOURCE,
  })
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(EGO_DRIVER_SOURCE, /composer\.matches\('input, textarea'\)/)
  assert.match(EGO_DRIVER_SOURCE, /collapsible-user-message-content/)
  assert.match(EGO_DRIVER_SOURCE, /aria-valuemax/)
  assert.match(EGO_DRIVER_SOURCE, /ARROWRIGHT/)
  assert.match(EGO_DRIVER_SOURCE, /dismiss ChatGPT policy menu/)
  assert.match(EGO_DRIVER_SOURCE, /draftMarkerCount/)
  assert.match(EGO_DRIVER_SOURCE, /digestMatchCount/)
  assert.match(EGO_DRIVER_SOURCE, /canonicalComposerText/)
  assert.match(EGO_DRIVER_SOURCE, /replaceAll\("\\u00a0", " "\)/)
  assert.match(EGO_DRIVER_SOURCE, /const candidates = await js\(String\.raw`/)
  assert.match(EGO_DRIVER_SOURCE, /blockChildren\.every\(\(child\) => child\.tagName === 'P'\)/)
  assert.match(EGO_DRIVER_SOURCE, /map\(\(child\) => String\(child\.textContent \|\| ''\)\)\.join\('\\n'\)/)
  assert.match(EGO_DRIVER_SOURCE, /fingerprintVersion: "tail-v1"/)
  assert.match(EGO_DRIVER_SOURCE, /expectedPreviousMessageId/)
  assert.match(EGO_DRIVER_SOURCE, /Input\.dispatchMouseEvent/)
  assert.match(EGO_DRIVER_SOURCE, /Input\.insertText/)
  assert.match(EGO_DRIVER_SOURCE, /compositionChunks\(value, maximumLength = 4_000\)/)
  assert.match(EGO_DRIVER_SOURCE, /clearUnsentComposerDraft/)
  assert.match(EGO_DRIVER_SOURCE, /draftCleared/)
  assert.match(EGO_DRIVER_SOURCE, /buttons\[0\]\.contains\(hit\)/)
  assert.match(EGO_DRIVER_SOURCE, /renderedMarkerCount/)
  assert.match(EGO_DRIVER_SOURCE, /responseEndsWithTerminal/)
  assert.match(EGO_DRIVER_SOURCE, /userMarkerCount/)
  assert.match(EGO_DRIVER_SOURCE, /model_policy_mismatch/)
  assert.match(EGO_DRIVER_SOURCE, /before_policy_verification/)
  assert.match(EGO_DRIVER_SOURCE, /before_send_click/)
  assert.match(EGO_DRIVER_SOURCE, /before_presend_policy_verification/)
  assert.match(EGO_DRIVER_SOURCE, /immediately_before_send_click/)
  assert.match(EGO_DRIVER_SOURCE, /before_head_commit/)
  assert.match(EGO_DRIVER_SOURCE, /broker_fence_lost/)
  assert.match(EGO_DRIVER_SOURCE, /process\.kill\(owner\.pid, 0\)/)
  assert.match(EGO_DRIVER_SOURCE, /browser_contract_mismatch/)
  assert.match(EGO_DRIVER_SOURCE, /inputPathOverride/)
  assert.match(EGO_DRIVER_SOURCE, /O_NOFOLLOW/)
  assert.match(EGO_DRIVER_SOURCE, /await fs\.unlink\(inputPath\)/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /Number\(inputNameMatch\[1\]\) !== process\.pid/)
  assert.match(EGO_DRIVER_SOURCE, /adoption_anchor_changed/)
  assert.match(EGO_DRIVER_SOURCE, /adoption_tail_interleaved/)
  assert.match(EGO_DRIVER_SOURCE, /adoptedWhileGenerating/)
  assert.match(EGO_DRIVER_SOURCE, /composerCount === 0/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /'value' in composer/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /document\.body\.innerText\.split/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /await click\("button\[data-testid=/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& committed\[0\]\?\.contentDigest === sha256\(input\.prompt\)/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& prompt\?\.contentDigest === input\.inputDigest/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /finishedHead\.messageCount !== beforeHead\.messageCount/)

  const composed = EGO_DRIVER_SOURCE.indexOf('await composePrompt(input.prompt)')
  const presendPolicy = EGO_DRIVER_SOURCE.indexOf('driverStage = "verifying_presend_model_policy"')
  const preClickPrompt = EGO_DRIVER_SOURCE.indexOf('driverStage = "verifying_preclick_prompt"')
  const recheckTarget = EGO_DRIVER_SOURCE.indexOf('driverStage = "rechecking_send_control"')
  const dispatchFence = EGO_DRIVER_SOURCE.indexOf('driverStage = "checking_send_dispatch_fence"')
  const dispatch = EGO_DRIVER_SOURCE.indexOf('driverStage = "dispatching_send_click"')
  assert.ok(composed < presendPolicy)
  assert.ok(presendPolicy < preClickPrompt)
  assert.ok(preClickPrompt < recheckTarget)
  assert.ok(recheckTarget < dispatchFence)
  assert.ok(dispatchFence < dispatch)
  assert.ok(EGO_DRIVER_SOURCE.indexOf("await fs.unlink(inputPath)") < composed)
})

test("per-operation Ego driver source embeds only a private unique mailbox path", () => {
  const inputPath = `/tmp/egc-driver-${process.getuid()}/input-${process.pid}-123e4567-e89b-42d3-a456-426614174000.json`
  const source = egoDriverSourceForInput(inputPath)
  const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    encoding: "utf8",
    input: source,
  })
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(source, new RegExp(JSON.stringify(inputPath).slice(1, -1)))
  assert.doesNotMatch(source, /EGO_CHAT_DRIVER_INPUT_PATH/)
})

test("driver mailbox startup scavenges stale inputs but preserves a live registered child", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group ownership is exercised on supported host platforms")
    return
  }
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-mailbox-sweep-test-"))
  const mailboxDirectory = path.join(fixtureDirectory, "mailbox")
  const ownerPath = path.join(fixtureDirectory, "broker-owner.json")
  await fs.mkdir(mailboxDirectory, { mode: 0o700 })
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  })
  t.after(async () => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error
      }
    }
    await fs.rm(fixtureDirectory, { force: true, recursive: true })
  })
  await fs.writeFile(ownerPath, JSON.stringify({
    brokerId: "mailbox-sweep-broker",
    browserProcessGroups: [child.pid],
    epoch: 7,
    pid: process.pid,
  }), { mode: 0o600 })
  const activePath = path.join(
    mailboxDirectory,
    `input-${child.pid}-11111111-1111-4111-8111-111111111111.json`,
  )
  const stalePath = path.join(
    mailboxDirectory,
    "input-999999-22222222-2222-4222-8222-222222222222.json",
  )
  const legacyPath = path.join(
    mailboxDirectory,
    "input-33333333-3333-4333-8333-333333333333.json",
  )
  for (const inputPath of [activePath, stalePath, legacyPath]) {
    await fs.writeFile(inputPath, "{}", { mode: 0o600 })
    const staleTime = new Date(Date.now() - 10_000)
    await fs.utimes(inputPath, staleTime, staleTime)
  }
  const adapterOptions = {
    brokerLease: {
      brokerId: "mailbox-sweep-broker",
      epoch: 7,
      ownerPath,
      pid: process.pid,
    },
    command: "/unused/ego-browser",
    mailboxDirectory,
    mailboxRetentionMs: 100,
  }
  const firstAdapter = new EgoAdapter(adapterOptions)
  const firstMetrics = await firstAdapter.initialize()
  assert.equal(firstMetrics.files, 1)
  assert.equal(firstMetrics.bytes, 2)
  await fs.access(activePath)
  await assert.rejects(fs.access(stalePath), { code: "ENOENT" })
  await assert.rejects(fs.access(legacyPath), { code: "ENOENT" })

  const secondAdapter = new EgoAdapter(adapterOptions)
  assert.equal((await secondAdapter.initialize()).files, 1)
  const childExit = new Promise((resolve) => child.once("exit", resolve))
  process.kill(-child.pid, "SIGKILL")
  await childExit
  const staleTime = new Date(Date.now() - 10_000)
  await fs.utimes(activePath, staleTime, staleTime)
  const finalAdapter = new EgoAdapter(adapterOptions)
  assert.equal((await finalAdapter.initialize()).files, 0)
  await assert.rejects(fs.access(activePath), { code: "ENOENT" })
})

test("driver mailbox capacity rejects before browser startup and recovers after retention", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-mailbox-quota-test-"))
  const mailboxDirectory = path.join(fixtureDirectory, "mailbox")
  const spawnedPath = path.join(fixtureDirectory, "spawned")
  const command = path.join(fixtureDirectory, "fake-ego-browser.mjs")
  await fs.mkdir(mailboxDirectory, { mode: 0o700 })
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs"
fs.writeFileSync(${JSON.stringify(spawnedPath)}, "spawned")
process.stdin.resume()
process.stdin.on("end", () => {
  const envelope = Buffer.from(JSON.stringify({ ok: true, result: { safe: true } }), "utf8").toString("base64url")
  process.stdout.write("${EGO_DRIVER_RESULT_PREFIX}" + envelope + "\\n")
})
`, { mode: 0o700 })
  const retainedPath = path.join(
    mailboxDirectory,
    "input-44444444-4444-4444-8444-444444444444.json",
  )
  await fs.writeFile(retainedPath, "{}", { mode: 0o600 })
  const adapter = new EgoAdapter({
    command,
    mailboxDirectory,
    mailboxMaxFiles: 1,
    mailboxRetentionMs: 60_000,
  })
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  assert.equal((await adapter.initialize()).files, 1)
  await assert.rejects(
    adapter.preflight({ taskSpace: 10 }),
    (error) => error.code === "driver_mailbox_capacity_exhausted"
      && error.details.requiredFiles === 2,
  )
  await assert.rejects(fs.access(spawnedPath), { code: "ENOENT" })

  const staleTime = new Date(Date.now() - 120_000)
  await fs.utimes(retainedPath, staleTime, staleTime)
  assert.equal((await adapter.initialize()).files, 0)
  const byteLimitedAdapter = new EgoAdapter({
    command,
    mailboxDirectory,
    mailboxMaxBytes: 1,
    mailboxRetentionMs: 60_000,
  })
  await assert.rejects(
    byteLimitedAdapter.preflight({ taskSpace: 10 }),
    (error) => error.code === "driver_mailbox_capacity_exhausted"
      && error.details.requiredBytes > error.details.byteLimit,
  )
  await assert.rejects(fs.access(spawnedPath), { code: "ENOENT" })
  assert.equal((await adapter.preflight({ taskSpace: 10 })).safe, true)
  await fs.access(spawnedPath)
  assert.deepEqual(await fs.readdir(mailboxDirectory), [])
})

test("driver mailbox rejects symlinks and non-private input modes", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-mailbox-safety-test-"))
  const mailboxDirectory = path.join(fixtureDirectory, "mailbox")
  const outsidePath = path.join(fixtureDirectory, "outside.json")
  const inputName = "input-999998-55555555-5555-4555-8555-555555555555.json"
  await fs.mkdir(mailboxDirectory, { mode: 0o700 })
  await fs.writeFile(outsidePath, "{}", { mode: 0o600 })
  const inputPath = path.join(mailboxDirectory, inputName)
  await fs.symlink(outsidePath, inputPath)
  const adapter = new EgoAdapter({
    command: "/unused/ego-browser",
    mailboxDirectory,
  })
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  await assert.rejects(
    adapter.initialize(),
    (error) => error.code === "unsafe_driver_mailbox",
  )
  await fs.unlink(inputPath)
  await fs.writeFile(inputPath, "{}", { mode: 0o644 })
  await assert.rejects(
    adapter.initialize(),
    (error) => error.code === "unsafe_driver_mailbox",
  )
})

test("child-read acknowledgement removes the prompt-bearing path before long browser work", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-mailbox-consume-test-"))
  const consumedPath = path.join(fixtureDirectory, "consumed")
  const command = path.join(fixtureDirectory, "fake-ego-browser.mjs")
  await fs.writeFile(command, `#!/usr/bin/env node
import fs from "node:fs/promises"
let source = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { source += chunk })
process.stdin.on("end", async () => {
  globalThis.cliLog = (value) => process.stdout.write(value + "\\n")
  globalThis.useOrCreateTaskSpace = async () => {
    const mailbox = "/tmp/egc-driver-" + process.getuid()
    const activeInput = (await fs.readdir(mailbox)).some(
      (entry) => entry.startsWith("input-" + process.pid + "-"),
    )
    if (activeInput) throw new Error("driver input remained linked before browser work")
    await fs.writeFile(${JSON.stringify(consumedPath)}, String(process.pid))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { id: 10 }
  }
  globalThis.openOrReuseTab = async () => ({ active: true, targetId: "consume-tab" })
  globalThis.listTabs = async () => [{ active: true, targetId: "consume-tab" }]
  globalThis.pageInfo = async () => ({ url: "https://chatgpt.com/" })
  globalThis.snapshotText = async () => ""
  globalThis.js = async () => ({
    composerCount: 1,
    composerSemanticId: true,
    draft: "",
    hasComposer: true,
    hasLoginAction: false,
  })
  await eval(source)
})
`, { mode: 0o700 })
  const adapter = new EgoAdapter({
    brokerLease: {
      registerChild: async () => {},
      unregisterChild: async () => {},
    },
    command,
  })
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  const running = adapter.preflight({ taskSpace: 10 })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fs.access(consumedPath)
      break
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await fs.access(consumedPath)
  const childPid = Number(await fs.readFile(consumedPath, "utf8"))
  const mailboxDirectory = `/tmp/egc-driver-${process.getuid()}`
  assert.equal(
    (await fs.readdir(mailboxDirectory)).some((entry) => entry.startsWith(`input-${childPid}-`)),
    false,
  )
  assert.equal((await running).browserContract.safe, true)
})

test("Ego adapter registers its click-capable child before supplying driver source", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-adapter-child-test-"))
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  const command = path.join(fixtureDirectory, "fake-ego-browser.mjs")
  await fs.writeFile(command, `#!/usr/bin/env node
let source = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { source += chunk })
process.stdin.on("end", () => {
  if (!/input-[1-9][0-9]*-[a-f0-9-]{36}\\.json/.test(source)) process.exit(2)
  const envelope = Buffer.from(JSON.stringify({ ok: true, result: { safe: true } }), "utf8").toString("base64url")
  process.stdout.write("${EGO_DRIVER_RESULT_PREFIX}" + envelope + "\\n")
})
`, { mode: 0o700 })
  const lifecycle = []
  const adapter = new EgoAdapter({
    brokerLease: {
      brokerId: "adapter-child-test",
      epoch: 1,
      ownerPath: "/unused/owner.json",
      pid: process.pid,
      registerChild: async (pid) => {
        assert.doesNotThrow(() => process.kill(pid, 0))
        lifecycle.push(["register", pid])
      },
      unregisterChild: async (pid) => {
        lifecycle.push(["unregister", pid])
      },
    },
    command,
  })

  const result = await adapter.preflight({ taskSpace: 10 })
  assert.equal(result.safe, true)
  assert.equal(lifecycle.length, 2)
  assert.equal(lifecycle[0][0], "register")
  assert.equal(lifecycle[1][0], "unregister")
  assert.equal(lifecycle[1][1], lifecycle[0][1])
})

test("failed child registration drains the unregistered browser process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group draining is exercised on supported host platforms")
    return
  }
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-adapter-register-failure-test-"))
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  const command = path.join(fixtureDirectory, "fake-ego-browser.mjs")
  const descendantPath = path.join(fixtureDirectory, "descendant.pid")
  const mailboxDirectory = path.join(fixtureDirectory, "mailbox")
  await fs.writeFile(command, `#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid))
process.stdin.resume()
setInterval(() => {}, 1000)
`, { mode: 0o700 })
  let registeredPid
  let descendantPid
  const adapter = new EgoAdapter({
    brokerLease: {
      registerChild: async (pid) => {
        registeredPid = pid
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            descendantPid = Number(await fs.readFile(descendantPath, "utf8"))
            break
          } catch (error) {
            if (error.code !== "ENOENT") {
              throw error
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(Number.isSafeInteger(descendantPid))
        throw new Error("simulated durable child registration failure")
      },
      unregisterChild: async () => {
        assert.fail("an unregistered process group must not be unregistered")
      },
    },
    command,
    mailboxDirectory,
  })

  await assert.rejects(
    adapter.preflight({ taskSpace: 10 }),
    /simulated durable child registration failure/,
  )
  assert.throws(() => process.kill(registeredPid, 0), { code: "ESRCH" })
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" })
  assert.deepEqual(await fs.readdir(mailboxDirectory), [])
})

test("Ego adapter shutdown drains the owned browser process group before unregistering it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group draining is exercised on supported host platforms")
    return
  }
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-adapter-drain-test-"))
  t.after(() => fs.rm(fixtureDirectory, { force: true, recursive: true }))
  const command = path.join(fixtureDirectory, "fake-ego-browser.mjs")
  const descendantPath = path.join(fixtureDirectory, "descendant.pid")
  const mailboxDirectory = path.join(fixtureDirectory, "mailbox")
  await fs.writeFile(command, `#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid))
let stopping = false
process.on("SIGTERM", () => {
  if (stopping) return
  stopping = true
  child.once("exit", () => process.exit(0))
  child.kill("SIGTERM")
})
process.stdin.resume()
setInterval(() => {}, 1000)
`, { mode: 0o700 })
  let registeredPid
  let registrationObserved
  const registered = new Promise((resolve) => {
    registrationObserved = resolve
  })
  const lifecycle = []
  const adapter = new EgoAdapter({
    brokerLease: {
      registerChild: async (pid, options) => {
        registeredPid = pid
        lifecycle.push(["register", pid, options])
        registrationObserved()
      },
      unregisterChild: async (pid) => {
        lifecycle.push(["unregister", pid])
      },
    },
    command,
    mailboxDirectory,
  })
  const running = adapter.preflight({ taskSpace: 10 })
  const runningResult = running.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await registered
  let descendantPid
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      descendantPid = Number(await fs.readFile(descendantPath, "utf8"))
      break
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(Number.isSafeInteger(descendantPid))
  let retainedInput
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const entries = await fs.readdir(mailboxDirectory)
    retainedInput = entries.find((entry) => entry.startsWith(`input-${registeredPid}-`))
    if (retainedInput) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(retainedInput)

  await adapter.drain(2_000)
  const stopped = await runningResult
  assert.equal(stopped.value, undefined)
  assert.ok(["ego_browser_process_failed", "invalid_driver_output"].includes(stopped.error?.code))
  assert.deepEqual(lifecycle, [
    ["register", registeredPid, { processGroup: true }],
    ["unregister", registeredPid],
  ])
  assert.throws(() => process.kill(registeredPid, 0), { code: "ESRCH" })
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" })
  assert.deepEqual(await fs.readdir(mailboxDirectory), [])
  await assert.rejects(
    adapter.preflight({ taskSpace: 10 }),
    (error) => error.code === "ego_adapter_draining",
  )
})

test("malformed model-policy attributes stop before composition or send", async () => {
  const valid = {
    "aria-valuemax": "0",
    "aria-valuemin": "0",
    "aria-valuenow": "0",
  }
  const cases = [
    { "aria-valuemax": "0", "aria-valuenow": "0" },
    { ...valid, "aria-valuemax": "" },
    { ...valid, "aria-valuenow": "   " },
    { ...valid, "aria-valuemin": "zero" },
    { ...valid, "aria-valuemax": "4.5" },
  ]

  for (const attributes of cases) {
    const counters = await runMalformedModelPolicyCase(attributes)
    assert.deepEqual(counters, { cdp: 0, fillInput: 0, pressKey: 0, typeText: 0 })
  }
})

test("a live policy downgrade after composition stops before Send", async () => {
  const stopped = await runPreSendDriverCase({ downgradeAtPresend: true })
  assert.equal(stopped.error?.code, "human_required")
  assert.equal(stopped.error?.details?.reason, "adoption_live_model_not_maximum")
  assert.equal(stopped.error?.details?.evidence?.powerLevel, 4)
  assert.equal(stopped.error?.details?.evidence?.powerMax, 5)
  assert.equal(stopped.counters.policyReads, 3)
  assert.equal(stopped.counters.insertText, 1)
  assert.equal(stopped.counters.mouseEvents, 0)
})

test("a changed Send control after final prompt verification stops before dispatch", async () => {
  const stopped = await runPreSendDriverCase({ changeSendControlAtRecheck: true })
  assert.equal(stopped.error?.code, "human_required")
  assert.equal(stopped.error?.details?.reason, "send_control_changed")
  assert.equal(stopped.counters.policyReads, 3)
  assert.equal(stopped.counters.sendTargetReads, 2)
  assert.equal(stopped.counters.mouseEvents, 0)
})

test("a broker fence change after Send hit-testing stops before dispatch", async () => {
  const stopped = await runPreSendDriverCase({ fenceAtRecheck: true })
  assert.equal(stopped.error?.code, "human_required")
  assert.equal(stopped.error?.details?.reason, "broker_fence_lost")
  assert.equal(stopped.counters.policyReads, 3)
  assert.equal(stopped.counters.sendTargetReads, 2)
  assert.equal(stopped.counters.mouseEvents, 0)
})

test("driver envelope returns structured data without log scraping", () => {
  const result = decodeDriverResult(envelope({ ok: true, result: { accountState: "authenticated" } }))
  assert.deepEqual(result, { accountState: "authenticated" })
})

test("driver envelope can be decoded when Ego writes cliLog to stderr", () => {
  const result = decodeDriverResult(`diagnostic on stdout\n${envelope({ ok: true, result: { state: "bound" } })}`)
  assert.deepEqual(result, { state: "bound" })
})

test("driver envelope preserves human-required stop state", () => {
  assert.throws(
    () => decodeDriverResult(envelope({
      humanRequired: true,
      message: "Login required",
      ok: false,
      reason: "authentication_required",
    })),
    (error) => error.code === "human_required" && error.details.reason === "authentication_required",
  )
})

test("driver envelope preserves only bounded browser-interruption diagnostics", () => {
  assert.throws(
    () => decodeDriverResult(envelope({
      error: {
        code: "ego_driver_error",
        diagnosticDigest: "a".repeat(64),
        draftCleared: true,
        message: "The fixed Ego Browser driver failed.",
        modelPolicy: {
          adjusted: false,
          effortLabel: "Pro",
          key: "chatgpt-web-default",
          modelLabel: "GPT-5.6 Sol",
          pillLabel: "Pro",
          powerLevel: 5,
          powerMax: 5,
        },
        stage: "composing_prompt",
      },
      ok: false,
    })),
    (error) => (
      error.code === "ego_driver_error"
      && error.details.diagnosticDigest === "a".repeat(64)
      && error.details.draftCleared === true
      && error.details.driverStage === "composing_prompt"
      && error.details.evidence.modelPolicy.effortLabel === "Pro"
    ),
  )
})

test("conversation adoption waits for a stable assistant tail without composing or sending", async () => {
  const adopted = await runAdoptionDriverCase()
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.adoptedWhileGenerating, true)
  assert.equal(adopted.result.anchor.messageId, "adopt-user-1")
  assert.equal(adopted.result.head.lastMessageId, "adopt-assistant-1")
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.deepEqual(adopted.taskSpaceRequests, [10])
  assert.deepEqual(adopted.counters, {
    click: 2,
    fillInput: 0,
    pressKey: 0,
    sendClick: 0,
    typeText: 0,
    waits: 4,
  })
})

test("conversation adoption tolerates transient ChatGPT hydration without asking for authentication", async () => {
  const adopted = await runAdoptionDriverCase({ pageStates: ["unknown", "authenticated"] })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption stabilizes one hydrated anchor prefix before locking it", async () => {
  const adopted = await runAdoptionDriverCase({ hydrateAnchorPrefix: true })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.anchor.messageId, "adopt-user-1")
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption still fails closed when the anchor changes after locking", async () => {
  const adopted = await runAdoptionDriverCase({ mutateAnchorAfterLock: true })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "adoption_anchor_changed")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption reports an unresolved page instead of a false authentication failure", async () => {
  const adopted = await runAdoptionDriverCase({ pageStates: ["unknown"] })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "page_state_unresolved")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption still fails closed for an explicit authentication page", async () => {
  const adopted = await runAdoptionDriverCase({ pageStates: ["unauthenticated"] })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "authentication_required")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption tolerates a transient logged-out shell during session restoration", async () => {
  const adopted = await runAdoptionDriverCase({ pageStates: ["unauthenticated", "authenticated"] })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption does not infer authentication from one deadline-edge sample", async () => {
  const adopted = await runAdoptionDriverCase({
    pageStates: ["unauthenticated"],
    timeoutMs: 0,
  })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "page_state_unresolved")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption still fails closed for a verification challenge", async () => {
  const adopted = await runAdoptionDriverCase({ pageStates: ["verification"] })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "verification_challenge")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption reports a settled project-page redirect after hydration", async () => {
  const adopted = await runAdoptionDriverCase({
    pageStates: ["unknown", "authenticated"],
    pageUrl: "https://chatgpt.com/g/g-p-adoption-test/project",
  })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "canonical_conversation_redirected")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption rechecks a reused tab URL after hydration", async () => {
  const canonicalUrl = "https://chatgpt.com/c/adoption-driver-test"
  const adopted = await runAdoptionDriverCase({
    pageStates: ["unknown", "authenticated"],
    pageUrls: [
      canonicalUrl,
      canonicalUrl,
      "https://chatgpt.com/g/g-p-adoption-test/project",
    ],
    targetId: "adopt-tab",
  })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "canonical_conversation_redirected")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption tolerates a transient composer remount before final capture", async () => {
  const adopted = await runAdoptionDriverCase({
    pageStates: ["authenticated", "unknown", "authenticated"],
  })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption rechecks the URL after maximum-model verification", async () => {
  const adopted = await runAdoptionDriverCase({ redirectAfterModelVerification: true })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "adoption_url_changed")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption never routes around a user-controlled bound task space", async () => {
  const adopted = await runAdoptionDriverCase({ taskSpaceOwnership: "user" })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "browser_control_unavailable")
  assert.deepEqual(adopted.taskSpaceRequests, [])
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption stays in its explicit space when an unrelated fallback is user-controlled", async () => {
  const adopted = await runAdoptionDriverCase({ fallbackTaskSpaceOwnership: "user" })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.taskSpaceId, 10)
  assert.deepEqual(adopted.taskSpaceRequests, [10])
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("conversation adoption selects the exact tab returned by canonical navigation", async () => {
  const adopted = await runAdoptionDriverCase({ unrelatedActiveAfterOpen: true })
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.targetId, "adopt-recovered-tab")
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})

test("bound recovery reopens a canonical conversation after its task space disappears", async () => {
  const reconciled = await runTaskSpaceReconciliationCase()
  assert.equal(reconciled.error, undefined)
  assert.equal(reconciled.result.deliveryState, "absent")
  assert.equal(reconciled.result.taskSpaceId, 11)
  assert.match(reconciled.taskSpaceRequests[0], /^ego-chat-bound-[a-f0-9]{16}$/)
  assert.equal(reconciled.taskSpaceRequests.length, 1)
  assert.deepEqual(reconciled.counters, {
    click: 0,
    fillInput: 0,
    pressKey: 0,
    typeText: 0,
  })
})

test("bound recovery ignores a recycled agent-owned numeric task space", async () => {
  const reconciled = await runTaskSpaceReconciliationCase({
    requestedTaskSpaceOwnership: "agent",
  })
  assert.equal(reconciled.error, undefined)
  assert.equal(reconciled.result.deliveryState, "absent")
  assert.equal(reconciled.result.taskSpaceId, 11)
  assert.match(reconciled.taskSpaceRequests[0], /^ego-chat-bound-[a-f0-9]{16}$/)
  assert.equal(reconciled.taskSpaceRequests.length, 1)
})

test("bound recovery stops instead of bypassing a user-controlled stale task space", async () => {
  const reconciled = await runTaskSpaceReconciliationCase({
    requestedTaskSpaceOwnership: "user",
  })
  assert.equal(reconciled.result, undefined)
  assert.equal(reconciled.error?.code, "human_required")
  assert.equal(reconciled.error?.details?.reason, "browser_control_unavailable")
  assert.deepEqual(reconciled.taskSpaceRequests, [])
})

test("bound recovery stops instead of bypassing a user-controlled deterministic task space", async () => {
  const reconciled = await runTaskSpaceReconciliationCase({
    fallbackTaskSpaceOwnership: "agentDelegatedToUser",
  })
  assert.equal(reconciled.result, undefined)
  assert.equal(reconciled.error?.code, "human_required")
  assert.equal(reconciled.error?.details?.reason, "browser_control_unavailable")
  assert.deepEqual(reconciled.taskSpaceRequests, [])
})

test("conversation adoption fails closed when another message interleaves", async () => {
  const adopted = await runAdoptionDriverCase({ interleave: true })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "adoption_tail_interleaved")
  assert.deepEqual(adopted.counters, {
    click: 0,
    fillInput: 0,
    pressKey: 0,
    sendClick: 0,
    typeText: 0,
    waits: 1,
  })
})

test("conversation adoption rejects a response when the live policy is below maximum", async () => {
  const adopted = await runAdoptionDriverCase({ policyInitiallyMaximum: false })
  assert.equal(adopted.result, undefined)
  assert.equal(adopted.error?.code, "human_required")
  assert.equal(adopted.error?.details?.reason, "adoption_live_model_not_maximum")
  assert.equal(adopted.error?.details?.evidence?.powerLevel, 4)
  assert.equal(adopted.error?.details?.evidence?.powerMax, 5)
  assert.equal(adopted.counters.sendClick, 0)
  assert.equal(adopted.counters.fillInput, 0)
  assert.equal(adopted.counters.pressKey, 0)
  assert.equal(adopted.counters.typeText, 0)
})
