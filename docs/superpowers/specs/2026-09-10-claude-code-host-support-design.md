# Claude Code host support

Date: 2026-09-10. Status: approved design, not yet implemented.

## Summary

Add Claude Code as a third supported host for Ego Chat, next to Codex and ZCode. The Claude desktop app's Code tab is covered by the same configuration because it loads user-scope MCP servers and personal skills from the Claude Code configuration directory. The Claude desktop chat surface is out of scope for this phase.

The MCP facade already works from any MCP host. The work is confined to the Rust launcher (a `setup-claude` / `doctor-claude` pair and a Claude skill copy), host-name text in the skill and facade, and documentation.

## Goals

- `ego-chat setup-claude` installs the managed runtime, installs the bundled skill for Claude Code, and registers `ego_chat` as a user-scope stdio MCP server with a per-call timeout of 29,100,000 ms (eight hours plus five minutes of host transport margin).
- `ego-chat doctor-claude` verifies that installation read-only and reports actionable failures.
- The current-host loops (`ego_exchange_and_wait`, `ego_review_candidate_and_wait`, adoption, status, cancel) work from a Claude Code session. Broker-owned convergence keeps using the Codex App Server when Codex is installed, exactly as it does from ZCode.
- No change to the broker, the browser driver, or durable state.

## Non-goals

- The Claude desktop chat surface (`claude_desktop_config.json`). It cannot load a skill from disk, has no documented long-call timeout, and an entry there overrides the Code tab's timeout-carrying user-scope definition.
- A Claude-owned implementing agent for detached convergence (driving headless Claude Code instead of the Codex App Server). That is a separate spec.
- Project-scope (`.mcp.json`) or local-scope registration.

## Verified host facts

Verified on 2026-09-10 against the official Claude Code MCP, desktop, skills, and settings pages, plus an isolated `CLAUDE_CONFIG_DIR` probe with Claude Code 2.1.261.

- User-scope MCP servers live in `.claude.json`. With `CLAUDE_CONFIG_DIR` set, that file is `$CLAUDE_CONFIG_DIR/.claude.json`; otherwise it is `~/.claude.json`. `CLAUDE_CONFIG_DIR` relocates the whole Claude home directory, including skills.
- A stdio entry has the shape `{"type":"stdio","command":...,"args":[...],"env":{...},"timeout":<ms>}`.
- The per-server `timeout` is a hard wall-clock cap per tool call. Progress notifications do not extend it. Values below 1000 are ignored and fall through to `MCP_TOOL_TIMEOUT`, whose unset default is about 28 hours.
- Stdio servers have a separate idle abort, default 30 minutes, for calls that send neither a response nor a progress notification. From Claude Code 2.1.203 onward, a per-server `timeout` of at least 1000 ms also floors that idle window. Below 2.1.203 a Token-Saver wait (which sends no notifications) would abort after 30 minutes.
- A main-conversation tool call that runs past two minutes is moved to a background task and its result is delivered to the session as a notification.
- `claude mcp add-json -s user <name> '<json>'` writes the entry including `timeout`; `claude mcp get <name>` reports the timeout. `add-json` refuses an existing name ("already exists"). `claude mcp remove <name> -s user` removes only the user-scope entry.
- Personal skills load from `skills/<name>/SKILL.md` under the Claude home directory. All frontmatter fields are optional; `name` and `description` are the ones this project uses. Extra files in the directory are allowed.
- The desktop app's Code tab loads MCP servers from `claude_desktop_config.json`, `~/.claude.json`, and `.mcp.json`, and personal skills from the Claude home directory in local sessions. If the same name is in `claude_desktop_config.json` and `~/.claude.json`, the Code tab uses the desktop definition. The standalone CLI never reads `claude_desktop_config.json`.

## Design

### Launcher commands

`rust/main.rs` gains three commands, dispatched like their ZCode equivalents:

- `setup-claude [--force]`
- `doctor-claude`
- `install-claude-skill [--force]`

`print_help` lists them and the summary line becomes: setup configures Codex; setup-zcode configures ZCode; setup-claude configures Claude Code.

### Paths and toolchain

`InstallPaths` gains `claude_config` and `claude_skill_dir`:

- Claude home = `CLAUDE_CONFIG_DIR` if set, else `~/.claude`.
- `claude_config` = `$CLAUDE_CONFIG_DIR/.claude.json` if `CLAUDE_CONFIG_DIR` is set, else `~/.claude.json`.
- `claude_skill_dir` = Claude home joined with `skills/ego-chat`.

