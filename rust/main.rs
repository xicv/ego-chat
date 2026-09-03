use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::{Map as JsonMap, Value as JsonValue};
use toml_edit::{Array, DocumentMut, Item, Table, value};

const MINIMUM_NODE_MAJOR: u64 = 24;
const RUNTIME_MARKER: &str = ".ego-chat-runtime-version";
const MCP_SERVER_NAME: &str = "ego_chat";
const MCP_TOOL_TIMEOUT_SECONDS: i64 = 21_900;
const MCP_TOOL_TIMEOUT_MILLISECONDS: u64 = 21_900_000;
const COCO_MCP_END_MARKER: &str = "# --- end coco MCP server ---";

struct EmbeddedFile {
    path: &'static str,
    bytes: &'static [u8],
}

const RUNTIME_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        path: "package.json",
        bytes: include_bytes!("../package.json"),
    },
    EmbeddedFile {
        path: "package-lock.json",
        bytes: include_bytes!("../package-lock.json"),
    },
    EmbeddedFile {
        path: "bin/ego-chat-mcp.mjs",
        bytes: include_bytes!("../bin/ego-chat-mcp.mjs"),
    },
    EmbeddedFile {
        path: "bin/ego-chat.mjs",
        bytes: include_bytes!("../bin/ego-chat.mjs"),
    },
    EmbeddedFile {
        path: "bin/ego-chatd.mjs",
        bytes: include_bytes!("../bin/ego-chatd.mjs"),
    },
    EmbeddedFile {
        path: "src/app-server-client.mjs",
        bytes: include_bytes!("../src/app-server-client.mjs"),
    },
    EmbeddedFile {
        path: "src/auth-token.mjs",
        bytes: include_bytes!("../src/auth-token.mjs"),
    },
    EmbeddedFile {
        path: "src/broker-lease.mjs",
        bytes: include_bytes!("../src/broker-lease.mjs"),
    },
    EmbeddedFile {
        path: "src/broker.mjs",
        bytes: include_bytes!("../src/broker.mjs"),
    },
    EmbeddedFile {
        path: "src/config.mjs",
        bytes: include_bytes!("../src/config.mjs"),
    },
    EmbeddedFile {
        path: "src/constants.mjs",
        bytes: include_bytes!("../src/constants.mjs"),
    },
    EmbeddedFile {
        path: "src/convergence.mjs",
        bytes: include_bytes!("../src/convergence.mjs"),
    },
    EmbeddedFile {
        path: "src/ego-adapter.mjs",
        bytes: include_bytes!("../src/ego-adapter.mjs"),
    },
    EmbeddedFile {
        path: "src/ego-driver-source.mjs",
        bytes: include_bytes!("../src/ego-driver-source.mjs"),
    },
    EmbeddedFile {
        path: "src/errors.mjs",
        bytes: include_bytes!("../src/errors.mjs"),
    },
    EmbeddedFile {
        path: "src/ipc-client.mjs",
        bytes: include_bytes!("../src/ipc-client.mjs"),
    },
    EmbeddedFile {
        path: "src/ipc-server.mjs",
        bytes: include_bytes!("../src/ipc-server.mjs"),
    },
    EmbeddedFile {
        path: "src/mcp-server.mjs",
        bytes: include_bytes!("../src/mcp-server.mjs"),
    },
    EmbeddedFile {
        path: "src/runtime-handoff.mjs",
        bytes: include_bytes!("../src/runtime-handoff.mjs"),
    },
    EmbeddedFile {
        path: "src/store.mjs",
        bytes: include_bytes!("../src/store.mjs"),
    },
    EmbeddedFile {
        path: "src/task-domain.mjs",
        bytes: include_bytes!("../src/task-domain.mjs"),
    },
    EmbeddedFile {
        path: "src/task-fakes.mjs",
        bytes: include_bytes!("../src/task-fakes.mjs"),
    },
    EmbeddedFile {
        path: "src/task-spine.mjs",
        bytes: include_bytes!("../src/task-spine.mjs"),
    },
    EmbeddedFile {
        path: "src/task-store.mjs",
        bytes: include_bytes!("../src/task-store.mjs"),
    },
    EmbeddedFile {
        path: "src/upgrade-dispatch.mjs",
        bytes: include_bytes!("../src/upgrade-dispatch.mjs"),
    },
    EmbeddedFile {
        path: "src/validation.mjs",
        bytes: include_bytes!("../src/validation.mjs"),
    },
];

const SKILL_FILES: &[EmbeddedFile] = &[
    EmbeddedFile {
        path: "SKILL.md",
        bytes: include_bytes!("../skills/ego-chat/SKILL.md"),
    },
    EmbeddedFile {
        path: "agents/openai.yaml",
        bytes: include_bytes!("../skills/ego-chat/agents/openai.yaml"),
    },
];

const ZCODE_SKILL_FILES: &[EmbeddedFile] = &[EmbeddedFile {
    path: "SKILL.md",
    bytes: include_bytes!("../skills/ego-chat/SKILL.md"),
}];

#[derive(Clone, Debug)]
struct InstallPaths {
    codex_config: PathBuf,
    codex_skill_dir: PathBuf,
    runtime_dir: PathBuf,
    zcode_config: PathBuf,
    zcode_skill_dir: PathBuf,
}

