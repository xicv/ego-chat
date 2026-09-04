import { execFile, spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function execBounded(executable, args, timeout = 5_000) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout,
    })
    return { code: 0, stdout: result.stdout }
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
    }
  }
}

export function createMonitorClock() {
  return {
    monotonicMs: () => performance.now(),
    wallMs: () => Date.now(),
  }
}

export function createStorageObserver(config, { minimumAvailableBytes = 64 * 1024 * 1024 } = {}) {
  return {
    observe: async () => {
      try {
        await fs.access(config.dataDir, fsConstants.W_OK)
        const stats = await fs.statfs(config.dataDir)
        const availableBytes = Number(stats.bavail) * Number(stats.bsize)
        return {
          spaceAvailable: Number.isFinite(availableBytes)
            && availableBytes >= minimumAvailableBytes,
          writable: true,
        }
      } catch (_error) {
        return { spaceAvailable: false, writable: false }
      }
    },
  }
}

export function createPowerController(config, {
  runCommand = execBounded,
  spawnPowerObserver = spawn,
  spawnProcess = spawn,
} = {}) {
  let assertion = null
  let observer = null
  let observerBuffer = ""
  let pendingSleep = false
  let pendingWake = false

  const closeObserver = () => {
    const previous = observer
    observer = null
    observerBuffer = ""
    if (previous && previous.exitCode === null) previous.kill("SIGTERM")
  }

  const ensureObserver = () => {
    if (observer && observer.exitCode === null) return
    let child
    try {
      child = spawnPowerObserver(
        config.commands.pmset,
        ["-g", "uuidlog"],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
    } catch (_error) {
      return
    }
    observer = child
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      const lines = `${observerBuffer}${chunk}`.split("\n")
      observerBuffer = lines.pop().slice(-4_096)
      for (const line of lines) {
        if (/IORegisterForSystemPower:\s*\.\.\.Sleeping\.\.\./.test(line)) {
          pendingSleep = true
        }
        if (/IORegisterForSystemPower:\s*\.\.\.HasPoweredOn\.\.\./.test(line)) {
          pendingWake = true
        }
      }
    })
    const forget = () => {
      if (observer === child) observer = null
    }
    child.once("error", forget)
    child.once("exit", forget)
  }

  return {
    observe: async () => {
      ensureObserver()
      const result = await runCommand(config.commands.pmset, ["-g", "ps"])
      const sleepDetected = pendingSleep
      const wakeDetected = pendingWake
      pendingSleep = false
      pendingWake = false
      return {
        onAc: result.code === 0 ? /AC Power/.test(result.stdout) : null,
        sleepDetected,
        wakeDetected,
      }
    },
    close: closeObserver,
    setIdleSleepAssertion: async (enabled, dispatchFence) => {
      await dispatchFence?.assertCurrent()
      if (!enabled) {
        const previous = assertion
        assertion = null
        if (previous && previous.exitCode === null) previous.kill("SIGTERM")
        return false
      }
      if (assertion && assertion.exitCode === null) return true
      const child = spawnProcess(
        config.commands.caffeinate,
        ["-i", "-w", String(process.pid)],
        { stdio: "ignore" },
      )
      assertion = child
      child.once("exit", () => {
        if (assertion === child) assertion = null
      })
      child.on("error", () => {
        if (assertion === child) assertion = null
      })
      try {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve)
          child.once("error", reject)
        })
        return true
      } catch (_error) {
        throw new Error("idle_sleep_assertion_failed")
      }
    },
  }
}

export function createLocalNotifier(config) {
  const messages = {
    ambiguous_unconfirmed_delivery: "Ego Chat delivery is ambiguous; exact-workflow reconciliation is required.",
    crash_loop: "The Ego Chat broker is in a crash loop; recovery is paused.",
    disk_full: "Eagle Monitor storage is unavailable; recovery is paused.",
    human_required_auth_challenge: "Ego Chat needs human authentication or challenge completion.",
    human_required_other: "Eagle Monitor needs human review before recovery can continue.",
    send_confirmed_capture: "Ego Chat response capture exceeded its service budget; review the exact workflow.",
    version_skew: "The running Ego Chat broker is incompatible with this monitor runtime.",
  }
  return {
    notify: async (classification, dispatchFence) => {
      await dispatchFence?.assertCurrent()
      const message = messages[classification.state] ?? "Eagle Monitor requires attention."
      const script = `display notification ${JSON.stringify(message)} with title "Eagle Monitor"`
      const result = await execBounded(config.commands.osascript, ["-e", script])
      if (result.code !== 0) throw new Error("notification_failed")
    },
  }
}
