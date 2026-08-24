import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { decodeDriverResult } from "../src/ego-adapter.mjs"
import { EGO_DRIVER_RESULT_PREFIX, EGO_DRIVER_SOURCE } from "../src/ego-driver-source.mjs"

function envelope(value) {
  return `${EGO_DRIVER_RESULT_PREFIX}${Buffer.from(JSON.stringify(value)).toString("base64url")}\n`
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
  assert.match(EGO_DRIVER_SOURCE, /!dom\.hasComposer/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /'value' in composer/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /document\.body\.innerText\.split/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /await click\("button\[data-testid=/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& committed\[0\]\?\.contentDigest === sha256\(input\.prompt\)/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /&& prompt\?\.contentDigest === input\.inputDigest/)
  assert.doesNotMatch(EGO_DRIVER_SOURCE, /finishedHead\.messageCount !== beforeHead\.messageCount/)
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
