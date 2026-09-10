# Claude Code Host Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ego-chat setup-claude` / `doctor-claude` / `install-claude-skill` so Claude Code (and the Claude.app Code tab) can use the existing `ego_chat` MCP server with the 8h05m tool timeout and the bundled skill.

**Architecture:** The MCP facade is already host-neutral, so all code lives in the Rust launcher (`rust/main.rs`) and mirrors the ZCode host path: a paths helper, a version gate, a read-only config classifier, and a configuration writer that delegates every write to `claude mcp add-json` / `claude mcp remove` and verifies the file afterwards. Skill, facade strings, and docs gain Claude Code wording.

**Tech Stack:** Rust 2024 edition (rust-version 1.88), `serde_json` with `preserve_order`, `std::process::Command`, shell-script fake executables in unit tests; Node 24 for the unchanged facade tests.

**Spec:** `docs/superpowers/specs/2026-09-10-claude-code-host-support-design.md`

**Baselines (main at 0.2.22):** `cargo test` = 20 passed; `cargo clippy --all-targets` = no warnings; `cargo fmt --check` = clean.

**Conventions used below**

- All Rust code goes in `rust/main.rs`. Non-test functions go directly above `fn doctor()`; test functions go inside `mod tests` directly above `fn skill_installation_requires_force_for_different_managed_files()`. The file is one module, so a new function is callable from anywhere in it.
- Tests are in the same file, so "run the failing test" means `cargo test <name>` fails to compile with `error[E0425]: cannot find function` until the implementation exists. That is the expected red state.
- Until Task 4 wires everything into `run()`, `cargo build`/`cargo clippy` emit `dead_code` warnings for the new functions. `cargo test` never warns (the tests use them). Task 4 removes the warnings; clippy must be clean at the end of Task 4 and every task after it.
- Commit messages follow conventional commits without attribution trailers. Branch: `feature/claude-code-host-support`.
- Run `cargo fmt` before every commit.

---

### Task 1: Claude Code version parsing and minimum-version gate

**Files:**
- Modify: `rust/main.rs` (constants after line 27 `COCO_MCP_END_MARKER`; functions above `fn doctor()`; tests inside `mod tests`)

- [ ] **Step 1: Add a shared fake-executable test helper and the failing tests**

Add inside `mod tests`, right after `impl Drop for TestDirectory { ... }` (after line ~1557):

```rust
    fn write_fake_executable(path: &Path, script: &str) -> PathBuf {
        fs::write(path, script).expect("write fake executable");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path).expect("read mode").permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions).expect("set executable mode");
        }
        path.to_path_buf()
    }
```

Add these tests directly above `fn skill_installation_requires_force_for_different_managed_files()`:

```rust
    #[test]
    fn claude_version_parser_accepts_cli_output() {
        assert_eq!(
            parse_claude_version("2.1.261 (Claude Code)"),
            Some((2, 1, 261))
        );
        assert_eq!(parse_claude_version("v2.1.203\n"), Some((2, 1, 203)));
        assert_eq!(parse_claude_version("2.2.0-beta.1"), Some((2, 2, 0)));
        assert_eq!(parse_claude_version("unknown"), None);
        assert_eq!(parse_claude_version("2.1"), None);
        assert!((2, 1, 202) < MINIMUM_CLAUDE_VERSION);
        assert!((2, 1, 203) >= MINIMUM_CLAUDE_VERSION);
        assert!((2, 2, 0) > MINIMUM_CLAUDE_VERSION);
    }

    #[test]
    fn claude_version_check_rejects_hosts_older_than_the_idle_floor_release() {
        let directory = TestDirectory::new();
        let old = write_fake_executable(
            &directory.0.join("claude-old"),
            "#!/bin/sh\nprintf '2.1.202 (Claude Code)\\n'\n",
        );
        let error = check_claude_version(&old).expect_err("must reject 2.1.202");
        assert!(error.contains("2.1.203 or newer"));
        assert!(error.contains("2.1.202"));

        let current = write_fake_executable(
            &directory.0.join("claude-current"),
            "#!/bin/sh\nprintf '2.1.261 (Claude Code)\\n'\n",
        );
        assert_eq!(
            check_claude_version(&current).expect("accept 2.1.261"),
            "2.1.261"
        );

        let broken = write_fake_executable(
            &directory.0.join("claude-broken"),
            "#!/bin/sh\nprintf 'not a version\\n'\n",
        );
        let error = check_claude_version(&broken).expect_err("must reject garbage");
        assert!(error.contains("could not parse Claude Code version"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test claude_version`
Expected: compile error `error[E0425]: cannot find function `parse_claude_version`` (and `check_claude_version`, `MINIMUM_CLAUDE_VERSION`).

- [ ] **Step 3: Implement the constant and the two functions**

Add after `const COCO_MCP_END_MARKER: &str = "# --- end coco MCP server ---";`:

```rust
const MINIMUM_CLAUDE_VERSION: (u64, u64, u64) = (2, 1, 203);
```

Add directly above `fn doctor() -> Result<(), String> {`:

```rust
fn parse_claude_version(version: &str) -> Option<(u64, u64, u64)> {
    fn leading_number(part: &str) -> Option<u64> {
        let digits = part
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        digits.parse().ok()
    }
    let mut parts = version
        .split_whitespace()
        .next()?
        .trim_start_matches('v')
        .split('.');
    let major = leading_number(parts.next()?)?;
    let minor = leading_number(parts.next()?)?;
    let patch = leading_number(parts.next()?)?;
    Some((major, minor, patch))
}

fn check_claude_version(claude: &Path) -> Result<String, String> {
    let output = command_output(claude, &[OsStr::new("--version")])?;
    let (major, minor, patch) = parse_claude_version(&output)
        .ok_or_else(|| format!("could not parse Claude Code version {output:?}"))?;
    if (major, minor, patch) < MINIMUM_CLAUDE_VERSION {
        let (required_major, required_minor, required_patch) = MINIMUM_CLAUDE_VERSION;
        return Err(format!(
            "Claude Code {required_major}.{required_minor}.{required_patch} or newer is required so the per-server MCP timeout also floors the 30-minute stdio idle abort; found {output}. Upgrade Claude Code and rerun ego-chat setup-claude"
        ));
    }
    Ok(format!("{major}.{minor}.{patch}"))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo fmt && cargo test claude_version`
Expected: `test result: ok. 2 passed` (plus a `dead_code` warning for the two functions in the non-test build, which is expected until Task 4).

- [ ] **Step 5: Commit**

```bash
git add rust/main.rs
git commit -m "feat: gate Claude Code setup on the idle-floor release"
```

---

### Task 2: Read-only classification of the Claude Code user-scope entry

**Files:**
- Modify: `rust/main.rs` (functions above `fn doctor()`; tests inside `mod tests`)

- [ ] **Step 1: Write the failing test**

Add directly above `fn skill_installation_requires_force_for_different_managed_files()`:

