// flake-explorer CLI (Rust) — port of flake-explorer.ts: extract flake
// structure/options to JSON, serve the SPA, or export a standalone HTML
// file. A wrapper may set FLAKE_EXPLORER_PROG so usage shows the invoked
// name.

use flake_explorer::drive::{self, DriveFlags, Selection};
use flake_explorer::{export, manifest, serve};
use std::process::exit;
use std::time::Duration;

struct Flags {
    out: String,
    configs: Selection,
    packages: Selection,
    all_systems: bool,
    timeout: f64,
    html: String,
    sources_all: bool,
    port: Option<u16>,
    host: Option<String>,
    dev: bool,
    positional: Vec<String>,
}

fn prog() -> String {
    std::env::var("FLAKE_EXPLORER_PROG").unwrap_or_else(|_| "flake-explorer".to_string())
}

fn die(msg: &str) -> ! {
    eprintln!("{}: {msg}", prog());
    exit(1)
}

fn parse_flags(argv: &[String]) -> Flags {
    let mut f = Flags {
        out: "./flake-explorer-data".to_string(),
        configs: Selection::None,
        packages: Selection::None,
        all_systems: false,
        timeout: 600.0,
        html: "./flake.html".to_string(),
        sources_all: false,
        port: None,
        host: None,
        dev: false,
        positional: Vec::new(),
    };
    // A missing value (end of argv, or the next flag consumed as the value)
    // must be an error, not a silent default.
    let arg = |flag: &str, raw: Option<&String>| -> String {
        match raw {
            Some(v) if !v.starts_with("--") => v.clone(),
            _ => die(&format!("{flag} expects a value")),
        }
    };
    let num = |flag: &str, raw: Option<&String>| -> f64 {
        let v = arg(flag, raw);
        match v.parse::<f64>() {
            Ok(n) if n.is_finite() && n > 0.0 => n,
            _ => die(&format!("{flag} expects a positive number, got: {v}")),
        }
    };
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "--out" => {
                i += 1;
                f.out = arg(a, argv.get(i));
            }
            "--configs" => {
                i += 1;
                f.configs = Selection::Ids(
                    arg(a, argv.get(i))
                        .split(',')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect(),
                );
            }
            "--packages" => {
                i += 1;
                f.packages = Selection::Ids(
                    arg(a, argv.get(i))
                        .split(',')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect(),
                );
            }
            "--all" => {
                f.configs = Selection::All;
                f.packages = Selection::All;
            }
            "--all-systems" => f.all_systems = true,
            "--timeout" => {
                i += 1;
                f.timeout = num(a, argv.get(i));
            }
            "--html" => {
                i += 1;
                f.html = arg(a, argv.get(i));
            }
            "--sources" => {
                i += 1;
                match arg(a, argv.get(i)).as_str() {
                    "self" => f.sources_all = false,
                    "all" => f.sources_all = true,
                    v => die(&format!("--sources expects self or all, got: {v}")),
                }
            }
            "--port" => {
                i += 1;
                f.port = Some(num(a, argv.get(i)) as u16);
            }
            "--host" => {
                i += 1;
                f.host = Some(arg(a, argv.get(i)));
            }
            "--dev" => f.dev = true,
            _ if a.starts_with("--") => die(&format!("unknown flag: {a}")),
            _ => f.positional.push(a.to_string()),
        }
        i += 1;
    }
    f
}

/// Canonicalize path-like flakerefs: nix with lazy-trees disabled refuses a
/// flake root that is itself a symlink (/etc/nixos usually is one).
fn canonical_ref(r#ref: &str) -> String {
    let Some(dir) = manifest::local_flake_dir(r#ref) else {
        return r#ref.to_string();
    };
    // Keep any ?query (e.g. ?dir=sub) — it's flake selection, not filesystem.
    let query = r#ref.find('?').map(|i| &r#ref[i..]).unwrap_or("");
    match std::fs::canonicalize(&dir) {
        Ok(p) => format!("{}{query}", p.to_string_lossy()),
        Err(_) => r#ref.to_string(),
    }
}

