import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { runEagleMonitorCli } from "../src/eagle-monitor-cli.mjs"
import { loadEagleMonitorConfig } from "../src/eagle-monitor-config.mjs"
import { EagleMonitorLifecycle, generateLaunchAgent } from "../src/eagle-monitor-lifecycle.mjs"
import { EagleMonitorStore } from "../src/eagle-monitor-store.mjs"
import { EgoChatError } from "../src/errors.mjs"

const WORKFLOW_ID = "00000000-0000-4000-8000-000000000001"

async function fixture(t, { initiallyLoaded = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-lifecycle-"))
  const brokerData = path.join(root, "broker")
  const launchAgents = path.join(root, "LaunchAgents")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const calls = []
  let loaded = initiallyLoaded
  const runner = async (executable, args) => {
    calls.push([executable, ...args])
    if (args[0] === "print") return { code: loaded ? 0 : 113, stderr: "", stdout: "" }
    if (args[0] === "bootstrap") {
      loaded = true
      return { code: 0, stderr: "", stdout: "" }
    }
    if (args[0] === "bootout") {
      loaded = false
      return { code: 0, stderr: "", stdout: "" }
    }
    throw new Error(`Unexpected fake launchctl call ${args.join(" ")}`)
  }
  const config = loadEagleMonitorConfig({
    brokerConfig: {
      dataDir: brokerData,
      egoBrowserCommand: process.execPath,
      socketPath: path.join(os.tmpdir(), `egc-eagle-${process.pid}.sock`),
    },
    commands: {
      caffeinate: process.execPath,
      launchctl: process.execPath,
      osascript: process.execPath,
      pmset: process.execPath,
    },
    dataDir: path.join(brokerData, "eagle-monitor"),
    launchAgentsDir: launchAgents,
    platform: "darwin",
  })
  return { calls, config, lifecycle: new EagleMonitorLifecycle(config, { runner }) }
}

test("configuration rejects root instead of creating a privileged monitor scope", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-root-scope-"))
  const brokerData = path.join(root, "broker")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))

  assert.throws(
    () => loadEagleMonitorConfig({
      brokerConfig: {
        dataDir: brokerData,
        egoBrowserCommand: process.execPath,
        socketPath: path.join(os.tmpdir(), `egc-eagle-root-${process.pid}.sock`),
      },
      dataDir: path.join(brokerData, "eagle-monitor"),
      launchAgentsDir: path.join(root, "LaunchAgents"),
      platform: "darwin",
      uid: 0,
    }),
    (error) => error.code === "privileged_monitor_forbidden",
  )
})

test("non-start commands can load configuration when Ego Browser is unavailable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "eagle-monitor-missing-browser-"))
  const brokerData = path.join(root, "broker")
  const missingBrowser = path.join(root, "missing-ego-browser")
  await fs.mkdir(brokerData, { mode: 0o700 })
  t.after(() => fs.rm(root, { force: true, recursive: true }))
  const overrides = {
    brokerConfig: {
      dataDir: brokerData,
      egoBrowserCommand: missingBrowser,
      socketPath: path.join(os.tmpdir(), `egc-eagle-missing-${process.pid}.sock`),
    },
    dataDir: path.join(brokerData, "eagle-monitor"),
    launchAgentsDir: path.join(root, "LaunchAgents"),
    platform: "darwin",
  }

  assert.throws(
    () => loadEagleMonitorConfig(overrides),
    (error) => error.code === "monitor_dependency_unavailable",
  )
  const config = loadEagleMonitorConfig({ ...overrides, requireEgoBrowser: false })
  assert.equal(config.brokerConfig.egoBrowserCommand, await fs.realpath(root).then((realRoot) => (
    path.join(realRoot, "missing-ego-browser")
  )))

  const outputs = []
  const exit = await runEagleMonitorCli({
    argv: ["stop", "--json"],
    lifecycle: { stop: async () => ({ changed: false, loaded: false }) },
    observeMonitor: async () => ({ active: false, epoch: null }),
    resolveConfig: (options) => {
      assert.deepEqual(options, { requireEgoBrowser: false })
      return config
    },
    store: {
      readSession: async () => null,
      stopSession: async () => null,
    },
    write: (value) => outputs.push(value),
  })
  assert.equal(exit, 0)
  assert.equal(outputs.at(-1).ok, true)
})

