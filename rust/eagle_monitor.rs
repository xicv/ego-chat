use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::json;

const EXIT_SOFTWARE: u8 = 70;
const RUNTIME_MARKER: &str = ".ego-chat-runtime-version";

fn main() -> ExitCode {
    match run(env::args_os().skip(1).collect()) {
        Ok(code) => ExitCode::from(code),
        Err(code) => ExitCode::from(code),
    }
}

fn emit_error<T>(code: &str, message: &str, exit: u8) -> Result<T, u8> {
    println!(
        "{}",
        json!({
            "command": null,
            "error": { "code": code, "message": message },
            "ok": false,
            "schemaVersion": 1
        })
    );
    Err(exit)
}

fn runtime_dir() -> Result<PathBuf, u8> {
    let home = match env::var_os("HOME") {
        Some(value) => PathBuf::from(value),
        None => {
            return emit_error(
                "runtime_unavailable",
                "The installed Ego Chat runtime cannot be located; run ego-chat setup.",
                EXIT_SOFTWARE,
            );
        }
    };
    let root = env::var_os("EGO_CHAT_INSTALL_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home.join("Library")
                .join("Application Support")
                .join("Ego Chat")
                .join("runtime")
        });
    Ok(root.join(env!("CARGO_PKG_VERSION")))
}

fn read_absolute_path(path: &Path) -> Result<PathBuf, u8> {
    let value = match fs::read_to_string(path) {
        Ok(value) => PathBuf::from(value.trim()),
        Err(_) => {
            return emit_error(
                "runtime_unavailable",
                "The installed Ego Chat runtime is incomplete; run ego-chat setup.",
                EXIT_SOFTWARE,
            );
        }
    };
    if !value.is_absolute() || !value.is_file() {
        return emit_error(
            "runtime_unavailable",
            "The installed Node runtime path is invalid; run ego-chat setup.",
            EXIT_SOFTWARE,
        );
    }
    Ok(value)
}

fn run(arguments: Vec<OsString>) -> Result<u8, u8> {
    let runtime = runtime_dir()?;
    let marker_matches = fs::read_to_string(runtime.join(RUNTIME_MARKER))
        .map(|value| value.trim() == env!("CARGO_PKG_VERSION"))
        .unwrap_or(false);
    let script = runtime.join("bin/eagle-monitor.mjs");
    if !marker_matches || !script.is_file() {
        return emit_error(
            "runtime_unavailable",
            "The embedded Eagle Monitor runtime is not installed; run ego-chat setup.",
            EXIT_SOFTWARE,
        );
    }
    let node = read_absolute_path(&runtime.join(".node-path"))?;
    let ego_browser = read_absolute_path(&runtime.join(".ego-browser-path"))?;
    let mut command = Command::new(node);
    command.arg(script).args(arguments);
    command.env("EGO_CHAT_EGO_BROWSER", ego_browser);

    #[cfg(unix)]
    {
        let _error = command.exec();
        emit_error(
            "runtime_launch_failed",
            "The installed Eagle Monitor runtime could not be launched.",
            EXIT_SOFTWARE,
        )
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => Ok(status.code().unwrap_or(1).clamp(0, 255) as u8),
            Err(_) => emit_error(
                "runtime_launch_failed",
                "The installed Eagle Monitor runtime could not be launched.",
                EXIT_SOFTWARE,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_runtime_path_uses_the_package_version() {
        let path = runtime_dir().expect("runtime path");
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }
}