fn usage() -> String {
    format!(
        r#"usage: {prog} <command> [args]

commands:
  extract <flakeref> [--out DIR] [--configs kind/name,... | --all] [--packages path/segs,... | --all] [--all-systems] [--timeout SECS]
      Extract manifest (+ selected configurations/packages) to the data dir.
      --packages takes ids like "packages/x86_64-linux/rtk" (path.join("/") —
      also devShells/checks/formatter). --all means all configurations
      AND all packages.
  export <flakeref> [--html FILE] [--out DIR] [--configs kind/name,... | --all] [--packages path/segs,... | --all] [--all-systems] [--sources self|all] [--timeout SECS]
      Extract, then write ONE standalone HTML file (default ./flake.html)
      that works without a server — file://, any CDN, GitHub Pages.
      --sources all also embeds every file the exported configurations
      reference (can be large against nixpkgs).
  serve <flakeref> [--port N] [--host ADDR] [--out DIR] [--dev]
      Extract manifest, then serve the explorer UI with on-demand
      per-configuration extraction. --dev watches app/ and live-reloads
      the browser. Binds 127.0.0.1 by default — it serves file contents
      off local disk, so pass --host 0.0.0.0 only on a network you trust.

  --help, -h  Show this help.

docs: https://kris.net/flake-explorer/docs/ (or docs/ in the repo)"#,
        prog = prog()
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, rest) = match args.split_first() {
        Some((c, r)) => (c.clone(), r.to_vec()),
        None => {
            println!("{}", usage());
            exit(0);
        }
    };

    // Help is handled before parse_flags so `serve --help` works without
    // teaching the flag parser about it.
    if matches!(cmd.as_str(), "help" | "--help" | "-h")
        || rest.iter().any(|a| a == "--help" || a == "-h")
    {
        println!("{}", usage());
        exit(0);
    }

    let flags = parse_flags(&rest);
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let result = rt.block_on(run_command(&cmd, flags));
    if let Err(e) = result {
        eprintln!("{}: {e}", prog());
        exit(1);
    }
}

async fn run_command(cmd: &str, flags: Flags) -> anyhow::Result<()> {
    let timeout = Duration::from_secs_f64(flags.timeout);
    match cmd {
        "extract" => {
            let flake_ref = canonical_ref(flags.positional.first().unwrap_or_else(|| {
                die("usage: extract <flakeref> [--out DIR] [--configs a,b | --all] [--packages a,b | --all]")
            }));
            drive::extract_to_dir(
                &flake_ref,
                &DriveFlags {
                    out: flags.out.clone(),
                    configs: flags.configs.clone(),
                    packages: flags.packages.clone(),
                    all_systems: flags.all_systems,
                    timeout,
                },
            )
            .await?;
            Ok(())
        }
        "export" => {
            let flake_ref = canonical_ref(flags.positional.first().unwrap_or_else(|| {
                die("usage: export <flakeref> [--html FILE] [--configs a,b | --all] [--packages a,b | --all] [--sources self|all]")
            }));
            let r = drive::extract_to_dir(
                &flake_ref,
                &DriveFlags {
                    out: flags.out.clone(),
                    configs: flags.configs.clone(),
                    packages: flags.packages.clone(),
                    all_systems: flags.all_systems,
                    timeout,
                },
            )
            .await?;
            export::export_html(
                &flake_ref,
                &r.manifest,
                &export::ExportOptions {
                    out_dir: flags.out.clone(),
                    html_path: flags.html.clone(),
                    sources_all: flags.sources_all,
                    timeout,
                    wanted: r.wanted,
                    wanted_packages: r.wanted_packages,
                },
            )
            .await
        }
        "serve" => {
            let flake_ref =
                canonical_ref(flags.positional.first().unwrap_or_else(|| {
                    die("usage: serve <flakeref> [--port N] [--out DIR] [--dev]")
                }));
            serve::serve(
                flake_ref,
                serve::ServeFlags {
                    out: flags.out.clone(),
                    all_systems: flags.all_systems,
                    timeout,
                    port: flags.port.unwrap_or(4321),
                    host: flags
                        .host
                        .clone()
                        .unwrap_or_else(|| "127.0.0.1".to_string()),
                    dev: flags.dev,
                },
            )
            .await
        }
        _ => {
            eprintln!("{}: unknown command: {cmd}\n\n{}", prog(), usage());
            exit(1);
        }
    }
}
