import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import {
  EAGLE_MONITOR_EXIT,
  EAGLE_MONITOR_MODES,
  EAGLE_MONITOR_POWER_POLICIES,
  EAGLE_MONITOR_SCHEMA_VERSION,
} from "./eagle-monitor-constants.mjs"
import { loadEagleMonitorConfig, safeDigest } from "./eagle-monitor-config.mjs"
import { inspectMonitorLease } from "./eagle-monitor-lease.mjs"
import { EagleMonitorLifecycle, generateLaunchAgent } from "./eagle-monitor-lifecycle.mjs"
import { EagleMonitorStore } from "./eagle-monitor-store.mjs"
import { EgoChatError } from "./errors.mjs"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BINDING_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PUBLIC_COMMANDS = new Set(["doctor", "incidents", "start", "status", "stop"])

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  corrupt_monitor_epoch: "Eagle Monitor epoch state is invalid; recovery remains paused.",
  corrupt_monitor_lease: "Eagle Monitor lease state is invalid; recovery remains paused.",
  corrupt_monitor_state: "Eagle Monitor state is invalid; recovery remains paused.",
  invalid_cli_usage: "The Eagle Monitor command or arguments are invalid.",
  invalid_input: "The Eagle Monitor input is invalid.",
  invalid_monitor_path: "An Eagle Monitor path is invalid; recovery remains paused.",
  launchagent_start_failed: "The per-user Eagle Monitor service could not be started.",
  launchagent_start_rollback_failed: "The per-user Eagle Monitor start needs review; ownership evidence was preserved.",
  launchagent_status_failed: "The per-user Eagle Monitor service status could not be determined safely.",
  launchagent_stop_failed: "The per-user Eagle Monitor service could not be stopped.",
  monitor_dependency_unavailable: "A required Eagle Monitor executable is unavailable.",
  monitor_already_configured: "Eagle Monitor is already configured; stop it before changing policy.",
  monitor_definition_conflict: "The existing Eagle Monitor service definition was preserved for review.",
  privileged_monitor_forbidden: "Eagle Monitor requires a non-root user session.",
  unsafe_launchagent_definition: "The Eagle Monitor service definition is unsafe and was preserved.",
  unsafe_monitor_storage: "Eagle Monitor private storage is unsafe; recovery remains paused.",
  unowned_launchagent_definition: "The unowned Eagle Monitor service definition was preserved.",
  unowned_launchagent_service: "The unowned Eagle Monitor service was preserved.",
  unsupported_platform: "Eagle Monitor service management requires macOS.",
})

function usageError(message) {
  return new EgoChatError("invalid_cli_usage", message)
}

function parseOptions(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === "--json") {
      if (options.has("json")) throw usageError("Duplicate option --json.")
      options.set("json", true)
      continue
    }
    if (!key.startsWith("--") || index + 1 >= args.length) {
      throw usageError(`Invalid option ${key}.`)
    }
    if (options.has(key.slice(2))) throw usageError(`Duplicate option ${key}.`)
    options.set(key.slice(2), args[index + 1])
    index += 1
  }
  return options
}

function assertOnly(options, allowed) {
  for (const key of options.keys()) {
    if (key !== "json" && !allowed.includes(key)) throw usageError(`Unknown option --${key}.`)
  }
}

function envelope(command, result) {
  return { command, ok: true, result, schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION }
}

function errorEnvelope(command, error) {
  const candidateCode = typeof error?.code === "string" ? error.code : "unexpected_error"
  const code = Object.hasOwn(PUBLIC_ERROR_MESSAGES, candidateCode)
    ? candidateCode
    : "unexpected_error"
  return {
    command: PUBLIC_COMMANDS.has(command) ? command : null,
    error: {
      code,
      message: PUBLIC_ERROR_MESSAGES[code]
        ?? "Eagle Monitor failed safely; inspect the error code and private daemon log.",
    },
    ok: false,
    schemaVersion: EAGLE_MONITOR_SCHEMA_VERSION,
  }
}