#[derive(Clone, Debug)]
struct Toolchain {
    codex: Option<PathBuf>,
    ego_browser: PathBuf,
    node: PathBuf,
    npm: PathBuf,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("ego-chat: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let mut args = env::args_os().skip(1).collect::<Vec<_>>();
    let command = args
        .first()
        .and_then(|value| value.to_str())
        .unwrap_or("help");

    match command {
        "help" | "--help" | "-h" => {
            print_help();
            Ok(0)
        }
        "version" | "--version" | "-V" => {
            println!("ego-chat {}", env!("CARGO_PKG_VERSION"));
            Ok(0)
        }
        "setup" => {
            args.remove(0);
            let flags = parse_setup_flags(&args)?;
            setup(flags.force, !flags.skip_codex_config)?;
            Ok(0)
        }
        "setup-zcode" => {
            args.remove(0);
            let force = parse_force_only(&args, "setup-zcode")?;
            setup_zcode(force)?;
            Ok(0)
        }
        "install-skill" => {
            args.remove(0);
            let force = parse_force_only(&args, "install-skill")?;
            let paths = InstallPaths::discover()?;
            install_skill(&paths.codex_skill_dir, SKILL_FILES, force)?;
            println!(
                "Installed Codex skill at {}",
                paths.codex_skill_dir.display()
            );
            Ok(0)
        }
        "install-zcode-skill" => {
            args.remove(0);
            let force = parse_force_only(&args, "install-zcode-skill")?;
            let paths = InstallPaths::discover()?;
            install_skill(&paths.zcode_skill_dir, ZCODE_SKILL_FILES, force)?;
            println!(
                "Installed ZCode skill at {}",
                paths.zcode_skill_dir.display()
            );
            Ok(0)
        }
        "doctor" => {
            doctor()?;
            Ok(0)
        }
        "doctor-zcode" => {
            doctor_zcode()?;
            Ok(0)
        }
        "mcp" => {
            args.remove(0);
            proxy_node("bin/ego-chat-mcp.mjs", &args)
        }
        _ => proxy_node("bin/ego-chat.mjs", &args),
    }
}

#[derive(Default)]
struct SetupFlags {
    force: bool,
    skip_codex_config: bool,
}

fn parse_setup_flags(args: &[OsString]) -> Result<SetupFlags, String> {
    let mut flags = SetupFlags::default();
    for arg in args {
        match arg.to_str() {
            Some("--force") => flags.force = true,
            Some("--skip-codex-config") => flags.skip_codex_config = true,
            Some(value) => return Err(format!("unknown setup option {value:?}")),
            None => return Err("setup options must be valid UTF-8".to_string()),
        }
    }
    Ok(flags)
}

fn parse_force_only(args: &[OsString], command: &str) -> Result<bool, String> {
    match args {
        [] => Ok(false),
        [value] if value == "--force" => Ok(true),
        _ => Err(format!("{command} accepts only the optional --force flag")),
    }
}

fn print_help() {
    println!(
        "Ego Chat portable launcher\n\n\
Usage:\n  \
  ego-chat setup [--force] [--skip-codex-config]\n  \
  ego-chat setup-zcode [--force]\n  \
  ego-chat install-skill [--force]\n  \
  ego-chat install-zcode-skill [--force]\n  \
  ego-chat doctor\n  \
  ego-chat doctor-zcode\n  \
  ego-chat broker-status\n  \
  ego-chat mcp\n  \
  ego-chat <broker-cli-command> [args...]\n\n\
setup configures Codex; setup-zcode configures ZCode. Both install the same embedded runtime and host skill, then register this executable as the ego_chat MCP server.\n\
All other commands are forwarded to the qualified Ego Chat broker CLI."
    );
}

impl InstallPaths {
    fn discover() -> Result<Self, String> {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        let codex_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let zcode_home = env::var_os("ZCODE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".zcode"));
        let install_root = env::var_os("EGO_CHAT_INSTALL_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home.join("Library")
                    .join("Application Support")
                    .join("Ego Chat")
                    .join("runtime")
            });
        Ok(Self {
            codex_config: codex_home.join("config.toml"),
            codex_skill_dir: codex_home.join("skills").join("ego-chat"),
            runtime_dir: install_root.join(env!("CARGO_PKG_VERSION")),
            zcode_config: zcode_home.join("cli").join("config.json"),
            zcode_skill_dir: zcode_home.join("skills").join("ego-chat"),
        })
    }
}

impl Toolchain {
    fn discover(require_codex: bool) -> Result<Self, String> {
        Ok(Self {
            codex: if require_codex {
                Some(find_program("codex", "EGO_CHAT_CODEX")?)
            } else {
                find_optional_program("codex", "EGO_CHAT_CODEX")?
            },
            ego_browser: find_program("ego-browser", "EGO_CHAT_EGO_BROWSER")?,
            node: find_program("node", "EGO_CHAT_NODE")?,
            npm: find_program("npm", "EGO_CHAT_NPM")?,
        })
    }

    fn validate(&self, require_codex: bool) -> Result<(), String> {
        let node_version = command_output(&self.node, &[OsStr::new("--version")])?;
        let major = parse_node_major(&node_version)
            .ok_or_else(|| format!("could not parse Node.js version {node_version:?}"))?;
        if major < MINIMUM_NODE_MAJOR {
            return Err(format!(
                "Node.js {MINIMUM_NODE_MAJOR} or newer is required; found {node_version}"
            ));
        }
        command_output(&self.npm, &[OsStr::new("--version")])?;
        if require_codex {
            let codex = self.codex.as_ref().ok_or_else(|| {
                "Codex is required for Codex setup and broker-owned convergence".to_string()
            })?;
            command_output(codex, &[OsStr::new("--version")])?;
        }
        command_output(&self.ego_browser, &[OsStr::new("--help")])?;
        Ok(())
    }

    fn prepend_path(&self, command: &mut Command) -> Result<(), String> {
        let mut directories = Vec::new();
        for program in [
            Some(&self.node),
            Some(&self.npm),
            self.codex.as_ref(),
            Some(&self.ego_browser),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(parent) = program.parent()
                && !directories.iter().any(|candidate| candidate == parent)
            {
                directories.push(parent.to_path_buf());
            }
        }
        if let Some(existing) = env::var_os("PATH") {
            directories.extend(env::split_paths(&existing));
        }
        let joined = env::join_paths(directories)
            .map_err(|error| format!("could not construct child PATH: {error}"))?;
        command.env("PATH", joined);
        Ok(())
    }
}

fn setup(force: bool, configure: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the Ego Lite integration currently supports macOS only".to_string());
    }
    let paths = InstallPaths::discover()?;
    let tools = Toolchain::discover(true)?;
    tools.validate(true)?;
    install_runtime(&paths.runtime_dir, &tools, force)?;
    let redirected_launchers = redirect_stale_broker_launchers(&paths.runtime_dir)?;
    let handoff_status = handoff_installed_broker(&paths.runtime_dir, &tools)?;
    install_skill(&paths.codex_skill_dir, SKILL_FILES, force)?;

    if configure {
        let executable = env::current_exe()
            .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
        configure_codex(&paths.codex_config, &executable, force)?;
    }

    println!("Ego Chat runtime: {}", paths.runtime_dir.display());
    if handoff_status == "stopped" {
        println!("Stopped the idle stale Ego Chat broker before activating this runtime.");
    }
    if redirected_launchers > 0 {
        println!(
            "Redirected {redirected_launchers} older managed broker launcher(s) to this runtime."
        );
    }
    println!("Codex skill: {}", paths.codex_skill_dir.display());
    if configure {
        println!("Codex MCP server: {MCP_SERVER_NAME}");
        println!(
            "Restart Codex.app and any other open Ego Chat host, then use /mcp to verify the connection."
        );
    } else {
        println!("Codex MCP configuration was skipped.");
    }
    Ok(())
}