The `claude` executable is resolved with `find_program("claude", "EGO_CHAT_CLAUDE")` inside `setup_claude` and `doctor_claude` only. It is not added to `Toolchain`, so `prepend_path`, `write_runtime_tool_paths`, and the runtime's recorded tool paths are unchanged. Codex remains optional (`Toolchain::discover(false)`), as for ZCode.

A new `CLAUDE_SKILL_FILES` constant embeds `SKILL.md` only, matching `ZCODE_SKILL_FILES`.

### Setup flow

`setup_claude(force)` mirrors `setup_zcode`:

1. Refuse on non-macOS.
2. Discover paths, discover and validate the toolchain with Codex optional, resolve `claude`.
3. Check the Claude Code version (see Doctor); fail before touching anything if it is older than 2.1.203.
4. `install_runtime`, `redirect_stale_broker_launchers`, `handoff_installed_broker` exactly as today.
5. `install_skill(&paths.claude_skill_dir, CLAUDE_SKILL_FILES, force)`.
6. `configure_claude(&paths.claude_config, &claude, &executable, force)`.
7. Print the runtime path, skill path, MCP server name, the restart instruction, the Codex-absent note when Codex was not found, and either a line that the Claude.app Code tab picks up the same configuration or a warning when `claude_desktop_config.json` also defines `ego_chat`.

### Configuration write

`configure_claude` never writes the JSON file itself. It reads the file for classification and delegates writes to the Claude CLI.

1. Read `claude_config`. A missing file means no entry. A present file must parse as a JSON object; any other content is an error.
2. Classify `mcpServers.ego_chat` with `claude_server_value_status`, returning the existing `HostConfigStatus`:
   - identity match = `command` equals this executable's path, `args` equals `["mcp"]`, and `type` is absent or `"stdio"`;
   - `timeout` must be a number of milliseconds at least `MCP_TOOL_TIMEOUT_MILLISECONDS`.
3. If the entry exists, identity does not match, and `--force` was not given: fail with the same wording the other hosts use, before any CLI invocation.
4. If the status is `Ready`: write nothing and report that the server is already configured.
5. Otherwise, if an entry exists, run `claude mcp remove ego_chat -s user`. Then run `claude mcp add-json -s user ego_chat <json>` where `<json>` is `{"type":"stdio","command":<executable>,"args":["mcp"],"timeout":<ms>}` and `<ms>` is `MCP_TOOL_TIMEOUT_MILLISECONDS`, followed by every extra field of the owned entry being repaired (such as `env`) in its original order; a foreign entry replaced under `--force` contributes nothing. A longer existing timeout survives because an owned entry that is already `Ready` is never rewritten (step 4); an owned entry that reaches this step always has a missing, invalid, or too-short timeout.
6. Both CLI calls inherit the launcher's environment so they target the file inspected in step 1. A non-zero exit is an error; CLI output is not parsed because step 7 verifies the file itself.
7. Re-read the file and re-classify. Anything other than `Ready` is an error naming the file and the status, so a CLI that silently declined cannot leave a half-configured host.

The `env` and any other keys the CLI adds are left as the CLI wrote them.

### Doctor

`doctor_claude` mirrors `doctor_zcode` and adds a version check:

- Node.js, npm, and ego-browser are available; Codex, if found, is reported as also available for broker-owned convergence, or warned about if unusable.
- `claude --version` runs and parses. The output shape is `2.1.261 (Claude Code)`; `parse_claude_version` takes the leading dotted integers. A version older than 2.1.203 fails with: Claude Code 2.1.203 or newer is required so the per-server MCP timeout also floors the 30-minute stdio idle abort; upgrade Claude Code.
- Runtime installed and broker generation current, as today.
- Skill bytes match `CLAUDE_SKILL_FILES`.
- `claude_server_status(&paths.claude_config, &executable)` is `Ready`; otherwise `host_config_problem("Claude Code", "timeout", MCP_TOOL_TIMEOUT_MILLISECONDS, "milliseconds", status)`.
- A read-only check of `~/Library/Application Support/Claude/claude_desktop_config.json` prints `[warn]` when that file also defines `ego_chat` (the Code tab would use that definition instead of the timeout-carrying user-scope entry) or when it cannot be parsed; it never fails doctor and never edits the file.
- Closing line on success: Ego Chat is ready. Restart open Claude Code sessions and Claude.app after configuration changes. On failure: doctor-claude found N problem(s); run ego-chat setup-claude.

Doctor never spawns the MCP server and never invokes `claude mcp get`, so it cannot start a broker or open the browser.

### Skill text

`skills/ego-chat/SKILL.md` stays one host-aware file, under 500 lines:

