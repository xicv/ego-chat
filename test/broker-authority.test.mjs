import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { acquireBrokerLease } from "../src/broker-lease.mjs"
import { loadConfig } from "../src/config.mjs"
import { IPC_VERSION, RUNTIME_IDENTITY } from "../src/constants.mjs"
import { requestBroker } from "../src/ipc-client.mjs"
import { startIpcServer, startIpcServers } from "../src/ipc-server.mjs"

function rawRequest(socketPath, token, method, runtime = undefined) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: randomUUID(),
        method,
        params: {},
        ...(runtime ? { runtime } : {}),
        token,
        version: IPC_VERSION,
      })}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline !== -1) {
        socket.destroy()
        resolve(JSON.parse(buffer.slice(0, newline)))
      }
    })
    socket.on("error", reject)
  })
}

test("one canonical data directory has one authoritative broker generation", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-lease-test-"))
  const dataDir = path.join(parent, "real-data")
  await fs.mkdir(dataDir, { mode: 0o700 })
  const alias = path.join(parent, "data-alias")
  await fs.symlink(dataDir, alias, "dir")
  t.after(() => fs.rm(parent, { force: true, recursive: true }))
  const socketPath = path.join(os.tmpdir(), `egc-lease-${process.pid}.sock`)
  const directConfig = loadConfig({ dataDir, socketPath })
  const aliasConfig = loadConfig({ dataDir: alias, socketPath })
  assert.equal(aliasConfig.dataDir, directConfig.dataDir)
  assert.equal(aliasConfig.brokerKey, directConfig.brokerKey)
  const first = await acquireBrokerLease({
    dataDir: directConfig.dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })

  await assert.rejects(
    acquireBrokerLease({
      dataDir: aliasConfig.dataDir,
      runtimeIdentity: RUNTIME_IDENTITY,
      socketPath,
    }),
    (error) => error.code === "broker_already_running"
      && error.details.brokerId === first.identity.brokerId
      && error.details.epoch === 1,
  )

  const owner = JSON.parse(await fs.readFile(first.ownerPath, "utf8"))
  assert.equal(owner.brokerId, first.identity.brokerId)
  assert.equal(owner.epoch, 1)
  await first.release()

  const second = await acquireBrokerLease({
    dataDir: aliasConfig.dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })
  assert.equal(second.identity.epoch, 2)
  assert.notEqual(second.identity.brokerId, first.identity.brokerId)
  await second.release()
})

test("a complete claiming record cannot be stolen while its live owner is paused", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-paused-claim-test-"))
  await fs.chmod(dataDir, 0o700)
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const socketPath = path.join(os.tmpdir(), `egc-paused-${process.pid}.sock`)
  let continueClaim
  let claimPublished
  let claimingIdentity
  const published = new Promise((resolve) => {
    claimPublished = resolve
  })
  const held = new Promise((resolve) => {
    continueClaim = resolve
  })
  const firstLease = acquireBrokerLease({
    afterClaim: async (identity) => {
      claimingIdentity = identity
      claimPublished()
      await held
    },
    dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })
  await published
  await new Promise((resolve) => setTimeout(resolve, 2_100))

  await assert.rejects(
    acquireBrokerLease({ dataDir, runtimeIdentity: RUNTIME_IDENTITY, socketPath }),
    (error) => error.code === "broker_already_running"
      && error.details.brokerId === claimingIdentity.brokerId
      && error.details.epoch === 0
      && error.details.livePids.includes(process.pid),
  )

  continueClaim()
  const acquired = await firstLease
  assert.equal(acquired.identity.epoch, 1)
  assert.equal(acquired.identity.brokerId, claimingIdentity.brokerId)
  await acquired.release()
})