fn setup_zcode(force: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("the Ego Lite integration currently supports macOS only".to_string());
    }
    let paths = InstallPaths::discover()?;
    let tools = Toolchain::discover(false)?;
    tools.validate(false)?;
    install_runtime(&paths.runtime_dir, &tools, force)?;
    let redirected_launchers = redirect_stale_broker_launchers(&paths.runtime_dir)?;
    let handoff_status = handoff_installed_broker(&paths.runtime_dir, &tools)?;
    install_skill(&paths.zcode_skill_dir, ZCODE_SKILL_FILES, force)?;
    let executable = env::current_exe()
        .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
    configure_zcode(&paths.zcode_config, &executable, force)?;

    println!("Ego Chat runtime: {}", paths.runtime_dir.display());
    if handoff_status == "stopped" {
        println!("Stopped the idle stale Ego Chat broker before activating this runtime.");
    }
    if redirected_launchers > 0 {
        println!(
            "Redirected {redirected_launchers} older managed broker launcher(s) to this runtime."
        );
    }
    println!("ZCode skill: {}", paths.zcode_skill_dir.display());
    println!("ZCode MCP server: {MCP_SERVER_NAME}");
    println!(
        "Restart ZCode.app and any other open Ego Chat host, then verify ego_chat in MCP Services."
    );
    if tools.codex.is_none() {
        println!(
            "Codex was not found; ZCode-owned reviews work, while broker-owned Codex convergence remains unavailable."
        );
    }
    Ok(())
}

fn handoff_installed_broker(runtime_dir: &Path, tools: &Toolchain) -> Result<String, String> {
    let cli = runtime_dir.join("bin/ego-chat.mjs");
    if !cli.is_file() {
        return Err(format!(
            "the installed broker CLI {} is missing",
            cli.display()
        ));
    }
    let mut command = Command::new(&tools.node);
    command.arg(&cli).arg("broker-handoff");
    tools.prepend_path(&mut command)?;
    let output = command
        .output()
        .map_err(|error| format!("could not run broker runtime handoff: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let parsed = serde_json::from_str::<JsonValue>(stderr.trim()).ok();
        let code = parsed
            .as_ref()
            .and_then(|value| value.get("code"))
            .and_then(JsonValue::as_str)
            .unwrap_or("broker_handoff_failed");
        let message = parsed
            .as_ref()
            .and_then(|value| value.get("message"))
            .and_then(JsonValue::as_str)
            .unwrap_or("The installed runtime could not safely hand off the authoritative broker.");
        return Err(format!("{code}: {message}"));
    }
    let response = serde_json::from_slice::<JsonValue>(&output.stdout)
        .map_err(|_| "the installed broker handoff returned invalid JSON".to_string())?;
    let status = response
        .get("status")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "the installed broker handoff omitted its status".to_string())?;
    if !matches!(status, "current" | "not_running" | "stopped") {
        return Err(format!(
            "the installed broker handoff returned unknown status {status:?}"
        ));
    }
    Ok(status.to_string())
}

fn inspect_installed_broker_runtime(
    runtime_dir: &Path,
    tools: &Toolchain,
) -> Result<String, String> {
    let cli = runtime_dir.join("bin/ego-chat.mjs");
    if !cli.is_file() {
        return Err(format!(
            "the installed broker CLI {} is missing",
            cli.display()
        ));
    }
    let mut command = Command::new(&tools.node);
    command.arg(&cli).arg("broker-runtime-status");
    tools.prepend_path(&mut command)?;
    let output = command
        .output()
        .map_err(|error| format!("could not inspect the live broker runtime: {error}"))?;
    if !output.status.success() {
        return Err("the installed runtime could not inspect the authoritative broker".to_string());
    }
    let response = serde_json::from_slice::<JsonValue>(&output.stdout)
        .map_err(|_| "the installed broker runtime check returned invalid JSON".to_string())?;
    let status = response
        .get("status")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| "the installed broker runtime check omitted its status".to_string())?;
    if !matches!(status, "current" | "not_running" | "stale") {
        return Err(format!(
            "the installed broker runtime check returned unknown status {status:?}"
        ));
    }
    Ok(status.to_string())
}

fn redirect_stale_broker_launchers(current_runtime: &Path) -> Result<usize, String> {
    let install_root = current_runtime.parent().ok_or_else(|| {
        format!(
            "the managed runtime {} has no installation root",
            current_runtime.display()
        )
    })?;
    let current_daemon = current_runtime.join("bin/ego-chatd.mjs");
    if !current_daemon.is_file() {
        return Err(format!(
            "the current managed broker daemon {} is missing",
            current_daemon.display()
        ));
    }
    let daemon_path = serde_json::to_string(&path_bytes(&current_daemon)?)
        .map_err(|error| format!("could not encode the current broker daemon path: {error}"))?;
    let launcher = format!(
        "#!/usr/bin/env node\n\
import {{ pathToFileURL }} from \"node:url\"\n\
await import(pathToFileURL({daemon_path}).href)\n"
    );
    let mut redirected = 0;
    let entries = fs::read_dir(install_root)
        .map_err(|error| format!("could not inspect {}: {error}", install_root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "could not inspect an entry under {}: {error}",
                install_root.display()
            )
        })?;
        if !entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", entry.path().display()))?
            .is_dir()
        {
            continue;
        }
        let runtime = entry.path();
        if runtime == current_runtime {
            continue;
        }
        let version = match fs::read_to_string(runtime.join(RUNTIME_MARKER)) {
            Ok(value) => value.trim().to_string(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "could not read the managed marker under {}: {error}",
                    runtime.display()
                ));
            }
        };
        if version.is_empty()
            || version == env!("CARGO_PKG_VERSION")
            || runtime.file_name().and_then(OsStr::to_str) != Some(version.as_str())
        {
            continue;
        }
        let daemon = runtime.join("bin/ego-chatd.mjs");
        let metadata = match fs::symlink_metadata(&daemon) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("could not inspect {}: {error}", daemon.display()));
            }
        };
        if !metadata.file_type().is_file() {
            return Err(format!(
                "refusing to replace non-regular managed broker launcher {}",
                daemon.display()
            ));
        }
        if fs::read(&daemon)
            .map(|value| value == launcher.as_bytes())
            .unwrap_or(false)
        {
            continue;
        }
        write_atomic(&daemon, launcher.as_bytes())?;
        redirected += 1;
    }
    Ok(redirected)
}

fn install_runtime(runtime_dir: &Path, tools: &Toolchain, force: bool) -> Result<(), String> {
    let marker = runtime_dir.join(RUNTIME_MARKER);
    let version_matches = fs::read_to_string(&marker)
        .map(|value| value.trim() == env!("CARGO_PKG_VERSION"))
        .unwrap_or(false);
    let dependencies_present = runtime_dir
        .join("node_modules/@modelcontextprotocol/sdk/package.json")
        .is_file()
        && runtime_dir.join("node_modules/zod/package.json").is_file();
    let embedded_files_match = managed_files_match(runtime_dir, RUNTIME_FILES);
    if runtime_dir.exists() && !version_matches && !force {
        return Err(format!(
            "{} contains an unmanaged or incomplete runtime; inspect it and rerun setup with --force to repair managed files",
            runtime_dir.display()
        ));
    }

    write_runtime_tool_paths(runtime_dir, tools)?;
    if version_matches && dependencies_present && embedded_files_match && !force {
        return Ok(());
    }

    for file in RUNTIME_FILES {
        let destination = safe_join(runtime_dir, file.path)?;
        write_atomic(&destination, file.bytes)?;
    }
    let mut npm = Command::new(&tools.npm);
    npm.args(["ci", "--omit=dev", "--ignore-scripts"])
        .current_dir(runtime_dir);
    tools.prepend_path(&mut npm)?;
    let status = npm
        .status()
        .map_err(|error| format!("could not run npm ci: {error}"))?;
    if !status.success() {
        return Err(format!("npm ci failed with status {status}"));
    }
    write_atomic(
        &marker,
        format!("{}\n", env!("CARGO_PKG_VERSION")).as_bytes(),
    )?;
    Ok(())
}