- The frontmatter description names Codex, ZCode, or Claude Code.
- The unavailable-tools sentence adds `ego-chat setup-claude` for Claude Code.
- The concurrent-use paragraph lists Claude Code among hosts that may use independent conversations.
- "Choose the loop" gains a Claude Code bullet matching the ZCode one: use detached convergence only when handing implementation to the broker-owned Codex App Server task is acceptable and that runtime is available; otherwise use the current-host fallback and keep the Claude Code turn alive.
- The waits section gains one paragraph: in Claude Code, a tool call that runs past two minutes is moved to a background task and its result arrives as a notification in the same session; wait for that notification and do not call `workflow_status` or `await_workflow` from extra turns.

`skills/ego-chat/agents/openai.yaml` is unchanged and remains Codex-only.

### Facade and daemon strings

Only prose changes:

- `src/mcp-server.mjs`: the shared-broker guidance names Codex, ZCode, and Claude Code; the `ego_review_candidate_and_wait` description names the current ZCode, Codex, Claude Code, or compatible host.
- `src/ipc-client.mjs` and `bin/ego-chatd.mjs`: "Restart Codex and ZCode" becomes "Restart Codex, ZCode, and Claude Code".

No test asserts on these strings today.

### Documentation and metadata

- `README.md`: Requirements gains Claude Code 2.1.203 or newer for Claude setup, with the Code tab note. Portable Rust installation gains `setup-claude` / `doctor-claude` in the command blocks and a bullet list of what `setup-claude` does. The MCP configuration section gains the development-checkout `claude mcp add-json` command with the timeout. The skill section names all three hosts. Concurrent hosts mentions Claude Code. Not yet supported gains the Claude desktop chat surface and a Claude-owned implementer for detached convergence.
- `CONTINUITY.md`: the outcome paragraph and the token/process paragraph name Claude Code alongside Codex and ZCode.
- `package.json` and `Cargo.toml`: descriptions and keywords add Claude Code.

## Error handling

- Every failure is returned as `Err(String)` and printed by `main`, as today.
- Setup fails closed before any write when the version is too old, the toolchain is invalid, the skill directory holds different managed files without `--force`, or an unowned server entry exists without `--force`.
- After the CLI write, setup verifies the file and fails if the result is not `Ready`.
- Doctor is read-only.

## Testing

Rust unit tests in `rust/main.rs`, using the existing `TestDirectory` and fake shell-script executables:

- `claude_server_status` distinguishes missing file, missing entry, identity mismatch (command, args, and explicit non-stdio type), missing timeout, too-short timeout, and ready, with `type` absent and with `type: "stdio"`.
- `configure_claude` with a fake `claude` that records its argument vectors and edits the JSON the way the real CLI does:
  - fresh or absent file: no `remove`, one `add-json -s user` with the exact JSON;
  - owned entry with a short or missing timeout: `remove` then `add-json`, without `--force`;
  - owned entry with a longer timeout: preserved;
  - unowned entry without `--force`: error and no invocation;
  - ready entry: no invocation;
  - a fake CLI that exits zero but writes nothing: error from post-write verification;
  - owned entry with extra fields such as `env`: carried into the replacement after the managed keys; foreign fields under `--force`: dropped;
  - remove succeeds but add-json fails: error surfaced, no entry left, so a rerun takes the fresh path.
- `parse_claude_version` accepts `2.1.261 (Claude Code)` and rejects garbage; the 2.1.203 minimum comparison is covered.
- `embedded_paths_are_relative_and_unique` includes `CLAUDE_SKILL_FILES`.
- `skill_installation_requires_force_for_different_managed_files` is reused for the Claude skill directory.
- desktop-config shadow detection: missing, blank, other-server, shadowing, and broken files.

Node: `npm test` and `npm run lint` unchanged in scope, run to confirm nothing regressed. Rust: `cargo test` and `cargo clippy --all-targets`.

## Live verification

On this Mac, after the deterministic suites pass:

1. `cargo install --path . --locked`, then `ego-chat setup-claude` and `ego-chat doctor-claude`.
2. `claude mcp get ego_chat` shows the executable, `mcp`, and a 29,100,000 ms timeout.
3. From a fresh Claude Code session, one `ego_exchange_and_wait` in Token-Saver mode that runs longer than two minutes, confirming the call is backgrounded and its result returns to the session without a second Send.
4. The same from the Claude.app Code tab, confirming the skill and server are visible there.
5. Codex review of the diff, with the GLM fallback if Codex is out of quota.

## Assumptions to confirm during live verification

- The Code tab honours the per-server `timeout` from the user-scope entry the same way the CLI does. The desktop documentation states the Code tab re-delivers user-scope stdio servers to the embedded CLI, so this is expected.
- Backgrounded calls preserve the MCP result envelope, including `responseRef` for large responses.
