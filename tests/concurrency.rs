// The extraction driver's concurrency, checked on the gate's own counter
// rather than on a stopwatch. A wall-clock assertion is the obvious way to
// test "these subprocesses overlap" and the wrong one: it fails on a loaded
// machine and passes on a fast serial one, so it measures the host as much as
// the code.
//
// FLAKE_EXPLORER_NIX_JOBS is read once per process and cached, so pinning it
// here means this file holds exactly ONE test — the same rule tests/degrade.rs
// keeps for its PATH shim, for the same reason. The phases below share the one
// test body instead.

mod common;

use common::{TempDir, fixture, nix_available};
use flake_explorer::drive::{DriveFlags, Selection, extract_to_dir};
use flake_explorer::run_nix::{nix_jobs, peak_nix_in_flight, reset_peak_nix_in_flight};
use std::path::Path;
use std::time::Duration;

/// The gate is pinned wide enough that the fixture's own work — one
/// configuration whose option tree splits into three namespace chunks, and five
/// derivation-typed outputs — cannot saturate it from any single pass. That is
/// what makes "did these two passes overlap each other" answerable at all.
const JOBS: usize = 8;

async fn extract(flake_ref: &str, out: &Path, configs: Selection, packages: Selection) {
    std::fs::create_dir_all(out).unwrap();
    extract_to_dir(
        flake_ref,
        &DriveFlags {
            out: out.display().to_string(),
            configs,
            packages,
            all_systems: false,
            timeout: Duration::from_secs(60),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn the_unit_pass_overlaps_and_stays_under_the_gate() {
    if !nix_available() {
        return;
    }
    // SAFETY: single test in this binary, set before anything reads it.
    unsafe { std::env::set_var("FLAKE_EXPLORER_NIX_JOBS", &JOBS.to_string()) };
    assert_eq!(
        nix_jobs(),
        JOBS,
        "the gate must be pinned for any of this to mean anything"
    );

    let flake_ref = fixture().canonicalize().unwrap().display().to_string();
    let tmp = TempDir::new("fe-concurrency");

    // The package pass on its own. `build_manifest` overlaps its opening evals
    // by itself and reaches 2, so the lower bound is 3: at 2 this would pass
    // against a package pass that ran one package at a time, which is the code
    // it was written to fail against.
    reset_peak_nix_in_flight();
    extract(
        &flake_ref,
        &tmp.0.join("packages"),
        Selection::None,
        Selection::All,
    )
    .await;
    let peak = peak_nix_in_flight();
    assert!(
        peak >= 3,
        "peak concurrent nix processes was {peak} — the five packages were \
         extracted one at a time"
    );
    assert!(
        peak <= JOBS,
        "peak concurrent nix processes was {peak}, over the gate's {JOBS} — \
         something is forking outside run_nix::run's gate"
    );
}
