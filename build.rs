use std::env;
use std::fs;
use std::process::Command;

fn valid_git_sha(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn git_sha_from_checkout() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    valid_git_sha(&value).then_some(value)
}

fn git_metadata_path(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git").args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_sha_from_cargo_package() -> Option<String> {
    let text = fs::read_to_string(".cargo_vcs_info.json").ok()?;
    let suffix = text.split_once("\"sha1\"")?.1;
    let value = suffix.split_once(':')?.1.trim_start();
    let value = value.strip_prefix('"')?.split_once('"')?.0.to_string();
    valid_git_sha(&value).then_some(value)
}

fn main() {
    println!("cargo:rerun-if-env-changed=EGO_CHAT_IMPLEMENTATION_GIT_SHA");
    println!("cargo:rerun-if-changed=.cargo_vcs_info.json");
    if let Some(head_path) = git_metadata_path(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head_path}");
    }
    if let Some(reference) = git_metadata_path(&["symbolic-ref", "-q", "HEAD"])
        && let Some(reference_path) = git_metadata_path(&["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={reference_path}");
    }
    if let Some(packed_refs) = git_metadata_path(&["rev-parse", "--git-path", "packed-refs"]) {
        println!("cargo:rerun-if-changed={packed_refs}");
    }
    let implementation_git_sha = env::var("EGO_CHAT_IMPLEMENTATION_GIT_SHA")
        .ok()
        .filter(|value| valid_git_sha(value))
        .or_else(git_sha_from_checkout)
        .or_else(git_sha_from_cargo_package)
        .expect("Ego Chat builds require an exact implementation Git SHA");
    println!("cargo:rustc-env=EGO_CHAT_IMPLEMENTATION_GIT_SHA={implementation_git_sha}");
}