fn write_runtime_tool_paths(runtime_dir: &Path, tools: &Toolchain) -> Result<(), String> {
    write_atomic(
        &runtime_dir.join(".node-path"),
        path_bytes(&tools.node)?.as_bytes(),
    )?;
    write_atomic(
        &runtime_dir.join(".npm-path"),
        path_bytes(&tools.npm)?.as_bytes(),
    )?;
    if let Some(codex) = &tools.codex {
        write_atomic(
            &runtime_dir.join(".codex-path"),
            path_bytes(codex)?.as_bytes(),
        )?;
    } else {
        let managed_codex_path = runtime_dir.join(".codex-path");
        match fs::read_to_string(&managed_codex_path) {
            Ok(value) => {
                let existing = PathBuf::from(value.trim());
                if !executable_file(&existing) {
                    fs::remove_file(&managed_codex_path).map_err(|error| {
                        format!(
                            "could not remove stale {}: {error}",
                            managed_codex_path.display()
                        )
                    })?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "could not read {}: {error}",
                    managed_codex_path.display()
                ));
            }
        }
    }
    write_atomic(
        &runtime_dir.join(".ego-browser-path"),
        path_bytes(&tools.ego_browser)?.as_bytes(),
    )?;
    Ok(())
}

fn install_skill(
    skill_dir: &Path,
    embedded_files: &[EmbeddedFile],
    force: bool,
) -> Result<(), String> {
    let conflicts = embedded_files.iter().any(|file| {
        let destination = skill_dir.join(file.path);
        destination.exists()
            && fs::read(&destination)
                .map(|existing| existing != file.bytes)
                .unwrap_or(true)
    });
    if conflicts && !force {
        return Err(format!(
            "{} contains a different Ego Chat skill; rerun with --force only if it is safe to replace the managed files",
            skill_dir.display()
        ));
    }
    for file in embedded_files {
        let destination = safe_join(skill_dir, file.path)?;
        write_atomic(&destination, file.bytes)?;
    }
    Ok(())
}

fn configure_codex(config_path: &Path, executable: &Path, force: bool) -> Result<(), String> {
    let original = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read {}: {error}", config_path.display())),
    };
    let mut document = original
        .parse::<DocumentMut>()
        .map_err(|error| format!("could not parse {}: {error}", config_path.display()))?;
    if document.get("mcp_servers").is_none() {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = document["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| "mcp_servers exists but is not a TOML table".to_string())?;
    let executable = path_bytes(executable)?;

    if let Some(existing) = servers.get(MCP_SERVER_NAME)
        && !server_matches(existing, &executable)
        && !force
    {
        return Err(format!(
            "Codex already has a different {MCP_SERVER_NAME} MCP server; rerun with --force only after verifying that replacement is intended"
        ));
    }

    if servers.get(MCP_SERVER_NAME).is_none()
        || !server_matches(
            servers.get(MCP_SERVER_NAME).expect("checked above"),
            &executable,
        )
    {
        servers[MCP_SERVER_NAME] = Item::Table(Table::new());
    }
    let table = servers[MCP_SERVER_NAME]
        .as_table_mut()
        .ok_or_else(|| format!("mcp_servers.{MCP_SERVER_NAME} is not a TOML table"))?;
    let mut arguments = Array::new();
    arguments.push("mcp");
    table["command"] = value(executable);
    table["args"] = value(arguments);
    table["required"] = value(true);
    table["startup_timeout_sec"] = value(30);
    let existing_timeout = table
        .get("tool_timeout_sec")
        .and_then(Item::as_integer)
        .unwrap_or_default();
    if existing_timeout < MCP_TOOL_TIMEOUT_SECONDS {
        table["tool_timeout_sec"] = value(MCP_TOOL_TIMEOUT_SECONDS);
    }
    let configured = keep_server_after_coco_marker(document.to_string());
    write_atomic(config_path, configured.as_bytes())?;
    Ok(())
}

fn keep_server_after_coco_marker(config: String) -> String {
    let server_header = format!("[mcp_servers.{MCP_SERVER_NAME}]");
    let mut lines = config.split_inclusive('\n').collect::<Vec<_>>();
    let Some(server_index) = lines
        .iter()
        .position(|line| line.trim_end() == server_header)
    else {
        return config;
    };
    let Some(marker_index) = lines
        .iter()
        .position(|line| line.trim_end() == COCO_MCP_END_MARKER)
    else {
        return config;
    };
    if marker_index < server_index {
        return config;
    }

    let marker = lines.remove(marker_index);
    let server_index = lines
        .iter()
        .position(|line| line.trim_end() == server_header)
        .expect("server header was not removed");
    lines.insert(server_index, marker);
    lines.concat()
}

fn server_matches(item: &Item, executable: &str) -> bool {
    let Some(table) = item.as_table() else {
        return false;
    };
    let command_matches = table.get("command").and_then(Item::as_str) == Some(executable);
    let args_match = table
        .get("args")
        .and_then(Item::as_array)
        .map(|values| {
            values.len() == 1 && values.get(0).and_then(|value| value.as_str()) == Some("mcp")
        })
        .unwrap_or(false);
    command_matches && args_match
}

fn configure_zcode(config_path: &Path, executable: &Path, force: bool) -> Result<(), String> {
    let original = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("could not read {}: {error}", config_path.display())),
    };
    let mut document = if original.trim().is_empty() {
        JsonValue::Object(JsonMap::new())
    } else {
        serde_json::from_str::<JsonValue>(&original)
            .map_err(|error| format!("could not parse {}: {error}", config_path.display()))?
    };
    let root = document
        .as_object_mut()
        .ok_or_else(|| format!("{} must contain a JSON object", config_path.display()))?;
    let mcp = json_object_entry(root, "mcp", "mcp")?;
    let servers = json_object_entry(mcp, "servers", "mcp.servers")?;
    let executable = path_bytes(executable)?;

    if let Some(existing) = servers.get(MCP_SERVER_NAME)
        && !zcode_server_identity_matches(existing, &executable)
        && !force
    {
        return Err(format!(
            "ZCode already has a different {MCP_SERVER_NAME} MCP server; rerun with --force only after verifying that replacement is intended"
        ));
    }

    if servers.get(MCP_SERVER_NAME).is_none()
        || !zcode_server_identity_matches(
            servers.get(MCP_SERVER_NAME).expect("checked above"),
            &executable,
        )
    {
        servers.insert(
            MCP_SERVER_NAME.to_string(),
            JsonValue::Object(JsonMap::new()),
        );
    }
    let server = servers
        .get_mut(MCP_SERVER_NAME)
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| format!("mcp.servers.{MCP_SERVER_NAME} is not a JSON object"))?;
    server.insert("command".to_string(), JsonValue::String(executable));
    server.insert(
        "args".to_string(),
        JsonValue::Array(vec![JsonValue::String("mcp".to_string())]),
    );
    for codex_only_key in ["required", "startup_timeout_sec", "tool_timeout_sec"] {
        server.remove(codex_only_key);
    }
    server.insert(
        "timeoutMs".to_string(),
        JsonValue::from(MCP_TOOL_TIMEOUT_MILLISECONDS),
    );
    let mut configured = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("could not serialize {}: {error}", config_path.display()))?;
    configured.push('\n');
    write_atomic(config_path, configured.as_bytes())?;
    Ok(())
}

