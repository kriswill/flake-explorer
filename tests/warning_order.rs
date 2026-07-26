// The option walk's warnings must come out in a fixed order, hermetic via a
// scripted `nix` shim on PATH.
//
// The walk spreads its chunks over a worker pool, so anything it accumulates as
// chunks COMPLETE is in scheduling order — which is how the same flake on the
// same machine came to write two different manifest.json files. That was true
// before extraction became concurrent (two runs against the user's dotfiles at
// the pre-concurrency commit differ in exactly this array, and in nothing else)
// and concurrency only widens the window, so this is the accumulation being
// fixed rather than a fallout of it.
//
// A real flake cannot test the order it produces, only the order it happened to
// produce. The shim can: it makes the chunk that must sort FIRST finish LAST,
// so completion order and sorted order are opposites and the assertion below
// can only pass one way.
//
// Env/PATH mutation is process-global, so this file holds exactly ONE test —
// the same rule tests/degrade.rs keeps, for the same reason.

mod common;

use common::TempDir;
use flake_explorer::options::{ExtractOptionsOpts, extract_options};
use flake_explorer::schema::ConfigKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// Four namespaces. `beta` and `gamma` walk cleanly; `alpha` and `delta` fail
/// at every rung and cannot be split (their child listing comes back empty), so
/// each ends as one "extraction failed" warning.
///
/// `alpha` sleeps on every attempt and `delta` does not, so `delta`'s warning is
/// recorded first while `alpha` is still evaluating. Sorted, `alpha` comes
/// first. The two orders are opposites by construction.
const SHIM: &str = r#"#!/bin/sh
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *'mode\":\"optionNames'*)
    case "$*" in
      # A retry asking for a failing namespace's children: unlistable, so the
      # chunk cannot be split and falls through to the rung ladder.
      *'path\":['*) echo '[]' ;;
      *) echo '["alpha","beta","gamma","delta"]' ;;
    esac ;;
  *'mode\":\"options'*)
    case "$*" in
      *'\"alpha\"'*) sleep 0.4; echo "error: alpha exploded" >&2; exit 1 ;;
      *'\"delta\"'*) echo "error: delta exploded" >&2; exit 1 ;;
      *) echo '{"options":[]}' ;;
    esac ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

#[tokio::test]
async fn option_warnings_come_out_in_a_fixed_order() {
    let shim = TempDir::new("warning-order-shim");
    let nix = shim.0.join("nix");
    std::fs::write(&nix, SHIM).unwrap();
    std::fs::set_permissions(&nix, std::fs::Permissions::from_mode(0o755)).unwrap();

    // SAFETY: single test in this binary; no other thread reads the env yet.
    unsafe {
        // Wide enough that all four namespaces are in flight together, so which
        // warning is recorded first is decided by the shim's sleep rather than
        // by how many workers the host happens to give us.
        std::env::set_var("FLAKE_EXPLORER_NIX_JOBS", "4");
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                shim.0.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
    }

    let r = extract_options(
        "github:example/warn-flake",
        ConfigKind::Nixos,
        "host",
        ExtractOptionsOpts {
            timeout: Duration::from_secs(20),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(
        r.warnings,
        [
            "nixos/host options.alpha: extraction failed — error: alpha exploded",
            "nixos/host options.delta: extraction failed — error: delta exploded",
        ],
        "the option walk's warnings are in the order its chunks finished rather \
         than an order the flake decides — so the same flake writes a different \
         manifest.json and a different sidecar on every run (see the sort in \
         crates/extract/src/options.rs)"
    );
}