test("LaunchAgent start and stop are idempotent and target only the current GUI user", async (t) => {
  const { calls, config, lifecycle } = await fixture(t)
  const definition = generateLaunchAgent(config)
  const first = await lifecycle.start(definition)
  const second = await lifecycle.start(definition, definition.digest)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
  assert.equal(calls.filter((call) => call[1] === "bootstrap").length, 1)
  assert.deepEqual(calls.find((call) => call[1] === "bootstrap").slice(1, 3), [
    "bootstrap",
    `gui/${config.uid}`,
  ])

  const plist = await fs.readFile(config.paths.launchAgent, "utf8")
  for (const absolute of [
    config.executablePath,
    config.daemonPath,
    config.dataDir,
    config.brokerConfig.dataDir,
    config.brokerConfig.egoBrowserCommand,
    config.brokerConfig.socketPath,
    "/dev/null",
  ]) {
    assert.match(plist, new RegExp(absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  assert.match(plist, /<key>Umask<\/key>\s*<string>077<\/string>/)
  assert.match(plist, /<string>--ego-browser<\/string>/)
  assert.equal((await fs.stat(config.paths.launchAgent)).mode & 0o777, 0o600)
  assert.doesNotMatch(plist, /system\//)
  assert.doesNotMatch(plist, /sudo|LaunchDaemon/)
  assert.doesNotMatch(plist, /daemon\.(stdout|stderr)\.log/)

  const stopped = await lifecycle.stop(definition.digest)
  const stoppedAgain = await lifecycle.stop(definition.digest)
  assert.equal(stopped.changed, true)
  assert.equal(stoppedAgain.changed, false)
  assert.equal(calls.filter((call) => call[1] === "bootout").length, 1)
  assert.deepEqual(calls.find((call) => call[1] === "bootout").slice(1), [
    "bootout",
    config.serviceTarget,
  ])
})

test("lifecycle preserves definitions or loaded services without private ownership proof", async (t) => {
  const first = await fixture(t)
  await fs.mkdir(path.dirname(first.config.paths.launchAgent), { mode: 0o700, recursive: true })
  await fs.writeFile(first.config.paths.launchAgent, "foreign definition\n", { mode: 0o600 })
  await assert.rejects(
    first.lifecycle.start(generateLaunchAgent(first.config)),
    (error) => error.code === "monitor_definition_conflict",
  )
  assert.equal(await fs.readFile(first.config.paths.launchAgent, "utf8"), "foreign definition\n")
  assert.equal(first.calls.some((call) => call[1] === "bootstrap"), false)

  const matching = await fixture(t)
  const matchingDefinition = generateLaunchAgent(matching.config)
  await fs.mkdir(path.dirname(matching.config.paths.launchAgent), { mode: 0o700, recursive: true })
  await fs.writeFile(
    matching.config.paths.launchAgent,
    matchingDefinition.contents,
    { mode: 0o600 },
  )
  await assert.rejects(
    matching.lifecycle.start(matchingDefinition),
    (error) => error.code === "monitor_definition_conflict",
  )
  assert.equal(matching.calls.some((call) => call[1] === "bootstrap"), false)

  const second = await fixture(t, { initiallyLoaded: true })
  await assert.rejects(
    second.lifecycle.stop(null),
    (error) => error.code === "unowned_launchagent_service",
  )
  assert.equal(second.calls.some((call) => call[1] === "bootout"), false)

  const missingDefinition = await fixture(t, { initiallyLoaded: true })
  await assert.rejects(
    missingDefinition.lifecycle.stop("a".repeat(64)),
    (error) => error.code === "unowned_launchagent_service",
  )
  assert.equal(missingDefinition.calls.some((call) => call[1] === "bootout"), false)
})

test("a failed bootstrap removes the newly written owned definition", async (t) => {
  const { config } = await fixture(t)
  const lifecycle = new EagleMonitorLifecycle(config, {
    runner: async (_executable, args) => ({
      code: args[0] === "bootstrap" ? 5 : 113,
      stderr: "",
      stdout: "",
    }),
  })

  await assert.rejects(
    lifecycle.start(generateLaunchAgent(config)),
    (error) => error.code === "launchagent_start_failed",
  )
  await assert.rejects(
    fs.stat(config.paths.launchAgent),
    (error) => error.code === "ENOENT",
  )
})

test("an unexpected launchctl status failure stops before lifecycle mutation", async (t) => {
  const { calls, config } = await fixture(t)
  const lifecycle = new EagleMonitorLifecycle(config, {
    runner: async (executable, args) => {
      calls.push([executable, ...args])
      return { code: 1, stderr: "untrusted detail", stdout: "" }
    },
  })

  await assert.rejects(
    lifecycle.start(generateLaunchAgent(config)),
    (error) => error.code === "launchagent_status_failed",
  )
  assert.deepEqual(calls.map((call) => call[1]), ["print"])
  await assert.rejects(fs.lstat(config.paths.launchAgent), { code: "ENOENT" })
})

test("a final status failure after bootstrap rolls back the service and definition", async (t) => {
  const { calls, config } = await fixture(t)
  let prints = 0
  const lifecycle = new EagleMonitorLifecycle(config, {
    runner: async (executable, args) => {
      calls.push([executable, ...args])
      if (args[0] === "print") {
        prints += 1
        return { code: prints === 1 ? 113 : 1, stderr: "", stdout: "" }
      }
      return { code: 0, stderr: "", stdout: "" }
    },
  })

  await assert.rejects(
    lifecycle.start(generateLaunchAgent(config)),
    (error) => error.code === "launchagent_status_failed",
  )
  assert.deepEqual(calls.map((call) => call[1]), ["print", "bootstrap", "print", "bootout"])
  await assert.rejects(fs.lstat(config.paths.launchAgent), { code: "ENOENT" })
})

test("a successful bootstrap that does not stay loaded fails and removes its definition", async (t) => {
  const { calls, config } = await fixture(t)
  const lifecycle = new EagleMonitorLifecycle(config, {
    runner: async (executable, args) => {
      calls.push([executable, ...args])
      return { code: args[0] === "bootstrap" ? 0 : 113, stderr: "", stdout: "" }
    },
  })

  await assert.rejects(
    lifecycle.start(generateLaunchAgent(config)),
    (error) => error.code === "launchagent_start_failed",
  )
  assert.deepEqual(calls.map((call) => call[1]), ["print", "bootstrap", "print", "bootout"])
  await assert.rejects(fs.lstat(config.paths.launchAgent), { code: "ENOENT" })
})

test("a failed start restores the prior private session transactionally", async (t) => {
  const { config } = await fixture(t)
  const store = new EagleMonitorStore(config)
  const outputs = []
  const lifecycle = {
    start: async () => {
      const error = new Error("injected lifecycle failure")
      error.code = "launchagent_start_failed"
      throw error
    },
  }
  const exit = await runEagleMonitorCli({
    argv: ["start", "--workflow", WORKFLOW_ID, "--json"],
    config,
    lifecycle,
    now: () => "2026-09-04T00:00:00.000Z",
    store,
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 70)
  assert.equal(outputs.at(-1).error.code, "launchagent_start_failed")
  assert.equal(await store.readSession(), null)
})

test("an active session preserves its owned definition digest across runtime drift", async (t) => {
  const { config } = await fixture(t)
  const store = new EagleMonitorStore(config)
  const previousDigest = "a".repeat(64)
  await store.configureSession({
    bindingKey: null,
    launchAgentDigest: previousDigest,
    mode: "shadow",
    now: "2026-09-04T00:00:00.000Z",
    powerPolicy: "allow-sleep",
    workflowId: WORKFLOW_ID,
  })
  let lifecycleStarts = 0
  const outputs = []

  const exit = await runEagleMonitorCli({
    argv: ["start", "--workflow", WORKFLOW_ID, "--json"],
    config,
    lifecycle: { start: async () => { lifecycleStarts += 1 } },
    observeMonitor: async () => ({ active: true, epoch: 3 }),
    store,
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 2)
  assert.equal(outputs.at(-1).error.code, "monitor_already_configured")
  assert.equal(lifecycleStarts, 0)
  assert.equal((await store.readSession()).launchAgentDigest, previousDigest)
})

test("start rejects corrupt existing state before lifecycle mutation", async (t) => {
  const { config } = await fixture(t)
  const store = new EagleMonitorStore(config)
  await store.initialize()
  await fs.writeFile(config.paths.state, "{not-json\n", { mode: 0o600 })
  let lifecycleStarts = 0
  const outputs = []

  const exit = await runEagleMonitorCli({
    argv: ["start", "--workflow", WORKFLOW_ID, "--json"],
    config,
    lifecycle: { start: async () => { lifecycleStarts += 1 } },
    store,
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 2)
  assert.equal(outputs.at(-1).error.code, "corrupt_monitor_state")
  assert.equal(lifecycleStarts, 0)
  assert.equal(await store.readSession(), null)
})

test("start rejects a corrupt monitor epoch before lifecycle mutation", async (t) => {
  const { config } = await fixture(t)
  const store = new EagleMonitorStore(config)
  await store.initialize()
  await fs.writeFile(config.paths.epoch, `${JSON.stringify({ epoch: "invalid" })}\n`, {
    mode: 0o600,
  })
  let lifecycleStarts = 0
  const outputs = []

  const exit = await runEagleMonitorCli({
    argv: ["start", "--workflow", WORKFLOW_ID, "--json"],
    config,
    lifecycle: { start: async () => { lifecycleStarts += 1 } },
    store,
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 2)
  assert.equal(outputs.at(-1).error.code, "corrupt_monitor_epoch")
  assert.equal(lifecycleStarts, 0)
  assert.equal(await store.readSession(), null)
})

test("the public CLI emits stable JSON and never registers a real LaunchAgent in tests", async (t) => {
  const { config, lifecycle } = await fixture(t)
  const store = new EagleMonitorStore(config)
  const outputs = []
  const observeMonitor = async () => {
    const session = await store.readSession()
    return { active: session?.active === true, epoch: session?.active ? 1 : null }
  }
  const run = (argv) => runEagleMonitorCli({
    argv,
    config,
    lifecycle,
    now: () => "2026-09-04T00:00:00.000Z",
    observeMonitor,
    store,
    write: (value) => outputs.push(value),
  })
  assert.equal(await run([
    "start",
    "--workflow",
    WORKFLOW_ID,
    "--binding-key",
    "ego-chat-main",
    "--mode",
    "safe",
    "--power-policy",
    "keep-awake-on-ac",
    "--json",
  ]), 0)
  assert.equal(outputs.at(-1).ok, true)
  assert.equal(outputs.at(-1).result.powerPolicy, "keep-awake-on-ac")
  assert.equal(JSON.stringify(outputs.at(-1)).includes(WORKFLOW_ID), false)

  assert.equal(await run(["status", "--json"]), 0)
  assert.equal(outputs.at(-1).result.session.workflowDigest.length, 64)
  assert.equal(outputs.at(-1).result.session.bindingDigest.length, 64)
  assert.deepEqual(outputs.at(-1).result.monitor, { active: true, epoch: 1 })
  assert.equal(outputs.at(-1).result.policyMatches, true)
  assert.equal(outputs.at(-1).result.semantic.schema, "EagleSemanticState.v1")
  assert.equal(outputs.at(-1).result.semantic.classification, "suspect")
  assert.equal(outputs.at(-1).result.semantic.reasonCode, "semantic_monitor_starting")
  assert.equal(JSON.stringify(outputs.at(-1)).includes("ego-chat-main"), false)

  assert.equal(await run(["incidents", "--limit", "10", "--json"]), 0)
  assert.deepEqual(outputs.at(-1).result.incidents, [])
  assert.equal(await run(["stop", "--json"]), 0)
  assert.equal(outputs.at(-1).result.changed, true)
  assert.equal(await run(["stop", "--json"]), 0)
  assert.equal(outputs.at(-1).result.changed, false)
  assert.equal(await run(["status", "--json"]), 3)

  assert.equal(await run(["doctor", "--json"]), 0)
  assert.equal(outputs.at(-1).result.mvpDependencies.llm, false)
  assert.equal(outputs.at(-1).result.mvpDependencies.network, false)
  assert.equal(outputs.at(-1).result.status.state, "stopped")
  assert.equal(outputs.at(-1).result.status.humanRequired.reasonCode, "monitor_not_started")
  assert.deepEqual(outputs.at(-1).result.status.monitor, { active: false, epoch: null })
  assert.equal(JSON.stringify(outputs.at(-1).result.status).includes(WORKFLOW_ID), false)
  assert.equal(JSON.stringify(outputs.at(-1).result.status).includes("ego-chat-main"), false)

  assert.equal(await run(["start", "--workflow", "not-a-uuid", "--json"]), 64)
  assert.equal(outputs.at(-1).error.code, "invalid_cli_usage")
  assert.equal(JSON.stringify(outputs.at(-1)).includes("not-a-uuid"), false)
  assert.equal(await run(["status", "--json", "--json"]), 64)
  assert.equal(outputs.at(-1).error.code, "invalid_cli_usage")

  const sensitive = new EgoChatError(
    "lower_layer_failure",
    "token=secret https://chatgpt.com/c/private",
  )
  const failingLifecycle = { status: async () => { throw sensitive } }
  assert.equal(await runEagleMonitorCli({
    argv: ["status", "--json"],
    config,
    lifecycle: failingLifecycle,
    store,
    write: (value) => outputs.push(value),
  }), 70)
  const publicError = JSON.stringify(outputs.at(-1))
  assert.equal(outputs.at(-1).error.code, "unexpected_error")
  assert.equal(publicError.includes("token=secret"), false)
  assert.equal(publicError.includes("chatgpt.com"), false)

  assert.equal(await run(["token_secret", "--json"]), 64)
  assert.equal(outputs.at(-1).command, null)
  assert.equal(JSON.stringify(outputs.at(-1)).includes("token_secret"), false)
})

test("status reports an active session without a monitor lease as degraded", async (t) => {
  const { config } = await fixture(t)
  const store = new EagleMonitorStore(config)
  await store.configureSession({
    bindingKey: "ego-chat-main",
    launchAgentDigest: "a".repeat(64),
    mode: "safe",
    now: "2026-09-04T00:00:00.000Z",
    powerPolicy: "allow-sleep",
    workflowId: WORKFLOW_ID,
  })
  const outputs = []
  const exit = await runEagleMonitorCli({
    argv: ["status", "--json"],
    config,
    lifecycle: {
      status: async () => ({
        definitionMatches: true,
        definitionPresent: true,
        domain: `gui/${config.uid}`,
        label: config.label,
        loaded: true,
      }),
    },
    observeMonitor: async () => ({ active: false, epoch: 4 }),
    store,
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 2)
  assert.deepEqual(outputs.at(-1).result.monitor, { active: false, epoch: 4 })
  assert.equal(outputs.at(-1).result.session.workflowDigest.length, 64)
})

test("status reports a shadow semantic loop as attention without taking action", async (t) => {
  const { config } = await fixture(t)
  const outputs = []
  const session = {
    active: true,
    launchAgentDigest: "a".repeat(64),
    policyDigest: config.policy.digest,
  }
  const status = {
    humanRequired: { reasonCode: "operationally_healthy", required: false },
    semantic: { classification: "looping", reasonCode: "repeated_loop_detected" },
    state: "healthy",
  }
  let writes = 0

  const exit = await runEagleMonitorCli({
    argv: ["status", "--json"],
    config,
    lifecycle: {
      status: async () => ({
        definitionMatches: true,
        definitionPresent: true,
        loaded: true,
      }),
    },
    now: () => "2026-09-04T00:00:00.000Z",
    observeMonitor: async () => ({ active: true, epoch: 4 }),
    store: {
      publicStatus: () => status,
      readSession: async () => session,
      readState: async () => ({}),
      writeState: async () => { writes += 1 },
    },
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 2)
  assert.equal(outputs.at(-1).result.semantic.classification, "looping")
  assert.equal(writes, 0)
})

test("stop leaves recovery-state mutation to the fenced daemon", async () => {
  const outputs = []
  let stateWrites = 0
  const session = {
    active: true,
    launchAgentDigest: "a".repeat(64),
  }
  const exit = await runEagleMonitorCli({
    argv: ["stop", "--json"],
    config: { policy: { digest: "b".repeat(64) } },
    lifecycle: {
      stop: async (digest) => {
        assert.equal(digest, session.launchAgentDigest)
        return { changed: true, loaded: false }
      },
    },
    now: () => "2026-09-04T00:00:00.000Z",
    store: {
      readSession: async () => session,
      readState: async () => ({ state: "healthy" }),
      stopSession: async () => ({ ...session, active: false }),
      writeState: async () => { stateWrites += 1 },
    },
    write: (value) => outputs.push(value),
  })

  assert.equal(exit, 0)
  assert.equal(outputs.at(-1).ok, true)
  assert.equal(stateWrites, 0)
})
