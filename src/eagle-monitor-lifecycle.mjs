import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { ensurePrivateDirectory, removeFileIfPresent, writeAtomicText } from "./eagle-monitor-fs.mjs"
import { EgoChatError } from "./errors.mjs"

const execFileAsync = promisify(execFile)

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

async function defaultRunner(executable, args) {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    })
    return { code: 0, stderr: result.stderr, stdout: result.stdout }
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      stdout: typeof error.stdout === "string" ? error.stdout : "",
    }
  }
}

export function generateLaunchAgent(config) {
  const args = [
    config.executablePath,
    config.daemonPath,
    "--monitor-data-dir",
    config.dataDir,
    "--broker-data-dir",
    config.brokerConfig.dataDir,
    "--ego-browser",
    config.brokerConfig.egoBrowserCommand,
    "--broker-socket",
    config.brokerConfig.socketPath,
  ]
  const argumentXml = args.map((value) => `    <string>${xml(value)}</string>`).join("\n")
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(config.label)}</string>
  <key>Program</key>
  <string>${xml(config.executablePath)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentXml}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <string>077</string>
  <key>WorkingDirectory</key>
  <string>${xml(path.dirname(config.daemonPath))}</string>
</dict>
</plist>
`
  return {
    contents,
    digest: createHash("sha256").update(contents, "utf8").digest("hex"),
  }
}

export class EagleMonitorLifecycle {
  #config
  #runner

  constructor(config, { runner = defaultRunner } = {}) {
    this.#config = config
    this.#runner = runner
  }

  async #serviceLoaded() {
    const result = await this.#runner(this.#config.commands.launchctl, [
      "print",
      this.#config.serviceTarget,
    ])
    if (result.code === 0) return true
    if (result.code === 113) return false
    throw new EgoChatError(
      "launchagent_status_failed",
      "The per-user Eagle Monitor LaunchAgent status could not be determined safely.",
      { exitCode: result.code },
    )
  }

  async #definitionDigest() {
    let stat
    try {
      stat = await fs.lstat(this.#config.paths.launchAgent)
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new EgoChatError(
        "unsafe_launchagent_definition",
        "The Eagle Monitor LaunchAgent path must be a regular file.",
      )
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new EgoChatError(
        "unsafe_launchagent_definition",
        "The Eagle Monitor LaunchAgent must be owned by the current user.",
      )
    }
    if ((stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) {
      throw new EgoChatError(
        "unsafe_launchagent_definition",
        "The Eagle Monitor LaunchAgent has unsafe permissions or size.",
      )
    }
    const contents = await fs.readFile(this.#config.paths.launchAgent, "utf8")
    return createHash("sha256").update(contents, "utf8").digest("hex")
  }

  async status(expectedDigest = null) {
    const definitionDigest = await this.#definitionDigest()
    return {
      definitionMatches: expectedDigest === null
        ? definitionDigest === null
        : definitionDigest === expectedDigest,
      definitionPresent: definitionDigest !== null,
      domain: `gui/${this.#config.uid}`,
      label: this.#config.label,
      loaded: await this.#serviceLoaded(),
    }
  }

  async start(definition, ownedDigest = null) {
    if (this.#config.platform !== "darwin") {
      throw new EgoChatError("unsupported_platform", "Eagle Monitor LaunchAgent management requires macOS.")
    }
    await ensurePrivateDirectory(this.#config.dataDir)
    await fs.mkdir(path.dirname(this.#config.paths.launchAgent), { mode: 0o700, recursive: true })
    const current = await this.status(definition.digest)
    const currentDigest = current.definitionPresent ? await this.#definitionDigest() : null
    const currentContents = current.definitionPresent
      ? await fs.readFile(this.#config.paths.launchAgent, "utf8")
      : null
    if (current.loaded && !current.definitionMatches) {
      throw new EgoChatError(
        "monitor_definition_conflict",
        "The loaded Eagle Monitor definition differs; stop it before changing configuration.",
      )
    }
    if (
      current.definitionPresent
      && currentDigest !== ownedDigest
    ) {
      throw new EgoChatError(
        "monitor_definition_conflict",
        "The existing Eagle Monitor definition is not owned by the private session record and was preserved.",
      )
    }
    const definitionChanged = !current.definitionPresent || !current.definitionMatches
    if (definitionChanged) {
      await writeAtomicText(this.#config.paths.launchAgent, definition.contents)
    }
    let bootstrapped = false
    if (!current.loaded) {
      const result = await this.#runner(this.#config.commands.launchctl, [
        "bootstrap",
        `gui/${this.#config.uid}`,
        this.#config.paths.launchAgent,
      ])
      if (result.code !== 0) {
        const becameLoaded = await this.#serviceLoaded()
        if (becameLoaded) {
          const status = await this.status(definition.digest)
          if (!status.loaded) {
            throw new EgoChatError(
              "launchagent_start_failed",
              "The per-user Eagle Monitor LaunchAgent did not remain loaded.",
            )
          }
          return {
            ...status,
            changed: true,
          }
        }
        if (definitionChanged) {
          if (currentContents === null) {
            await removeFileIfPresent(this.#config.paths.launchAgent)
          } else {
            await writeAtomicText(this.#config.paths.launchAgent, currentContents)
          }
        }
        throw new EgoChatError(
          "launchagent_start_failed",
          "The per-user Eagle Monitor LaunchAgent could not be started.",
          { exitCode: result.code },
        )
      }
      bootstrapped = true
    }
    try {
      const status = await this.status(definition.digest)
      if (!status.loaded) {
        throw new EgoChatError(
          "launchagent_start_failed",
          "The per-user Eagle Monitor LaunchAgent did not remain loaded.",
        )
      }
      return {
        ...status,
        changed: definitionChanged || !current.loaded,
      }
    } catch (error) {
      if (!bootstrapped) throw error
      const rollback = await this.#runner(this.#config.commands.launchctl, [
        "bootout",
        this.#config.serviceTarget,
      ])
      try {
        if (![0, 113].includes(rollback.code)) throw new Error("launchagent_bootout_failed")
        if (definitionChanged) {
          if (currentContents === null) {
            await removeFileIfPresent(this.#config.paths.launchAgent)
          } else {
            await writeAtomicText(this.#config.paths.launchAgent, currentContents)
          }
        }
      } catch (_rollbackError) {
        throw new EgoChatError(
          "launchagent_start_rollback_failed",
          "The per-user Eagle Monitor start could not be rolled back safely; ownership evidence was preserved.",
        )
      }
      throw error
    }
  }

  async stop(expectedDigest = null) {
    if (this.#config.platform !== "darwin") {
      throw new EgoChatError("unsupported_platform", "Eagle Monitor LaunchAgent management requires macOS.")
    }
    const status = await this.status(expectedDigest)
    if (status.definitionPresent && !status.definitionMatches) {
      throw new EgoChatError(
        "unowned_launchagent_definition",
        "The Eagle Monitor plist does not match the private session record and was preserved.",
      )
    }
    if (status.loaded && (expectedDigest === null || !status.definitionMatches)) {
      throw new EgoChatError(
        "unowned_launchagent_service",
        "The loaded Eagle Monitor service has no private ownership record and was preserved.",
      )
    }
    if (status.loaded) {
      const result = await this.#runner(this.#config.commands.launchctl, [
        "bootout",
        this.#config.serviceTarget,
      ])
      if (result.code !== 0) {
        throw new EgoChatError(
          "launchagent_stop_failed",
          "The per-user Eagle Monitor LaunchAgent could not be stopped.",
          { exitCode: result.code },
        )
      }
    }
    if (status.definitionPresent) await removeFileIfPresent(this.#config.paths.launchAgent)
    return { changed: status.loaded || status.definitionPresent, loaded: false }
  }
}
