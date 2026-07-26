// The opt-in phase timer, exercised through the real binary. Two properties
// matter and they pull in opposite directions: FLAKE_EXPLORER_TIMINGS=1 has to
// emit a line per extraction phase, and setting it must not change one byte of
// what the run prints without it. The second assertion is the load-bearing one
// — timing output is a benchmarking aid, not a format change, so stdout is
// compared between an instrumented and an uninstrumented run rather than
// merely spot-checked for the absence of "timing:".
//
// Skipped without nix, like the other real-nix suites (see tests/common).

mod common;

use common::{TempDir, fixture, nix_available};

struct Run {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

/// One `extract` of the fixture into a fresh directory. `timings` sets the
/// env var; `all` adds --all so the options and package passes actually run.
fn extract(dir: &std::path::Path, timings: bool, all: bool) -> Run {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_flake-explorer"));
    cmd.arg("extract")
        .arg(fixture())
        .arg("--out")
        .arg(dir)
        .env_remove("FLAKE_EXPLORER_PROG")
        .env_remove("FLAKE_EXPLORER_TIMINGS");
    if all {
        cmd.arg("--all");
    }
    if timings {
        cmd.env("FLAKE_EXPLORER_TIMINGS", "1");
    }
    let out = cmd.output().unwrap();
    Run {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code(),
    }
}

/// The two runs write to different directories and the data dir is printed,
/// so the path is the one legitimate difference to fold away before comparing.
fn without_out_dir(s: &str, dir: &std::path::Path) -> String {
    s.replace(&dir.to_string_lossy().to_string(), "<OUT>")
}

fn timing_lines(stderr: &str) -> Vec<&str> {
    stderr
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("timing:"))
        .collect()
}

#[test]
fn timings_are_off_by_default_and_on_with_the_env_var() {
    if !nix_available() {
        return;
    }
    let tmp = TempDir::new("fe-timings");
    let plain_dir = tmp.0.join("plain");
    let timed_dir = tmp.0.join("timed");

    let plain = extract(&plain_dir, false, false);
    let timed = extract(&timed_dir, true, false);

    assert_eq!(plain.code, Some(0), "plain run failed: {}", plain.stderr);
    assert_eq!(timed.code, Some(0), "timed run failed: {}", timed.stderr);

    // Off by default: not on stdout, not on stderr.
    assert!(
        !plain.stdout.contains("timing:") && timing_lines(&plain.stderr).is_empty(),
        "default run emitted timing output:\n{}\n{}",
        plain.stdout,
        plain.stderr
    );

    // On, and on stderr — stdout is progress text a caller may pipe.
    let lines = timing_lines(&timed.stderr);
    assert!(
        lines.iter().any(|l| l.starts_with("timing: manifest ")),
        "no manifest phase line in:\n{}",
        timed.stderr
    );
    assert!(
        lines.iter().any(|l| l.starts_with("timing: total ")),
        "no total line in:\n{}",
        timed.stderr
    );
    assert!(
        !timed.stdout.contains("timing:"),
        "timing output leaked onto stdout:\n{}",
        timed.stdout
    );
}

#[test]
fn the_env_var_does_not_change_what_the_run_prints() {
    if !nix_available() {
        return;
    }
    let tmp = TempDir::new("fe-timings-same");
    let plain_dir = tmp.0.join("plain");
    let timed_dir = tmp.0.join("timed");

    let plain = extract(&plain_dir, false, false);
    let timed = extract(&timed_dir, true, false);

    assert_eq!(
        without_out_dir(&plain.stdout, &plain_dir),
        without_out_dir(&timed.stdout, &timed_dir),
        "FLAKE_EXPLORER_TIMINGS changed stdout"
    );
    assert_eq!(
        without_out_dir(&plain.stderr, &plain_dir),
        without_out_dir(&timed.stderr, &timed_dir)
            .lines()
            .filter(|l| !l.trim_start().starts_with("timing:"))
            .map(|l| format!("{l}\n"))
            .collect::<String>(),
        "FLAKE_EXPLORER_TIMINGS changed stderr beyond adding timing lines"
    );
}

#[test]
fn every_pass_of_an_all_extraction_reports_a_phase() {
    if !nix_available() {
        return;
    }
    let tmp = TempDir::new("fe-timings-all");
    let r = extract(&tmp.0.join("data"), true, true);
    assert_eq!(r.code, Some(0), "run failed: {}", r.stderr);

    let lines = timing_lines(&r.stderr);
    for phase in ["manifest ", "options ", "packages ", "total "] {
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with(&format!("timing: {phase}"))),
            "no {phase}phase line in:\n{}",
            r.stderr
        );
    }
    // Per-item lines too: the fixture has configurations and packages, and a
    // phase total alone cannot say which of them was slow.
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("timing:   options nixos/")),
        "no per-configuration line in:\n{}",
        r.stderr
    );
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("timing:   package packages/")),
        "no per-package line in:\n{}",
        r.stderr
    );
}