```rust
    #[test]
    fn claude_doctor_status_distinguishes_missing_mismatched_and_timeout_problems() {
        let directory = TestDirectory::new();
        let executable = directory.0.join("ego-chat");
        let executable_json = serde_json::to_string(executable.to_str().expect("utf8 path"))
            .expect("encode executable");
        let config = directory.0.join(".claude.json");
        let status = |label: &str| {
            claude_server_status(&config, &executable)
                .unwrap_or_else(|error| panic!("inspect {label}: {error}"))
        };

        assert_eq!(status("missing file"), HostConfigStatus::Missing);
        fs::write(&config, "  \n").expect("seed blank file");
        assert_eq!(status("blank file"), HostConfigStatus::Missing);
        fs::write(
            &config,
            r#"{"mcpServers":{"other":{"type":"stdio","command":"other"}}}"#,
        )
        .expect("seed other server");
        assert_eq!(status("other server only"), HostConfigStatus::Missing);
        fs::write(
            &config,
            r#"{"mcpServers":{"ego_chat":{"type":"stdio","command":"someone-else","args":["mcp"],"timeout":29100000}}}"#,
        )
        .expect("seed foreign command");
        assert_eq!(status("foreign command"), HostConfigStatus::IdentityMismatch);
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"http","command":{executable_json},"args":["mcp"],"timeout":29100000}}}}}}"#
            ),
        )
        .expect("seed wrong transport");
        assert_eq!(status("wrong transport"), HostConfigStatus::IdentityMismatch);
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp","--verbose"],"timeout":29100000}}}}}}"#
            ),
        )
        .expect("seed wrong args");
        assert_eq!(status("wrong args"), HostConfigStatus::IdentityMismatch);
        fs::write(
            &config,
            format!(r#"{{"mcpServers":{{"ego_chat":{{"command":{executable_json},"args":["mcp"]}}}}}}"#),
        )
        .expect("seed missing timeout");
        assert_eq!(
            status("missing timeout"),
            HostConfigStatus::TimeoutMissingOrInvalid
        );
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp"],"timeout":"29100000"}}}}}}"#
            ),
        )
        .expect("seed string timeout");
        assert_eq!(
            status("string timeout"),
            HostConfigStatus::TimeoutMissingOrInvalid
        );
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp"],"timeout":600000}}}}}}"#
            ),
        )
        .expect("seed short timeout");
        assert_eq!(status("short timeout"), HostConfigStatus::TimeoutTooShort);
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp"],"env":{{}},"timeout":29100000}}}}}}"#
            ),
        )
        .expect("seed ready entry");
        assert_eq!(status("ready entry"), HostConfigStatus::Ready);
        fs::write(
            &config,
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"command":{executable_json},"args":["mcp"],"timeout":29160000}}}}}}"#
            ),
        )
        .expect("seed ready entry without type");
        assert_eq!(status("ready without type"), HostConfigStatus::Ready);

        fs::write(&config, "[]\n").expect("seed non-object");
        let error = claude_server_status(&config, &executable).expect_err("must reject an array");
        assert!(error.contains("must contain a JSON object"));
        fs::write(&config, "{not json").expect("seed broken json");
        let error = claude_server_status(&config, &executable).expect_err("must reject broken JSON");
        assert!(error.contains("could not parse"));

        assert!(
            host_config_problem(
                "Claude Code",
                "timeout",
                MCP_TOOL_TIMEOUT_MILLISECONDS,
                "milliseconds",
                HostConfigStatus::TimeoutTooShort,
            )
            .contains("Claude Code MCP server ego_chat has a too-short timeout")
        );
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test claude_doctor_status`
Expected: compile error `error[E0425]: cannot find function `claude_server_status``.

- [ ] **Step 3: Implement the classifier**

Add directly above `fn parse_claude_version(` (so the Claude functions stay together above `fn doctor()`):

```rust
fn claude_server_entry(config_path: &Path) -> Result<Option<JsonValue>, String> {
    let contents = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read {}: {error}", config_path.display())),
    };
    if contents.trim().is_empty() {
        return Ok(None);
    }
    let document = serde_json::from_str::<JsonValue>(&contents)
        .map_err(|error| format!("could not parse {}: {error}", config_path.display()))?;
    let root = document
        .as_object()
        .ok_or_else(|| format!("{} must contain a JSON object", config_path.display()))?;
    Ok(root
        .get("mcpServers")
        .and_then(|servers| servers.get(MCP_SERVER_NAME))
        .cloned())
}

fn claude_server_identity_matches(value: &JsonValue, executable: &str) -> bool {
    let Some(server) = value.as_object() else {
        return false;
    };
    let transport_matches = server
        .get("type")
        .is_none_or(|transport| transport.as_str() == Some("stdio"));
    let command_matches = server.get("command").and_then(JsonValue::as_str) == Some(executable);
    let args_match = server
        .get("args")
        .and_then(JsonValue::as_array)
        .map(|values| values.len() == 1 && values[0].as_str() == Some("mcp"))
        .unwrap_or(false);
    transport_matches && command_matches && args_match
}

fn claude_server_value_status(value: &JsonValue, executable: &str) -> HostConfigStatus {
    if !claude_server_identity_matches(value, executable) {
        return HostConfigStatus::IdentityMismatch;
    }
    let Some(timeout) = value.get("timeout").and_then(JsonValue::as_u64) else {
        return HostConfigStatus::TimeoutMissingOrInvalid;
    };
    if timeout < MCP_TOOL_TIMEOUT_MILLISECONDS {
        HostConfigStatus::TimeoutTooShort
    } else {
        HostConfigStatus::Ready
    }
}

fn claude_server_status(config_path: &Path, executable: &Path) -> Result<HostConfigStatus, String> {
    match claude_server_entry(config_path)? {
        None => Ok(HostConfigStatus::Missing),
        Some(server) => Ok(claude_server_value_status(
            &server,
            &path_bytes(executable)?,
        )),
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo fmt && cargo test claude_doctor_status`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add rust/main.rs
git commit -m "feat: classify the Claude Code user-scope MCP entry"
```

---

### Task 3: CLI-delegated configuration write with post-write verification

**Files:**
- Modify: `rust/main.rs` (functions above `fn doctor()`; tests inside `mod tests`)

- [ ] **Step 1: Add the fake Claude CLI helper and the failing tests**

Add inside `mod tests`, right after `fn write_fake_executable(...)`:

```rust
    /// A stand-in for the `claude` CLI: appends every argument vector to `log`
    /// and, when `applies_writes` is set, edits `config` the way the real CLI does
    /// (`add-json` stores the sixth argument under `mcpServers.ego_chat`,
    /// `remove` deletes the entry). Unrelated top-level content is preserved.
    fn fake_claude_cli(
        directory: &Path,
        name: &str,
        config: &Path,
        log: &Path,
        applies_writes: bool,
    ) -> PathBuf {
        let write_block = if applies_writes {
            format!(
                "case \"$2\" in\n  add-json) printf '{{\"mcpServers\":{{\"ego_chat\":%s}},\"unrelated\":true}}\\n' \"$6\" > '{config}' ;;\n  remove) printf '{{\"mcpServers\":{{}},\"unrelated\":true}}\\n' > '{config}' ;;\nesac\n",
                config = config.display()
            )
        } else {
            String::new()
        };
        write_fake_executable(
            &directory.join(name),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n{write_block}",
                log.display()
            ),
        )
    }

    fn expected_claude_entry(executable: &Path) -> String {
        format!(
            r#"{{"type":"stdio","command":{},"args":["mcp"],"timeout":{MCP_TOOL_TIMEOUT_MILLISECONDS}}}"#,
            serde_json::to_string(executable.to_str().expect("utf8 path")).expect("encode executable")
        )
    }

    fn read_lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .expect("read recorded invocations")
            .lines()
            .map(str::to_string)
            .collect()
    }
