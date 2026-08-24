import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import test from "node:test"

import { decodeDriverResult } from "../src/ego-adapter.mjs"
import { EGO_DRIVER_RESULT_PREFIX, EGO_DRIVER_SOURCE } from "../src/ego-driver-source.mjs"

function envelope(value) {
  return `${EGO_DRIVER_RESULT_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}\n`
}

let driverCase = 0

async function runMalformedModelPolicyCase(attributes) {
  driverCase += 1
  const driverUid = `ego-chat-test-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const input = {
    binding: {
      startUrl: "https://chatgpt.com/",
      state: "unbound",
      targetId: "policy-tab",
      taskSpaceId: 10,
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

async function runAdoptionDriverCase({
  interleave = false,
  initiallyGenerating = true,
  policyInitiallyMaximum = true,
} = {}) {
  driverCase += 1
  const driverUid = `ego-chat-adopt-${process.pid}-${driverCase}`
  const mailboxDirectory = `/tmp/egc-driver-${driverUid}`
  const canonicalUrl = "https://chatgpt.com/c/adoption-driver-test"
  const input = {
    bindingKey: "adoption-driver-test",
    canonicalUrl,
    mode: "adopt",
    modelPolicy: {
      enforcement: "repair_then_verify",
      key: "chatgpt-web-default",
      modelSelection: "strongest_available",
      thinkingEffort: "maximum_available",
    },
    taskSpace: 10,
    timeoutMs: 30_000,
  }
  await fs.mkdir(mailboxDirectory, { mode: 0o700, recursive: true })
  await fs.writeFile(`${mailboxDirectory}/input.json`, JSON.stringify(input), { mode: 0o600 })

  const harness = `
process.getuid = () => ${JSON.stringify(driverUid)}
let generating = ${JSON.stringify(initiallyGenerating)}
let waits = 0
let policyMenuOpen = false
let policyCurrent = ${JSON.stringify(policyInitiallyMaximum ? 4 : 3)}
const counters = { click: 0, fillInput: 0, pressKey: 0, sendClick: 0, typeText: 0 }
const canonicalUrl = ${JSON.stringify(canonicalUrl)}
const messages = () => {
  const values = [
    { messageId: 'adopt-user-1', role: 'user', text: 'Please perform a long review.' },
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
globalThis.useOrCreateTaskSpace = async () => ({ id: 10 })
globalThis.listTabs = async () => [{ active: true, targetId: 'adopt-tab' }]
globalThis.switchTab = async () => {}
globalThis.openOrReuseTab = async () => ({ active: true, targetId: 'adopt-tab' })
globalThis.pageInfo = async () => ({ url: canonicalUrl })
globalThis.snapshotText = async () => ''
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
    return { draft: '', hasComposer: true, hasLoginAction: false }
  }
  if (source.includes("return [...document.querySelectorAll('[data-message-author-role]')].map")) {
    return messages()
  }
  if (source.includes('aria-valuemin')) {
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
    assert.ok(countersLine)
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
  assert.match(EGO_DRIVER_SOURCE, /const candidates = await js\(String\.raw`/)
  assert.match(EGO_DRIVER_SOURCE, /blockChildren\.every\(\(child\) => child\.tagName === 'P'\)/)
  assert.match(EGO_DRIVER_SOURCE, /map\(\(child\) => String\(child\.textContent \|\| ''\)\)\.join\('\\n'\)/)
  assert.match(EGO_DRIVER_SOURCE, /fingerprintVersion: "tail-v1"/)
  assert.match(EGO_DRIVER_SOURCE, /expectedPreviousMessageId/)
  assert.match(EGO_DRIVER_SOURCE, /Input\.dispatchMouseEvent/)
  assert.match(EGO_DRIVER_SOURCE, /buttons\[0\]\.contains\(hit\)/)
  assert.match(EGO_DRIVER_SOURCE, /renderedMarkerCount/)
  assert.match(EGO_DRIVER_SOURCE, /responseEndsWithTerminal/)
  assert.match(EGO_DRIVER_SOURCE, /userMarkerCount/)
  assert.match(EGO_DRIVER_SOURCE, /model_policy_mismatch/)
  assert.match(EGO_DRIVER_SOURCE, /adoption_anchor_changed/)
  assert.match(EGO_DRIVER_SOURCE, /adoption_tail_interleaved/)
  assert.match(EGO_DRIVER_SOURCE, /adoptedWhileGenerating/)
  assert.match(EGO_DRIVER_SOURCE, /!dom\.hasComposer/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /'value' in composer/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /document\.body\.innerText\.split/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /await click\("button\[data-testid=/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& committed\[0\]\?\.contentDigest === sha256\(input\.prompt\)/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& prompt\?\.contentDigest === input\.inputDigest/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /finishedHead\.messageCount !== beforeHead\.messageCount/)
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

test("conversation adoption waits for a stable assistant tail without composing or sending", async () => {
  const adopted = await runAdoptionDriverCase()
  assert.equal(adopted.error, undefined)
  assert.equal(adopted.result.adoptedWhileGenerating, true)
  assert.equal(adopted.result.anchor.messageId, "adopt-user-1")
  assert.equal(adopted.result.head.lastMessageId, "adopt-assistant-1")
  assert.equal(adopted.result.responseText, "The stable long review is complete.")
  assert.deepEqual(adopted.counters, {
    click: 2,
    fillInput: 0,
    pressKey: 0,
    sendClick: 0,
    typeText: 0,
    waits: 4,
  })
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