fn json_object_entry<'a>(
    parent: &'a mut JsonMap<String, JsonValue>,
    key: &str,
    display_name: &str,
) -> Result<&'a mut JsonMap<String, JsonValue>, String> {
    let value = parent
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    value
        .as_object_mut()
        .ok_or_else(|| format!("{display_name} exists but is not a JSON object"))
}

fn zcode_server_identity_matches(value: &JsonValue, executable: &str) -> bool {
    let Some(server) = value.as_object() else {
        return false;
    };
    let command_matches = server.get("command").and_then(JsonValue::as_str) == Some(executable);
    let args_match = server
        .get("args")
        .and_then(JsonValue::as_array)
        .map(|values| values.len() == 1 && values[0].as_str() == Some("mcp"))
        .unwrap_or(false);
    command_matches && args_match
}

fn zcode_server_value_matches(value: &JsonValue, executable: &str) -> bool {
    zcode_server_identity_matches(value, executable)
        && value.get("timeoutMs").and_then(JsonValue::as_u64) == Some(MCP_TOOL_TIMEOUT_MILLISECONDS)
}

fn doctor() -> Result<(), String> {
    let paths = InstallPaths::discover()?;
    let tools = Toolchain::discover(true)?;
    let mut failures = Vec::new();

    match tools.validate(true) {
        Ok(()) => println!("[ok] Node.js, npm, Codex, and ego-browser are available"),
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
                let message = "A stale authoritative broker is still running; run ego-chat setup after its active work stops".to_string();
                println!("[fail] {message}");
                failures.push(message);
            }
            Err(error) => {
                println!("[fail] {error}");
                failures.push(error);
            }
        }
    }
    if skill_matches(&paths.codex_skill_dir, SKILL_FILES) {
        println!(
            "[ok] Codex skill {} is installed",
            paths.codex_skill_dir.display()
        );
    } else {
        let message = format!(
            "Codex skill {} is missing or differs",
            paths.codex_skill_dir.display()
        );
        println!("[fail] {message}");
        failures.push(message);
    }
    let executable = env::current_exe()
        .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
    if codex_server_matches(&paths.codex_config, &executable)? {
        println!("[ok] Codex MCP server {MCP_SERVER_NAME} points to this executable");
    } else {
        let message = format!("Codex MCP server {MCP_SERVER_NAME} is missing or points elsewhere");
        println!("[fail] {message}");
        failures.push(message);
    }

    if failures.is_empty() {
        println!("Ego Chat is ready. Restart Codex.app after configuration changes.");
        Ok(())
    } else {
        Err(format!(
            "doctor found {} problem(s); run ego-chat setup",
            failures.len()
        ))
    }
}

fn doctor_zcode() -> Result<(), String> {
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
                let message = "A stale authoritative broker is still running; run ego-chat setup-zcode after its active work stops".to_string();
                println!("[fail] {message}");
                failures.push(message);
            }
            Err(error) => {
                println!("[fail] {error}");
                failures.push(error);
            }
        }
    }
    if skill_matches(&paths.zcode_skill_dir, ZCODE_SKILL_FILES) {
        println!(
            "[ok] ZCode skill {} is installed",
            paths.zcode_skill_dir.display()
        );
    } else {
        let message = format!(
            "ZCode skill {} is missing or differs",
            paths.zcode_skill_dir.display()
        );
        println!("[fail] {message}");
        failures.push(message);
    }
    let executable = env::current_exe()
        .map_err(|error| format!("could not resolve the ego-chat executable: {error}"))?;
    if zcode_server_matches(&paths.zcode_config, &executable)? {
        println!("[ok] ZCode MCP server {MCP_SERVER_NAME} points to this executable");
    } else {
        let message = format!("ZCode MCP server {MCP_SERVER_NAME} is missing or points elsewhere");
        println!("[fail] {message}");
        failures.push(message);
    }

    if failures.is_empty() {
        println!("Ego Chat is ready. Restart ZCode.app after configuration changes.");
        Ok(())
    } else {
        Err(format!(
            "doctor-zcode found {} problem(s); run ego-chat setup-zcode",
            failures.len()
        ))
    }
}

fn runtime_ready(runtime_dir: &Path) -> bool {
    fs::read_to_string(runtime_dir.join(RUNTIME_MARKER))
        .map(|value| value.trim() == env!("CARGO_PKG_VERSION"))
        .unwrap_or(false)
        && runtime_dir
            .join("node_modules/@modelcontextprotocol/sdk/package.json")
            .is_file()
        && runtime_dir.join("node_modules/zod/package.json").is_file()
        && managed_files_match(runtime_dir, RUNTIME_FILES)
}

fn skill_matches(skill_dir: &Path, embedded_files: &[EmbeddedFile]) -> bool {
    managed_files_match(skill_dir, embedded_files)
}

fn managed_files_match(root: &Path, embedded_files: &[EmbeddedFile]) -> bool {
    embedded_files.iter().all(|file| {
        fs::read(root.join(file.path))
            .map(|existing| existing == file.bytes)
            .unwrap_or(false)
    })
}

fn codex_server_matches(config_path: &Path, executable: &Path) -> Result<bool, String> {
    let contents = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not read {}: {error}", config_path.display())),
    };
    let document = contents
        .parse::<DocumentMut>()
        .map_err(|error| format!("could not parse {}: {error}", config_path.display()))?;
    let Some(server) = document
        .get("mcp_servers")
        .and_then(Item::as_table)
        .and_then(|servers| servers.get(MCP_SERVER_NAME))
    else {
        return Ok(false);
    };
    Ok(server_matches(server, &path_bytes(executable)?))
}

