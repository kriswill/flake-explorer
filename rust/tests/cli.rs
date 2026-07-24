// The CLI entry exercised as a subprocess — port of the bun suite's
// cli-help.test.ts: help must go to stdout with exit 0 (scripts pipe it),
// errors to stderr with exit 1. cargo-llvm-cov instruments spawned
// test-built binaries, so these runs count toward main.rs coverage.

struct Run {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

fn run(args: &[&str]) -> Run {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_flake-explorer"))
        .args(args)
        .env_remove("FLAKE_EXPLORER_PROG")
        .output()
        .unwrap();
    Run {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code(),
    }
}

#[test]
fn help_prints_usage_on_stdout_and_exits_0() {
    let r = run(&["--help"]);
    assert_eq!(r.code, Some(0));
    assert!(r.stdout.contains("usage:"));
    assert!(r.stdout.contains("extract <flakeref>"));
    assert!(r.stdout.contains("export <flakeref>"));
    assert!(r.stdout.contains("serve <flakeref>"));
    assert_eq!(r.stderr, "");
}

#[test]
fn h_help_and_bare_invocation_show_help_with_exit_0() {
    for args in [vec!["-h"], vec!["help"], vec![]] {
        let r = run(&args);
        assert_eq!(r.code, Some(0), "args: {args:?}");
        assert!(r.stdout.contains("usage:"), "args: {args:?}");
    }
}

#[test]
fn command_help_shows_help_without_running_the_command() {
    let r = run(&["serve", "--help"]);
    assert_eq!(r.code, Some(0));
    assert!(r.stdout.contains("usage:"));
}

#[test]
fn unknown_command_prints_usage_to_stderr_and_exits_1() {
    let r = run(&["bogus"]);
    assert_eq!(r.code, Some(1));
    assert!(r.stderr.contains("unknown command: bogus"));
    assert!(r.stderr.contains("usage:"));
    assert_eq!(r.stdout, "");
}

#[test]
fn flag_value_errors_are_loud_not_silent_defaults() {
    // A missing value (end of argv, or the next flag consumed as the value)
    // must be an error, not a silent default — see parse_flags.
    let r = run(&["extract", ".", "--timeout"]);
    assert_eq!(r.code, Some(1));
    assert!(r.stderr.contains("--timeout expects a value"));

    let r = run(&["extract", ".", "--timeout", "zero"]);
    assert_eq!(r.code, Some(1));
    assert!(r.stderr.contains("--timeout expects a positive number"));

    let r = run(&["extract", ".", "--sources", "everything"]);
    assert_eq!(r.code, Some(1));
    assert!(r.stderr.contains("--sources expects self or all"));

    let r = run(&["extract", ".", "--bogus-flag"]);
    assert_eq!(r.code, Some(1));
    assert!(r.stderr.contains("unknown flag: --bogus-flag"));
}

#[test]
fn wrapper_prog_name_is_respected() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_flake-explorer"))
        .arg("bogus")
        .env("FLAKE_EXPLORER_PROG", "fe-wrapped")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("fe-wrapped: unknown command"));
}