test("a live click-capable browser child prevents generation takeover", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-child-lease-test-"))
  await fs.chmod(dataDir, 0o700)
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const socketPath = path.join(os.tmpdir(), `egc-child-${process.pid}.sock`)
  const lease = await acquireBrokerLease({
    dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })
  await lease.registerChild(process.pid)
  const owner = JSON.parse(await fs.readFile(lease.ownerPath, "utf8"))
  assert.deepEqual(owner.browserPids, [process.pid])
  assert.deepEqual((await lease.inspect()).browserPids, [process.pid])
  await fs.writeFile(lease.ownerPath, `${JSON.stringify({
    ...owner,
    pid: Number.MAX_SAFE_INTEGER,
  })}\n`, { mode: 0o600 })

  await assert.rejects(
    acquireBrokerLease({ dataDir, runtimeIdentity: RUNTIME_IDENTITY, socketPath }),
    (error) => error.code === "broker_already_running"
      && error.details.livePids.includes(process.pid)
      && error.details.browserPids.includes(process.pid),
  )
})

test("lease release stays fenced while a child is paused across either Send mouse event", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group fencing is exercised on supported host platforms")
    return
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-release-race-test-"))
  await fs.chmod(parent, 0o700)
  t.after(() => fs.rm(parent, { force: true, recursive: true }))

  for (const phase of ["after-final-fence", "between-mouse-events"]) {
    const dataDir = path.join(parent, phase)
    await fs.mkdir(dataDir, { mode: 0o700 })
    const socketPath = path.join(os.tmpdir(), `egc-release-${phase}-${process.pid}.sock`)
    const lease = await acquireBrokerLease({
      dataDir,
      runtimeIdentity: RUNTIME_IDENTITY,
      socketPath,
    })
    const child = spawn(process.execPath, [
      "-e",
      "const phase = process.argv[1]; console.log(phase === 'after-final-fence' ? 'finalFencePassed' : 'mousePressed'); process.stdin.setEncoding('utf8'); process.stdin.once('data', () => { if (phase === 'between-mouse-events') console.log('mouseReleased'); console.log('send'); process.exit(0) })",
      phase,
    ], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    })
    assert.ok(Number.isSafeInteger(child.pid))
    await lease.registerChild(child.pid, { processGroup: true })
    const [initialOutput] = await once(child.stdout, "data")
    const observedEvents = String(initialOutput).trim().split("\n").filter(Boolean)

    const releaseAttempt = lease.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assert.rejects(
      acquireBrokerLease({ dataDir, runtimeIdentity: RUNTIME_IDENTITY, socketPath }),
      (error) => error.code === "broker_already_running"
        && error.details.liveProcessGroups.includes(child.pid),
      phase,
    )
    await assert.rejects(
      releaseAttempt,
      (error) => error.code === "broker_children_active"
        && error.details.browserProcessGroups.includes(child.pid),
      phase,
    )

    child.stdout.on("data", (chunk) => {
      observedEvents.push(...String(chunk).trim().split("\n").filter(Boolean))
    })
    child.stdin.end("continue\n")
    await once(child, "close")
    assert.equal(observedEvents.filter((event) => event === "send").length, 1, phase)
    assert.equal(observedEvents.includes("finalFencePassed"), phase === "after-final-fence", phase)
    assert.equal(observedEvents.includes("mousePressed"), phase === "between-mouse-events", phase)
    assert.equal(observedEvents.includes("mouseReleased"), phase === "between-mouse-events", phase)
    await lease.unregisterChild(child.pid)
    await lease.release()
    const replacement = await acquireBrokerLease({
      dataDir,
      runtimeIdentity: RUNTIME_IDENTITY,
      socketPath,
    })
    assert.equal(replacement.identity.epoch, 2)
    await replacement.release()
  }
})

