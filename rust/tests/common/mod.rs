// Shared helpers for the integration suites. Mirrors the bun suite's nix
// gating: tests skip when `nix` is absent (the crane check sandbox), and
// FLAKE_EXPLORER_REQUIRE_NIX makes a silent skip impossible in CI.

use std::path::PathBuf;

/// The builtins-only fixture flake shared with the bun suite.
#[allow(dead_code)] // each tests/*.rs binary compiles its own copy; not all use every helper
pub fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/mini-flake")
}

/// True when real `nix` is on PATH. When absent: panics if
/// FLAKE_EXPLORER_REQUIRE_NIX is set (CI must never skip silently),
/// otherwise logs the skip.
#[allow(dead_code)]
pub fn nix_available() -> bool {
    let found = std::process::Command::new("nix")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !found {
        if std::env::var_os("FLAKE_EXPLORER_REQUIRE_NIX").is_some() {
            panic!(
                "FLAKE_EXPLORER_REQUIRE_NIX is set but `nix` is not on PATH — \
                 the integration suite would silently skip"
            );
        }
        eprintln!("skipping: `nix` not on PATH (sandboxed check build)");
    }
    found
}

/// A self-deleting temp dir under the std temp root.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(prefix: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}-{}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}