function errorExit(error) {
  if (error.code === "invalid_cli_usage" || error.code === "invalid_input") {
    return EAGLE_MONITOR_EXIT.USAGE
  }
  if ([
    "monitor_dependency_unavailable",
    "privileged_monitor_forbidden",
    "unsupported_platform",
  ].includes(error.code)) {
    return EAGLE_MONITOR_EXIT.UNAVAILABLE
  }
  if (
    /^corrupt_|^unsafe_|^unowned_|human_required|monitor_already_configured|monitor_definition_conflict/
      .test(error.code ?? "")
  ) {
    return EAGLE_MONITOR_EXIT.ATTENTION_REQUIRED
  }
  return EAGLE_MONITOR_EXIT.SOFTWARE
}

async function pathCheck(filePath, access = fsConstants.R_OK) {
  try {
    await fs.access(filePath, access)
    return { ok: true }
  } catch (error) {
    return { code: error.code ?? "unavailable", ok: false }
  }
}

async function executableCheck(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    return { code: "invalid_path", ok: false }
  }
  if (candidate.startsWith("/")) return pathCheck(candidate, fsConstants.X_OK)
  const directories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
  for (const directory of directories) {
    const result = await pathCheck(path.join(directory, candidate), fsConstants.X_OK)
    if (result.ok) return result
  }
  return { code: "ENOENT", ok: false }
}