fn zcode_server_matches(config_path: &Path, executable: &Path) -> Result<bool, String> {
    let contents = match fs::read_to_string(config_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not read {}: {error}", config_path.display())),
    };
    let document = serde_json::from_str::<JsonValue>(&contents)
        .map_err(|error| format!("could not parse {}: {error}", config_path.display()))?;
    let Some(server) = document
        .get("mcp")
        .and_then(|mcp| mcp.get("servers"))
        .and_then(|servers| servers.get(MCP_SERVER_NAME))
    else {
        return Ok(false);
    };
    Ok(zcode_server_value_matches(server, &path_bytes(executable)?))
}

fn proxy_node(script: &str, arguments: &[OsString]) -> Result<u8, String> {
    let paths = InstallPaths::discover()?;
    if !runtime_ready(&paths.runtime_dir) {
        return Err("the embedded runtime is not installed; run ego-chat setup first".to_string());
    }
    let node = read_managed_path(&paths.runtime_dir.join(".node-path"))?;
    let tools = Toolchain {
        codex: read_optional_managed_path(&paths.runtime_dir.join(".codex-path"))?,
        ego_browser: read_managed_path(&paths.runtime_dir.join(".ego-browser-path"))?,
        node: node.clone(),
        npm: read_managed_path(&paths.runtime_dir.join(".npm-path"))?,
    };
    let script_path = safe_join(&paths.runtime_dir, script)?;
    let mut command = Command::new(node);
    command.arg(script_path).args(arguments);
    tools.prepend_path(&mut command)?;

    #[cfg(unix)]
    {
        let error = command.exec();
        Err(format!(
            "could not launch the embedded Node runtime: {error}"
        ))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .map_err(|error| format!("could not launch the embedded Node runtime: {error}"))?;
        Ok(status.code().unwrap_or(1).clamp(0, 255) as u8)
    }
}

fn find_program(name: &str, override_name: &str) -> Result<PathBuf, String> {
    if let Some(value) = env::var_os(override_name) {
        return resolve_program(&value)
            .ok_or_else(|| format!("{override_name} does not identify an executable"));
    }
    resolve_program(OsStr::new(name)).ok_or_else(|| {
        format!(
            "{name} was not found on PATH; install it or set {override_name} to its absolute path"
        )
    })
}

fn find_optional_program(name: &str, override_name: &str) -> Result<Option<PathBuf>, String> {
    if let Some(value) = env::var_os(override_name) {
        return resolve_program(&value)
            .map(Some)
            .ok_or_else(|| format!("{override_name} does not identify an executable"));
    }
    Ok(resolve_program(OsStr::new(name)))
}

fn resolve_program(candidate: &OsStr) -> Option<PathBuf> {
    let path = PathBuf::from(candidate);
    if path.components().count() > 1 {
        return executable_file(&path).then_some(path);
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(&path))
        .find(|candidate| executable_file(candidate))
}

fn executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn command_output(program: &Path, arguments: &[&OsStr]) -> Result<String, String> {
    let output = Command::new(program)
        .args(arguments)
        .output()
        .map_err(|error| format!("could not run {}: {error}", program.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} exited with {}",
            program.display(),
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_node_major(version: &str) -> Option<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn read_managed_path(path: &Path) -> Result<PathBuf, String> {
    let value = fs::read_to_string(path).map_err(|error| {
        format!(
            "could not read {}: {error}; rerun ego-chat setup",
            path.display()
        )
    })?;
    let parsed = PathBuf::from(value.trim());
    if !executable_file(&parsed) {
        return Err(format!(
            "managed tool path {} is unavailable; rerun ego-chat setup",
            parsed.display()
        ));
    }
    Ok(parsed)
}

fn read_optional_managed_path(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let parsed = PathBuf::from(value.trim());
            if !executable_file(&parsed) {
                return Err(format!(
                    "managed tool path {} is unavailable; rerun ego-chat setup or setup-zcode",
                    parsed.display()
                ));
            }
            Ok(Some(parsed))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "could not read {}: {error}; rerun ego-chat setup or setup-zcode",
            path.display()
        )),
    }
}