test("a surviving descendant keeps its registered browser process group fenced", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group fencing is exercised on supported host platforms")
    return
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-descendant-fence-test-"))
  await fs.chmod(dataDir, 0o700)
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  const socketPath = path.join(os.tmpdir(), `egc-descendant-${process.pid}.sock`)
  const lease = await acquireBrokerLease({
    dataDir,
    runtimeIdentity: RUNTIME_IDENTITY,
    socketPath,
  })
  const leader = spawn(process.execPath, [
    "-e",
    "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(child.pid); setTimeout(() => process.exit(0), 100)",
  ], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  })
  assert.ok(Number.isSafeInteger(leader.pid))
  await lease.registerChild(leader.pid, { processGroup: true })
  const [output] = await once(leader.stdout, "data")
  const descendantPid = Number(String(output).trim())
  assert.ok(Number.isSafeInteger(descendantPid))
  await once(leader, "close")
  const owner = JSON.parse(await fs.readFile(lease.ownerPath, "utf8"))
  await fs.writeFile(lease.ownerPath, `${JSON.stringify({
    ...owner,
    pid: Number.MAX_SAFE_INTEGER,
  })}\n`, { mode: 0o600 })

  await assert.rejects(
    acquireBrokerLease({ dataDir, runtimeIdentity: RUNTIME_IDENTITY, socketPath }),
    (error) => error.code === "broker_already_running"
      && error.details.livePids.length === 0
      && error.details.liveProcessGroups.includes(leader.pid),
  )

  process.kill(-leader.pid, "SIGTERM")
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(descendantPid, 0)
    } catch (error) {
      if (error.code === "ESRCH") {
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await fs.writeFile(lease.ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 })
  await lease.unregisterChild(leader.pid)
  await lease.release()
})

test("a stale facade may inspect the broker but cannot mutate durable state", async (t) => {
  const socketPath = path.join(os.tmpdir(), `egc-runtime-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
  const token = randomUUID().replaceAll("-", "").repeat(2)
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-legacy-client-test-"))
  await fs.chmod(dataDir, 0o700)
  await fs.writeFile(path.join(dataDir, "broker-token"), `${token}\n`, { mode: 0o600 })
  t.after(() => fs.rm(dataDir, { force: true, recursive: true }))
  let mutations = 0
  const ipc = await startIpcServer({
    dispatch: async (method) => {
      if (method !== "ping") {
        mutations += 1
      }
      return { method }
    },
    socketPath,
    token,
  })
  t.after(() => ipc.close())

  const inspected = await rawRequest(socketPath, token, "ping")
  assert.equal(inspected.ok, true)
  const rejected = await rawRequest(socketPath, token, "workflow.start_probe")
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, "restart_required")
  assert.equal(mutations, 0)

  const accepted = await rawRequest(socketPath, token, "workflow.start_probe", RUNTIME_IDENTITY)
  assert.equal(accepted.ok, true)
  assert.equal(mutations, 1)

  await assert.rejects(
    requestBroker({
      dataDir,
      legacySocketPaths: [socketPath],
      socketPath,
    }, "workflow.start_probe", {}, { autostart: false }),
    (error) => error.code === "restart_required",
  )
  assert.equal(mutations, 1)
})

test("the canonical broker reserves legacy sockets against a late stale daemon", async (t) => {
  const privateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ego-chat-ipc-generation-test-"))
  await fs.chmod(privateDirectory, 0o700)
  const canonicalSocketPath = path.join(privateDirectory, "broker.sock")
  const legacySocketPath = path.join("/tmp", `egc-generation-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
  const token = randomUUID().replaceAll("-", "").repeat(2)
  let mutations = 0
  const ipc = await startIpcServers({
    dispatch: async (method) => {
      if (method !== "ping") {
        mutations += 1
      }
      return method === "ping" ? { runtimeIdentity: RUNTIME_IDENTITY } : { method }
    },
    socketPaths: [legacySocketPath, canonicalSocketPath],
    stickySocketPaths: [legacySocketPath],
    token,
  })
  t.after(async () => {
    await ipc.close()
    await fs.rm(privateDirectory, { force: false, recursive: true })
  })

  const inspected = await rawRequest(legacySocketPath, token, "ping")
  assert.equal(inspected.ok, true)
  const rejected = await rawRequest(legacySocketPath, token, "workflow.start_probe")
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, "restart_required")
  assert.equal(mutations, 0)

  await assert.rejects(
    startIpcServer({
      allowStickyDirectory: true,
      dispatch: async () => ({}),
      socketPath: legacySocketPath,
      token,
    }),
    (error) => error.code === "already_running",
  )
})