export async function runEagleMonitorCli({
  argv,
  config = undefined,
  lifecycle = undefined,
  resolveConfig = loadEagleMonitorConfig,
  now = () => new Date().toISOString(),
  observeMonitor = inspectMonitorLease,
  store = undefined,
  write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
} = {}) {
  const [command, ...args] = argv ?? []

  try {
    if (!command) throw usageError("A command is required: start, status, stop, doctor, or incidents.")
    if (!PUBLIC_COMMANDS.has(command)) throw usageError(`Unknown command ${command}.`)
    const resolvedConfig = config ?? resolveConfig({ requireEgoBrowser: command === "start" })
    const monitorStore = store ?? new EagleMonitorStore(resolvedConfig)
    const monitorLifecycle = lifecycle ?? new EagleMonitorLifecycle(resolvedConfig)
    const options = parseOptions(args)
    let result
    let exitCode = EAGLE_MONITOR_EXIT.OK

    if (command === "start") {
      assertOnly(options, ["binding-key", "mode", "power-policy", "workflow"])
      const workflowId = options.get("workflow")
      const bindingKey = options.get("binding-key") ?? null
      const mode = options.get("mode") ?? "shadow"
      const powerPolicy = options.get("power-policy") ?? "allow-sleep"
      if (!UUID_PATTERN.test(workflowId ?? "")) throw usageError("start requires --workflow <durable UUID>.")
      if (bindingKey !== null && !BINDING_PATTERN.test(bindingKey)) {
        throw usageError("--binding-key is invalid.")
      }
      if (!EAGLE_MONITOR_MODES.includes(mode)) throw usageError("--mode must be shadow or safe.")
      if (!EAGLE_MONITOR_POWER_POLICIES.includes(powerPolicy)) {
        throw usageError("--power-policy must be allow-sleep or keep-awake-on-ac.")
      }
      if (mode === "safe" && bindingKey === null) {
        throw usageError("safe mode requires --binding-key for exact broker-owned reconciliation.")
      }
      const definition = generateLaunchAgent(resolvedConfig)
      const previousSession = await monitorStore.readSession()
      await monitorStore.readState()
      await observeMonitor(resolvedConfig)
      const configured = await monitorStore.configureSession({
        bindingKey,
        launchAgentDigest: definition.digest,
        mode,
        now: now(),
        powerPolicy,
        workflowId,
      })
      try {
        const service = await monitorLifecycle.start(
          definition,
          previousSession?.launchAgentDigest ?? null,
        )
        result = {
          changed: configured.changed || service.changed,
          mode,
          policyDigest: resolvedConfig.policy.digest,
          powerPolicy,
          service,
          workflowDigest: safeDigest(workflowId),
        }
      } catch (error) {
        if (configured.changed && error.code !== "launchagent_start_rollback_failed") {
          await monitorStore.restoreSession(previousSession).catch(() => {})
        }
        throw error
      }
    } else if (command === "status") {
      assertOnly(options, [])
      const session = await monitorStore.readSession()
      const state = await monitorStore.readState()
      const service = await monitorLifecycle.status(
        session?.active ? session.launchAgentDigest : null,
      )
      const monitor = await observeMonitor(resolvedConfig)
      const policyMatches = !session || session.policyDigest === resolvedConfig.policy.digest
      result = monitorStore.publicStatus(
        session,
        state,
        service,
        monitor,
        policyMatches,
        Date.parse(now()),
      )
      if (!session?.active && !service.loaded && !service.definitionPresent && !monitor.active) {
        exitCode = EAGLE_MONITOR_EXIT.NOT_RUNNING
      }
      else if (
        !service.loaded
        || !service.definitionMatches
        || !monitor.active
        || !policyMatches
        || result.humanRequired.required
        || ["crash_loop", "disk_full", "version_skew"].includes(result.state)
        || ["human_required", "looping", "stagnant"].includes(result.semantic?.classification)
      ) exitCode = EAGLE_MONITOR_EXIT.ATTENTION_REQUIRED
    } else if (command === "stop") {
      assertOnly(options, [])
      const session = await monitorStore.readSession()
      const sessionWasActive = session?.active === true
      const service = await monitorLifecycle.stop(session?.launchAgentDigest ?? null)
      await monitorStore.stopSession(now())
      result = {
        changed: service.changed || sessionWasActive,
        service: { loaded: false },
        stopped: true,
      }
    } else if (command === "incidents") {
      assertOnly(options, ["limit"])
      const limit = options.has("limit") ? Number(options.get("limit")) : 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw usageError("--limit must be an integer from 1 to 200.")
      }
      const state = await monitorStore.readState()
      result = { incidents: monitorStore.publicIncidents(state, limit), limit }
    } else if (command === "doctor") {
      assertOnly(options, [])
      const session = await monitorStore.readSession()
      const checks = {
        caffeinate: await pathCheck(resolvedConfig.commands.caffeinate, fsConstants.X_OK),
        daemon: await pathCheck(resolvedConfig.daemonPath),
        egoBrowserExecutable: await executableCheck(resolvedConfig.brokerConfig.egoBrowserCommand),
        launchctl: await pathCheck(resolvedConfig.commands.launchctl, fsConstants.X_OK),
        node: await pathCheck(resolvedConfig.executablePath, fsConstants.X_OK),
        notification: await pathCheck(resolvedConfig.commands.osascript, fsConstants.X_OK),
        platform: { ok: resolvedConfig.platform === "darwin", value: resolvedConfig.platform },
        policy: { digest: resolvedConfig.policy.digest, ok: true },
        powerStatus: await pathCheck(resolvedConfig.commands.pmset, fsConstants.X_OK),
      }
      let state = null
      let stateReadable = true
      try {
        state = await monitorStore.readState()
      } catch (_error) {
        stateReadable = false
      }
      checks.state = { ok: stateReadable }
      const service = await monitorLifecycle.status(
        session?.active ? session.launchAgentDigest : null,
      )
      const monitor = await observeMonitor(resolvedConfig)
      const policyMatches = !session || session.policyDigest === resolvedConfig.policy.digest
      checks.monitorLease = {
        active: monitor.active,
        epoch: monitor.epoch,
        ok: session?.active === true ? monitor.active : !monitor.active,
      }
      checks.sessionPolicy = { ok: policyMatches }
      const healthy = Object.values(checks).every((check) => check.ok)
        && service.definitionMatches
        && (!service.loaded || session?.active === true)
      result = {
        checks,
        healthy,
        mvpDependencies: { llm: false, network: false },
        service,
        status: monitorStore.publicStatus(
          session,
          state,
          service,
          monitor,
          policyMatches,
          Date.parse(now()),
        ),
      }
      if (!healthy) exitCode = EAGLE_MONITOR_EXIT.ATTENTION_REQUIRED
    }

    write(envelope(command, result))
    return exitCode
  } catch (error) {
    write(errorEnvelope(command, error))
    return errorExit(error)
  }
}