```

Add these tests directly above `fn skill_installation_requires_force_for_different_managed_files()`:

```rust
    #[test]
    fn claude_configuration_registers_a_fresh_user_scope_server_through_the_cli() {
        let directory = TestDirectory::new();
        let config = directory.0.join(".claude.json");
        let log = directory.0.join("claude-invocations.txt");
        let claude = fake_claude_cli(&directory.0, "claude", &config, &log, true);
        let executable = directory.0.join("bin/ego-chat");

        assert!(configure_claude(&config, &claude, &executable, false).expect("register server"));

        assert_eq!(
            read_lines(&log),
            [format!(
                "mcp add-json -s user {MCP_SERVER_NAME} {}",
                expected_claude_entry(&executable)
            )]
        );
        assert_eq!(
            claude_server_status(&config, &executable).expect("inspect configured file"),
            HostConfigStatus::Ready
        );
        let document = serde_json::from_str::<JsonValue>(
            &fs::read_to_string(&config).expect("read configured file"),
        )
        .expect("parse configured file");
        assert_eq!(document["unrelated"].as_bool(), Some(true));
        assert_eq!(
            document["mcpServers"][MCP_SERVER_NAME]["timeout"].as_u64(),
            Some(MCP_TOOL_TIMEOUT_MILLISECONDS)
        );
    }

    #[test]
    fn claude_configuration_repairs_an_owned_short_timeout_without_force() {
        let directory = TestDirectory::new();
        let config = directory.0.join(".claude.json");
        let log = directory.0.join("claude-invocations.txt");
        let claude = fake_claude_cli(&directory.0, "claude", &config, &log, true);
        let executable = directory.0.join("bin/ego-chat");
        let executable_json = serde_json::to_string(executable.to_str().expect("utf8 path"))
            .expect("encode executable");
        for seed in [
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp"],"timeout":600000}}}},"unrelated":true}}"#
            ),
            format!(
                r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{executable_json},"args":["mcp"]}}}},"unrelated":true}}"#
            ),
        ] {
            fs::write(&config, seed).expect("seed owned entry");
            let _ = fs::remove_file(&log);
            assert_ne!(
                claude_server_status(&config, &executable).expect("inspect seeded file"),
                HostConfigStatus::Ready
            );

            assert!(configure_claude(&config, &claude, &executable, false).expect("repair timeout"));

            assert_eq!(
                read_lines(&log),
                [
                    format!("mcp remove {MCP_SERVER_NAME} -s user"),
                    format!(
                        "mcp add-json -s user {MCP_SERVER_NAME} {}",
                        expected_claude_entry(&executable)
                    ),
                ]
            );
            assert_eq!(
                claude_server_status(&config, &executable).expect("inspect repaired file"),
                HostConfigStatus::Ready
            );
        }
    }

    #[test]
    fn claude_configuration_refuses_an_unowned_server_without_force() {
        let directory = TestDirectory::new();
        let config = directory.0.join(".claude.json");
        let log = directory.0.join("claude-invocations.txt");
        let claude = fake_claude_cli(&directory.0, "claude", &config, &log, true);
        let executable = directory.0.join("bin/ego-chat");
        fs::write(
            &config,
            r#"{"mcpServers":{"ego_chat":{"type":"stdio","command":"someone-else","args":["mcp"],"timeout":29100000}},"unrelated":true}"#,
        )
        .expect("seed foreign entry");

        let error = configure_claude(&config, &claude, &executable, false)
            .expect_err("must reject conflict");
        assert!(error.contains("different ego_chat"));
        assert!(!log.exists(), "the CLI must not run before the conflict check");
        assert!(
            fs::read_to_string(&config)
                .expect("read untouched file")
                .contains("someone-else")
        );

        assert!(configure_claude(&config, &claude, &executable, true).expect("replace with force"));
        assert_eq!(
            read_lines(&log),
            [
                format!("mcp remove {MCP_SERVER_NAME} -s user"),
                format!(
                    "mcp add-json -s user {MCP_SERVER_NAME} {}",
                    expected_claude_entry(&executable)
                ),
            ]
        );
        assert_eq!(
            claude_server_status(&config, &executable).expect("inspect replaced file"),
            HostConfigStatus::Ready
        );
    }

    #[test]
    fn claude_configuration_leaves_a_ready_server_untouched() {
        let directory = TestDirectory::new();
        let config = directory.0.join(".claude.json");
        let log = directory.0.join("claude-invocations.txt");
        let claude = fake_claude_cli(&directory.0, "claude", &config, &log, true);
        let executable = directory.0.join("bin/ego-chat");
        let longer = MCP_TOOL_TIMEOUT_MILLISECONDS + 60_000;
        let seed = format!(
            r#"{{"mcpServers":{{"ego_chat":{{"type":"stdio","command":{},"args":["mcp"],"env":{{"KEEP":"1"}},"timeout":{longer}}}}},"unrelated":true}}"#,
            serde_json::to_string(executable.to_str().expect("utf8 path")).expect("encode executable")
        );
        fs::write(&config, &seed).expect("seed ready entry");

        assert!(!configure_claude(&config, &claude, &executable, false).expect("no-op"));

        assert!(!log.exists(), "a ready entry must not invoke the CLI");
        assert_eq!(fs::read_to_string(&config).expect("read file"), seed);
    }

    #[test]
    fn claude_configuration_fails_closed_when_the_cli_does_not_write() {
        let directory = TestDirectory::new();
        let config = directory.0.join(".claude.json");
        let log = directory.0.join("claude-invocations.txt");
        let executable = directory.0.join("bin/ego-chat");

        let silent = fake_claude_cli(&directory.0, "claude-silent", &config, &log, false);
        let error = configure_claude(&config, &silent, &executable, false)
            .expect_err("must detect a missing entry after add-json");
        assert!(error.contains("did not leave"));
        assert!(error.contains("is missing"));
        assert!(!config.exists());

        let failing = write_fake_executable(
            &directory.0.join("claude-failing"),
            "#!/bin/sh\nprintf 'boom\\n' >&2\nexit 3\n",
        );
        let error = configure_claude(&config, &failing, &executable, false)
            .expect_err("must surface a non-zero exit");
        assert!(error.contains("mcp add-json exited with"));
        assert!(error.contains("boom"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test claude_configuration`
Expected: compile error `error[E0425]: cannot find function `configure_claude``.

- [ ] **Step 3: Implement the CLI runner and the writer**

Add directly above `fn parse_claude_version(`:

```rust
fn run_claude_mcp(claude: &Path, arguments: &[&str]) -> Result<(), String> {
    let output = Command::new(claude)
        .arg("mcp")
        .args(arguments)
        .output()
        .map_err(|error| format!("could not run {}: {error}", claude.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} mcp {} exited with {}: {}",
            claude.display(),
            arguments.first().copied().unwrap_or_default(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Registers this executable as the user-scope `ego_chat` stdio server. Reads
/// the config only to classify an existing entry and to verify the result;
/// every write is delegated to the Claude CLI so concurrent Claude Code
/// sessions are never clobbered. Returns whether a write happened.
fn configure_claude(
    config_path: &Path,
    claude: &Path,
    executable: &Path,
    force: bool,
) -> Result<bool, String> {
    let executable_text = path_bytes(executable)?;
    if let Some(existing) = claude_server_entry(config_path)? {
        let owned = claude_server_identity_matches(&existing, &executable_text);
        if !owned && !force {
            return Err(format!(
                "Claude Code already has a different {MCP_SERVER_NAME} MCP server; rerun with --force only after verifying that replacement is intended"
            ));
        }
        if owned && claude_server_value_status(&existing, &executable_text) == HostConfigStatus::Ready
        {
            return Ok(false);
        }
        run_claude_mcp(claude, &["remove", MCP_SERVER_NAME, "-s", "user"])?;
    }
    let entry = serde_json::json!({
        "type": "stdio",
        "command": executable_text,
        "args": ["mcp"],
        "timeout": MCP_TOOL_TIMEOUT_MILLISECONDS,
    });
    let entry = serde_json::to_string(&entry)
        .map_err(|error| format!("could not encode the {MCP_SERVER_NAME} MCP entry: {error}"))?;
    run_claude_mcp(claude, &["add-json", "-s", "user", MCP_SERVER_NAME, &entry])?;
    let status = claude_server_status(config_path, executable)?;
    if status != HostConfigStatus::Ready {
        return Err(format!(
            "claude mcp add-json did not leave {} ready: {}",
            config_path.display(),
            host_config_problem(
                "Claude Code",
                "timeout",
                MCP_TOOL_TIMEOUT_MILLISECONDS,
                "milliseconds",
                status,
            )
        ));
    }
    Ok(true)
}
```

Note: `serde_json::json!` keeps insertion order because `Cargo.toml` enables the `preserve_order` feature, so the emitted string is exactly `{"type":"stdio","command":"...","args":["mcp"],"timeout":29100000}`, which the tests assert.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo fmt && cargo test claude_configuration`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 5: Commit**

```bash
git add rust/main.rs
git commit -m "feat: register ego_chat with Claude Code through claude mcp"
```

---

### Task 4: Wire `setup-claude`, `doctor-claude`, and `install-claude-skill`

**Files:**
- Modify: `rust/main.rs`:
  - `ZCODE_SKILL_FILES` (line ~239) — add `CLAUDE_SKILL_FILES` after it
  - `struct InstallPaths` (line ~246) and `impl InstallPaths::discover` (line ~384)
  - `fn run()` (line ~271) and `fn print_help()` (line ~364)
  - `fn setup_zcode` (line ~512) — add `setup_claude` after it
  - `fn doctor_zcode` — add `doctor_claude` after it
  - tests `embedded_paths_are_relative_and_unique`, plus new tests

- [ ] **Step 1: Write the failing tests**

Extend `embedded_paths_are_relative_and_unique`: change

```rust
        for file in RUNTIME_FILES
            .iter()
            .chain(SKILL_FILES.iter())
            .chain(ZCODE_SKILL_FILES.iter())
        {
```

to

```rust
        for file in RUNTIME_FILES
            .iter()
            .chain(SKILL_FILES.iter())
            .chain(ZCODE_SKILL_FILES.iter())
            .chain(CLAUDE_SKILL_FILES.iter())
        {
```

Add directly above `fn skill_installation_requires_force_for_different_managed_files()`:

```rust
    #[test]
    fn claude_host_paths_follow_claude_config_dir() {
        let home = Path::new("/Users/tester");

        let (config, skill) = claude_host_paths(home, None);
        assert_eq!(config, PathBuf::from("/Users/tester/.claude.json"));
        assert_eq!(skill, PathBuf::from("/Users/tester/.claude/skills/ego-chat"));

        let (config, skill) = claude_host_paths(home, Some(Path::new("/Users/tester/claude-config")));
        assert_eq!(
            config,
            PathBuf::from("/Users/tester/claude-config/.claude.json")
        );
        assert_eq!(
            skill,
            PathBuf::from("/Users/tester/claude-config/skills/ego-chat")
        );
    }

    #[test]
    fn claude_skill_files_carry_only_the_skill_document() {
        assert_eq!(
            CLAUDE_SKILL_FILES.iter().map(|file| file.path).collect::<Vec<_>>(),
            ["SKILL.md"]
        );
        assert_eq!(CLAUDE_SKILL_FILES[0].bytes, SKILL_FILES[0].bytes);

        let directory = TestDirectory::new();
        let skill = directory.0.join("ego-chat");
        fs::create_dir_all(&skill).expect("create skill");
        fs::write(skill.join("SKILL.md"), "custom skill").expect("write custom skill");
        assert!(install_skill(&skill, CLAUDE_SKILL_FILES, false).is_err());
        install_skill(&skill, CLAUDE_SKILL_FILES, true).expect("force managed skill files");
        assert!(skill_matches(&skill, CLAUDE_SKILL_FILES));
        assert!(!skill.join("agents").exists());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --no-run`
Expected: compile error `error[E0425]: cannot find value `CLAUDE_SKILL_FILES`` / `cannot find function `claude_host_paths``.

- [ ] **Step 3: Add the embedded skill constant and the paths**

After `const ZCODE_SKILL_FILES: &[EmbeddedFile] = &[EmbeddedFile { ... }];` add:

```rust
const CLAUDE_SKILL_FILES: &[EmbeddedFile] = &[EmbeddedFile {
    path: "SKILL.md",
    bytes: include_bytes!("../skills/ego-chat/SKILL.md"),
}];
```

Change `struct InstallPaths` to:

```rust
#[derive(Clone, Debug)]
struct InstallPaths {
    claude_config: PathBuf,
    claude_skill_dir: PathBuf,
    codex_config: PathBuf,
    codex_skill_dir: PathBuf,
    runtime_dir: PathBuf,
    zcode_config: PathBuf,
    zcode_skill_dir: PathBuf,
}
```

Directly above `impl InstallPaths {` add:

```rust
/// Claude Code keeps its user-scope MCP config in `.claude.json` and personal
/// skills under `skills/`. `CLAUDE_CONFIG_DIR` relocates both; without it the
/// config sits in the home directory and skills under `~/.claude`.
fn claude_host_paths(home: &Path, config_dir: Option<&Path>) -> (PathBuf, PathBuf) {
    match config_dir {
        Some(directory) => (
            directory.join(".claude.json"),
            directory.join("skills").join("ego-chat"),
        ),
        None => (
            home.join(".claude.json"),
            home.join(".claude").join("skills").join("ego-chat"),
        ),
    }
}
```

In `InstallPaths::discover`, after the `zcode_home` binding add:

```rust
        let claude_config_dir = env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        let (claude_config, claude_skill_dir) =
            claude_host_paths(&home, claude_config_dir.as_deref());
```

and change the returned struct literal to:

```rust
        Ok(Self {
            claude_config,
            claude_skill_dir,
            codex_config: codex_home.join("config.toml"),
            codex_skill_dir: codex_home.join("skills").join("ego-chat"),
            runtime_dir: install_root.join(env!("CARGO_PKG_VERSION")),
            zcode_config: zcode_home.join("cli").join("config.json"),
            zcode_skill_dir: zcode_home.join("skills").join("ego-chat"),
        })
```

- [ ] **Step 4: Add `setup_claude` and `doctor_claude`**

Directly after `fn setup_zcode(...) { ... }` add:

```rust
fn setup_claude(force: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the Ego Lite integration currently supports macOS only".to_string());
    }
    let paths = InstallPaths::discover()?;
    let tools = Toolchain::discover(false)?;
    tools.validate(false)?;
    let claude = find_program("claude", "EGO_CHAT_CLAUDE")?;
    let claude_version = check_claude_version(&claude)?;
    install_runtime(&paths.runtime_dir, &tools, force)?;
    let redirected_launchers = redirect_stale_broker_launchers(&paths.runtime_dir)?;
    let handoff_status = handoff_installed_broker(&paths.runtime_dir, &tools)?;
    install_skill(&paths.claude_skill_dir, CLAUDE_SKILL_FILES, force)?;
    let executable = env::current_exe()
        .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
    let registered = configure_claude(&paths.claude_config, &claude, &executable, force)?;

    println!("Ego Chat runtime: {}", paths.runtime_dir.display());
    if handoff_status == "stopped" {
        println!("Stopped the idle stale Ego Chat broker before activating this runtime.");
    }
    if redirected_launchers > 0 {
        println!(
            "Redirected {redirected_launchers} older managed broker launcher(s) to this runtime."
        );
    }
    println!("Claude Code {claude_version} at {}", claude.display());
    println!("Claude Code skill: {}", paths.claude_skill_dir.display());
    if registered {
        println!(
            "Claude Code MCP server: {MCP_SERVER_NAME} registered in user scope with a {MCP_TOOL_TIMEOUT_MILLISECONDS} ms tool timeout in {}",
            paths.claude_config.display()
        );
    } else {
        println!(
            "Claude Code MCP server: {MCP_SERVER_NAME} was already configured in {}",
            paths.claude_config.display()
        );
    }
    println!(
        "Restart open Claude Code sessions and Claude.app, then run `claude mcp get {MCP_SERVER_NAME}` to verify the connection. The Claude.app Code tab uses this same configuration."
    );
    if tools.codex.is_none() {
        println!(
            "Codex was not found; Claude Code-owned reviews work, while broker-owned Codex convergence remains unavailable."
        );
    }
    Ok(())
}
```

Directly after `fn doctor_zcode(...) { ... }` add:

```rust
fn doctor_claude() -> Result<(), String> {
    let paths = InstallPaths::discover()?;
    let tools = Toolchain::discover(false)?;
    let mut failures = Vec::new();

    match tools.validate(false) {
        Ok(()) => println!("[ok] Node.js, npm, and ego-browser are available"),
        Err(error) => {
            println!("[fail] {error}");
            failures.push(error);
        }
    }
    if let Some(codex) = &tools.codex {
        match command_output(codex, &[OsStr::new("--version")]) {
            Ok(_) => println!("[ok] Codex is also available for broker-owned convergence"),
            Err(error) => println!(
                "[warn] Codex was detected but is not usable for optional broker-owned convergence: {error}"
            ),
        }
    }
    match find_program("claude", "EGO_CHAT_CLAUDE").and_then(|claude| check_claude_version(&claude))
    {
        Ok(version) => println!("[ok] Claude Code {version} is available"),
        Err(error) => {
            println!("[fail] {error}");
            failures.push(error);
        }
    }
    let runtime_installed = runtime_ready(&paths.runtime_dir);
    if runtime_installed {
        println!("[ok] Runtime {} is installed", paths.runtime_dir.display());
    } else {
        let message = format!("Runtime {} is not ready", paths.runtime_dir.display());
        println!("[fail] {message}");
        failures.push(message);
    }
    if runtime_installed {
        match inspect_installed_broker_runtime(&paths.runtime_dir, &tools) {
            Ok(status) if status == "current" => {
                println!("[ok] The authoritative broker matches the installed runtime")
            }
            Ok(status) if status == "not_running" => {
                println!("[ok] No authoritative Ego Chat broker is currently running")
            }
            Ok(_) => {
                let message = "A stale authoritative broker is still running; run ego-chat setup-claude after its active work stops".to_string();
                println!("[fail] {message}");
                failures.push(message);
            }
            Err(error) => {
                println!("[fail] {error}");
                failures.push(error);
            }
        }
    }
    if skill_matches(&paths.claude_skill_dir, CLAUDE_SKILL_FILES) {
        println!(
            "[ok] Claude Code skill {} is installed",
            paths.claude_skill_dir.display()
        );
    } else {
        let message = format!(
            "Claude Code skill {} is missing or differs",
            paths.claude_skill_dir.display()
        );
        println!("[fail] {message}");
        failures.push(message);
    }
    let executable = env::current_exe()
        .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
    let server_status = claude_server_status(&paths.claude_config, &executable)?;
    if server_status == HostConfigStatus::Ready {
        println!(
            "[ok] Claude Code MCP server {MCP_SERVER_NAME} points to this executable with the required tool timeout"
        );
    } else {
        let message = host_config_problem(
            "Claude Code",
            "timeout",
            MCP_TOOL_TIMEOUT_MILLISECONDS,
            "milliseconds",
            server_status,
        );
        println!("[fail] {message}");
        failures.push(message);
    }

    if failures.is_empty() {
        println!(
            "Ego Chat is ready. Restart open Claude Code sessions and Claude.app after configuration changes."
        );
        Ok(())
    } else {
        Err(format!(
            "doctor-claude found {} problem(s); run ego-chat setup-claude",
            failures.len()
        ))
    }
}
```

- [ ] **Step 5: Wire the commands and the help text**

In `fn run()`, after the `"setup-zcode" => { ... }` arm add:

```rust
        "setup-claude" => {
            args.remove(0);
            let force = parse_force_only(&args, "setup-claude")?;
            setup_claude(force)?;
            Ok(0)
        }
```

After the `"install-zcode-skill" => { ... }` arm add:

```rust
        "install-claude-skill" => {
            args.remove(0);
            let force = parse_force_only(&args, "install-claude-skill")?;
            let paths = InstallPaths::discover()?;
            install_skill(&paths.claude_skill_dir, CLAUDE_SKILL_FILES, force)?;
            println!(
                "Installed Claude Code skill at {}",
                paths.claude_skill_dir.display()
            );
            Ok(0)
        }
```

After the `"doctor-zcode" => { ... }` arm add:

```rust
        "doctor-claude" => {
            doctor_claude()?;
            Ok(0)
        }
```

Replace the body of `fn print_help()` with:

```rust
fn print_help() {
    println!(
        "Ego Chat portable launcher\n\n\
Usage:\n  \
  ego-chat setup [--force] [--skip-codex-config]\n  \
  ego-chat setup-zcode [--force]\n  \
  ego-chat setup-claude [--force]\n  \
  ego-chat install-skill [--force]\n  \
  ego-chat install-zcode-skill [--force]\n  \
  ego-chat install-claude-skill [--force]\n  \
  ego-chat doctor\n  \
  ego-chat doctor-zcode\n  \
  ego-chat doctor-claude\n  \
  ego-chat receipt-signer-enroll\n  \
  ego-chat broker-status\n  \
  ego-chat mcp\n  \
  ego-chat <broker-cli-command> [args...]\n\n\
setup configures Codex; setup-zcode configures ZCode; setup-claude configures Claude Code and the Claude.app Code tab. All three install the same embedded runtime and host skill, then register this executable as the ego_chat MCP server.\n\
All other commands are forwarded to the qualified Ego Chat broker CLI."
    );
}
```

- [ ] **Step 6: Run the full Rust checks**

Run: `cargo fmt && cargo clippy --all-targets && cargo test`
Expected: clippy prints no warnings (the `dead_code` warnings from Tasks 1 to 3 are gone); `test result: ok. 30 passed` (20 baseline + 2 + 1 + 5 + 2).

Run: `cargo run --bin ego-chat -- help`
Expected: the usage block lists `setup-claude`, `install-claude-skill`, and `doctor-claude`.

- [ ] **Step 7: Commit**

```bash
git add rust/main.rs
git commit -m "feat: add setup-claude and doctor-claude host commands"
```

---

### Task 5: Skill text for Claude Code

**Files:**
- Modify: `skills/ego-chat/SKILL.md` (lines 3, 8, 34, after 40, after 52, 82)

The Rust binary embeds this file, so Task 4's `claude_skill_files_carry_only_the_skill_document` and `embedded_paths_are_relative_and_unique` keep passing regardless of content; there is no separate unit test for prose.

- [ ] **Step 1: Edit the frontmatter description (line 3)**

Replace `between Codex or ZCode and the ChatGPT web client in Ego Browser` with `between Codex, ZCode, or Claude Code and the ChatGPT web client in Ego Browser`.

- [ ] **Step 2: Edit the repair hint (line 8)**

Replace `tell the user to run `ego-chat setup` for Codex or `ego-chat setup-zcode` for ZCode and restart that host.` with `tell the user to run `ego-chat setup` for Codex, `ego-chat setup-zcode` for ZCode, or `ego-chat setup-claude` for Claude Code and restart that host.`

- [ ] **Step 3: Edit the concurrent-use sentence (line 34)**

Replace `Codex, ChatGPT.app, and ZCode may use independent conversations concurrently` with `Codex, ChatGPT.app, ZCode, and Claude Code may use independent conversations concurrently`.

- [ ] **Step 4: Add the Claude Code wait paragraph**

Insert as a new paragraph after line 40 (the paragraph ending `reattach to that workflow rather than resending.`) and before the `Large responses may return` paragraph:

```markdown
In Claude Code, a tool call that runs past two minutes is moved to a background task and its result arrives as a notification in the same session. Wait for that notification; do not call `workflow_status` or `await_workflow` from extra turns while it is pending, and do not start a second workflow. The per-server `timeout` that `ego-chat setup-claude` writes bounds that call at eight hours plus five minutes and, on Claude Code 2.1.203 or newer, also floors the stdio idle abort, so a silent `token_saver` wait is safe there.
```

- [ ] **Step 5: Add the Claude Code loop-choice bullet**

Insert after the `- From ZCode, use detached convergence only when ...` bullet (line 52):

```markdown
- From Claude Code, use detached convergence only when handing implementation to the broker-owned Codex App Server task is acceptable and that runtime is available. Otherwise use the current-host fallback and keep the Claude Code turn alive, including while a backgrounded call is pending; Ego Chat does not claim it can externally wake a Claude Code session whose turn has ended.
```

- [ ] **Step 6: Edit the detached-convergence sentence (line 82)**

Replace `setup configures Codex and ZCode host tool caps five minutes longer.` with `setup configures Codex, ZCode, and Claude Code host tool caps five minutes longer.`

- [ ] **Step 7: Verify**

Run: `wc -l skills/ego-chat/SKILL.md && grep -c 'Claude Code' skills/ego-chat/SKILL.md && cargo test embedded_paths claude_skill_files`
Expected: line count under 500 (about 83); at least 6 matches; `test result: ok. 2 passed`.

- [ ] **Step 8: Commit**

```bash
git add skills/ego-chat/SKILL.md
git commit -m "docs: teach the ego-chat skill about Claude Code hosts"
```

---

### Task 6: Facade and daemon host strings

**Files:**
- Modify: `src/mcp-server.mjs:122` and `src/mcp-server.mjs:710`
- Modify: `src/ipc-client.mjs:179`
- Modify: `bin/ego-chatd.mjs:29` and `bin/ego-chatd.mjs:160`

No test asserts on these strings (`grep -rn 'Restart Codex' test/` is empty), so this task is text-only and verified by lint and the existing suites.

- [ ] **Step 1: Update the guidance strings**

`src/mcp-server.mjs:122`: replace `Codex and ZCode share one authoritative broker and do not automatically receive separate bindings or task spaces.` with `Codex, ZCode, and Claude Code share one authoritative broker and do not automatically receive separate bindings or task spaces.`

`src/mcp-server.mjs:710`: replace `Review one candidate from the current ZCode, Codex, or compatible host against an immutable target.` with `Review one candidate from the current ZCode, Codex, Claude Code, or compatible host against an immutable target.`

`src/ipc-client.mjs:179`: replace `Restart Codex and ZCode before starting another durable operation.` with `Restart Codex, ZCode, and Claude Code before starting another durable operation.`

`bin/ego-chatd.mjs:29`: replace `Restart Codex and ZCode before starting the canonical broker generation.` with `Restart Codex, ZCode, and Claude Code before starting the canonical broker generation.`

`bin/ego-chatd.mjs:160`: replace `Restart Codex and ZCode before retrying.` with `Restart Codex, ZCode, and Claude Code before retrying.`

- [ ] **Step 2: Verify with lint and the affected suites**

Run: `grep -rn 'Codex and ZCode' src bin skills` 
Expected: no output.

Run: `npm run lint`
Expected: exit 0, no findings.

Run: `node --test --test-reporter=spec test/mcp-recovery.test.mjs test/runtime-handoff.test.mjs test/store-broker.test.mjs`
Expected: `fail 0`.

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server.mjs src/ipc-client.mjs bin/ego-chatd.mjs
git commit -m "docs: name Claude Code in host restart guidance"
```

---

### Task 7: Documentation and package metadata

**Files:**
- Modify: `README.md` (lines 3, 130, 132, 140-141, 151, 153-160, after 181, 188-200, 412, before 440, 440, 442, 444, 618, after 624)
- Modify: `CONTINUITY.md` (lines 7 and 69)
- Modify: `package.json:5` (description)
- Modify: `Cargo.toml` (description and keywords)

Line numbers refer to the file as it is on `main` at 0.2.22; edit by matching the quoted text.

- [ ] **Step 1: README intro and concurrent-host paragraphs**

Line 3: replace `for Codex- or ZCode-to-ChatGPT collaboration through Ego Lite` with `for Codex-, ZCode-, or Claude Code-to-ChatGPT collaboration through Ego Lite`.

Line 130: replace `Codex.app and ZCode.app share one authoritative Ego Chat broker` with `Codex.app, ZCode.app, and Claude Code share one authoritative Ego Chat broker`.

Line 132: replace `so Codex and ZCode queue rather than racing Ego Lite's global automation channel` with `so Codex, ZCode, and Claude Code queue rather than racing Ego Lite's global automation channel`.

- [ ] **Step 2: README requirements and installation**

After line 141 (`- ZCode for a ZCode-owned implementation/review loop; Codex is optional on a ZCode-only installation.`) add:

```markdown
- Claude Code 2.1.203 or newer for a Claude Code-owned implementation/review loop, which also covers the Claude.app Code tab; Codex is optional on a Claude-only installation.
```

Line 151: replace `automatic Codex or ZCode MCP configuration` with `automatic Codex, ZCode, or Claude Code MCP configuration`.

Line 153: replace `From a local checkout, configure either or both clients:` with `From a local checkout, configure any of the clients:` and change the block that follows to:

```sh
cargo install --path /absolute/path/to/ego-chat --locked
ego-chat setup
ego-chat doctor
ego-chat setup-zcode
ego-chat doctor-zcode
ego-chat setup-claude
ego-chat doctor-claude
```

After line 181 (the paragraph starting `Restart ZCode.app after setup`) insert:

```markdown
`ego-chat setup-claude` uses Claude Code's native user-level surfaces and also covers the Claude.app Code tab:

- installs `SKILL.md` under `~/.claude/skills/ego-chat`, or under `$CLAUDE_CONFIG_DIR/skills/ego-chat` when that variable relocates the Claude home directory;
- registers the absolute installed executable with `args: ["mcp"]` as the user-scope `ego_chat` stdio server through `claude mcp add-json --scope user`, with a per-server `timeout` of 29,100,000 ms: the eight-hour attachment plus five minutes of host transport margin. Setup never rewrites `.claude.json` itself; it reads the file to detect a conflicting entry, delegates the write to the Claude CLI, and re-reads the file to verify the result, which `doctor-claude` also validates read-only;
- requires Claude Code 2.1.203 or newer, because from that version the per-server timeout also floors the 30-minute stdio idle abort that would otherwise end a silent Token-Saver wait;
- does not require Codex for Claude Code-owned review cycles; broker-owned Codex convergence remains available when Codex is installed.

Restart open Claude Code sessions and Claude.app after setup and verify with `claude mcp get ego_chat`, which reports the executable and the timeout. Claude Code moves any tool call that runs past two minutes to a background task and delivers its result as a notification, which suits Ego Chat's single long wait. The Claude.app Code tab loads the same user-scope server and personal skill; the Claude.app chat surface is not configured because it cannot load the skill from disk, has no documented long-call timeout, and a `claude_desktop_config.json` entry would override the timeout-carrying definition for the Code tab. A conflicting `ego_chat` server or skill is never replaced without explicit `--force`.
```

In both install blocks (lines 188-192 and 197-201), after `ego-chat setup-zcode` add:

```sh
# Or, for Claude Code:
ego-chat setup-claude
```

- [ ] **Step 3: README MCP configuration and skill sections**

Line 412: replace `## Codex and ZCode MCP configuration` with `## Codex, ZCode, and Claude Code MCP configuration`.

Before line 440 (`Both values are eight hours plus five minutes ...`) insert:

````markdown
For development directly from this checkout, register the facade with Claude Code's own CLI in user scope:

```sh
claude mcp add-json --scope user ego_chat '{"type":"stdio","command":"node","args":["/absolute/path/to/ego-chat/bin/ego-chat-mcp.mjs"],"timeout":29100000}'
```

````

Line 440: replace `Both values are eight hours plus five minutes of host transport margin.` with `All three values are eight hours plus five minutes of host transport margin.`

Line 442: replace `## Codex and ZCode skill` with `## Codex, ZCode, and Claude Code skill`.

Line 444: replace `` `ego-chat setup` installs the Codex copy, while `ego-chat setup-zcode` installs the ZCode copy. `` with `` `ego-chat setup` installs the Codex copy, `ego-chat setup-zcode` the ZCode copy, and `ego-chat setup-claude` the Claude Code copy. ``

- [ ] **Step 4: README not-yet-supported list**

Line 618: replace `adopting its private `/c/` URL from Codex or ZCode.` with `adopting its private `/c/` URL from Codex, ZCode, or Claude Code.`

After line 624 (`- Externally waking or resuming a ZCode task after ZCode exits; ...`) add:

```markdown
- Externally waking a Claude Code session after its turn ends; Claude Code-owned loops remain continuous while the tool call, or the background task Claude Code moves it to, is still pending.
- The Claude.app chat surface; only Claude Code and the Claude.app Code tab are configured, because the chat surface cannot load the skill from disk and has no documented long-call timeout.
- A Claude-owned implementing agent for detached convergence; broker-owned convergence still uses the Codex App Server.
```

- [ ] **Step 5: CONTINUITY.md**

Line 7: replace `Codex or ZCode remains side A` with `Codex, ZCode, or Claude Code remains side A`.

Line 69: replace `Codex and ZCode setup configure a matching eight-hour-plus-five-minute MCP tool cap` with `Codex, ZCode, and Claude Code setup configure a matching eight-hour-plus-five-minute MCP tool cap`, and `A fully exited current-host Codex or ZCode task still cannot be externally awakened` with `A fully exited current-host Codex, ZCode, or Claude Code task still cannot be externally awakened`.

- [ ] **Step 6: Package metadata**

`package.json`: replace `"description": "Durable Codex, ZCode, and ChatGPT handoffs through Ego Browser",` with `"description": "Durable Codex, ZCode, Claude Code, and ChatGPT handoffs through Ego Browser",`.

`Cargo.toml`: replace `description = "Portable launcher for durable Codex, ZCode, and ChatGPT review loops through Ego Browser"` with `description = "Portable launcher for durable Codex, ZCode, Claude Code, and ChatGPT review loops through Ego Browser"`, and replace `keywords = ["codex", "zcode", "chatgpt", "mcp", "browser"]` with `keywords = ["codex", "zcode", "claude", "chatgpt", "mcp"]` (crates.io allows at most five keywords, so `browser` gives way to `claude`).

- [ ] **Step 7: Verify**

Run: `grep -n 'Codex or ZCode\|Codex and ZCode' README.md CONTINUITY.md`
Expected: no output.

Run: `cargo test release_version_surfaces && cargo package --list --allow-dirty | grep -c 'skills/ego-chat/SKILL.md'`
Expected: `1 passed`; `1`.

- [ ] **Step 8: Commit**

```bash
git add README.md CONTINUITY.md package.json Cargo.toml
git commit -m "docs: document Claude Code and Claude.app Code tab support"
```

---

### Task 8: Deterministic verification, live install, and skill refresh on this Mac

**Files:** none modified; this task produces evidence.

- [ ] **Step 1: Full deterministic suites**

Run: `cargo fmt --check && cargo clippy --all-targets && cargo test`
Expected: fmt clean, no clippy warnings, `test result: ok. 30 passed`.

Run: `npm run lint && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: lint exit 0; `ℹ fail 0`.

- [ ] **Step 2: Confirm the broker is idle before touching the installed runtime**

Run: `ego-chat broker-status`
Expected: JSON with no running workflows. If any workflow is `running`, `human_required`, or paused, stop here and wait: `setup-claude` reinstalls the shared 0.2.22 runtime, and the broker handoff only proceeds for an idle broker.

- [ ] **Step 3: Install the launcher and run the Claude setup**

Run: `cargo install --path . --locked`
Expected: `Replacing /Users/xicao/.cargo/bin/ego-chat` ... `Replaced package ego-chat v0.2.22`.

Run: `ego-chat setup-claude`
Expected output (paths may differ):

```
Ego Chat runtime: /Users/xicao/Library/Application Support/Ego Chat/runtime/0.2.22
Claude Code 2.1.261 at /Users/xicao/.local/bin/claude
Claude Code skill: /Users/xicao/.claude/skills/ego-chat
Claude Code MCP server: ego_chat registered in user scope with a 29100000 ms tool timeout in /Users/xicao/.claude/.claude.json
Restart open Claude Code sessions and Claude.app, then run `claude mcp get ego_chat` to verify the connection. The Claude.app Code tab uses this same configuration.
```

Run: `ego-chat doctor-claude`
Expected: every line `[ok]`, ending `Ego Chat is ready. Restart open Claude Code sessions and Claude.app after configuration changes.`

Run: `claude mcp get ego_chat`
Expected: `Scope: User config`, `Type: stdio`, `Command: /Users/xicao/.cargo/bin/ego-chat`, `Args: mcp`, `Timeout: 29100000ms`, `Status: ✔ Connected`.

Run: `ego-chat setup-claude`
Expected: second run prints `Claude Code MCP server: ego_chat was already configured in ...` and makes no CLI write.

- [ ] **Step 4: Refresh the other installed skill copies so they match the new SKILL.md**

Run: `ego-chat install-skill --force && ego-chat doctor`
Expected: `Installed Codex skill at /Users/xicao/.codex/skills/ego-chat`; doctor ends `Ego Chat is ready.`

Run: `test -d ~/.zcode/skills/ego-chat && ego-chat install-zcode-skill --force && ego-chat doctor-zcode || echo "no ZCode skill installed; skipping"`
Expected: either the ZCode skill is refreshed and doctor-zcode passes, or the skip message.

Run: `diff ~/.claude/skills/ego-chat/SKILL.md skills/ego-chat/SKILL.md && diff ~/.codex/skills/ego-chat/SKILL.md skills/ego-chat/SKILL.md && echo "skills in sync"`
Expected: `skills in sync`.

- [ ] **Step 5: Live ChatGPT round trip from Claude Code (needs the user's go-ahead)**

This step creates one new ChatGPT conversation in Ego Browser under a separate binding and spends one strongest-model turn, so run it only after the user confirms. From a fresh interactive Claude Code session in this repo, ask:

> Use the ego-chat skill. Call `ego_exchange_and_wait` with `bindingKey: "claude-code-live-check"`, `waitMode: "token_saver"`, a prompt that asks ChatGPT to think carefully for at least three minutes before answering "What are the three most important properties of an at-most-once browser send?", a unique `EGO_CHAT_` turn marker, and a distinct terminal marker. Report the workflow ID and the first 200 characters of the response.

Expected: after about two minutes Claude Code reports the call moved to a background task; the result later arrives as a notification with the captured response and no second Send; `ego-chat workflow-status <id>` shows one confirmed send and one captured response. Do the same once from the Claude.app Code tab to confirm the skill and server are visible there.

- [ ] **Step 6: Record the evidence**

Append the observed outputs of Steps 1 to 4 (and 5 if run) to the pull-request description draft in `docs/superpowers/plans/2026-09-10-claude-code-host-support.md` under a `## Evidence` heading, then commit:

```bash
git add docs/superpowers/plans/2026-09-10-claude-code-host-support.md
git commit -m "docs: record Claude Code host verification evidence"
```

---

### Task 9: External review and branch finish

- [ ] **Step 1: Codex review of the branch**

Run: `git fetch origin main:main && codex review --base main`
If the output contains `hit your usage limit`, `5-hour message limit`, `rate limit`, `too many requests`, or `429`, run `glm-review --base main` instead and note that GLM saw only the diff.

- [ ] **Step 2: Address findings**

Fix every confirmed finding on the branch with its own conventional commit, re-run `cargo test` and the affected Node suites, and re-run the review until it reports nothing actionable.

- [ ] **Step 3: Finish the branch**

Use the superpowers:finishing-a-development-branch skill: present merge / pull request / keep-branch options to the user. The repo convention is a pull request into `main`.

## Evidence

Recorded 2026-09-10 on the development Mac (Claude Code 2.1.267, Codex and ZCode also installed).

Deterministic suites in the worktree: `cargo fmt --check` clean; `cargo clippy --all-targets` zero warnings; `cargo test` 33 passed, 0 failed; `npm run lint` exit 0; `npm test` 695 tests, 694 pass, 0 fail.

Live install (`cargo install --path . --locked`, then the host commands):

```
Ego Chat runtime: /Users/xicao/Library/Application Support/Ego Chat/runtime/0.2.22
Claude Code 2.1.267 at /Users/xicao/.local/bin/claude
Claude Code skill: /Users/xicao/.claude/skills/ego-chat
Claude Code MCP server: ego_chat registered in user scope with a 29100000 ms tool timeout in /Users/xicao/.claude/.claude.json
```

`ego-chat doctor-claude` reported every check `[ok]`, including the desktop-config shadow check. `claude mcp get ego_chat` reported `Status: ✔ Connected`, `Command: /Users/xicao/.cargo/bin/ego-chat`, `Args: mcp`, `Timeout: 29100000ms`. A second `ego-chat setup-claude` reported the server was already configured and made no CLI write. `ego-chat install-skill --force` plus `ego-chat doctor`, and `ego-chat install-zcode-skill --force` plus `ego-chat doctor-zcode`, both passed, and all three installed `SKILL.md` copies match the branch. The live ChatGPT round trip (Task 8, step 5) was not run; it needs the user's go-ahead because it creates a conversation and spends a strongest-model turn.

A fresh headless Claude Code session (`claude -p --allowedTools mcp__ego_chat__ego_get_conversation`) loaded the user-scope server and returned the bound `ego-chat-main` binding (state `bound`, revision 44, 52 messages) in about 16 seconds without any Send. The Claude Code session that ran `setup-claude` did not see the new server until restarted, as expected: user-scope MCP servers connect at session start.