fn path_bytes(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("path {} is not valid UTF-8", path.display()))
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    if Path::new(relative).is_absolute()
        || Path::new(relative)
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("embedded path {relative:?} is unsafe"));
    }
    Ok(candidate)
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| format!("{} has an invalid file name", path.display()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before the Unix epoch: {error}"))?
        .as_nanos();
    let temporary = parent.join(format!(".{file_name}.{}-{nonce}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("could not create {}: {error}", temporary.display()))?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not write {}: {error}", temporary.display()))?;
    drop(file);
    fs::rename(&temporary, path)
        .map_err(|error| format!("could not replace {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path =
                env::temp_dir().join(format!("ego-chat-rust-test-{}-{id}", std::process::id()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove owned test directory");
        }
    }

    #[test]
    fn node_major_parser_accepts_node_output() {
        assert_eq!(parse_node_major("v24.19.0"), Some(24));
        assert_eq!(parse_node_major("23.1.0"), Some(23));
        assert_eq!(parse_node_major("unknown"), None);
    }

    #[test]
    fn embedded_paths_are_relative_and_unique() {
        let mut paths = RUNTIME_FILES
            .iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), RUNTIME_FILES.len());
        for file in RUNTIME_FILES
            .iter()
            .chain(SKILL_FILES.iter())
            .chain(ZCODE_SKILL_FILES.iter())
        {
            assert!(safe_join(Path::new("/tmp/owned"), file.path).is_ok());
            assert!(!file.bytes.is_empty());
        }
    }

    #[test]
    fn setup_runtime_handoff_invokes_the_installed_broker_cli() {
        let directory = TestDirectory::new();
        let runtime = directory.0.join("runtime");
        let runtime_bin = runtime.join("bin");
        let tool_bin = directory.0.join("tools");
        fs::create_dir_all(&runtime_bin).expect("create runtime bin");
        fs::create_dir_all(&tool_bin).expect("create tool bin");
        fs::write(runtime_bin.join("ego-chat.mjs"), "// managed runtime CLI\n")
            .expect("write runtime CLI");
        let invocation = directory.0.join("node-invocation.txt");
        let node = tool_bin.join("node");
        fs::write(
            &node,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '{{\"status\":\"not_running\"}}\\n'\n",
                invocation.display()
            ),
        )
        .expect("write fake node");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&node).expect("read node mode").permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&node, permissions).expect("make node executable");
        }
        let tools = Toolchain {
            codex: None,
            ego_browser: tool_bin.join("ego-browser"),
            node,
            npm: tool_bin.join("npm"),
        };

        assert_eq!(
            handoff_installed_broker(&runtime, &tools).expect("handoff idle broker"),
            "not_running"
        );
        let arguments = fs::read_to_string(invocation).expect("read node invocation");
        assert_eq!(
            arguments.lines().collect::<Vec<_>>(),
            [
                runtime_bin.join("ego-chat.mjs").to_str().unwrap(),
                "broker-handoff"
            ]
        );
    }

    #[test]
    fn doctor_runtime_check_detects_a_live_stale_broker_without_handoff() {
        let directory = TestDirectory::new();
        let runtime = directory.0.join("runtime");
        let runtime_bin = runtime.join("bin");
        let tool_bin = directory.0.join("tools");
        fs::create_dir_all(&runtime_bin).expect("create runtime bin");
        fs::create_dir_all(&tool_bin).expect("create tool bin");
        fs::write(runtime_bin.join("ego-chat.mjs"), "// managed runtime CLI\n")
            .expect("write runtime CLI");
        let invocation = directory.0.join("node-doctor-invocation.txt");
        let node = tool_bin.join("node");
        fs::write(
            &node,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '{{\"runtime\":{{\"appVersion\":\"0.2.0\"}},\"status\":\"stale\"}}\\n'\n",
                invocation.display()
            ),
        )
        .expect("write fake node");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(&node).expect("read node mode").permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&node, permissions).expect("make node executable");
        }
        let tools = Toolchain {
            codex: None,
            ego_browser: tool_bin.join("ego-browser"),
            node,
            npm: tool_bin.join("npm"),
        };

        assert_eq!(
            inspect_installed_broker_runtime(&runtime, &tools).expect("inspect live broker"),
            "stale"
        );
        let arguments = fs::read_to_string(invocation).expect("read node invocation");
        assert_eq!(
            arguments.lines().collect::<Vec<_>>(),
            [
                runtime_bin.join("ego-chat.mjs").to_str().unwrap(),
                "broker-runtime-status"
            ]
        );
    }

    #[test]
    fn setup_redirects_only_verified_stale_managed_broker_launchers() {
        let directory = TestDirectory::new();
        let install_root = directory.0.join("runtime");
        let current = install_root.join(env!("CARGO_PKG_VERSION"));
        let stale = install_root.join("0.1.0");
        let unmanaged = install_root.join("personal-runtime");
        for runtime in [&current, &stale, &unmanaged] {
            fs::create_dir_all(runtime.join("bin")).expect("create runtime bin");
            fs::write(runtime.join("bin/ego-chatd.mjs"), "// original daemon\n")
                .expect("write daemon");
        }
        fs::write(
            current.join(RUNTIME_MARKER),
            format!("{}\n", env!("CARGO_PKG_VERSION")),
        )
        .expect("write current marker");
        fs::write(stale.join(RUNTIME_MARKER), "0.1.0\n").expect("write stale marker");
        fs::write(unmanaged.join(RUNTIME_MARKER), "different-name\n")
            .expect("write unmanaged marker");

        assert_eq!(
            redirect_stale_broker_launchers(&current).expect("redirect stale launchers"),
            1
        );
        let redirected =
            fs::read_to_string(stale.join("bin/ego-chatd.mjs")).expect("read redirected daemon");
        assert!(redirected.contains("pathToFileURL"));
        assert!(redirected.contains(current.join("bin/ego-chatd.mjs").to_str().unwrap()));
        assert_eq!(
            fs::read_to_string(unmanaged.join("bin/ego-chatd.mjs")).expect("read unmanaged daemon"),
            "// original daemon\n"
        );
    }

    #[test]
    fn zcode_only_tool_paths_remove_a_stale_managed_codex_path() {
        let directory = TestDirectory::new();
        let runtime = directory.0.join("runtime");
        let bin = directory.0.join("bin");
        fs::create_dir_all(&bin).expect("create fake bin");
        let node = bin.join("node");
        let npm = bin.join("npm");
        let ego_browser = bin.join("ego-browser");
        for path in [&node, &npm, &ego_browser] {
            fs::write(path, "test executable placeholder").expect("write fake executable");
        }
        fs::create_dir_all(&runtime).expect("create runtime");
        fs::write(runtime.join(".codex-path"), "/removed/codex").expect("seed stale path");
        let tools = Toolchain {
            codex: None,
            ego_browser,
            node,
            npm,
        };

        write_runtime_tool_paths(&runtime, &tools).expect("write managed tool paths");

        assert!(!runtime.join(".codex-path").exists());
        assert!(runtime.join(".node-path").is_file());
        assert!(runtime.join(".npm-path").is_file());
        assert!(runtime.join(".ego-browser-path").is_file());
    }

    #[test]
    fn zcode_only_tool_paths_preserve_a_valid_managed_codex_outside_path() {
        let directory = TestDirectory::new();
        let runtime = directory.0.join("runtime");
        let bin = directory.0.join("bin");
        fs::create_dir_all(&bin).expect("create fake bin");
        let codex = directory.0.join("private-codex");
        let node = bin.join("node");
        let npm = bin.join("npm");
        let ego_browser = bin.join("ego-browser");
        for path in [&codex, &node, &npm, &ego_browser] {
            fs::write(path, "test executable placeholder").expect("write fake executable");
            #[cfg(unix)]
            {
                let mut permissions = fs::metadata(path).expect("read mode").permissions();
                permissions.set_mode(0o700);
                fs::set_permissions(path, permissions).expect("set executable mode");
            }
        }
        fs::create_dir_all(&runtime).expect("create runtime");
        fs::write(
            runtime.join(".codex-path"),
            codex.to_str().expect("utf8 test path"),
        )
        .expect("seed managed Codex path");
        let tools = Toolchain {
            codex: None,
            ego_browser,
            node,
            npm,
        };

        write_runtime_tool_paths(&runtime, &tools).expect("write managed tool paths");

        assert_eq!(
            read_optional_managed_path(&runtime.join(".codex-path")).expect("read preserved path"),
            Some(codex)
        );
    }

    #[test]
    fn codex_configuration_is_scoped_and_preserves_other_entries() {
        let directory = TestDirectory::new();
        let config = directory.0.join("config.toml");
        fs::write(
            &config,
            "# keep this comment\nmodel = \"gpt-test\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .expect("seed config");
        let executable = directory.0.join("bin/ego-chat");
        configure_codex(&config, &executable, false).expect("configure Ego Chat");
        let value = fs::read_to_string(&config).expect("read config");
        assert!(value.contains("# keep this comment"));
        assert!(value.contains("[mcp_servers.other]"));
        let document = value.parse::<DocumentMut>().expect("parse updated config");
        let server = &document["mcp_servers"][MCP_SERVER_NAME];
        assert!(server_matches(
            server,
            executable.to_str().expect("utf8 path")
        ));
        assert_eq!(server["required"].as_bool(), Some(true));
        assert_eq!(
            server["tool_timeout_sec"].as_integer(),
            Some(MCP_TOOL_TIMEOUT_SECONDS)
        );
    }

    #[test]
    fn codex_configuration_refuses_an_unowned_server_without_force() {
        let directory = TestDirectory::new();
        let config = directory.0.join("config.toml");
        fs::write(
            &config,
            "[mcp_servers.ego_chat]\ncommand = \"someone-else\"\nargs = [\"mcp\"]\n",
        )
        .expect("seed config");
        let executable = directory.0.join("ego-chat");
        let error = configure_codex(&config, &executable, false).expect_err("must reject conflict");
        assert!(error.contains("different ego_chat"));
        assert!(
            fs::read_to_string(&config)
                .expect("read config")
                .contains("someone-else")
        );
    }

    #[test]
    fn codex_configuration_keeps_ego_chat_outside_coco_managed_section() {
        let directory = TestDirectory::new();
        let config = directory.0.join("config.toml");
        fs::write(
            &config,
            "[mcp_servers.computer-use]\ncommand = \"computer-use\"\n# --- end coco MCP server ---\n",
        )
        .expect("seed config");
        let executable = directory.0.join("ego-chat");
        configure_codex(&config, &executable, false).expect("configure Ego Chat");
        let value = fs::read_to_string(&config).expect("read config");
        let marker_index = value.find(COCO_MCP_END_MARKER).expect("managed marker");
        let server_index = value
            .find("[mcp_servers.ego_chat]")
            .expect("Ego Chat server");
        assert!(marker_index < server_index);
        assert!(value.contains("[mcp_servers.computer-use]"));
    }

    #[test]
    fn zcode_configuration_is_scoped_and_preserves_other_entries() {
        let directory = TestDirectory::new();
        let config = directory.0.join("config.json");
        fs::write(
            &config,
            r#"{
  "plugins": {
    "enabledPlugins": {
      "existing": true
    }
  },
  "mcp": {
    "servers": {
      "other": {
        "command": "other"
      }
    }
  }
}
"#,
        )
        .expect("seed config");
        let executable = directory.0.join("bin/ego-chat");
        configure_zcode(&config, &executable, false).expect("configure Ego Chat");
        let value = fs::read_to_string(&config).expect("read config");
        let document = serde_json::from_str::<JsonValue>(&value).expect("parse updated config");
        assert_eq!(
            document["plugins"]["enabledPlugins"]["existing"].as_bool(),
            Some(true)
        );
        assert_eq!(
            document["mcp"]["servers"]["other"]["command"].as_str(),
            Some("other")
        );
        let server = &document["mcp"]["servers"][MCP_SERVER_NAME];
        assert!(zcode_server_value_matches(
            server,
            executable.to_str().expect("utf8 path")
        ));
        assert_eq!(
            server["timeoutMs"].as_u64(),
            Some(MCP_TOOL_TIMEOUT_MILLISECONDS)
        );
        assert!(value.find("\"plugins\"").unwrap() < value.find("\"mcp\"").unwrap());
    }

    #[test]
    fn zcode_configuration_refuses_an_unowned_server_without_force() {
        let directory = TestDirectory::new();
        let config = directory.0.join("config.json");
        fs::write(
            &config,
            r#"{"mcp":{"servers":{"ego_chat":{"command":"someone-else","args":["mcp"],"required":true,"tool_timeout_sec":1900}}}}"#,
        )
        .expect("seed config");
        let executable = directory.0.join("ego-chat");
        let error = configure_zcode(&config, &executable, false).expect_err("must reject conflict");
        assert!(error.contains("different ego_chat"));
        assert!(
            fs::read_to_string(&config)
                .expect("read config")
                .contains("someone-else")
        );

        configure_zcode(&config, &executable, true).expect("replace with force");
        assert!(zcode_server_matches(&config, &executable).expect("inspect ZCode config"));
        let configured = serde_json::from_str::<JsonValue>(
            &fs::read_to_string(&config).expect("read configured ZCode config"),
        )
        .expect("parse configured ZCode config");
        let server = &configured["mcp"]["servers"][MCP_SERVER_NAME];
        assert!(server.get("required").is_none());
        assert!(server.get("tool_timeout_sec").is_none());
    }

    #[test]
    fn zcode_configuration_normalizes_every_invalid_timeout_form() {
        let directory = TestDirectory::new();
        let executable = directory.0.join("ego-chat");
        let invalid_timeouts = [
            ("missing", None),
            ("string", Some(JsonValue::String("1900000".to_string()))),
            (
                "fractional",
                Some(JsonValue::Number(
                    serde_json::Number::from_f64(1_900_000.5).expect("finite timeout"),
                )),
            ),
            ("too-small", Some(JsonValue::from(30_000_u64))),
            ("excessive", Some(JsonValue::from(3_800_000_u64))),
        ];

        for (label, invalid_timeout) in invalid_timeouts {
            let config = directory.0.join(format!("config-{label}.json"));
            let mut server = JsonMap::new();
            server.insert(
                "command".to_string(),
                JsonValue::String(executable.to_str().expect("utf8 path").to_string()),
            );
            server.insert(
                "args".to_string(),
                JsonValue::Array(vec![JsonValue::String("mcp".to_string())]),
            );
            if let Some(timeout) = invalid_timeout {
                server.insert("timeoutMs".to_string(), timeout);
            }
            let mut servers = JsonMap::new();
            servers.insert(MCP_SERVER_NAME.to_string(), JsonValue::Object(server));
            let mut mcp = JsonMap::new();
            mcp.insert("servers".to_string(), JsonValue::Object(servers));
            let mut root = JsonMap::new();
            root.insert("mcp".to_string(), JsonValue::Object(mcp));
            let document = JsonValue::Object(root);
            fs::write(
                &config,
                serde_json::to_vec_pretty(&document).expect("serialize invalid config"),
            )
            .expect("seed invalid timeout");

            assert!(!zcode_server_matches(&config, &executable).expect("inspect invalid config"));
            configure_zcode(&config, &executable, false).expect("normalize owned timeout");
            assert!(zcode_server_matches(&config, &executable).expect("inspect repaired config"));
            let repaired = serde_json::from_str::<JsonValue>(
                &fs::read_to_string(&config).expect("read repaired config"),
            )
            .expect("parse repaired config");
            assert_eq!(
                repaired["mcp"]["servers"][MCP_SERVER_NAME]["timeoutMs"].as_u64(),
                Some(MCP_TOOL_TIMEOUT_MILLISECONDS),
                "invalid timeout variant {label} was not normalized"
            );
        }
    }

    #[test]
    fn skill_installation_requires_force_for_different_managed_files() {
        let directory = TestDirectory::new();
        let skill = directory.0.join("ego-chat");
        fs::create_dir_all(&skill).expect("create skill");
        fs::write(skill.join("SKILL.md"), "custom skill").expect("write custom skill");
        assert!(install_skill(&skill, SKILL_FILES, false).is_err());
        install_skill(&skill, SKILL_FILES, true).expect("force managed skill files");
        assert!(skill_matches(&skill, SKILL_FILES));
    }
}
