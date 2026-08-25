import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

import { createTestConfig, removeTestConfig } from "./helpers.mjs"
import { loadOrCreateBrokerToken } from "../src/auth-token.mjs"
import { RUNTIME_IDENTITY } from "../src/constants.mjs"
import { requestBroker, requestBrokerUpgrade } from "../src/ipc-client.mjs"
import { handoffBrokerRuntime } from "../src/runtime-handoff.mjs"

const execFileAsync = promisify(execFile)
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(TEST_DIRECTORY, "../bin/ego-chat.mjs")
const FIXTURE_PATH = path.resolve(TEST_DIRECTORY, "fixtures/fake-stale-broker.mjs")

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = ""
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      reject(new Error(`Fake stale broker exited before readiness: ${code ?? signal}\n${output}`))
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.includes("ready\n")) {
        resolve()
      }
    })
  })
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once("error", reject)
    child.once("exit", (code) => resolve(code))
  })
}

async function startFakeStaleBroker(t, config, env, mode = "idle", aliasPath = undefined) {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...env,
      ...(aliasPath ? { EGO_CHAT_FAKE_STALE_ALIAS_PATH: aliasPath } : {}),
      EGO_CHAT_FAKE_STALE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await waitForExit(child)
    }
    await removeTestConfig(config)
  })
  await waitForReady(child)
  return child
}

async function assertHandoffRefused(env, expectedCode) {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_PATH, "broker-handoff"], { env }),
    (error) => JSON.parse(error.stderr).code === expectedCode,
  )
}

async function waitForMissing(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.lstat(filePath)
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`Timed out waiting for ${filePath} to disappear`)
}

test("broker handoff gracefully stops an authenticated idle stale runtime", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env)

  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "broker-handoff"], { env })
  const result = JSON.parse(stdout)

  assert.equal(result.previousRuntime.appVersion, "0.2.0")
  assert.equal(result.status, "stopped")
  assert.equal(await waitForExit(child), 0)
  await assert.rejects(fs.lstat(path.join(config.dataDir, "broker.lock")), { code: "ENOENT" })
  await assert.rejects(fs.lstat(config.socketPath), { code: "ENOENT" })
})

test("broker handoff asks a compatible stale runtime to drain atomically", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "atomic-idle")

  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "broker-handoff"], { env })
  const result = JSON.parse(stdout)

  assert.equal(result.previousRuntime.appVersion, "0.2.0")
  assert.equal(result.status, "stopped")
  assert.equal(await waitForExit(child), 0)
})

test("the real daemon atomically accepts a future-runtime drain and exits cleanly", async (t) => {
  const { config } = await createTestConfig()
  t.after(() => removeTestConfig(config))
  const status = await requestBroker(config, "broker.status")
  const targetRuntime = {
    ...RUNTIME_IDENTITY,
    appVersion: "99.0.0",
    contractDigest: "future-runtime-contract",
    runtimeGeneration: "future-runtime-generation",
  }

  const result = await requestBrokerUpgrade(config, status.broker, targetRuntime)

  assert.equal(result.status, "accepted")
  assert.deepEqual(result.targetRuntime, targetRuntime)
  await waitForMissing(path.join(config.dataDir, "broker.lock"))
  await waitForMissing(config.socketPath)
})

test("legacy broker handoff restores its socket when work starts after the idle snapshot", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "legacy-admission-race")

  await assertHandoffRefused(env, "upgrade_blocked_active_work")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(config.socketPath)).isSocket(), true)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("legacy handoff fences and restores every socket alias for one broker", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const aliasPath = path.join(
    path.dirname(config.socketPath),
    `egc-alias-${process.pid}-${Date.now()}.sock`,
  )
  const child = await startFakeStaleBroker(
    t,
    config,
    env,
    "legacy-admission-race",
    aliasPath,
  )

  await assert.rejects(
    handoffBrokerRuntime({ ...config, legacySocketPaths: [aliasPath] }),
    (error) => error.code === "upgrade_blocked_active_work",
  )

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(config.socketPath)).isSocket(), true)
  assert.equal((await fs.lstat(aliasPath)).isSocket(), true)
})

test("broker handoff leaves a stale runtime with active work untouched", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "active")

  await assertHandoffRefused(env, "upgrade_blocked_active_work")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("broker runtime status reports a live stale runtime without stopping it", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env)

  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "broker-runtime-status"], { env })
  const result = JSON.parse(stdout)

  assert.equal(result.runtime.appVersion, "0.2.0")
  assert.equal(result.status, "stale")
  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("broker handoff leaves a stale runtime with a browser child untouched", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "browser")

  await assertHandoffRefused(env, "upgrade_blocked_browser_child")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("broker handoff refuses unknown stale-runtime mailbox evidence", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "mailbox-unknown")

  await assertHandoffRefused(env, "invalid_broker_status")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("broker handoff refuses an unknown browser-child ledger", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "browser-ledger-unknown")

  await assertHandoffRefused(env, "unsafe_broker_lease")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})

test("broker handoff refuses an identity change without signalling either runtime", async (t) => {
  const { config, env } = await createTestConfig()
  await loadOrCreateBrokerToken(config.dataDir)
  const child = await startFakeStaleBroker(t, config, env, "identity-race")

  await assertHandoffRefused(env, "broker_handoff_identity_changed")

  assert.equal(child.exitCode, null)
  assert.equal((await fs.lstat(path.join(config.dataDir, "broker.lock"))).isFile(), true)
})
